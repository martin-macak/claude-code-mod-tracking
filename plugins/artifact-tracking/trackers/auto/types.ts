// The slot, proof and fact types of the auto tracker. Moved from the shared contract in plan L5, Task 1.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.13.

/** `workflow`: the run-prefix proof (A4 proof 4). */
export type WorktreeOrigin = 'enter' | 'agent' | 'workflow'

/** A4: proof that this run made a worktree. Kept for the run. Row id: `wt:<path>`. */
export type WorktreeProof = {
  /** Absolute path as git prints it. */
  path: string
  origin: WorktreeOrigin
  /** Agent id (enter from a subagent, agent). */
  owner?: string
  /** Workflow run id (origin `workflow`). */
  runId?: string
  /** Last branch known: from the event, then from each round. */
  branch?: string
  provenAt: number
  /** Set when a round first matches it in porcelain, and again when it is matched after it was `removed`. Absent: never seen live. */
  seenAt?: number
}

export type AgentKind = 'subagent' | 'workflow'

/** A5, A6, A7: one agent of this session, recorded from events. Row id: `ag:<id>`. */
export type AgentProof = {
  id: string
  kind: AgentKind
  /** `name`, else `description`, else `subagentType`. */
  label: string
  /** The loop that spawned it. Absent: the main loop. */
  parentId?: string
  workflow?: { runId: string; agentIndex: number }
  /** Spawn cwd: `agent.spawn.cwd`, else the parent's at spawn time (A6). */
  cwd?: string
  /** Exact path from the Agent tool result. */
  worktreePath?: string
  /** From the agent's own Bash `gitOperation.commit.branch` or `push.branch`, or the Agent result. */
  branch?: string
  /** Last status of the engine's agent list (AgentStatus). Absent for workflow agents. */
  status?: string
  teammate?: boolean
  /** True once the engine's agent list listed it. */
  listed?: boolean
  spawnedAt: number
  /** Last sign of life (A7): a hooked tool call or a turn.complete. Absent: `spawnedAt`. */
  lastActiveAt?: number
  endedAt?: number
  failed?: boolean
  /** Ended by the workflow idle bound, not by an event (A7). */
  stale?: boolean
}

export type Health = { ok: boolean; at: number; error?: string }

/** A prunable record (directory gone) is `removed` too (A23). */
export type WorktreeRowState = 'live' | 'removed'
export type WorktreeRow = {
  /** `wt:<path>`. */
  id: string
  path: string
  /** Basename of the path. */
  name: string
  branch?: string
  detached: boolean
  state: WorktreeRowState
  depth: 0 | 1
}

export type AgentRowState = 'running' | 'waiting' | 'ended' | 'failed'
export type AgentRow = {
  /** `ag:master` or `ag:<id>`. */
  id: string
  kind: 'master' | AgentKind
  label: string
  depth: number
  branch?: string
  /** Basename of the worktree. */
  worktree?: string
  worktreeLive: boolean
  state: AgentRowState
  workflow?: { runId: string; agentIndex: number }
}

/**
 * What the last round computed. Derived: never written to the plugin store. Written only when it changed (A22). The
 * pull requests are not part of it: the github tracker keeps their note and the default branch in its own slot.
 */
export type AutoSnapshot = {
  /** The round that last changed it. */
  at: number
  /** Root first, then children by provenAt. */
  worktrees: WorktreeRow[]
  /** Master first, then a depth-first tree by spawnedAt. */
  agents: AgentRow[]
  /** Branches the PR step polls, root first. */
  branches: string[]
  /** Tracked branches over the cap, not polled. */
  overflow: number
  git: Health
  agentList: Health
}

export type AutoState = {
  /** A3. null until the first session.start of the run. `top` undefined: not resolved yet; null: not a git repo. */
  root: { cwd: string; at: number; top?: string | null } | null
  worktrees: WorktreeProof[]
  agents: AgentProof[]
  /** A14: row ids (`wt:`, `ag:`) and item keys. */
  dismissed: string[]
  snapshot: AutoSnapshot | null
}

export type AutoReason = 'start' | 'tick' | 'worktree' | 'agent' | 'git' | 'pr-event' | 'manual'

/**
 * The fact `auto.branches`: the branches of this run after a round, for the readers that cannot wait (the PR lane, the
 * priority rule R7). A new round always gives a new value, because `seq` moves.
 */
export type BranchesFact = {
  /** The number of rounds this load has run. A fact published at init repeats the last one. A restore (a switch) counts as a publish and moves it. */
  seq: number
  /** What started the round. Empty for a fact published at init or after a restore. */
  reasons: readonly string[]
  /** The branch of the master agent. Absent: a detached HEAD, or not known yet. */
  current?: string
  /** The branches the PR step polls, root first. */
  branches: readonly string[]
  /** Tracked branches over the cap, not polled. */
  overflow: number
}

export type EnterFacts = { path: string; branch?: string; agentId?: string }
export type AgentResultFacts = { agentId: string; worktreePath?: string; worktreeBranch?: string }
export type BashFacts = { agentId?: string; branch?: string; kick?: 'pr-event' | 'git' }
/** Copied from the `agent.spawn` input and its `next(e)` answer. */
export type SpawnFacts = {
  agentId: string
  name?: string
  description: string
  subagentType: string
  parentAgentId?: string
  workflow?: { runId: string; agentIndex: number }
  /** `agent.spawn` cwd. Absent: the parent's at spawn time (A6). */
  cwd?: string
}

export type GitWorktree = {
  path: string
  head?: string
  /** Without `refs/heads/`. Absent when detached or bare. */
  branch?: string
  detached: boolean
  bare: boolean
  /** Lock reason ('' when locked with none). */
  locked?: string
  prunable?: string
}

/** The part of AgentInfo the round reads. */
export type LiveAgent = { id: string; status: string; teammateId?: string }
