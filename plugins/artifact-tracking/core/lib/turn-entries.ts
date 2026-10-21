// The entries of a turn (issue #69): the two lists of what a turn added (`new`) and saw again (`seen`), their cap, how the
// sightings of a capture go into them, the sightings of a merge, and how a record is read for its counts and keys. Pure: no
// input is mutated, and a call that changes nothing returns its input, so a caller can test for a change with `===`. It
// imports nothing of the ledger rules (`turns.ts` imports it).
// Split from `turns.ts` (review of #136, m4).
// Spec: issue #69, the design study "Show what each turn tracked", section 5, and the owner decisions of 2026-10-21.

import type { CoreReason } from '../interfaces/items'
import type { Sightings, TurnEntry, TurnLedger, TurnRecord } from '../interfaces/turns'
import { strongerReason } from './reasons'

/** The entries of one list of one turn. More count as `moreNew` or `moreSeen`. */
export const MAX_ENTRIES = 50
// ---------------------------------------------------------------- entries

type Lists = {
  readonly new: readonly TurnEntry[]
  readonly seen: readonly TurnEntry[]
  readonly moreNew?: number
  readonly moreSeen?: number
}

/** The entry with the stronger reason of the two. The first entry's `late` stays: it was told when it came. */
const stronger = (a: TurnEntry, b: TurnEntry): TurnEntry => (strongerReason(a.r, b.r) === a.r ? a : { ...a, r: b.r })

/** One entry into a list: a known key keeps its place and takes the stronger reason, else it goes last, up to the cap. */
function listed(list: readonly TurnEntry[], more: number, e: TurnEntry): { list: readonly TurnEntry[]; more: number } {
  const at = list.findIndex(x => x.k === e.k)
  if (at >= 0) {
    const next = stronger(list[at]!, e)
    return next === list[at] ? { list, more } : { list: list.map((x, i) => (i === at ? next : x)), more }
  }
  if (list.length >= MAX_ENTRIES) return { list, more: more + 1 }
  return { list: [...list, e], more }
}

/**
 * The sightings into the lists of one turn. An item that the turn added stays in `new` when a later claim of the turn
 * names it, with the stronger reason; it never moves to `seen`. An item the turn saw again counts once. A repeat (the
 * turn stamped the item before) only strengthens an entry that is listed, in `new` or in `seen`: an item that did not fit
 * a list was counted at its first sighting, and a repeat counts nothing more.
 */
export function withSightings(lists: Lists, s: Sightings, late: boolean): Lists {
  const mark = (e: TurnEntry): TurnEntry => (late ? { ...e, late: true } : e)
  const st = { fresh: lists.new, again: lists.seen, moreNew: lists.moreNew ?? 0, moreSeen: lists.moreSeen ?? 0 }
  for (const e of s.added.map(mark)) {
    const was = st.again.find(x => x.k === e.k)
    if (was !== undefined) st.again = st.again.filter(x => x.k !== e.k)
    const into = listed(st.fresh, st.moreNew, was === undefined ? e : stronger(was, e))
    st.fresh = into.list
    st.moreNew = into.more
  }
  for (const e of s.seen.map(mark)) {
    if (st.fresh.some(x => x.k === e.k)) {
      const into = listed(st.fresh, st.moreNew, e)
      st.fresh = into.list
      st.moreNew = into.more
    } else {
      const into = listed(st.again, st.moreSeen, e)
      st.again = into.list
      st.moreSeen = into.more
    }
  }
  for (const e of (s.repeat ?? []).map(mark)) {
    if (st.fresh.some(x => x.k === e.k)) st.fresh = listed(st.fresh, st.moreNew, e).list
    else if (st.again.some(x => x.k === e.k)) st.again = listed(st.again, st.moreSeen, e).list
  }
  const same =
    st.fresh === lists.new &&
    st.again === lists.seen &&
    st.moreNew === (lists.moreNew ?? 0) &&
    st.moreSeen === (lists.moreSeen ?? 0)
  if (same) return lists
  return {
    new: st.fresh,
    seen: st.again,
    ...(st.moreNew > 0 ? { moreNew: st.moreNew } : {}),
    ...(st.moreSeen > 0 ? { moreSeen: st.moreSeen } : {}),
  }
}

/** A capture that made no claim. */
export const NO_SIGHTINGS: Sightings = { added: [], seen: [] }

/** The capture named no item at all. */
export const isEmpty = (s: Sightings): boolean => s.added.length + s.seen.length + (s.repeat?.length ?? 0) === 0

/** The sightings of two captures: the entries of `a`, then those of `b`. */
export function joinSightings(a: Sightings, b: Sightings): Sightings {
  if (isEmpty(b)) return a
  const repeat = [...(a.repeat ?? []), ...(b.repeat ?? [])]
  return {
    added: [...a.added, ...b.added],
    seen: [...a.seen, ...b.seen],
    ...(repeat.length > 0 ? { repeat } : {}),
  }
}

/**
 * The sightings of one merge. Each key of `added`, `touched` and `repeated` becomes an entry: its category from the claim
 * that named it first, its reason the strongest of the claims that named it. Order: the order of the keys. `claims` are the
 * claims the merge took (dismissed keys and kinds that are off are out).
 */
export function sightingsOf(
  claims: readonly { readonly key: string; readonly category: string; readonly reason: CoreReason }[],
  added: readonly string[],
  touched: readonly string[],
  repeated: readonly string[] = [],
): Sightings {
  const entry = (k: string): TurnEntry[] => {
    const hits = claims.filter(c => c.key === k)
    const first = hits[0]
    if (first === undefined) return []
    return [{ k, c: first.category, r: hits.reduce<CoreReason>((r, c) => strongerReason(r, c.reason), first.reason) }]
  }
  const repeat = repeated.flatMap(entry)
  return { added: added.flatMap(entry), seen: touched.flatMap(entry), ...(repeat.length > 0 ? { repeat } : {}) }
}

// ---------------------------------------------------------------- reading

/** How many items a turn listed, with the ones that did not fit. */
export const countOf = (
  r: Pick<TurnRecord, 'new' | 'seen' | 'moreNew' | 'moreSeen'>,
): { added: number; seen: number } => ({
  added: r.new.length + (r.moreNew ?? 0),
  seen: r.seen.length + (r.moreSeen ?? 0),
})

/** The newest turn that tracked anything, the running one included. The band shows it. */
export function latestWithEntries(l: TurnLedger): TurnRecord | undefined {
  return [...l.turns].reverse().find(r => r.new.length + r.seen.length > 0)
}

/** The keys of a turn in the order it lists them: what it added, then what it saw again. */
export const keysOf = (r: Pick<TurnRecord, 'new' | 'seen'>): readonly string[] => [...r.new, ...r.seen].map(e => e.k)
