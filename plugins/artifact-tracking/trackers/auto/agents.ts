// trackAgents: rows for the master loop, subagents and workflow agents of this run (spec A5 to A7, 8.2).
// Pure and synchronous. Rows come only from `agent.spawn` records; a list entry with no record is ignored.

import {
  agentWorktreePath,
  basename,
  findByPath,
  locate,
  normPath,
  workflowWorktreePath,
} from '../../core/lib/porcelain'
import { AUTO_DEFAULTS } from './config'
import { agentRowId, MASTER_ID } from './ids'
import { type AgentPatch, patchRecord } from './ledger'
import type { AgentProof, AgentRow, AgentRowState, AutoState, GitWorktree, LiveAgent, WorktreeProof } from './types'

/** The one A7 table: an `AgentStatus` word to a row state. An unknown word is running (K11). */
export function classifyStatus(status: string, teammate: boolean): AgentRowState {
  switch (status) {
    case 'waiting':
      return 'waiting'
    case 'idle':
      return teammate ? 'waiting' : 'ended'
    case 'completed':
      return 'ended'
    case 'failed':
    case 'killed':
      return 'failed'
    default:
      return 'running'
  }
}

/** Status, listed, endedAt and failed per A7. Workflow agents end by the idle bound. */
function refreshAgent(a: AgentProof, live: readonly LiveAgent[] | null, at: number, idleMs: number): AgentProof {
  if (a.kind === 'workflow') {
    const idle = at - (a.lastActiveAt ?? a.spawnedAt) > idleMs
    return a.endedAt === undefined && idle ? patchRecord(a, { endedAt: at, stale: true }) : a
  }
  if (live === null) return a
  const l = live.find(x => x.id === a.id)
  if (!l) return a.listed && a.endedAt === undefined ? patchRecord(a, { endedAt: at }) : a
  const teammate = l.teammateId !== undefined
  const st = classifyStatus(l.status, teammate)
  const patch: AgentPatch = { status: l.status, listed: true, teammate: teammate ? true : undefined }
  if (st === 'running' || st === 'waiting') {
    patch.endedAt = undefined
    patch.failed = undefined
  } else {
    patch.endedAt = a.endedAt ?? at
    patch.failed = st === 'failed' ? true : undefined
  }
  return patchRecord(a, patch)
}

/** `path`: the path of the record that git lists, for a live location. A dimmed location (the folder is gone) has none. */
type Loc = { name?: string; branch?: string; live: boolean; path?: string }

const fromRecord = (r: GitWorktree): Loc => ({
  name: basename(r.path),
  ...(r.branch ? { branch: r.branch } : {}),
  live: true,
  path: r.path,
})

function rowState(a: AgentProof): AgentRowState {
  if (a.endedAt !== undefined) return a.failed ? 'failed' : 'ended'
  return classifyStatus(a.status ?? 'running', a.teammate === true)
}

/**
 * Where each agent works (A6): one rule set, in spawn order so a parent resolves before its child, and the first match wins.
 * `masterLoc` is the place of an agent that has no clue of its own and no parent in the list. `trackAgents` draws the rows
 * from it, and `/track clean` asks it whether an agent works in a tree (`agentWorksIn`), so the two never disagree.
 * `proven` collects the workflow paths that this call found in porcelain, to write them to their agents.
 */
function agentLocations(
  agents: readonly AgentProof[],
  worktrees: readonly WorktreeProof[],
  list: readonly GitWorktree[],
  masterLoc: Loc | undefined,
): { locs: Map<string, Loc | undefined>; proven: Map<string, string> } {
  const main = list[0] ? normPath(list[0].path) : undefined
  const proofBranch = (path: string): string | undefined => worktrees.find(w => w.path === normPath(path))?.branch
  const locs = new Map<string, Loc | undefined>()
  // A resume restarts `agentIndex`, so two agents of one run can share a convention path. The first agent that holds a
  // path keeps it, and `proven` collects the paths this round found, to write them to their agents.
  const held = new Set(agents.flatMap(a => (a.worktreePath ? [normPath(a.worktreePath)] : [])))
  const proven = new Map<string, string>()
  for (const a of agents) {
    let loc: Loc | undefined
    if (a.worktreePath) {
      const r = findByPath(list, a.worktreePath)
      loc = r
        ? fromRecord(r)
        : { name: basename(a.worktreePath), branch: a.branch ?? proofBranch(a.worktreePath), live: false }
    }
    if (!loc && main) {
      const conv = agentWorktreePath(main, a.id)
      const r = findByPath(list, conv)
      if (r) loc = fromRecord(r)
      else if (worktrees.some(w => w.path === conv))
        loc = { name: basename(conv), branch: a.branch ?? proofBranch(conv), live: false }
    }
    // A workflow agent that runs in a worktree of its own: `<runId>-<agentIndex>`. A path in porcelain is proof, so keep
    // it on the agent. The exact-path step above then owns it: a removed worktree stays (dimmed), and a later worktree
    // that checks out the same branch does not take it.
    if (!loc && main && a.workflow) {
      const wf = workflowWorktreePath(main, a.workflow.runId, a.workflow.agentIndex)
      const r = held.has(wf) ? undefined : findByPath(list, wf)
      if (r) {
        loc = fromRecord(r)
        held.add(wf)
        proven.set(a.id, wf)
      }
    }
    if (!loc && a.branch) {
      const r = list.find(x => x.branch === a.branch)
      if (r) loc = fromRecord(r)
    }
    if (!loc && a.cwd) {
      const r = locate(list, a.cwd)
      if (r) loc = fromRecord(r)
    }
    if (!loc) loc = a.parentId !== undefined && locs.has(a.parentId) ? locs.get(a.parentId) : masterLoc
    locs.set(a.id, loc)
  }
  return { locs, proven }
}

