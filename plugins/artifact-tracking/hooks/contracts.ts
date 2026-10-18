// Shared contracts between the modules of the mod. No `$` here: only register.tsx touches it.
// Plan L5, Task 1: this file is a barrel over the new homes of the types (`types/`, `core/interfaces/`, `core/lib/` and the
// `trackers/<id>/types.ts` files). It keeps the values and the old union aliases (`ItemRecord`, `Ref`, `Category`, `Source`,
// `ToolName`, `Tools`, `HydratedItem`) that the legacy modules and their tests use. Task 15 moves it to the test fixtures.
// Spec: docs/superpowers/specs/2026-10-10-artifact-tracking-design.md

import type { TurnCompleteReason } from 'claude-code'
import type { Refreshable, ScanMode, StoredItem } from '../core/interfaces/items'
import type { RepoRef, RunOpts } from '../core/interfaces/ports'
import type { ArtifactRecord, ArtifactRef } from '../trackers/artifact/types'
import type { FileRecord } from '../trackers/file/types'
import type {
  DiscoveryApplied as Applied,
  GitHubRecord,
  GitHubRef,
  GitHubTarget,
  GitHubToolApi,
} from '../trackers/github/types'
import type { JiraRecord, JiraRef, JiraTarget, JiraToolApi } from '../trackers/jira/types'
import type { WebRecord, WebRef } from '../trackers/web/types'

export type { Priority, ScanMode } from '../core/interfaces/items'
export type { Now, RepoRef, Runner, RunResult } from '../core/interfaces/ports'
export type { BaseRecord as ItemRecordBase, ItemError } from '../core/lib/records'
export type {
  ArtifactFields,
  ArtifactOrigin,
  ArtifactRecord,
  ArtifactRef,
} from '../trackers/artifact/types'
export type {
  AgentKind,
  AgentProof,
  AgentResultFacts,
  AgentRow,
  AgentRowState,
  AutoReason,
  AutoSnapshot,
  AutoState,
  BashFacts,
  EnterFacts,
  GitWorktree,
  Health,
  LiveAgent,
  SpawnFacts,
  WorktreeOrigin,
  WorktreeProof,
  WorktreeRow,
  WorktreeRowState,
} from '../trackers/auto/types'
export type { FileActivity, FileRecord } from '../trackers/file/types'
export type {
  Checks,
  DiscoveredPr,
  DiscoveryOutcome,
  GitHubDiscoveryApi,
  GitHubFields,
  GitHubRecord,
  GitHubRef,
  GitHubState,
  GitHubTarget,
  GitHubToolApi,
  GitHubType,
  GraphqlOutcome,
  GraphqlReply,
  PrSkip,
  ReplyClass,
} from '../trackers/github/types'
export type { JiraFields, JiraNode, JiraRecord, JiraRef, JiraTarget, JiraToolApi } from '../trackers/jira/types'
export type { ProcessKind, ProcessRecord, ProcessState, ProcessUiState } from '../trackers/processes/types'
export type { RepoRecord } from '../trackers/repos/types'
export type { WebRecord, WebRef } from '../trackers/web/types'
export type * from '../types'

// ---------------------------------------------------------------- process runner

/** The options of one run. The same as `RunOpts`, under its old name. */
export type RunInit = RunOpts

// ---------------------------------------------------------------- the old unions over the item kinds

export type Category = 'jira' | 'github' | 'artifact' | 'web' | 'file'
/**
 * Where a reference was seen. `auto`: a PR on a tracked branch. `pr-body`: named in a discovered PR body.
 * `publish`: the session's Artifact tool published or updated it.
 */
export type Source = 'prompt' | 'response' | 'tool' | 'auto' | 'pr-body' | 'publish'
export type ToolName = 'gh' | 'acli'

export type ItemRecord = GitHubRecord | JiraRecord | ArtifactRecord | WebRecord | FileRecord

/** What `applyDiscovery` returns, over the old record union. */
export type DiscoveryApplied = Applied<ItemRecord>

/**
 * The list the plugin state holds, as the old modules see it. The state contract types the items atom as
 * `StoredItem[]` (spec 5.13); the cast sits here once. Task 8 deletes it with the item runtime.
 */
export const asRecords = (list: readonly StoredItem[]): ItemRecord[] => list as unknown as ItemRecord[]

// ---------------------------------------------------------------- references found in text

export type Ref = GitHubRef | JiraRef | ArtifactRef | WebRef

export type ExtractOptions = {
  mode: ScanMode
  /** Repo for bare `#N`. null or absent: bare `#N` stays unresolved. */
  defaultRepo?: RepoRef | null
  /** Hosts besides github.com whose issue and PR URLs count as GitHub (GHE hosts gh is logged in to). */
  githubHosts?: readonly string[]
  /** In conversation text, track short GitHub refs only when a keyword prefixes them and they target the current repo. */
  strictShortRefs?: boolean
  /**
   * The lead words that opt a short `#N` in when `strictShortRefs` is on (`trackers.github.shortRefKeywords`).
   * Absent: the defaults. An empty list: no word does, so no short ref is tracked.
   */
  shortRefWords?: readonly string[]
}

// ---------------------------------------------------------------- what tools mutate

export type Tools = { gh: GitHubToolApi; acli: JiraToolApi }

// ---------------------------------------------------------------- hydrated items

/**
 * The pre-L5 shape of an item the coordinator refreshes. The coordinator hydrates through it until Task 7 gives it
 * lanes; its test keeps the `HydratedItem` type to the end of L5.
 */
interface Hydrated extends Refreshable {
  readonly category: Category
  refresh(): Promise<void>
  toRecord(): ItemRecord
}

export type HydratedItem =
  | (Hydrated & GitHubTarget & { readonly category: 'github' })
  | (Hydrated & JiraTarget & { readonly category: 'jira' })
  | (Hydrated & { readonly category: 'artifact' })
  | (Hydrated & { readonly category: 'web' })
  | (Hydrated & { readonly category: 'file' })

export type Sighting = { source: Source; at: number }

// The key of a resolved GitHub issue or PR, the auto sources and the child-tree carry live with their owners now
// (plan L5, Task 4). The old callers import them from here until Task 15.
export { AUTO_SOURCES } from '../core/lib/records'
export { githubKey } from '../trackers/github/urls'
export { carryPriorities } from '../trackers/jira/nodes'
export { JIRA_KEY } from '../trackers/jira/urls'

// ---------------------------------------------------------------- auto tracking (spec 5.3, 6.3)

// Row ids of the auto sections (spec 6.2). An item key never starts with `wt:` or `ag:`. Build and test ids here only.
export const MASTER_ID = 'ag:master'
export const worktreeId = (path: string): string => `wt:${path}`
export const agentRowId = (agentId: string): string => `ag:${agentId}`
/** The id of a repo row (`rp:` + the repo key). A repo key starts with `remote:` or `local:`, so it is no item key. */
export const repoRowId = (key: string): string => `rp:${key}`
/** True for the id of a worktree, agent or repo row, false for an item key. */
export const isRowId = (id: string): boolean => id.startsWith('wt:') || id.startsWith('ag:') || id.startsWith('rp:')

export type { TurnCompleteReason }
