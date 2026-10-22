// The turn span of a row (issue #133, P1b of #69): `firstTurn` and `lastTurn` on a record, how a visit of a turn changes
// them, and what the visit tells the ledger. The records of the items (`records.ts`) and the rows of the processes, repos
// and auto trackers keep the same two fields, so one rule serves them all. Pure: no input is mutated, and a call that changes
// nothing returns its input, so a caller can test for a change with `===`. No `$`, no I/O, no tracker named.

import type { CoreReason } from '../interfaces/reasons'
import type { Sightings, TurnEntry, TurnSpan } from '../interfaces/turns'

/** What a record keeps of its turns. A record from before the lineage has neither field. */
export type TurnStamps = { readonly firstTurn?: number; readonly lastTurn?: number }

const numberOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/**
 * The first and the last turn over some records, or undefined when none has a turn. A record with only one of the two
 * stamps counts that turn for both, before the records are combined: `{firstTurn: 5}` and `{lastTurn: 3}` make 3 to 5,
 * never 5 to 3.
 */
export function turnSpan(...recs: readonly TurnStamps[]): TurnSpan | undefined {
  const spans: TurnSpan[] = []
  for (const r of recs) {
    const first = numberOf(r.firstTurn) ?? numberOf(r.lastTurn)
    const last = numberOf(r.lastTurn) ?? numberOf(r.firstTurn)
    if (first !== undefined && last !== undefined) spans.push({ first, last })
  }
  if (spans.length === 0) return undefined
  return { first: Math.min(...spans.map(s => s.first)), last: Math.max(...spans.map(s => s.last)) }
}

/**
 * The record with the span of its copies: the smallest `firstTurn` and the largest `lastTurn`. A merge of two rows spreads
 * one over the other and would lose a stamp, so it ends with this. The same object comes back when the stamps are right
 * already, and when no copy has a turn.
 */
export function withSpan<R extends TurnStamps>(rec: R, ...copies: readonly TurnStamps[]): R {
  const span = turnSpan(...copies)
  if (span === undefined || (rec.firstTurn === span.first && rec.lastTurn === span.last)) return rec
  return { ...rec, firstTurn: span.first, lastTurn: span.last }
}

/**
 * The record as a visit of `turn` leaves it: `firstTurn` the smallest and `lastTurn` the largest of the turns the record
 * had and `turn`. A record from before the lineage gets `turn` for both, as an item does. Late work of an older turn can
 * move `firstTurn` down; it never moves `lastTurn` down.
 */
export const stampedTurn = <R extends TurnStamps>(rec: R, turn: number): R =>
  withSpan(rec, rec, { firstTurn: turn, lastTurn: turn })

/**
 * How a visit of `turn` names a row that was `held` before it. `added`: no row was held. `repeat`: the same turn stamped it
 * already, so the visit only strengthens an entry that the turn lists. `seen`: a known row of an older turn, or of no turn.
 * The words are those of `Sightings` (`core/interfaces/turns.ts`).
 */
export function sightOf(held: TurnStamps | undefined, turn: number): 'added' | 'seen' | 'repeat' {
  if (held === undefined) return 'added'
  return held.lastTurn === turn ? 'repeat' : 'seen'
}

/** One row that an event named: its id, the category word of the ledger line, why it is tracked, and the row as it was before. */
export type RowVisit = {
  /** The id of the row in the pane. */
  readonly id: string
  /** `process`, `repo` or `agent`: the word of the line when the row is no longer listed. */
  readonly category: string
  readonly reason: CoreReason
  /** The row before the event, or undefined when the event added it. */
  readonly held: TurnStamps | undefined
}

/** The sightings of the rows an event named in `turn`: each row goes to the list its visit makes (`sightOf`). */
export function rowSightings(turn: number, rows: readonly RowVisit[]): Sightings {
  const lists: Record<'added' | 'seen' | 'repeat', TurnEntry[]> = { added: [], seen: [], repeat: [] }
  for (const row of rows) lists[sightOf(row.held, turn)].push({ k: row.id, c: row.category, r: row.reason })
  return { added: lists.added, seen: lists.seen, ...(lists.repeat.length > 0 ? { repeat: lists.repeat } : {}) }
}
