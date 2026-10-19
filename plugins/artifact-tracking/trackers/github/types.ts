// The record, ref and tool types of the github tracker. Moved from the shared contract in plan L5, Task 1.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.13.

import type { RefreshTool, StoredItem } from '../../core/interfaces/items'
import type { RepoRef } from '../../core/interfaces/ports'
import type { BaseRecord, ItemError } from '../../core/lib/records'

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
  /** Issue keys the PR's closing references name. Set by discovery only, like the branches. Absent when none. */
  closes?: string[]
}

export type GitHubRecord = BaseRecord & { category: 'github' } & GitHubFields

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
  /** True when a ref came from short `#N` text matching (not from a full GitHub URL). */
  short?: true
}

/** A GitHub item as GhTool sees it. GitHubItem implements it. */
export interface GitHubTarget extends GitHubFields {
  readonly key: string
  refreshedAt?: number
  error?: ItemError
}

export interface GitHubToolApi extends RefreshTool<GitHubTarget> {
  /** Cached answer of `gh auth status --hostname <host>`. undefined: not asked yet. */
  isHostAuthed(host: string): boolean | undefined
  /** Asks gh once per host and caches the answer. */
  checkHost(host: string): Promise<boolean>
  /** `gh repo view --json nameWithOwner` in the session cwd, at most once per tool instance. */
  defaultRepo(): Promise<RepoRef | null>
}

// ---------------------------------------------------------------- PR discovery (spec 5.9, the PR lane)

export type PrSkip = 'no-repo' | 'no-gh' | 'not-logged-in' | 'paused' | 'host-not-authed' | 'no-branches'

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

/** What `applyDiscovery` returns. `list` is the input list itself when nothing changed (A22). */
export type DiscoveryApplied<R extends StoredItem = StoredItem> = { list: R[]; added: string[]; untracked: number }

/** A new interface, so the existing GitHubToolApi fakes in tests still compile. */
export interface GitHubDiscoveryApi extends GitHubToolApi {
  /** One `gh api graphql --hostname <host> -f query=<q>` through the breaker, with `trackers.github.discoveryTimeoutMs` (A21). */
  graphql(host: string, query: string): Promise<GraphqlOutcome>
}

/** What the PR lane asks of `gh`: whether it can be called, who is logged in, and the one discovery query. */
export type DiscoveryTool = Pick<GitHubDiscoveryApi, 'isAvailable' | 'canCall' | 'status' | 'isHostAuthed' | 'graphql'>

/**
 * The state of the PR lane, in the github slot of the `trackers` family. It is run-scoped (`persist: false`) and goes
 * to `v2:run` beside the auto slot. Before L5b it was `prs` and `defaultBranch` of the auto snapshot.
 */
export type LaneState = {
  prs: {
    at?: number
    ok: boolean
    skipped?: PrSkip
    error?: string
    /** Auto-only items not added over `maxAutoItems` (A11). */
    untracked?: number
  }
  /** The default branch the last discovery reply named. It gets no alias in the next query. */
  defaultBranch?: string
}

/**
 * What the PR lane reads of the fact `auto.branches`. The auto tracker owns the fact and its own type for it. A tracker
 * imports no other, so the reader spells what it needs (spec 5.8, Facts).
 */
export type BranchesFact = {
  /** The round that gave the fact. A new round always moves it. */
  seq: number
  /** What started the round. Empty for a fact published at init or after a restore. */
  reasons: readonly string[]
  /** The branches the PR step polls, root first. */
  branches: readonly string[]
  /** Tracked branches over the cap, not polled. */
  overflow: number
}
