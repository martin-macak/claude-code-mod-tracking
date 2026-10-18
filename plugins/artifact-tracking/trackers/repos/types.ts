// The slot record type of the repos tracker. Moved from the shared contract in plan L5, Task 1.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.13.

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
}
