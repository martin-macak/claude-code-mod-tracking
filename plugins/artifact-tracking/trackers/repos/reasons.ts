// Why a repo row is tracked (issue #62): the mode of the row says what Claude did there. `edit` is an `updated` repo,
// `read` a `read` one; a row an older version stored with no mode reads as `read`. The row keeps no history, so the set
// holds the one reason it knows. No capture logic: the mode already exists.

import type { ReasonSet } from '../../core/interfaces/reasons'
import { reasonSet } from '../../core/lib/reasons'
import { repoRowId } from './ids'
import { asRepoRows } from './rows'
import type { RepoRecord } from './types'

export const repoReasons = (r: Pick<RepoRecord, 'mode'>): ReasonSet => reasonSet(r.mode === 'edit' ? 'updated' : 'read')

/** `Traceable.reasonsOf` of the repos tracker: the reasons of the row `rp:<key>`, or undefined when there is none. */
export function repoReasonsOf(data: readonly RepoRecord[] | undefined, rowId: string): ReasonSet | undefined {
  const row = asRepoRows(data).find(r => repoRowId(r.key) === rowId)
  return row === undefined ? undefined : repoReasons(row)
}
