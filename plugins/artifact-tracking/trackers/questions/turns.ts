// The turns of the Questions rows (issue #201, after #133). A call is stamped with the turn that made it (`QuestionCall.turn`).
// `Traceable.turnsOf` hands that stamp to the pane, and the sightings tell the ledger which calls an event added, so `/track
// turn n` lists them. The label of such an entry is the key of the row (`Q3`) and never its words: see `turnLabels` in
// `hooks/pane-text.ts`. The rules of the stamps are in `core/lib/turn-span.ts`.

import type { Json } from '../../core/interfaces/items'
import type { Sightings, TurnSpan } from '../../core/interfaces/turns'
import { rowSightings, type TurnStamps, turnSpan } from '../../core/lib/turn-span'
import { asCalls } from './log'
import { callWord } from './present'
import { questionReasons } from './reasons'
import type { QuestionCall } from './types'

/** A call keeps one turn, the one that made it: it is both ends of its span. The core rules (`turnSpan`) read it as two stamps. */
const stampsOf = (c: Pick<QuestionCall, 'turn'>): TurnStamps => ({ firstTurn: c.turn, lastTurn: c.turn })

/** `Traceable.turnsOf` of the questions tracker: the turn of the call `rowId` for both ends, or undefined. A question row below a call has none. */
export function questionTurnsOf(data: Json | undefined, rowId: string): TurnSpan | undefined {
  const call = asCalls(data).find(c => c.id === rowId)
  return call === undefined ? undefined : turnSpan(stampsOf(call))
}

/** The sightings of the calls that an event kept in `turn`: `held` is the list before the write. */
export function questionSightings(
  turn: number,
  calls: readonly Pick<QuestionCall, 'id' | 'kind'>[],
  held: readonly QuestionCall[],
): Sightings {
  return rowSightings(
    turn,
    calls.map(c => {
      const before = held.find(h => h.id === c.id)
      return {
        id: c.id,
        category: callWord(c),
        reason: questionReasons().strongest,
        held: before === undefined ? undefined : stampsOf(before),
      }
    }),
  )
}
