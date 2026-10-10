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
/** Where a reference was seen: the person's prompt or command, Claude's reply, or tool output. */
export type Source = 'prompt' | 'response' | 'tool'

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
}

export type GitHubRecord = ItemRecordBase & { category: 'github' } & GitHubFields
export type JiraRecord = ItemRecordBase & { category: 'jira' } & JiraFields
export type WebRecord = ItemRecordBase & { category: 'web' }
export type ItemRecord = GitHubRecord | JiraRecord | WebRecord

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

declare module 'claude-code' {
  interface PluginState {
    'artifact-tracking': {
      items: ItemRecord[]
      tools: { gh: ToolStatus; acli: ToolStatus }
      ui: UiState
    }
  }
}
