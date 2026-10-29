// The schema normaliser: one rule set for the `global` block and for every tracker slice of the config file.
// A schema is data (`int`, `bool`, `words`, `oneOf`, `enums`, `obj`). `normaliseWith` turns a raw value into a valid one: per-field
// fallback to the default, a min and a max on every number, one problem line per bad value, unknown keys kept.
// Pure: no I/O, no clock. The functions do not freeze. `specOf` freezes its defaults only; the caller freezes results.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.7. Plan: L4 Task 1 (copy table N1 to N10).

import type { ConfigSpec } from '../interfaces/config'
import type { JsonObject } from '../interfaces/items'

export type Rule =
  | { readonly kind: 'int'; readonly def: number; readonly min: number; readonly max: number }
  | { readonly kind: 'bool'; readonly def: boolean }
  | { readonly kind: 'words'; readonly def: readonly string[]; readonly max: number }
  | { readonly kind: 'globs'; readonly def: readonly string[]; readonly max: number }
  | { readonly kind: 'enum'; readonly def: string; readonly values: readonly string[] }
  | { readonly kind: 'enums'; readonly def: readonly string[]; readonly values: readonly string[] }
  | { readonly kind: 'obj'; readonly of: Schema }

export type Schema = { readonly [key: string]: Rule }

/** The value type a schema describes. A mapped type alias, so it meets `C extends JsonObject` (an interface would not). */
export type ConfigOf<S extends Schema> = {
  readonly [K in keyof S]: S[K] extends { readonly kind: 'int' }
    ? number
    : S[K] extends { readonly kind: 'bool' }
      ? boolean
      : S[K] extends { readonly kind: 'words' }
        ? readonly string[]
        : S[K] extends { readonly kind: 'globs' }
          ? readonly string[]
          : S[K] extends { readonly kind: 'enum'; readonly values: readonly (infer V extends string)[] }
            ? V
            : S[K] extends { readonly kind: 'enums'; readonly values: readonly (infer V extends string)[] }
              ? readonly V[]
              : S[K] extends { readonly kind: 'obj'; readonly of: infer O extends Schema }
                ? ConfigOf<O>
                : never
}

/** Any C0 or C1 control character, DEL among them: a glob holds none. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

/** A word of a word list, after lowercasing. */
export const WORD: RegExp = /^[a-z][a-z0-9-]{0,31}$/

/** A whole number from `min` to `max`. */
export const int = (def: number, min: number, max: number): Rule & { kind: 'int' } => ({ kind: 'int', def, min, max })

/** True or false. */
export const bool = (def: boolean): Rule & { kind: 'bool' } => ({ kind: 'bool', def })

/** A list of at most `max` words (`WORD`). The default list is the fallback for a value that is not a list. */
export const words = (def: readonly string[], max: number): Rule & { kind: 'words' } => ({ kind: 'words', def, max })

/** The longest glob of a glob list, in characters. */
export const GLOB_MAX_LENGTH = 200

/**
 * A list of at most `max` globs: strings that stand for paths (`*.vault`, `~/keys/**`). Each is kept as written, case too, once, in
 * the order given. A glob is a non-empty string of at most `GLOB_MAX_LENGTH` characters with no control character. A word list
 * would refuse every glob: a glob has dots, stars and slashes. The default list is the fallback for a value that is not a list.
 */
export const globs = (def: readonly string[], max: number): Rule & { kind: 'globs' } => ({ kind: 'globs', def, max })

/**
 * One of a fixed list of words, compared as written (no case folding). The default must be one of them. The result type is
 * the union of the words, so a reader of the config gets `'off' | 'text'`, not `string`.
 */
export const oneOf = <const V extends string>(
  def: V,
  values: readonly V[],
): { readonly kind: 'enum'; readonly def: V; readonly values: readonly V[] } => ({ kind: 'enum', def, values })

/**
 * A list of words from a fixed list: each word compared as written, each kept once, in the order given. The default list must
 * hold only listed words. The result type is the list of the union, so a reader gets `readonly ('list' | 'flat')[]`. A value
 * that is no list, and a list with no listed word left, read as the default list: a reader of it (the `g` key) needs one entry.
 */
export const enums = <const V extends string>(
  def: readonly V[],
  values: readonly V[],
): { readonly kind: 'enums'; readonly def: readonly V[]; readonly values: readonly V[] } => ({
  kind: 'enums',
  def,
  values,
})

/**
 * A nested object with its own schema. The result type is the exact member, not `Rule & {...}`: that intersection would
 * make `of` a `Schema & S` and give the nested type an index signature, so a wrong nested key would still compile.
 */
