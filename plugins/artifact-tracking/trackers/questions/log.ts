// The log of calls that the questions tracker keeps in its slot (issue #71): an append-only list, oldest first. It reads the
// slot value, merges two lists without a duplicate, numbers a call, and holds the caps of a session (the most calls, the most
// bytes, the oldest dropped first). Pure: no `$`, no I/O.
// The merge is keyed by the id of the call. It serves the carry of `/clear`, the load of `/resume` and the replay of the
// transcript: any two of them may meet in any order, and a call must stay one record.

import type { Json } from '../../core/interfaces/items'
import { isRecord } from '../../core/lib/json'
import { clip } from '../../core/lib/prompt-text'
import type { QuestionCall } from './types'

/** The most calls a session keeps, and the most bytes (JSON characters) of its list. */
export type Caps = { readonly maxCalls: number; readonly maxBytes: number }

/** A string longer than this is the first to be cut when a call alone passes the byte cap. A text cut below it reads as nothing. */
const SMALLEST_CUT = 16

/** The slot value as calls. The slot stores Json, so a value that is not a list of records reads as none. */
export const asCalls = (v: Json | undefined): QuestionCall[] =>
  Array.isArray(v) ? (v as unknown[]).filter(isCall) : []

const isCall = (v: unknown): v is QuestionCall => isRecord(v) && typeof v.id === 'string' && typeof v.n === 'number'

/** The size of one call as the store counts it: its JSON text. */
export const sizeOf = (c: QuestionCall | readonly QuestionCall[]): number => JSON.stringify(c).length

/** The number of the next call: one more than the highest. The number of a dropped call is never used again. */
export const nextNumber = (calls: readonly QuestionCall[]): number => calls.reduce((m, c) => Math.max(m, c.n), 0) + 1

/**
 * Two copies of one call as one record. A record read back from the transcript has the time of the replay and no turn, so a
 * call that was seen live wins. The first copy otherwise, with a turn filled in when only the other has one.
 */
export function joinCall(a: QuestionCall, b: QuestionCall): QuestionCall {
  const [keep, other] = a.replayed === true && b.replayed !== true ? [b, a] : [a, b]
  return keep.turn === undefined && other.turn !== undefined ? { ...keep, turn: other.turn } : keep
}

/**
 * `older` and `newer` in one list: the older calls first, then the newer ones that the older list lacks. A call that both
 * hold is joined (`joinCall`), and keeps the number of the live copy only when no other call has it. A call of `newer` whose
 * number another call has takes the next free number: two sessions may both have a call 1. `older` itself comes back when
 * `newer` adds nothing.
 */
export function mergeCalls(older: readonly QuestionCall[], newer: readonly QuestionCall[]): QuestionCall[] {
  if (newer.length === 0) return older as QuestionCall[]
  const out = [...older]
  const at = new Map(out.map((c, i) => [c.id, i] as const))
  const used = new Set(out.map(c => c.n))
  let top = nextNumber(out) - 1
  for (const c of newer) {
    const known = at.get(c.id)
    if (known !== undefined) {
      const old = out[known]!
      const joined = joinCall(old, c)
      // The live copy has a number of its own. It counts only when no other call has it: one number is one call (`/track qa 3`).
      const n = joined.n === old.n || !used.has(joined.n) ? joined.n : old.n
      used.add(n)
      top = Math.max(top, n)
      out[known] = n === joined.n ? joined : { ...joined, n }
      continue
    }
    let n = c.n
    if (used.has(n)) n = ++top
    top = Math.max(top, n)
    used.add(n)
    at.set(c.id, out.length)
    out.push(n === c.n ? c : { ...c, n })
  }
  return out
}

/** What the tracker knows when it adds a call: the time, the turn when the ledger has it, and whether a replay found it. */
export type Stamp = { at: number; turn?: number; replayed?: true }

/**
 * The list with one call added: `body` numbered and stamped. A call whose id the list holds is joined with the old one, so
 * a call that the live hook and the replay both saw is one record. The same list comes back when nothing changes.
 */
export function addCall(
  calls: readonly QuestionCall[],
  body: Omit<QuestionCall, 'n' | 'at' | 'turn' | 'replayed'>,
  stamp: Stamp,
): QuestionCall[] {
  const made: QuestionCall = {
    ...body,
    n: nextNumber(calls),
    at: stamp.at,
    ...(stamp.turn !== undefined ? { turn: stamp.turn } : {}),
    ...(stamp.replayed ? { replayed: true as const } : {}),
  }
  const merged = mergeCalls(calls, [made])
  return merged.length === calls.length && merged.every((c, i) => c === calls[i]) ? (calls as QuestionCall[]) : merged
}

/** The strings of a value, each cut to `limit` characters. A new value; the id of a call stays whole. */
function cutStrings(v: unknown, limit: number, key?: string): unknown {
  if (typeof v === 'string') return key === 'id' || v.length <= limit ? v : clip(v, limit)
  if (Array.isArray(v)) return v.map(x => cutStrings(x, limit))
  if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cutStrings(x, limit, k)]))
  return v
}

const longest = (v: unknown): number =>
  typeof v === 'string'
    ? v.length
    : Array.isArray(v)
      ? v.reduce((m: number, x) => Math.max(m, longest(x)), 0)
      : isRecord(v)
        ? Object.values(v).reduce((m: number, x) => Math.max(m, longest(x)), 0)
        : 0

/**
 * A call cut to fit `maxBytes`: the longest texts shrink first (the limit halves until the call fits), so a long preview or
 * plan goes before a short answer does. The record says it was cut. The same call comes back when it fits.
 */
export function fitCall(call: QuestionCall, maxBytes: number): QuestionCall {
  if (sizeOf(call) <= maxBytes) return call
  let limit = longest(call)
  let out = call
  while (sizeOf(out) > maxBytes && limit > SMALLEST_CUT) {
    limit = Math.max(SMALLEST_CUT, Math.floor(limit / 2))
    out = cutStrings(call, limit) as QuestionCall
  }
  return { ...out, cut: true }
}

/**
 * The list within the caps. The oldest calls drop first: by count, then by bytes while more than one call is left. A last
 * call that is over the byte cap alone is cut (`fitCall`). The same list comes back when it fits.
 */
export function capCalls(calls: QuestionCall[], caps: Caps): QuestionCall[] {
  let out = calls.length > caps.maxCalls ? calls.slice(calls.length - caps.maxCalls) : calls
  if (sizeOf(out) > caps.maxBytes) {
    let total = sizeOf(out)
    let drop = 0
    const sizes = out.map(c => sizeOf(c) + 1)
    while (total > caps.maxBytes && out.length - drop > 1) total -= sizes[drop++]!
    out = out.slice(drop)
  }
  const last = out.at(-1)
  if (last !== undefined && sizeOf(out) > caps.maxBytes) {
    const fit = fitCall(last, caps.maxBytes)
    if (fit !== last) out = [...out.slice(0, -1), fit]
  }
  return out
}
