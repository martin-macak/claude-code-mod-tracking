// The turns of the agent and worktree rows (issue #133, P1b of #69; issue #205). An agent proof is stamped with the turn of the
// `agent.spawn` that made it, and with the turn of a later spawn that named it again (a resumed agent). A worktree proof is
// stamped with the turn of the `EnterWorktree` or the completed `Agent` result that proved it, and with the turn of a later
// event that named it again (`EnterWorktree`, `ExitWorktree`, an `Agent` result). A round has no turn: it stamps nothing.
// `Traceable.turnsOf` hands the stamps to the pane. The rows of agent proofs have turns, and so has a workflow run row
// `ag:wf:<runId>` (issue #203): it has no record, so its turns are the span of the stamps of its agents. The master agent and
// the root worktree have none, and a worktree that only a round found has none until an event names it. The rules of the
// stamps are in `core/lib/turn-span.ts`.

import type { Sightings, TurnSpan } from '../../core/interfaces/turns'
import { normPath } from '../../core/lib/porcelain'
import { reasonSet } from '../../core/lib/reasons'
import { type RowVisit, rowSightings, turnSpan } from '../../core/lib/turn-span'
import { agentRowId, workflowRowId, worktreeId } from './ids'
import type { AgentProof, AutoState, SpawnFacts, WorktreeProof } from './types'

/** The agents of workflow run `runId`: one rule for the visit of a spawn and for the turns of the run row. */
export const agentsOfRun = (agents: readonly AgentProof[], runId: string): AgentProof[] =>
  agents.filter(a => a.workflow?.runId === runId)

const RUN_ROW_PREFIX = workflowRowId('')

/**
 * `Traceable.turnsOf` of the auto tracker: the first and the last turn of the row `ag:<id>` of an agent proof, of the row
 * `wt:<path>` of a worktree proof, or of the run row `ag:wf:<runId>` (the span of the stamps of the agents of that run), or
 * undefined.
 */
export function autoTurnsOf(data: AutoState | undefined, rowId: string): TurnSpan | undefined {
  if (data === undefined) return undefined
  const tree = data.worktrees.find(w => worktreeId(w.path) === rowId)
  if (tree !== undefined) return turnSpan(tree)
  const proof = data.agents.find(a => agentRowId(a.id) === rowId)
  if (proof !== undefined) return turnSpan(proof)
  return rowId.startsWith(RUN_ROW_PREFIX)
    ? turnSpan(...agentsOfRun(data.agents, rowId.slice(RUN_ROW_PREFIX.length)))
    : undefined
}

/** The visit of a spawn to the row of agent `id`: `held` is the proof before the spawn. An agent that a spawn makes is `created`. */
export const agentVisit = (id: string, held: AgentProof | undefined): RowVisit => ({
  id: agentRowId(id),
  category: 'agent',
  reason: reasonSet('created').strongest,
  held,
})

/**
 * The visit of a spawn to the row of workflow run `runId` (issue #203): `heldRun` are the agents of the run before the spawn. A
 * run is one entry of its turn whatever its size, or a run of many agents would fill the 50 entries of the turn. No agent held:
 * the run is `new`. An agent held: the run is a known row, with the span of the stamps of its agents. The key is that of the run
 * row, so the entry reads as the row when the pane draws it, and as `workflow ag:wf:<runId>` when it does not (a run that still
 * runs, a run of one agent, `foldWorkflows` off, a run past its TTL).
 */
export function runVisit(runId: string, heldRun: readonly AgentProof[]): RowVisit {
  const span = turnSpan(...heldRun)
  return {
    id: workflowRowId(runId),
    category: 'workflow',
    reason: reasonSet('created').strongest,
    // An agent that a spawn with no turn running made has no stamp: the run is known, of no turn, so it reads `seen again` in
    // the first turn that owns a spawn. A plain agent resumed in a turn reads the same (`agentVisit`; G5 of the study of #203).
    held: heldRun.length === 0 ? undefined : span === undefined ? {} : { firstTurn: span.first, lastTurn: span.last },
  }
}

/**
 * The visit of an event that names the worktree at `path` (issue #205): `held` is the proof before the event. A worktree that
 * an event proves or names is `created`, as `autoReasonsOf` says for a proof. A proof that no turn stamped (a round found it
 * by the path convention, or an event with no turn running made it) counts as no row held: the turn of the event is its
 * first, so the turn lists it `new`. This is not the rule of an agent proof that no turn stamped (`agentVisit`, `runVisit`):
 * that one reads `seen again`, by #203.
 */
const worktreeVisit = (path: string, held: WorktreeProof | undefined): RowVisit => ({
  id: worktreeId(path),
  category: 'worktree',
  reason: reasonSet('created').strongest,
  held: held?.firstTurn === undefined && held?.lastTurn === undefined ? undefined : held,
})

/**
 * The sightings of an event in `turn` that names the worktree at `path` (issue #205): `before` and `after` are the state around
 * the write of the event. No proof after the event (the root, a path no proof holds): no entry.
 */
export function worktreeSightings(turn: number, path: string, before: AutoState, after: AutoState): Sightings {
  const p = normPath(path)
  if (!after.worktrees.some(w => w.path === p)) return rowSightings(turn, [])
  return rowSightings(turn, [
    worktreeVisit(
      p,
      before.worktrees.find(w => w.path === p),
    ),
  ])
}

/** The sightings of one spawn in `turn`: `before` is the state before `recordSpawn`. A workflow agent is the entry of its run. */
export function spawnSightings(turn: number, f: SpawnFacts, before: AutoState): Sightings {
  const known = before.agents.find(a => a.id === f.agentId)
  const visit =
    f.workflow === undefined
      ? agentVisit(f.agentId, known)
      : runVisit(f.workflow.runId, agentsOfRun(before.agents, f.workflow.runId))
  return rowSightings(turn, [visit])
}
