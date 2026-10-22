// Turn contracts (issue #69): what the TurnLedger stores and what the capture funnel tells it. Types only. The stored
// shapes live in the state contract (`types/index.d.ts`, spec 5.13) and are re-exported here.

import type { TurnEntry } from '../../types'

export type { TurnEnd, TurnEntry, TurnLedger, TurnRecord } from '../../types'

/**
 * What one capture did to the item list, as ledger entries. `added`: the items it put in. `seen`: the known items that a
 * claim of it named for the first time in this turn. `repeat`: the known items that the same turn had stamped already (it
 * added them or saw them before), named again. A key is in one list only. The reason of an entry is the strongest of the
 * claims that named the key. A repeat only strengthens an entry that the turn lists: it is never a new entry and never
 * counts, so an item that did not fit a list is counted once. A status refresh and a tracker's own `items.track` make no
 * sighting.
 */
export type Sightings = {
  readonly added: readonly TurnEntry[]
  readonly seen: readonly TurnEntry[]
  readonly repeat?: readonly TurnEntry[]
}

/**
 * Where the work of an event goes: the ordinal of a turn. `pending`: the turn has not opened yet (the person's prompt row
 * comes before its `turn.start`), so the ordinal is the next one and the entries wait. `late`: the turn has ended
 * already, and a subagent that it started still works.
 */
export type TurnTarget = { readonly ord: number; readonly pending?: true; readonly late?: true }

/** Who made an event, as the ledger needs it. `person`: the person's own prompt row. */
export type TurnSource = { readonly agentId?: string; readonly person?: boolean }

/** What the duration line of a turn draws under the engine's words (issue #69, P2): the turn's ordinal and its counts. */
export type DurationStrip = { readonly ord: number; readonly counts: string }

/** The first and the last turn that named a row (issue #133). The pane row (`TreeRow.turns`) and `Traceable.turnsOf` use it. */
export type TurnSpan = { readonly first: number; readonly last: number }

/**
 * The turn of the event a tracker handler runs for, and the way to tell the ledger which of the tracker's own rows that
 * event named in it (issue #133, P1b of #69). Items need no such call: the capture funnel stamps them. A slot tracker (repos,
 * processes, auto) keeps its rows itself, so it stamps them with `ord` and reports them here. `TrackerContext.turn` holds
 * one for the events of a main-loop turn; a tick, a command, a start and a replay have none.
 */
export interface TurnPort {
  /** The ordinal of the turn that the event belongs to. The turn the person's prompt starts counts, though it has not opened yet. */
  readonly ord: number
  /**
   * The rows the event named. The ledger lists them in the turn: the added ones as `new`, the known ones as `seen again`.
   * Work that comes after the turn ended (a subagent) is marked late. Never rejects: a fault is logged and the tracker goes on.
   */
  note(s: Sightings): Promise<void>
}
