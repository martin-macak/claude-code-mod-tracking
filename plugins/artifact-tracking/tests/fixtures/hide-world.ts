// The helpers of the tests that draw the agents, the worktrees and the process rows of the pane world and look at what the
// view leaves out (issue #49): the clock, the readers of a section, and the setters of the `auto` and `processes` slots.
import { NO_VIEW } from '../../core/infra/views'
import type { Json } from '../../core/interfaces/items'
import type { SectionSpec, TreeRow } from '../../core/interfaces/view'
import type { AgentProof, AgentRow } from '../../trackers/auto/types'
import type { ProcessRecord } from '../../trackers/processes/types'
import { type paneWorld, WORLD_AUTO, WORLD_SNAPSHOT } from './pane-world'

export const MIN = 60_000
export type World = Awaited<ReturnType<typeof paneWorld>>

/** The ids of the rows and of every row below them, depth first. */
export const flat = (rows: readonly TreeRow[]): string[] => rows.flatMap(r => [r.id, ...flat(r.children ?? [])])
export const find = (rows: readonly TreeRow[], id: string): TreeRow | undefined => {
  for (const r of rows) {
    const found = r.id === id ? r : find(r.children ?? [], id)
    if (found) return found
  }
  return undefined
}
/** The ids of the top-level rows of a section. */
export const ids = (s: SectionSpec): string[] => s.rows.map(r => r.id)

/** The section `id` as the pane draws it now. */
export const draw = async (t: World, id: string): Promise<SectionSpec> => {
  const s = (await t.m.paneData(t.w.ports, NO_VIEW)).find(x => x.id === id)
  if (!s) throw new Error(`no section ${id}`)
  return s
}

export const proof = (id: string, f: Partial<AgentProof> = {}): AgentProof => ({
  id,
  kind: 'subagent',
  label: id,
  spawnedAt: 1,
  ...f,
})
/** Sets the `auto` slot to the world's, with these proofs and, when given, these rows in the snapshot. */
export const setAgents = (t: World, proofs: AgentProof[], agents?: AgentRow[]) =>
  t.w.state.set('auto', {
    ...WORLD_AUTO,
    agents: proofs,
    ...(agents ? { snapshot: { ...WORLD_SNAPSHOT, agents } } : {}),
  } as unknown as Json)

export const proc = (id: string, state: ProcessRecord['state'], f: Partial<ProcessRecord> = {}): ProcessRecord => ({
  id,
  kind: 'background-task',
  name: id,
  state,
  firstSeen: 3,
  lastSeen: 3,
  ...f,
})
export const setProcesses = (t: World, rows: ProcessRecord[]) => t.w.state.set('processes', rows as unknown as Json)
/** The processes note is the docker issue in the world; a test that wants the count removes the issue. */
export const noDockerIssue = (t: World) => t.m.facts.publish('processes.ui', { breaker: 'closed' })
