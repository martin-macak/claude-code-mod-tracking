// State contract and record types for the artifact-tracking mod.
// `claude plugin validate` reads the literal shape of PluginState, so record types live here.
// Spec: docs/superpowers/specs/2026-10-10-artifact-tracking-design.md

// ---------------------------------------------------------------- link scanner (copied from link-capture)

export type Via = 'inline' | 'autolink' | 'bare' | 'issue-ref' | 'reference' | 'image' | 'mailto' | 'osc8'

export type Captured = {
  url: string
  label?: string
  via: Via
  kind: 'link' | 'non-clickable'
  web: boolean
  door: string
  uuid: string
  agentId?: string
  n: number
}

// ---------------------------------------------------------------- tracked items

export type Category = 'jira' | 'github' | 'web'
/** Where a reference was seen. `auto`: a PR on a tracked branch. `pr-body`: named in a discovered PR body. */
export type Source = 'prompt' | 'response' | 'tool' | 'auto' | 'pr-body'

/** `not-found`: the tool says the item does not exist (or no permission). `failed`: the last refresh failed. */
export type ItemError = { kind: 'not-found' | 'failed'; message: string; at: number }

export type GitHubType = 'issue' | 'pr' | 'unknown'
export type GitHubState = 'open' | 'closed' | 'merged'
export type Checks = 'success' | 'failure' | 'pending' | 'none'

export type GitHubFields = {
  host: string
  /** Absent while a bare `#N` has no known repo. */
  owner?: string
  repo?: string
  number: number
  type: GitHubType
  title?: string
  state?: GitHubState
  /** GraphQL `stateReason`, e.g. COMPLETED, NOT_PLANNED, DUPLICATE. Issues only. */
  stateReason?: string
  isDraft?: boolean
  /** GraphQL `reviewDecision`, e.g. APPROVED, REVIEW_REQUIRED. PRs only. */
  reviewDecision?: string
  checks?: Checks
  /** PR branches. Set by discovery only (A8). */
  headRefName?: string
  baseRefName?: string
}

export type JiraNode = {
  key: string
  summary: string
  issueType: string
  status: string
  /** Jira status category key: `new`, `indeterminate` or `done`. */
  statusCategory?: string
  children: JiraNode[]
}

export type JiraFields = {
  /** Host of the URL, e.g. `acme.atlassian.net`. */
  site: string
  issueKey: string
  /** True when acli can never refresh it: a non-Cloud host. A non-active Cloud site is decided at refresh time. */
  trackOnly: boolean
  summary?: string
  issueType?: string
  status?: string
  statusCategory?: string
  children: JiraNode[]
}

export type ItemRecordBase = {
  /** Dedupe key. github: `gh:<host>/<owner>/<repo>#<n>` or `gh:?#<n>`; jira: `jira:<site>/<KEY>`; web: `web:<url>`. */
  key: string
  url: string
  /** Display text: Markdown label, title, or host + path. */
  label: string
  sources: Source[]
  firstSeen: number
  lastSeen: number
  seenCount: number
  refreshedAt?: number
  error?: ItemError
  /** Keys of discovered PRs whose body names this item (A9). Absent when none. */
  via?: string[]
}

export type GitHubRecord = ItemRecordBase & { category: 'github' } & GitHubFields
export type JiraRecord = ItemRecordBase & { category: 'jira' } & JiraFields
export type WebRecord = ItemRecordBase & { category: 'web' }
export type ItemRecord = GitHubRecord | JiraRecord | WebRecord

// ---------------------------------------------------------------- tracked processes

export type ProcessKind =
  | 'background-task'
  | 'monitor'
  | 'docker-container'
  | 'docker-compose'
  | 'tmux'
  | 'screen'
  | 'detached-process'

export type ProcessState = 'running' | 'up' | 'completed' | 'failed' | 'killed' | 'exited' | 'unhealthy'

export type ProcessRecord = {
  /** Dedupe key. */
  id: string
  kind: ProcessKind
  /** Command, container, compose project or session name. */
  name: string
  state: ProcessState
  firstSeen: number
  lastSeen: number
  /** For task-backed rows. */
  taskId?: string
  toolUseId?: string
  /** Docker container id for docker rows. */
  containerId?: string
  /** Docker compose project for compose rows. */
  project?: string
  /** Pid for detached process rows. */
  pid?: number
  /** Command fingerprint to defend against PID reuse. */
  fingerprint?: string
}

export type ProcessUiState = {
  breaker: BreakerState
  openUntil?: number
  dockerIssue?: string
}

// ---------------------------------------------------------------- tools

export type ToolName = 'gh' | 'acli'
export type BreakerState = 'closed' | 'open' | 'half-open'

export type ToolStatus = {
  name: ToolName
  /** null: not probed yet. */
  available: boolean | null
  version?: string
  /** null: unknown. false: a call proved the tool is not logged in. */
  loggedIn: boolean | null
  breaker: BreakerState
  /** When an open breaker may let one probe call through (epoch ms). */
  openUntil?: number
  lastError?: string
  lastRunAt?: number
  /** acli only: host of the active site, e.g. `acme.atlassian.net`. */
  site?: string
}

export type UiState = {
  /** Keys of folded tree rows (item keys or Jira node ids). */
  folded: string[]
  paneOpen: boolean
}

// ---------------------------------------------------------------- auto tracking (spec 6.2)

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
  /** Last `$.agent.list()` status (AgentStatus). Absent for workflow agents. */
  status?: string
  teammate?: boolean
  /** True once `$.agent.list()` listed it. */
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

export type PrSkip = 'no-repo' | 'no-gh' | 'not-logged-in' | 'paused' | 'host-not-authed' | 'no-branches'

/** What the last round computed. Derived: never written to $.store. Written only when it changed (A22). */
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
  /** `untracked`: auto-only items not added over `maxAutoItems` (A11). */
  prs: { at?: number; ok: boolean; skipped?: PrSkip; error?: string; untracked?: number }
  defaultBranch?: string
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

declare module 'claude-code' {
  interface PluginState {
    'artifact-tracking': {
      items: ItemRecord[]
      processes: ProcessRecord[]
      processUi: ProcessUiState
      tools: { gh: ToolStatus; acli: ToolStatus }
      ui: UiState
      auto: AutoState
    }
  }
}
