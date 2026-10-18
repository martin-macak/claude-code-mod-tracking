// The ledger: root pin, worktree proofs and agent records of this run (spec A3 to A7, A18).
// Pure functions over AutoState. A call that changes nothing returns its input object (A22).

import { normPath } from '../../core/lib/porcelain'
import type {
  AgentProof,
  AgentResultFacts,
  AutoState,
  EnterFacts,
  SpawnFacts,
  TurnCompleteReason,
  WorktreeProof,
} from '../../hooks/contracts'
import { AUTO_DEFAULTS } from './config'

/** A bump of `lastActiveAt` younger than this is skipped, so a busy agent does not write `auto` per command. */
const ACTIVITY_MIN_MS = 60_000
const HELD = new Set(['pending', 'running', 'waiting'])

export function emptyAuto(): AutoState {
  return { root: null, worktrees: [], agents: [], dismissed: [], snapshot: null }
}

/** A3. Pins `cwd` at the first session.start of the run. Later calls change nothing. */
export function pinRoot(s: AutoState, cwd: string, at: number): AutoState {
  return s.root ? s : { ...s, root: { cwd, at } }
}

/** Sets the resolved toplevel once. `null`: not a git repository. */
export function setRootTop(s: AutoState, top: string | null): AutoState {
  if (!s.root || s.root.top !== undefined) return s
  return { ...s, root: { ...s.root, top } }
}

function isRootPath(s: AutoState, path: string): boolean {
  if (!s.root) return false
  return path === normPath(s.root.cwd) || (typeof s.root.top === 'string' && path === normPath(s.root.top))
}

/**
 * Adds a proof for `path`, or updates the branch of the one that exists. The root path never becomes a proof. The list
 * keeps the newest `maxProofs`.
 */
function withProof(
  s: AutoState,
  path: string,
  make: () => WorktreeProof,
  branch: string | undefined,
  maxProofs: number,
): AutoState {
  if (isRootPath(s, path)) return s
  const i = s.worktrees.findIndex(w => w.path === path)
  if (i < 0) return { ...s, worktrees: [...s.worktrees, make()].slice(-maxProofs) }
  const w = s.worktrees[i]!
  if (branch === undefined || w.branch === branch) return s
  const worktrees = s.worktrees.slice()
  worktrees[i] = { ...w, branch }
  return { ...s, worktrees }
}

/** Proof 1 (A4): an EnterWorktree result path. */
export function recordEnter(
  s: AutoState,
  ev: EnterFacts,
  at: number,
  maxProofs: number = AUTO_DEFAULTS.maxProofs,
): AutoState {
  const path = normPath(ev.path)
  return withProof(
    s,
    path,
    () => {
      const p: WorktreeProof = { path, origin: 'enter', provenAt: at }
      if (ev.agentId !== undefined) p.owner = ev.agentId
      if (ev.branch !== undefined) p.branch = ev.branch
      return p
    },
    ev.branch,
    maxProofs,
  )
}

export type AgentPatch = { [K in keyof AgentProof]?: AgentProof[K] | undefined }

/** A copy of `a` with the patch (undefined removes a key). No change returns `a` itself. */
export function patchRecord(a: AgentProof, patch: AgentPatch): AgentProof {
  const next: Record<string, unknown> = { ...a }
  let changed = false
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) {
      if (k in next) {
        delete next[k]
        changed = true
      }
    } else if (next[k] !== v) {
      next[k] = v
      changed = true
    }
  }
  return changed ? (next as AgentProof) : a
}

/** Replaces agent `i` with its patched copy. No change returns `s`. */
function patchAgent(s: AutoState, i: number, patch: AgentPatch): AutoState {
  const cur = s.agents[i]!
  const next = patchRecord(cur, patch)
  if (next === cur) return s
  const agents = s.agents.slice()
  agents[i] = next
  return { ...s, agents }
}

const indexOfAgent = (s: AutoState, id: string): number => s.agents.findIndex(a => a.id === id)

/**
 * Records an `agent.spawn`. A second spawn for a known id (a retry) keeps the first record (A5).
 * The proof's cwd is `ev.cwd`, else the parent's recorded cwd for a nested child, else `sessionCwd` (A6).
 */
