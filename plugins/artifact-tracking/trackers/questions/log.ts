// The log of calls that the questions tracker keeps in its slot (issue #71): an append-only list, oldest first. It reads the
// slot value, merges two lists without a duplicate, numbers a call, and holds the caps of a session (the most calls, the most
// bytes, the oldest dropped first). Pure: no `$`, no I/O.
// The merge is keyed by the id of the call. It serves the carry of `/clear`, the load of `/resume` and the replay of the
// transcript: any two of them may meet in any order, and a call must stay one record.

import type { Json } from '../../core/interfaces/items'
import { isRecord } from '../../core/lib/json'
import { clip } from '../../core/lib/prompt-text'
import { wordsAskForSecret } from './secrets'
import type { QuestionCall } from './types'

/** The most calls a session keeps, and the most bytes (JSON characters) of its list. */
export type Caps = { readonly maxCalls: number; readonly maxBytes: number }

/** A string longer than this is the first to be cut when a call alone passes the byte cap. A text cut below it reads as nothing. */
const SMALLEST_CUT = 16

/** The slot value as calls. The slot stores Json, so a value that is not a list of records reads as none. */
export const asCalls = (v: Json | undefined): QuestionCall[] =>
  Array.isArray(v) ? (v as unknown[]).filter(isCall) : []

/**
 * The calls of the slot within the caps that the config names now. A limit that the person lowered since the last write
 * applies in every read (the pane, `/track qa`, the copy key) at once; the beat writes the cut list back. The same array
 * comes back from `capCalls` when the list fits.
 */
export const callsWithin = (v: Json | undefined, caps: Caps): QuestionCall[] => capCalls(asCalls(v), caps)

const isCall = (v: unknown): v is QuestionCall => isRecord(v) && typeof v.id === 'string' && typeof v.n === 'number'

/** The size of one call as the store counts it: its JSON text. */
export const sizeOf = (c: QuestionCall | readonly QuestionCall[]): number => JSON.stringify(c).length

/** The number of the next call: one more than the highest. The number of a dropped call is never used again. */
export const nextNumber = (calls: readonly QuestionCall[]): number => calls.reduce((m, c) => Math.max(m, c.n), 0) + 1

/**
 * Two copies of one call as one record. A record read back from the transcript has the time of the replay and no turn, so a
 * call that was seen live wins. The first copy otherwise, with a turn and a watermark filled in when only the other has one.
 */
export function joinCall(a: QuestionCall, b: QuestionCall): QuestionCall {
  const [keep, other] = a.replayed === true && b.replayed !== true ? [b, a] : [a, b]
  const turn = keep.turn === undefined ? other.turn : undefined
  const watermark = keep.watermark === undefined ? other.watermark : undefined
  if (turn === undefined && watermark === undefined) return keep
  return { ...keep, ...(turn !== undefined ? { turn } : {}), ...(watermark !== undefined ? { watermark } : {}) }
}

/**
 * `older` and `newer` in one list: the older calls first, then the newer ones that the older list lacks. A call that both
 * hold is joined (`joinCall`), and keeps the number of the live copy only when no other call has it. A call of `newer` that
 * the older list lacks keeps its number only when it is above every number so far, and else takes the next one: two sessions
 * may both have a call 1, and a restored list that the caps cut (Q5 to Q10) must not give Q1 again to a call that a fresh
 * process counted from 1. The numbers only grow. `older` itself comes back when `newer` adds nothing.
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
    // A number is used once, and the numbers only grow: a new call keeps its own only when it is above every number so far.
    // A number below the highest may belong to a call that the caps dropped (a fresh process counts from 1), so it is not free.
    let n = c.n
    if (n <= top) n = ++top
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

/** The keys whose text is an id, so a cut never shortens it: a shorter id names no call. */
const WHOLE = new Set(['id', 'watermark'])

