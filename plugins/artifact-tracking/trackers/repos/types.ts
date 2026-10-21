// The slot record type of the repos tracker. Moved from the shared contract in plan L5, Task 1.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.13.

/** What repos reads of one agent proof in the fact `auto.agents`: its id, its label and its spawn cwd. It imports nothing of auto. */
export type AgentFact = { id: string; label?: string; cwd?: string }

/** What repos reads of the run root in the fact `auto.root`. */
export type RootFact = { cwd?: string; top?: string | null }

export type RepoRecord = {
  /** Group key: `remote:<host>/<owner>/<repo>`, `remote:<url>` or `local:<root>`. */
  key: string
  /** Repo display name. */
  name: string
  /** Resolved git root when known. */
  root?: string
  /** Last known branch. */
  branch?: string
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
