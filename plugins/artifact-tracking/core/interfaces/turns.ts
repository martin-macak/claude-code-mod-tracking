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
