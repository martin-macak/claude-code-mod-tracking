// The turns of the agent rows (issue #133, P1b of #69). An agent proof is stamped with the turn of the `agent.spawn` that made
// it, and with the turn of a later spawn that named it again (a resumed agent). `Traceable.turnsOf` hands the stamps to the
// pane. Only the rows of agent proofs have turns: the master agent, the workflow run rows and the worktrees have none. The
// rules of the stamps are in `core/lib/turn-span.ts`.

import type { TurnSpan } from '../../core/interfaces/turns'
import { reasonSet } from '../../core/lib/reasons'
import { type RowVisit, turnSpan } from '../../core/lib/turn-span'
import { agentRowId } from './ids'
import type { AgentProof, AutoState } from './types'

/** `Traceable.turnsOf` of the auto tracker: the first and the last turn of the row `ag:<id>` of an agent proof, or undefined. */
export function autoTurnsOf(data: AutoState | undefined, rowId: string): TurnSpan | undefined {
  const proof = data?.agents.find(a => agentRowId(a.id) === rowId)
  return proof === undefined ? undefined : turnSpan(proof)
}

/** The visit of a spawn to the row of agent `id`: `held` is the proof before the spawn. An agent that a spawn makes is `created`. */
export const agentVisit = (id: string, held: AgentProof | undefined): RowVisit => ({
  id: agentRowId(id),
  category: 'agent',
  reason: reasonSet('created').strongest,
  held,
})
