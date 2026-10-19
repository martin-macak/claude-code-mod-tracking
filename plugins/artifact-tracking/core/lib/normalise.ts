// The schema normaliser: one rule set for the `global` block and for every tracker slice of the config file.
// A schema is data (`int`, `bool`, `words`, `obj`). `normaliseWith` turns a raw value into a valid one: per-field
// fallback to the default, a min and a max on every number, one problem line per bad value, unknown keys kept.
// Pure: no I/O, no clock. The functions do not freeze. `specOf` freezes its defaults only; the caller freezes results.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.7. Plan: L4 Task 1 (copy table N1 to N10).

import type { ConfigSpec } from '../interfaces/config'
import type { JsonObject } from '../interfaces/items'

export type Rule =
  | { readonly kind: 'int'; readonly def: number; readonly min: number; readonly max: number }
  | { readonly kind: 'bool'; readonly def: boolean }
  | { readonly kind: 'words'; readonly def: readonly string[]; readonly max: number }
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
        : S[K] extends { readonly kind: 'obj'; readonly of: infer O extends Schema }
          ? ConfigOf<O>
          : never
}

/** A word of a word list, after lowercasing. */
export const WORD: RegExp = /^[a-z][a-z0-9-]{0,31}$/

/** A whole number from `min` to `max`. */
export const int = (def: number, min: number, max: number): Rule & { kind: 'int' } => ({ kind: 'int', def, min, max })

/** True or false. */
export const bool = (def: boolean): Rule & { kind: 'bool' } => ({ kind: 'bool', def })

/** A list of at most `max` words (`WORD`). The default list is the fallback for a value that is not a list. */
export const words = (def: readonly string[], max: number): Rule & { kind: 'words' } => ({ kind: 'words', def, max })

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
    else if (rule.kind === 'words') out[key] = [...rule.def]
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

/** The word list of a raw value, or the fallback list when it is not a list. */
function wordsOf(
  rule: Rule & { kind: 'words' },
  v: unknown,
  fallback: readonly string[],
  p: string,
  warn: (problem: string) => void,
): readonly string[] {
  if (!Array.isArray(v)) {
    warn(`${p}: ${show(v)} is not a list of words. Using the default list.`)
    return fallback
  }
  const kept: string[] = []
  for (const item of v) {
    const word = typeof item === 'string' ? item.toLowerCase() : undefined
    if (word === undefined || !WORD.test(word)) warn(`${p}: ${show(item)} is not a valid word. The mod leaves it out.`)
    else if (!kept.includes(word)) kept.push(word)
  }
  if (kept.length > rule.max) {
    warn(`${p}: the list has more than ${rule.max} words. The mod uses the first ${rule.max}.`)
    return kept.slice(0, rule.max)
  }
  return kept
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
    } else known[key] = wordsOf(rule, v, fallback as readonly string[], p, warn)
  }
  for (const key of Object.keys(src))
    if (!Object.hasOwn(s, key)) warn(`${at(key)}: unknown key. The mod keeps it and ignores it.`)
  return { ...src, ...known } as unknown as ConfigOf<S>
}

/** A `ConfigSpec` over a schema: frozen defaults and `normaliseWith` as the rule. */
export function specOf<S extends Schema>(s: S): ConfigSpec<ConfigOf<S>> {
  return {
    defaults: deepFreeze(defaultsOf(s)),
    normalise: (raw: Readonly<JsonObject>, defaults, warn) => normaliseWith(s, raw, defaults, warn),
  }
}