export const obj = <S extends Schema>(of: S): { readonly kind: 'obj'; readonly of: S } => ({ kind: 'obj', of })

type Rec = Record<string, unknown>

const isPlain = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A value as a problem line shows it: JSON, cut at 40 characters with an ellipsis. */
export function show(v: unknown): string {
  let text: string
  try {
    text = JSON.stringify(v) ?? String(v)
  } catch {
    text = String(v)
  }
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}

/** The defaults a schema holds, as a new unfrozen tree. */
export function defaultsOf<S extends Schema>(s: S): ConfigOf<S> {
  const out: Rec = {}
  for (const [key, rule] of Object.entries(s)) {
    if (rule.kind === 'obj') out[key] = defaultsOf(rule.of)
    else if (rule.kind === 'words' || rule.kind === 'globs' || rule.kind === 'enums') out[key] = [...rule.def]
    else out[key] = rule.def
  }
  return out as ConfigOf<S>
}

/** Freezes the value and everything under it. */
export function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null) {
    for (const child of Object.values(v)) deepFreeze(child)
    Object.freeze(v)
  }
  return v
}

/** What a list rule keeps of one raw item: its kept form, or undefined for an item that does not belong. */
type Keep = (item: unknown) => string | undefined

/** A word: lowercased, and one of `WORD`. */
const keepWord: Keep = item => {
  const word = typeof item === 'string' ? item.toLowerCase() : undefined
  return word !== undefined && WORD.test(word) ? word : undefined
}

/** A glob: a non-empty string of at most `GLOB_MAX_LENGTH` characters with no control character, kept as written. */
const keepGlob: Keep = item =>
  typeof item === 'string' && item !== '' && item.length <= GLOB_MAX_LENGTH && !CONTROL.test(item) ? item : undefined

/**
 * The list of a raw value, or the fallback list when it is not a list: the items that `keep` accepts, each once, in the order
 * given. One problem for each item that is left out, and one when the list is cut at `rule.max`. The word list and the glob list
 * differ in `keep` and in the noun of their problems.
 */
function listOf(
  noun: 'word' | 'glob',
  keep: Keep,
  rule: { readonly max: number },
  v: unknown,
  fallback: readonly string[],
  p: string,
  warn: (problem: string) => void,
): readonly string[] {
  if (!Array.isArray(v)) {
    warn(`${p}: ${show(v)} is not a list of ${noun}s. Using the default list.`)
    return fallback
  }
  const kept: string[] = []
  for (const item of v) {
    const one = keep(item)
    if (one === undefined) warn(`${p}: ${show(item)} is not a valid ${noun}. The mod leaves it out.`)
    else if (!kept.includes(one)) kept.push(one)
  }
  if (kept.length > rule.max) {
    warn(`${p}: the list has more than ${rule.max} ${noun}s. The mod uses the first ${rule.max}.`)
    return kept.slice(0, rule.max)
  }
  return kept
}

/** The listed words of a raw list, each once. One problem for each item that is not listed, and one when no word is left. */
function enumsOf(
  rule: Rule & { kind: 'enums' },
  v: unknown,
  fallback: readonly string[],
  p: string,
  warn: (problem: string) => void,
): readonly string[] {
  const names = rule.values.join(', ')
  if (!Array.isArray(v)) {
    warn(`${p}: ${show(v)} is not a list of ${names}. Using the default list.`)
    return fallback
  }
  const kept: string[] = []
  for (const item of v) {
    if (typeof item !== 'string' || !rule.values.includes(item)) {
      warn(`${p}: ${show(item)} is not one of ${names}. The mod leaves it out.`)
    } else if (!kept.includes(item)) kept.push(item)
  }
  if (kept.length === 0) {
    warn(`${p}: no listed word is left. Using the default list.`)
    return fallback
  }
  return kept
}

/** One of the listed words, or the fallback when the value is any other. */
function enumOf(
  rule: Rule & { kind: 'enum' },
  v: unknown,
  fallback: string,
  p: string,
  warn: (problem: string) => void,
): string {
  if (typeof v === 'string' && rule.values.includes(v)) return v
  warn(`${p}: ${show(v)} is not one of ${rule.values.join(', ')}. Using ${fallback}.`)
  return fallback
}

