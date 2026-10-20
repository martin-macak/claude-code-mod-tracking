// Why a worktree or an agent row is tracked (issue #62). The rows this run made are `created`: a worktree proof
// (`WorktreeProof.origin`: `enter`, `agent` or `workflow`, each a worktree the run made) and an agent proof. The root
// worktree and the master agent are where the session started, not finds, so they have no reason.

import type { ReasonSet } from '../../core/interfaces/reasons'
import { reasonSet } from '../../core/lib/reasons'
import { agentRowId, worktreeId } from './ids'
import type { AutoState } from './types'

/** `Traceable.reasonsOf` of the auto tracker: `created` for the row of a proof, undefined for any other row. */
export function autoReasonsOf(data: AutoState | undefined, rowId: string): ReasonSet | undefined {
  const proven =
    (data?.worktrees ?? []).some(w => worktreeId(w.path) === rowId) ||
    (data?.agents ?? []).some(a => agentRowId(a.id) === rowId)
  return proven ? reasonSet('created') : undefined
}
