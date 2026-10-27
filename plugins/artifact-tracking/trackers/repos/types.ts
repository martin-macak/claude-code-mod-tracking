// The slot record type of the repos tracker. Moved from the shared contract in plan L5, Task 1.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.13.

/** What repos reads of one agent proof in the fact `auto.agents`: its id, its label and its spawn cwd. It imports nothing of auto. */
export type AgentFact = { id: string; label?: string; cwd?: string }

/** What repos reads of the run root in the fact `auto.root`. */
export type RootFact = { cwd?: string; top?: string | null }

/**
 * A toplevel of a repo that the session visited, and the branch it had at the last visit. It proves the branch to the PR
 * lane (issue #195): a branch is asked for on GitHub only when the session stood on it.
 */
export type RepoRoot = { path: string; branch?: string }

export type RepoRecord = {
  /** Group key: `remote:<host>/<owner>/<repo>`, `remote:<url>` or `local:<root>`. */
  key: string
  /** Repo display name. */
  name: string
  /** Resolved git root when known. */
  root?: string
  /** Last known branch: the one of `root`. */
  branch?: string
  /**
   * The toplevels the session visited, newest visit first, at most `trackers.repos.maxRepoRoots`. `root` and `branch` are
   * the first of them. Absent in a row from before the list: it reads as the one root of the row (`rootsOf`).
   */
  roots?: RepoRoot[]
  /** How the repo was used. `edit` wins over `read`. Missing means `read` (a row from an older version). */
  mode?: 'read' | 'edit'
  /** Agent labels that touched this repo. */
  touchedBy: string[]
  firstSeen: number
  lastSeen: number
  /**
   * The first and the last turn that visited the repo (issue #133). `lastTurn` moves with each later turn, though `lastSeen`
   * may not (a burst of visits is one write). Absent: no turn stamped the row (a row from before the lineage).
   */
  firstTurn?: number
  lastTurn?: number
}
