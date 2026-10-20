// Why a process row is tracked (issue #62). A process row exists because a Bash or Monitor call of this session started
// it, so every row is `created`. The probe only moves the state of a row that exists; it adds none.

import type { Json } from '../../core/interfaces/items'
import type { ReasonSet } from '../../core/interfaces/reasons'
import { reasonSet } from '../../core/lib/reasons'
import { asRows } from './rows'

/** The reasons of any process row. */
export const processReasons = (): ReasonSet => reasonSet('created')

/** `Traceable.reasonsOf` of the processes tracker: the reasons of the row `rowId`, or undefined when there is none. */
export function processReasonsOf(data: Json | undefined, rowId: string): ReasonSet | undefined {
  return asRows(data).some(r => r.id === rowId) ? processReasons() : undefined
}
