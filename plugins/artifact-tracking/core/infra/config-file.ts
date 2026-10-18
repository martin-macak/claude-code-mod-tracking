// The file format of the config file: a signature for the cache, a strict parse, a merge that adds only missing keys,
// a stable render and the normalised document. All pure. The ConfigManager owns the fs and the policy.
// Names no tracker: a tracker reaches this file only as `{ id, config }`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.7. Plan: L4 Task 3 (decisions C8, C11, C17).

import type { ConfigSpec, GlobalConfig } from '../interfaces/config'
import type { Json, JsonObject } from '../interfaces/items'
import type { FsStat } from '../interfaces/ports'
import { GLOBAL_DEFAULTS, normaliseGlobal } from '../lib/global-config'
import { deepFreeze, show } from '../lib/normalise'

/** The version of the file this mod writes and knows. Version 1 has no migration. */
export const CONFIG_VERSION = 1

/** What the normaliser needs of a tracker: its id and its config spec. A `Tracker` fits. */
export type DocSpec = { readonly id: string; readonly config: ConfigSpec<JsonObject> }

/** The file as the mod uses it: valid values, frozen, and the problems found on the way. */
export interface NormalisedDoc {
  readonly version: number
  /** True when the mod must not change the file: its version is not the one the mod knows. */
  readonly readOnly: boolean
  readonly global: GlobalConfig
  /** One slice per spec, in spec order. A tracker the file does not name gets its defaults. */
  readonly slices: ReadonlyMap<string, Readonly<JsonObject>>
  readonly problems: readonly string[]
}

/** The cache key of a file: its mtime and size. */
export const signatureOf = (st: FsStat): string => `${st.mtimeMs}:${st.size}`

/** A JSON object: not null, not an array. */
export const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v)

/** `JSON.parse` after one BOM strip. A comment or a trailing comma is an error. `error` has no trailing period. */
export function parseConfig(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text.startsWith('﻿') ? text.slice(1) : text) }
  } catch (e) {
    return { ok: false, error: (e instanceof Error ? e.message : String(e)).replace(/\.$/, '') }
  }
}

/**
 * Adds the keys of `wanted` that `raw` lacks, deep where both sides are objects. Any other raw value stays, so a user
 * value is never changed. Raw keys come first in raw order, then the added keys in `wanted` order. Arrays are values.
 * Builds with `Object.fromEntries`, so a `__proto__` key stays data.
 */
export function mergeMissing(raw: JsonObject, wanted: JsonObject): JsonObject {
  const entries: [string, Json | undefined][] = Object.entries(raw).map(([key, value]) => {
    const w = Object.hasOwn(wanted, key) ? wanted[key] : undefined
    return [key, isObject(value) && isObject(w) ? mergeMissing(value, w) : value]
  })
  for (const [key, value] of Object.entries(wanted)) if (!Object.hasOwn(raw, key)) entries.push([key, value])
  return Object.fromEntries(entries)
}

/** The text to write: `version`, `global` and `trackers` first when present, then the other keys in order. */
export function renderConfig(doc: JsonObject): string {
  const first = ['version', 'global', 'trackers']
  const ordered = [
    ...first.filter(key => Object.hasOwn(doc, key)).map((key): [string, Json | undefined] => [key, doc[key]]),
    ...Object.entries(doc).filter(([key]) => !first.includes(key)),
  ]
  return `${JSON.stringify(Object.fromEntries(ordered), null, 2)}\n`
}

const OFF_HINT = ' To turn the tracker off, write { "enabled": false }.'

/**
 * Turns a parsed file into valid, frozen values and a list of problems. Order of the problems: the version, `global`,
 * the slices in spec order, then each tracker id no spec has. A missing `version` is `known`. A version that is not a
 * whole number of 1 or more is read as `known`. A version other than `known` makes the document read-only: a higher
 * one is a newer file, a lower one reaches this call only when the manager holds no migration chain for it.
 */
export function normaliseDoc(
  raw: JsonObject,
  specs: readonly DocSpec[],
  known: number = CONFIG_VERSION,
): NormalisedDoc {
  const problems: string[] = []
  const warn = (p: string): void => void problems.push(p)
  let version = known
  let readOnly = false
  if (Object.hasOwn(raw, 'version')) {
    const v = raw.version
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1)
      warn(`version: ${show(v)} is not a whole number of 1 or more. The mod reads the file as version ${known}.`)
    else if (v !== known) {
      version = v
      readOnly = true
      warn(
        `The file has version ${v}, and this mod knows version ${known} only. The mod reads the file but does not change it.`,
      )
    }
  }
  const g = raw.global
  let global: GlobalConfig = GLOBAL_DEFAULTS
  if (g === undefined || isObject(g)) global = normaliseGlobal(g, warn)
  else warn(`global: ${show(g)} is not an object. Using the defaults.`)
  const t = raw.trackers
  if (t !== undefined && !isObject(t)) warn(`trackers: ${show(t)} is not an object. Using the defaults.`)
  const trackers = isObject(t) ? t : {}
  const slices = new Map<string, Readonly<JsonObject>>()
  for (const { id, config } of specs) {
    const s = Object.hasOwn(trackers, id) ? trackers[id] : undefined
    let slice: Readonly<JsonObject> = config.defaults
    if (isObject(s)) slice = config.normalise(s, config.defaults, w => warn(`trackers.${id}.${w}`))
    else if (s !== undefined)
      warn(`trackers.${id}: ${show(s)} is not an object. Using the defaults.${s === false ? OFF_HINT : ''}`)
    slices.set(id, deepFreeze(slice))
  }
  for (const id of Object.keys(trackers))
    if (!specs.some(spec => spec.id === id))
      warn(`trackers.${id}: no tracker has this id. The mod keeps it and ignores it.`)
  return Object.freeze({
    version,
    readOnly,
    global: deepFreeze(global),
    slices,
    problems: Object.freeze(problems),
  })
}