export function recordSpawn(
  s: AutoState,
  ev: SpawnFacts,
  at: number,
  sessionCwd?: string,
  maxAgents: number = AUTO_DEFAULTS.maxAgents,
): AutoState {
  if (indexOfAgent(s, ev.agentId) >= 0) return s
  const parent = ev.parentAgentId === undefined ? undefined : s.agents.find(a => a.id === ev.parentAgentId)
  const cwd = ev.cwd ?? (ev.parentAgentId === undefined ? sessionCwd : parent?.cwd)
  const a: AgentProof = {
    id: ev.agentId,
    kind: ev.workflow ? 'workflow' : 'subagent',
    label: ev.name || ev.description || ev.subagentType,
    spawnedAt: at,
  }
  if (ev.parentAgentId !== undefined) a.parentId = ev.parentAgentId
  if (ev.workflow) a.workflow = { runId: ev.workflow.runId, agentIndex: ev.workflow.agentIndex }
  if (cwd !== undefined) a.cwd = cwd
  return { ...s, agents: [...s.agents, a].slice(-maxAgents) }
}

/**
 * A sign of life (A7): sets `lastActiveAt` of a workflow agent and clears a stale end.
 * Returns `s` for an unknown id, a subagent (the list rules its end), an agent that an event ended,
 * and a `lastActiveAt` under 60 s old.
 */
export function recordActivity(s: AutoState, agentId: string, at: number): AutoState {
  const i = indexOfAgent(s, agentId)
  if (i < 0) return s
  const a = s.agents[i]!
  if (a.kind !== 'workflow') return s
  if (a.endedAt !== undefined && !a.stale) return s
  if (!a.stale && at - (a.lastActiveAt ?? a.spawnedAt) < ACTIVITY_MIN_MS) return s
  return patchAgent(s, i, { lastActiveAt: at, endedAt: undefined, stale: undefined })
}

/** Proof 2 (A4): the exact `worktreePath` of an Agent result. Also sets the agent's path and branch. */
export function recordAgentResult(
  s: AutoState,
  ev: AgentResultFacts,
  at: number,
  maxProofs: number = AUTO_DEFAULTS.maxProofs,
): AutoState {
  if (ev.worktreePath === undefined) return s
  const path = normPath(ev.worktreePath)
  if (isRootPath(s, path)) return s
  let next = withProof(
    s,
    path,
    () => {
      const p: WorktreeProof = { path, origin: 'agent', owner: ev.agentId, provenAt: at }
      if (ev.worktreeBranch !== undefined) p.branch = ev.worktreeBranch
      return p
    },
    ev.worktreeBranch,
    maxProofs,
  )
  const i = indexOfAgent(next, ev.agentId)
  if (i >= 0) {
    const patch: AgentPatch = { worktreePath: path }
    if (ev.worktreeBranch !== undefined) patch.branch = ev.worktreeBranch
    next = patchAgent(next, i, patch)
  }
  return next
}

/** The agent's own Bash `gitOperation.commit.branch` or `push.branch`. */
export function recordAgentBranch(s: AutoState, agentId: string, branch: string): AutoState {
  const i = indexOfAgent(s, agentId)
  return i < 0 ? s : patchAgent(s, i, { branch })
}

/** The list holds a subagent while it says pending, running, waiting, or idle for a teammate. */
function heldByList(a: AgentProof): boolean {
  if (a.kind !== 'subagent' || !a.listed || a.status === undefined) return false
  return HELD.has(a.status) || (a.status === 'idle' && a.teammate === true)
}

/** Ends an agent the list does not hold (A7). `error` and `refusal` fail it. Unknown ids: returns `s`. */
export function recordTurnEnd(s: AutoState, agentId: string, reason: TurnCompleteReason, at: number): AutoState {
  const i = indexOfAgent(s, agentId)
  if (i < 0) return s
  const a = s.agents[i]!
  if (a.endedAt !== undefined && !a.stale) return s
  if (heldByList(a)) return s
  const failed = reason === 'error' || reason === 'refusal'
  return patchAgent(s, i, { endedAt: at, failed: failed ? true : undefined, stale: undefined })
}

/**
 * /clear and reload (A18). `cur` is the state copy, `held` the module copy.
 * Returns `cur` whenever `cur.root` is set. Returns `held` only when `cur` has no root (after /clear).
 * Else an empty state.
 */
export function carryAuto(held: AutoState | undefined, cur: AutoState | undefined): AutoState {
  if (cur?.root) return cur
  if (held?.root) return held
  return cur ?? emptyAuto()
}