/** A whole number inside the range, or the nearest bound, or the fallback when it is no whole number. */
function intOf(
  rule: Rule & { kind: 'int' },
  v: unknown,
  fallback: number,
  p: string,
  warn: (problem: string) => void,
): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    warn(`${p}: ${show(v)} is not a number. Using ${fallback}.`)
    return fallback
  }
  if (!Number.isInteger(v)) {
    warn(`${p}: ${v} is not a whole number. Using ${fallback}.`)
    return fallback
  }
  if (v < rule.min) {
    warn(`${p}: ${v} is below the min ${rule.min}. Using ${rule.min}.`)
    return rule.min
  }
  if (v > rule.max) {
    warn(`${p}: ${v} is above the max ${rule.max}. Using ${rule.max}.`)
    return rule.max
  }
  return v
}

/**
 * Turns a raw value into a valid one. A missing key takes the default. A bad value takes the default (wrong type, not
 * whole) or the nearest bound (out of range) and reports one problem. Unknown keys stay in the result and are named.
 * `defaults` is the fallback, so a caller can pass the last good values. `path` prefixes the messages of a nested block.
 */
export function normaliseWith<S extends Schema>(
  s: S,
  raw: unknown,
  defaults: ConfigOf<S>,
  warn: (problem: string) => void,
  path = '',
): ConfigOf<S> {
  const src: Rec = isPlain(raw) ? raw : {}
  const fallbacks = defaults as unknown as Rec
  const known: Rec = {}
  const at = (key: string): string => (path === '' ? key : `${path}.${key}`)
  for (const [key, rule] of Object.entries(s)) {
    const p = at(key)
    const fallback = fallbacks[key]
    const v = src[key]
    if (rule.kind === 'obj') {
      // A missing block is the defaults. A present block goes one level deeper under its own path.
      if (v === undefined) known[key] = fallback
      else if (isPlain(v)) known[key] = normaliseWith(rule.of, v, fallback as ConfigOf<typeof rule.of>, warn, p)
      else {
        warn(`${p}: ${show(v)} is not an object. Using the defaults.`)
        known[key] = fallback
      }
    } else if (v === undefined) known[key] = fallback
    else if (rule.kind === 'int') known[key] = intOf(rule, v, fallback as number, p, warn)
    else if (rule.kind === 'bool') {
      if (typeof v === 'boolean') known[key] = v
      else {
        warn(`${p}: ${show(v)} is not true or false. Using ${fallback}.`)
        known[key] = fallback
      }
    } else if (rule.kind === 'enum') known[key] = enumOf(rule, v, fallback as string, p, warn)
    else if (rule.kind === 'enums') known[key] = enumsOf(rule, v, fallback as readonly string[], p, warn)
    else if (rule.kind === 'globs')
      known[key] = listOf('glob', keepGlob, rule, v, fallback as readonly string[], p, warn)
    else known[key] = listOf('word', keepWord, rule, v, fallback as readonly string[], p, warn)
  }
  for (const key of Object.keys(src))
    if (!Object.hasOwn(s, key)) warn(`${at(key)}: unknown key. The mod keeps it and ignores it.`)
  return { ...src, ...known } as unknown as ConfigOf<S>
}

/**
 * A `ConfigSpec` that names the keys which moved to another slice. `moved` maps an old key to its new path. A file that
 * still sets one gets a problem that says where it went, in place of the unknown-key line. The mod keeps the key and
 * ignores it, as it keeps any unknown key (spec 10.4, K32).
 */
export function movedKeys<C extends JsonObject>(
  spec: ConfigSpec<C>,
  moved: Readonly<Record<string, string>>,
): ConfigSpec<C> {
  const gone = (key: string): boolean => Object.hasOwn(moved, key)
  return {
    defaults: spec.defaults,
    normalise: (raw, defaults, warn) => {
      // `fromEntries` defines own properties, so a `__proto__` key stays data. An assignment would call the setter.
      const entries = Object.entries(raw)
      const rest = Object.fromEntries(entries.filter(([key]) => !gone(key)))
      const left = Object.fromEntries(entries.filter(([key]) => gone(key)))
      const out = spec.normalise(rest as JsonObject, defaults, warn)
      for (const key of Object.keys(left)) warn(`${key}: moved to ${moved[key]}. The mod keeps it and ignores it here.`)
      return { ...out, ...left } as unknown as Readonly<C>
    },
  }
}

/** A `ConfigSpec` over a schema: frozen defaults and `normaliseWith` as the rule. */
export function specOf<S extends Schema>(s: S): ConfigSpec<ConfigOf<S>> {
  return {
    defaults: deepFreeze(defaultsOf(s)),
    normalise: (raw: Readonly<JsonObject>, defaults, warn) => normaliseWith(s, raw, defaults, warn),
  }
}
