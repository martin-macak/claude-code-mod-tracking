// The stored copy of the ledger (issue #69): what a session copy keeps, when the copy is out of date, how a stored value is
// read back (it is JSON of some build, so it is checked and capped again) and how two ledgers of one lineage join, for
// `session.end`, a carry over `/clear` and a load. Pure. Imports `turns.ts` (the caps and the shared words) and
// `turn-entries.ts` (the cap of a list).
// Split from `turns.ts` (review of #136, m4).
// Spec: issue #69, the design study "Show what each turn tracked", section 5, and the owner decisions of 2026-10-21.

import type { CoreReason } from '../interfaces/items'
import type { TurnEntry, TurnLedger, TurnRecord } from '../interfaces/turns'
import { isRecord } from './json'
import { isCoreReason } from './reasons'
import { MAX_ENTRIES } from './turn-entries'
import { capped, excerpt, isEnd, MAX_MAPPED, MAX_TURNS, type Pairs } from './turns'

/** What a session copy keeps: the records and the counters. A running turn, the pending prompt and a notice are not kept. */
export function persisted(l: TurnLedger): TurnLedger {
  return { next: l.next, turns: l.turns, agents: l.agents, calls: l.calls }
}

/**
 * The change from `a` to `b` touches a stored part, so the session copy is out of date. The pure rules return the same
 * list when they change none of it, so identity tells. A change of the running turn, the pending prompt or a notice
 * alone writes nothing worth a copy.
 */
export const persistedChanged = (a: TurnLedger, b: TurnLedger): boolean =>
  a.next !== b.next || a.turns !== b.turns || a.agents !== b.agents || a.calls !== b.calls

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const str = (v: unknown): v is string => typeof v === 'string'

function entryOf(v: unknown): TurnEntry | undefined {
  if (!isRecord(v) || !str(v.k) || !str(v.c) || !isCoreReason(v.r)) return undefined
  return { k: v.k, c: v.c, r: v.r as CoreReason, ...(v.late === true ? { late: true as const } : {}) }
}

const entriesOf = (v: unknown): TurnEntry[] =>
  (Array.isArray(v) ? v : []).flatMap(x => entryOf(x) ?? []).slice(0, MAX_ENTRIES)

/** A count that is more than 0, whole; else undefined. */
const some = (v: unknown): number | undefined => (num(v) && v >= 1 ? Math.floor(v) : undefined)

function recordFrom(v: unknown): TurnRecord | undefined {
  if (!isRecord(v) || !num(v.ord) || !str(v.turnId) || !str(v.session) || !num(v.startedAt)) return undefined
  const [moreNew, moreSeen, wakes] = [some(v.moreNew), some(v.moreSeen), some(v.wakes)]
  return {
    ord: v.ord,
    turnId: v.turnId,
    session: v.session,
    startedAt: v.startedAt,
    ...(num(v.endedAt) ? { endedAt: v.endedAt } : {}),
    ...(isEnd(v.end) ? { end: v.end } : {}),
    ...(str(v.prompt) && v.prompt !== '' ? { prompt: excerpt(v.prompt) } : {}),
    new: entriesOf(v.new),
    seen: entriesOf(v.seen),
    ...(moreNew !== undefined ? { moreNew } : {}),
    ...(moreSeen !== undefined ? { moreSeen } : {}),
    ...(wakes !== undefined ? { wakes } : {}),
  }
}

const pairsFrom = (v: unknown): Pairs =>
  (Array.isArray(v) ? v : [])
    .flatMap(p => (Array.isArray(p) && str(p[0]) && num(p[1]) ? [[p[0], p[1]] as const] : []))
    .slice(-MAX_MAPPED)

/**
 * A ledger from a stored value. The store holds JSON of a build, so the value is checked: a record or an entry that is
 * not well formed is dropped, the caps are applied again. undefined: not a ledger at all.
 */
export function ledgerFrom(v: unknown): TurnLedger | undefined {
  if (!isRecord(v) || !Array.isArray(v.turns)) return undefined
  const turns = v.turns.flatMap(r => recordFrom(r) ?? []).slice(-MAX_TURNS)
  const last = turns.at(-1)?.ord ?? 0
  return {
    next: Math.max(num(v.next) ? Math.floor(v.next) : 1, last + 1),
    turns,
    agents: pairsFrom(v.agents),
    calls: pairsFrom(v.calls),
  }
}

/**
 * Two ledgers of one lineage in one: `a` is the newer (the live one), so its record of a turn wins. The counters go on
 * from the larger. Used for `session.end`, for a carry over `/clear` and for a load. A running turn of `a` stays.
 */
export function joinLedgers(a: TurnLedger, b: TurnLedger): TurnLedger {
  const known = new Set(a.turns.map(r => r.turnId))
  const turns = [...a.turns, ...b.turns.filter(r => !known.has(r.turnId))].sort((x, y) => x.ord - y.ord)
  const out: TurnLedger = {
    ...a,
    next: Math.max(a.next, b.next),
    turns,
    agents: [...b.agents.filter(([k]) => !a.agents.some(([x]) => x === k)), ...a.agents],
    calls: [...b.calls.filter(([k]) => !a.calls.some(([x]) => x === k)), ...a.calls],
  }
  return capped(out)
}

/** A ledger that holds no turn. */
export const isBare = (l: TurnLedger): boolean => l.turns.length === 0
