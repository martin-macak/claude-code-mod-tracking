// The record, ref and tool types of the github tracker. Moved from the shared contract in plan L5, Task 1.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.13.

import type { RefreshTool, StoredItem } from '../../core/interfaces/items'
import type { RepoRef } from '../../core/interfaces/ports'
import type { BaseRecord, ItemError } from '../../core/lib/records'

export type GitHubType = 'issue' | 'pr' | 'unknown'
export type GitHubState = 'open' | 'closed' | 'merged'
export type Checks = 'success' | 'failure' | 'pending' | 'none'
/** GraphQL `mergeable`. `UNKNOWN`: GitHub has not worked it out yet, which it does lazily after a push (issue #50). */
export type Mergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'

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
  /** GraphQL `mergeable` of a PR: whether it merges into its own base, a stack base included. Absent: not asked. */
  mergeable?: Mergeable
  /** GraphQL `mergeStateStatus`, e.g. CLEAN, DIRTY, BEHIND, DRAFT. Only `BEHIND` is read; a draft hides `DIRTY` behind `DRAFT`. */
  mergeStateStatus?: string
  /** PR branches. Set by discovery only (A8). */
  headRefName?: string
  baseRefName?: string
  /**
   * True when the head branch lives in a fork. Set by discovery only. The branches of such a PR are not branches of this
   * repo, so the mod looks up no worktree for it and offers no key that acts on it (issue #50). Absent: not a fork.
   */
  crossRepo?: true
  /**
   * True when the PR is in another repo than the session repo (issue #158): a PR the session created there. Set by
   * discovery only. Its branches are not branches of the session repo, so the mod looks up no worktree for it and offers
   * no key that acts on it, as for a fork PR. Absent: the PR is in the session repo.
   */
  otherRepo?: true
  /** Issue keys the PR's closing references name. Set by discovery only, like the branches. Absent when none. */
  closes?: string[]
  /**
   * True while the PR lane finds this PR (a PR on a tracked branch). Set by discovery only, and cleared by its prune. It
   * tells a PR the lane found from an item that only a PR body names: both have the reason `discovered`, but only the
   * body ref has `via`. Read it through `isLanePr`, never alone. Absent: the lane does not find the item.
   */
  lane?: true
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
  /**
   * `canCall` for a call to `host`: the session host asks the tool, another host its own denial and breaker, so the session
   * host being logged out or at rest does not hold it up (issue #158).
   */
  canCallHost(host: string, now: number): boolean
  /** Cached answer of `gh auth status --hostname <host>`. undefined: not asked yet. */
  isHostAuthed(host: string): boolean | undefined
  /** Asks gh once per host and caches the answer. */
  checkHost(host: string): Promise<boolean>
  /** `gh repo view --json nameWithOwner` in the session cwd, at most once per tool instance. */
  defaultRepo(): Promise<RepoRef | null>
}

// ---------------------------------------------------------------- PR discovery (spec 5.9, the PR lane)

export type PrSkip = 'no-repo' | 'no-gh' | 'not-logged-in' | 'paused' | 'host-not-authed' | 'no-branches'

/** A PR by repo and number: one the session created (issue #158). Owner and repo keep their case. */
export type PrRef = { host: string; owner: string; repo: string; number: number }

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
  mergeable?: Mergeable
  mergeStateStatus?: string
  headRefName: string
  baseRefName: string
  /** The head branch is in a fork. A base alias keeps such a PR, so the record must remember it. */
  crossRepo?: true
  /** The PR is in another repo than the session repo (issue #158). Set by `discoverPrs`, not by the parse. */
  otherRepo?: true
  /** The session created this PR: it is one of the PRs the lane was asked for by number (issue #158). Set by `discoverPrs`. */
  created?: true
  body: string
  closing: { host: string; owner: string; repo: string; number: number; url: string }[]
  /** Which alias found it. A PR found by two keeps the first of `head`, `base`, `created`. */
  by: 'head' | 'base' | 'created'
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

/**
 * `held` (absent when empty): the keys of the created PRs of another repo that got no sure answer: all of a repo with a
 * failed query, a host `gh` is not logged in to or `repository: null`, and in a repo that did answer only the PRs with
 * no verdict. The reply stays `complete` for the rest, and a prune leaves these alone. A PR that parsed is never held.
 * `host` (a failed outcome): the host that said no, for the skips `host-not-authed` and `not-logged-in` of a query. The
 * note of the lane names it: the session repo may be on another host (issue #158).
 */
export type DiscoveryOutcome =
  | { ok: true; prs: DiscoveredPr[]; complete: boolean; held?: string[]; defaultBranch?: string }
  | { ok: false; skipped?: PrSkip; error?: string; host?: string }

/** What `applyDiscovery` returns. `list` is the input list itself when nothing changed (A22). */
export type DiscoveryApplied<R extends StoredItem = StoredItem> = { list: R[]; added: string[]; untracked: number }

/** A new interface, so the existing GitHubToolApi fakes in tests still compile. */
export interface GitHubDiscoveryApi extends GitHubToolApi {
  /** One `gh api graphql --hostname <host> -f query=<q>` through the breaker, with `trackers.github.discoveryTimeoutMs` (A21). */
  graphql(host: string, query: string): Promise<GraphqlOutcome>
}

/**
 * What the PR lane asks of `gh`: whether it can be called, who is logged in, whether a host is authed (`checkHost` asks
 * once per host and caches it, so a host that only a created PR names is checked too; `isHostAuthed` tells a denial from a
 * check that could not run), and the one discovery query.
 */
export type DiscoveryTool = Pick<
  GitHubDiscoveryApi,
  'isAvailable' | 'canCall' | 'status' | 'checkHost' | 'isHostAuthed' | 'graphql'
>

/**
 * What the `files` key found for a conflicted PR: the files `git merge-tree` named, or why it could not. `pending` is
 * set while the git calls run, so the row says so. `more` counts the names past the cap.
 */
export type ConflictFiles = { at: number; pending?: true; files?: string[]; more?: number; error?: string }

/**
 * What the lane keeps of one open PR whose merge state needs more than the record holds (issue #50). The key of the
 * note is the key of the PR. A note exists only while the PR is CONFLICTING or UNKNOWN, so a changed value starts afresh.
 */
export type MergeNote = {
  /** UNKNOWN only: the steps that saw it, up to `UNKNOWN_SPENT`. The row says `? merge` once the retries are spent. */
  unknown?: number
  /** CONFLICTING only: the path of a worktree that has the head branch checked out. Absent: there is none. */
  worktree?: string
  /** CONFLICTING only: when the person pressed resolve (epoch ms). The row reads `queued` for a while after. */
  queuedAt?: number
  /** CONFLICTING only: the answer of the `files` key. */
  files?: ConflictFiles
}

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
    /** The host that `gh` is not logged in to, when the step knows it (`host-not-authed`, or `not-logged-in` of a query). */
    host?: string
    /** Auto-only items not added over `maxAutoItems` (A11). */
    untracked?: number
  }
  /** The default branch the last discovery reply named. It gets no alias in the next query. */
  defaultBranch?: string
  /** The notes on the open PRs the last discovery found CONFLICTING or UNKNOWN, by PR key. Absent: none. */
  merge?: Record<string, MergeNote>
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