/** The strings of a value, each cut to `limit` characters. A new value; the id of a call and its watermark stay whole. */
function cutStrings(v: unknown, limit: number, key?: string): unknown {
  if (typeof v === 'string') return (key !== undefined && WHOLE.has(key)) || v.length <= limit ? v : clip(v, limit)
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
 * The call with every question that asks for a secret marked (`sensitive`). The cut below may take the words that ask
 * (`password`, `token`), and the typed answer is short, so it stays whole: the masking needs the sign after the cut.
 */
function markSensitive(call: QuestionCall): QuestionCall {
  if (call.items === undefined) return call
  return {
    ...call,
    items: call.items.map(i => (wordsAskForSecret(i) ? { ...i, sensitive: true as const } : i)),
  }
}

/** What the mark `cut` adds to a call that has none: `,"cut":true`. */
const CUT_MARK_BYTES = ',"cut":true'.length

/**
 * A call cut to fit `maxBytes`: the longest texts shrink first (the limit halves until the call fits), so a long preview or
 * plan goes before a short answer does. The record says it was cut, and a question that asked for a secret says so before
 * its words are cut. The mark `cut` comes after the fit, so its bytes are kept out of the texts' budget: the call with its
 * marks is within `maxBytes`. The same call comes back when it fits.
 */
export function fitCall(call: QuestionCall, maxBytes: number): QuestionCall {
  if (sizeOf(call) <= maxBytes) return call
  const marked = markSensitive(call)
  const budget = maxBytes - (call.cut === true ? 0 : CUT_MARK_BYTES)
  let limit = longest(marked)
  let out = marked
  while (sizeOf(out) > budget && limit > SMALLEST_CUT) {
    limit = Math.max(SMALLEST_CUT, Math.floor(limit / 2))
    out = cutStrings(marked, limit) as QuestionCall
  }
  return { ...out, cut: true }
}

/** True for a call that the transcript of the main loop holds: not the `ui.ask` of a plugin, not the call of a subagent. */
const inTranscript = (c: QuestionCall): boolean => c.plugin !== true && c.agentId === undefined

/**
 * The watermark that the calls in `dropped` (oldest first) leave: the id of the newest call of the transcript among them, or
 * else the newest watermark that one of them carries. A mark that a dropped call carries came from calls before it, and the
 * call itself is later than its mark, so scanning from the end finds the newest.
 */
function watermarkOf(dropped: readonly QuestionCall[]): string | undefined {
  for (let i = dropped.length - 1; i >= 0; i--) {
    const c = dropped[i]!
    if (inTranscript(c)) return c.id
    if (c.watermark !== undefined) return c.watermark
  }
  return undefined
}

/**
 * `calls` without the first `drop` of them. The first call that stays takes the watermark of the dropped ones, unless it
 * has one: a mark that it carries was set when the calls before it dropped, so it is the newer.
 */
function dropFirst(calls: QuestionCall[], drop: number): QuestionCall[] {
  if (drop === 0) return calls
  const kept = calls.slice(drop)
  const first = kept[0]
  if (first === undefined || first.watermark !== undefined) return kept
  const watermark = watermarkOf(calls.slice(0, drop))
  return watermark === undefined ? kept : [{ ...first, watermark }, ...kept.slice(1)]
}

/**
 * The list within the caps. The oldest calls drop first: by count, then by bytes while more than one call is left. The first
 * call that stays keeps the id of the newest call of the transcript that dropped (`watermark`), and its bytes count. A last
 * call that is over the byte cap alone is cut (`fitCall`). The same list comes back when it fits.
 */
export function capCalls(calls: QuestionCall[], caps: Caps): QuestionCall[] {
  let drop = Math.max(0, calls.length - caps.maxCalls)
  let out = dropFirst(calls, drop)
  if (sizeOf(out) > caps.maxBytes) {
    let total = sizeOf(out)
    let more = 0
    const sizes = out.map(c => sizeOf(c) + 1)
    while (total > caps.maxBytes && out.length - more > 1) total -= sizes[more++]!
    drop += more
    out = dropFirst(calls, drop)
    // The watermark of the new first call has bytes too: when it tips the list over the cap, one more call goes.
    while (sizeOf(out) > caps.maxBytes && out.length > 1) out = dropFirst(calls, ++drop)
  }
  const last = out.at(-1)
  if (last !== undefined && sizeOf(out) > caps.maxBytes) {
    // The list is the call inside `[` and `]` (and the commas of any other call): the call gets the bytes that are left.
    const fit = fitCall(last, caps.maxBytes - (sizeOf(out) - sizeOf(last)))
    if (fit !== last) out = [...out.slice(0, -1), fit]
  }
  return out
}
