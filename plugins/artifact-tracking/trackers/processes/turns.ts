// The turns of the process rows (issue #133, P1b of #69). A row is stamped with the turn of the Bash or Monitor call that
// started it or named it again, or of the model's TaskStop that stopped it (issue #204); `Traceable.turnsOf` hands the stamps
// to the pane, and the sightings tell the ledger which rows the call added and which it saw again. A state change that no
// action of the turn made (a task notice, the probe, a turn that ends a task, a TaskStop that a plugin raised) is no
// sighting: it stamps nothing. The rules of the stamps are in `core/lib/turn-span.ts`.

import type { Json } from '../../core/interfaces/items'
import type { Sightings, TurnSpan } from '../../core/interfaces/turns'
import { rowSightings, turnSpan } from '../../core/lib/turn-span'
import { processReasons } from './reasons'
import type { ProcessRecord } from './types'

/** `Traceable.turnsOf` of the processes tracker: the first and the last turn of the row `rowId`, or undefined. */
export function processTurnsOf(data: Json | undefined, rowId: string): TurnSpan | undefined {
  const row = Array.isArray(data) ? (data as unknown as ProcessRecord[]).find(r => r.id === rowId) : undefined
  return row === undefined ? undefined : turnSpan(row)
}

/** The sightings of rows that a call named in `turn`: `held` is the list before the call. */
export function processSightings(
  turn: number,
  rows: readonly ProcessRecord[],
  held: readonly ProcessRecord[],
): Sightings {
  return rowSightings(
    turn,
    rows.map(r => ({
      id: r.id,
      category: 'process',
      reason: processReasons().strongest,
      held: held.find(h => h.id === r.id),
    })),
  )
}