/**
 * Whether an agent that has not ended works in the live record `rec` of `list`, where the pane draws it (`agentLocations`):
 * its worktree path, the convention path of its id, its run and index, its branch, its spawn cwd, and else the place of its
 * parent. `/track clean` asks it for each tree it is about to remove (issue #123). `masterCwd` is the folder of the session,
 * the place of an agent with no clue of its own.
 */
export function agentWorksIn(
  s: Pick<AutoState, 'agents' | 'worktrees'>,
  list: readonly GitWorktree[],
  masterCwd: string,
  rec: GitWorktree,
): boolean {
  const masterRec = locate(list, masterCwd)
  const { locs } = agentLocations(s.agents, s.worktrees, list, masterRec ? fromRecord(masterRec) : undefined)
  const here = normPath(rec.path)
  return s.agents.some(a => {
    const at = locs.get(a.id)?.path
    return a.endedAt === undefined && at !== undefined && normPath(at) === here
  })
}

/** `idleMs` is `workflowIdleMs`: a workflow agent with no sign of life for that long ends as stale. */
export function trackAgents(
  s: AutoState,
  live: readonly LiveAgent[] | null,
  list: readonly GitWorktree[],
  masterCwd: string | null,
  at: number,
  idleMs: number = AUTO_DEFAULTS.workflowIdleMs,
): { state: AutoState; rows: AgentRow[] } {
  // 1. Status and end per agent.
  let changed = false
  const agents = s.agents.map(a => {
    const next = refreshAgent(a, live, at, idleMs)
    if (next !== a) changed = true
    return next
  })
  const state = changed ? { ...s, agents } : s

  // 2. The master location. A failed cwd read keeps the last drawn location.
  const prevMaster = s.snapshot?.agents.find(r => r.id === MASTER_ID)
  const masterRec = masterCwd === null ? undefined : locate(list, masterCwd)
  const masterLoc: Loc | undefined =
    masterCwd === null && prevMaster
      ? { name: prevMaster.worktree, branch: prevMaster.branch, live: prevMaster.worktreeLive }
      : masterRec
        ? fromRecord(masterRec)
        : undefined

  // 3. Locations (A6).
  const { locs, proven } = agentLocations(agents, s.worktrees, list, masterLoc)

  // 4. Rows: master first, then a depth-first tree by spawnedAt. A dismissed agent hides its subtree.
  const dismissed = new Set(s.dismissed)
  const known = new Set(agents.map(a => a.id))
  const children = new Map<string, AgentProof[]>()
  agents
    .map((a, i) => ({ a, i }))
    .sort((x, y) => x.a.spawnedAt - y.a.spawnedAt || x.i - y.i)
    .forEach(({ a }) => {
      const key = a.parentId !== undefined && known.has(a.parentId) ? a.parentId : 'master'
      children.set(key, [...(children.get(key) ?? []), a])
    })
  const rows: AgentRow[] = [
    {
      id: MASTER_ID,
      kind: 'master',
      label: 'this session',
      depth: 0,
      ...(masterLoc?.branch !== undefined ? { branch: masterLoc.branch } : {}),
      ...(masterLoc?.name !== undefined ? { worktree: masterLoc.name } : {}),
      worktreeLive: masterLoc?.live ?? false,
      state: 'running',
    },
  ]
  const walk = (parent: string, depth: number): void => {
    for (const a of children.get(parent) ?? []) {
      if (dismissed.has(agentRowId(a.id))) continue
      const loc = locs.get(a.id)
      const branch = loc?.branch ?? a.branch
      rows.push({
        id: agentRowId(a.id),
        kind: a.kind,
        label: a.label,
        depth,
        ...(branch !== undefined ? { branch } : {}),
        ...(loc?.name !== undefined ? { worktree: loc.name } : {}),
        worktreeLive: loc?.live ?? false,
        state: rowState(a),
        ...(a.workflow ? { workflow: a.workflow } : {}),
      })
      walk(a.id, Math.min(depth + 1, 3))
    }
  }
  walk('master', 1)
  if (proven.size === 0) return { state, rows }
  const withPaths = agents.map(a => (proven.has(a.id) ? patchRecord(a, { worktreePath: proven.get(a.id) }) : a))
  return { state: { ...state, agents: withPaths }, rows }
}
