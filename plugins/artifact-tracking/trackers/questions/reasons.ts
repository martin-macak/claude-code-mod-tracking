// Why a row of the questions tracker is tracked (issue #62). A record exists because a call of this session made it, so every
// row is `created`. A question row below a call has the reason of its call.

import type { Json } from '../../core/interfaces/items'
import type { ReasonSet } from '../../core/interfaces/reasons'
import { reasonSet } from '../../core/lib/reasons'
import { asCalls } from './log'

/** The reasons of any row of this tracker. */
export const questionReasons = (): ReasonSet => reasonSet('created')

/** The id of a question row below a call: the id of the call, a colon and the place of the question. */
export const itemRowId = (callId: string, i: number): string => `${callId}:${i}`

/** `Traceable.reasonsOf`: the reasons of the call `rowId` names, or of one of its question rows. undefined: no such row. */
export function questionReasonsOf(data: Json | undefined, rowId: string): ReasonSet | undefined {
  return asCalls(data).some(c => rowId === c.id || rowId.startsWith(`${c.id}:`)) ? questionReasons() : undefined
}
