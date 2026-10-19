// The barrel of the tests: every type and value that the old `hooks/contracts.ts` had, from its new home, so the fixtures
// and the pre-L5 tests need no edit beyond their import line. Production code does not import it (plan L5, Task 15): each
// tracker keeps its types in its own folder (`trackers/<id>/types.ts`), core keeps its own (`core/interfaces/`,
// `core/lib/`). Only the tests use the old union aliases (`ItemRecord`, `Ref`, `Category`, `Source`, `ToolName`, `Tools`,
// `HydratedItem`) and `isRowId`, and the legacy auto state with `prs` and `defaultBranch`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.1

import type { Refreshable, ScanMode } from '../../core/interfaces/items'
import type { RepoRef, RunOpts } from '../../core/interfaces/ports'
import type { ArtifactRecord, ArtifactRef } from '../../trackers/artifact/types'
import type { AutoSnapshot as Snapshot, AutoState as State } from '../../trackers/auto/types'
import type { FileRecord } from '../../trackers/file/types'
import type {
  DiscoveryApplied as Applied,
  GitHubRecord,
  GitHubRef,
  GitHubTarget,
  GitHubToolApi,
  LaneState,
} from '../../trackers/github/types'
import type { JiraRecord, JiraRef, JiraTarget, JiraToolApi } from '../../trackers/jira/types'
import type { WebRecord, WebRef } from '../../trackers/web/types'

export type { Priority, ScanMode } from '../../core/interfaces/items'
export type { Now, RepoRef, Runner, RunResult } from '../../core/interfaces/ports'
export type { BaseRecord as ItemRecordBase, ItemError } from '../../core/lib/records'
export type {
  ArtifactFields,
  ArtifactOrigin,
  ArtifactRecord,
  ArtifactRef,
} from '../../trackers/artifact/types'
export type {
  AgentKind,
  AgentProof,
  AgentResultFacts,
  AgentRow,
  AgentRowState,
  AutoReason,
  BashFacts,
  EnterFacts,
  GitWorktree,
  Health,
  LiveAgent,
  SpawnFacts,
  TurnCompleteReason,
  WorktreeOrigin,
  WorktreeProof,
  WorktreeRow,
  WorktreeRowState,
} from '../../trackers/auto/types'
export type { FileActivity, FileRecord } from '../../trackers/file/types'
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
} from '../../trackers/github/types'
export type { JiraFields, JiraNode, JiraRecord, JiraRef, JiraTarget, JiraToolApi } from '../../trackers/jira/types'
export type { ProcessKind, ProcessRecord, ProcessState, ProcessUiState } from '../../trackers/processes/types'
export type { RepoRecord } from '../../trackers/repos/types'
export type { WebRecord, WebRef } from '../../trackers/web/types'
export type * from '../../types'

// ---------------------------------------------------------------- the auto state, as the legacy views read it

/**
 * The snapshot with the two fields that lived in it before plan L5, Task 12: the note of the Pull requests section and the
 * default branch. They are the state of the PR lane in the github slot now. The legacy composers (`hooks/ui/*`) and their
 * tests still read them from the snapshot, and `hooks/view-inputs.ts` puts them there. `hooks/ui/view.ts` has the same two
 * aliases for the draw path; the tests keep their own, so L6 can delete that file alone.
 */
export type AutoSnapshot = Snapshot & { prs?: LaneState['prs']; defaultBranch?: string }
export type AutoState = Omit<State, 'snapshot'> & { snapshot: AutoSnapshot | null }

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
 * The pre-L5 shape of an item the coordinator refreshed. The coordinator works on `Refreshable` through lanes now (plan
 * L5, Task 7); the `hydrate` binding of the registry and the coordinator test keep this type to the end of L5.
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

// The key of a resolved GitHub issue or PR, the auto sources, the child-tree carry and the row ids live with their owners
// (plan L5, Tasks 4, 14 and 15). The tests import them from here.
export { AUTO_SOURCES } from '../../core/lib/records'
export { agentRowId, MASTER_ID, worktreeId } from '../../trackers/auto/ids'
export { githubKey } from '../../trackers/github/urls'
export { carryPriorities } from '../../trackers/jira/nodes'
export { JIRA_KEY } from '../../trackers/jira/urls'
export { repoRowId } from '../../trackers/repos/ids'

/** True for the id of a worktree, agent or repo row, false for an item key. No production code asks (plan L5, Task 15). */
export const isRowId = (id: string): boolean => id.startsWith('wt:') || id.startsWith('ag:') || id.startsWith('rp:')
