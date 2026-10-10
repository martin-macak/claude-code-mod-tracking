// Shared contracts between the modules of the mod. No `$` here: only register.tsx touches it.
// Spec: docs/superpowers/specs/2026-10-10-artifact-tracking-design.md

import type { TurnCompleteReason } from 'claude-code'
import type {
  Category,
  Checks,
  GitHubFields,
  GitHubState,
  ItemError,
  ItemRecord,
  JiraFields,
  PrSkip,
  Source,
  ToolName,
  ToolStatus,
} from '../types'

export type * from '../types'

// ---------------------------------------------------------------- process runner

export type RunInit = { timeoutMs?: number; cwd?: string }

export type RunResult = {
  exitCode: number
  stdout: string
  stderr: string
  isStdoutTruncated?: boolean
  isStderrTruncated?: boolean
}

/**
 * Runs one command by argument vector, no shell. In production a closure over `$.process.run`.
 * Rejects when the command cannot start (not on PATH) or runs past its timeout.
 * A non-zero exit resolves.
 */
export type Runner = (argv: readonly string[], init?: RunInit) => Promise<RunResult>

/** Epoch milliseconds. Production: `Date.now`. Tests: a fake. */
export type Now = () => number

// ---------------------------------------------------------------- references found in text

export type RepoRef = { host: string; owner: string; repo: string }

export type GitHubRef = {
  category: 'github'
  host: string
  /** Absent for a bare `#N` with no known repo. */
  owner?: string
  repo?: string
  number: number
  type: 'issue' | 'pr' | 'unknown'
  /** The URL as written, when the reference was a URL. */
  url?: string
}

export type JiraRef = {
  category: 'jira'
  site: string
  issueKey: string
  url: string
  trackOnly: boolean
}

export type WebRef = { category: 'web'; url: string; label: string }

export type Ref = GitHubRef | JiraRef | WebRef

/** `full`: every pattern (prompt, command, response rows). `urls-only`: explicit GitHub and Jira URLs (tool-result rows). */
export type ScanMode = 'full' | 'urls-only'

export type ExtractOptions = {
  mode: ScanMode
  /** Repo for bare `#N`. null or absent: bare `#N` stays unresolved. */
  defaultRepo?: RepoRef | null
  /** Hosts besides github.com whose issue and PR URLs count as GitHub (GHE hosts gh is logged in to). */
  githubHosts?: readonly string[]
  /** In conversation text, track short GitHub refs only when a keyword prefixes them and they target the current repo. */
  strictShortRefs?: boolean
}

// ---------------------------------------------------------------- what tools mutate

/** A GitHub item as GhTool sees it. GitHubItem implements it. */
export interface GitHubTarget extends GitHubFields {
  readonly key: string
  refreshedAt?: number
  error?: ItemError
}

/** A Jira item as AcliTool sees it. JiraItem implements it. */
export interface JiraTarget extends JiraFields {
  readonly key: string
  refreshedAt?: number
  error?: ItemError
}

export interface RefreshTool<T> {
  readonly name: ToolName
  /** True once the `--version` probe succeeded. False before the probe settles. */
  readonly isAvailable: boolean
  /** Available, not known to be logged out, and the breaker lets a call through. */
  canCall(now: number): boolean
  /** Refreshes the given items in place: status fields, `refreshedAt`, `error`. Never rejects. */
  refreshItems(items: T[]): Promise<void>
  /** Manual refresh: forget `loggedIn: false`, move an open breaker to half-open. */
  reset(): void
  status(): ToolStatus
}

export interface GitHubToolApi extends RefreshTool<GitHubTarget> {
  /** Cached answer of `gh auth status --hostname <host>`. undefined: not asked yet. */
  isHostAuthed(host: string): boolean | undefined
  /** Asks gh once per host and caches the answer. */
  checkHost(host: string): Promise<boolean>
  /** `gh repo view --json nameWithOwner` in the session cwd, at most once per tool instance. */
  defaultRepo(): Promise<RepoRef | null>
}

export interface JiraToolApi extends RefreshTool<JiraTarget> {
  /** Host of acli's active site. undefined: not loaded yet. null: none (not logged in). */
  readonly activeSite: string | null | undefined
  /** Runs `acli jira auth status` and caches the site. */
  loadActiveSite(): Promise<string | null>
}

export type Tools = { gh: GitHubToolApi; acli: JiraToolApi }

// ---------------------------------------------------------------- hydrated items

/** What the coordinator needs from a TrackedItem. */
export interface Refreshable {
  readonly key: string
  readonly category: Category
  canRefresh(now: number): boolean
  isDue(now: number): boolean
  refresh(): Promise<void>
  toRecord(): ItemRecord
}

export type HydratedItem =
  | (Refreshable & GitHubTarget & { readonly category: 'github' })
  | (Refreshable & JiraTarget & { readonly category: 'jira' })
  | (Refreshable & { readonly category: 'web' })

export type Sighting = { source: Source; at: number }

// ---------------------------------------------------------------- limits (spec sections 6.2, 7, 8, 10)

export const LIMITS = {
  maxItems: 500,
  keepSessions: 20,
  staleMs: 5 * 60_000,
  pendingStaleMs: 60_000,
  tickMs: 30_000,
  captureDebounceMs: 1_000,
  flushMs: 1_500,
  breakerThreshold: 3,
  breakerOpenMs: 5 * 60_000,
  toolTimeoutMs: 30_000,
  acliConcurrency: 3,
  epicChildLimit: 50,
  autoDebounceMs: 750,
  gitTimeoutMs: 5_000,
  discoveryTimeoutMs: 10_000,
  workflowIdleMs: 60 * 60_000,
  maxBranches: 12,
  headPrsPerBranch: 5,
  basePrsPerBranch: 10,
  closingRefsPerPr: 10,
  maxBodyRefs: 50,
  maxAutoItems: 100,
  maxProofs: 100,
  maxAgents: 200,
  maxDismissed: 500,
} as const

export const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/

// ---------------------------------------------------------------- auto tracking (spec 5.3, 6.3)

/** Sources that discovery adds. The transcript backfill and the capture hooks never write them. */
export const AUTO_SOURCES: ReadonlySet<Source> = new Set<Source>(['auto', 'pr-body'])

// Row ids of the auto sections (spec 6.2). An item key never starts with `wt:` or `ag:`. Build and test ids here only.
export const MASTER_ID = 'ag:master'
export const worktreeId = (path: string): string => `wt:${path}`
export const agentRowId = (agentId: string): string => `ag:${agentId}`
/** True for the id of a worktree or agent row, false for an item key. */
export const isRowId = (id: string): boolean => id.startsWith('wt:') || id.startsWith('ag:')

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

export type DiscoveredPr = {
  host: string
  owner: string
  repo: string
  number: number
  url: string
  title: string
  state: GitHubState
  isDraft: boolean
  reviewDecision?: string
  checks: Checks
  headRefName: string
  baseRefName: string
  body: string
  closing: { host: string; owner: string; repo: string; number: number; url: string }[]
  /** Which alias found it. A PR found by both keeps `head`. */
  by: 'head' | 'base'
}

export type GraphqlReply = { data: Record<string, unknown>; errors: unknown[] }

/** A21. `blocked`: breaker open; `no-gh`: the probe found no gh; `transport`: cannot start, timeout or non-JSON output. */
export type GraphqlOutcome =
  | { ok: true; reply: GraphqlReply }
  | { ok: false; kind: 'blocked' | 'no-gh' | 'auth' | 'transport' | 'truncated' | 'query-error'; error?: string }

/** One gh reply, classified once for `graphql` and `refreshChunk`. */
export type ReplyClass =
  | { kind: 'data'; data: Record<string, unknown>; errors: unknown[] }
  | { kind: 'auth' | 'truncated' | 'query-error' | 'unparsable'; detail?: string }

export type DiscoveryOutcome =
  | { ok: true; prs: DiscoveredPr[]; complete: boolean; defaultBranch?: string }
  | { ok: false; skipped?: PrSkip; error?: string }

export type AutoReason = 'start' | 'tick' | 'worktree' | 'agent' | 'git' | 'pr-event' | 'manual'

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
/** What `applyDiscovery` returns. `list` is the input list itself when nothing changed (A22). */
export type DiscoveryApplied = { list: ItemRecord[]; added: string[]; untracked: number }

/** A new interface, so the existing GitHubToolApi fakes in tests still compile. */
export interface GitHubDiscoveryApi extends GitHubToolApi {
  /** One `gh api graphql --hostname <host> -f query=<q>` through the breaker, with `LIMITS.discoveryTimeoutMs` (A21). */
  graphql(host: string, query: string): Promise<GraphqlOutcome>
}

export type { TurnCompleteReason }
