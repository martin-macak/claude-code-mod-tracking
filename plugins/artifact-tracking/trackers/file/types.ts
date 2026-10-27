// The record types of the file tracker. Moved from the shared contract in plan L5, Task 1. Any file, not only `.md`, since issue #57.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.13.

import type { BaseRecord } from '../../core/lib/records'

/**
 * How a file was touched: made (a Write of type `create`, or a file that a Bash command added), edited (an Edit, a NotebookEdit,
 * a Write update, a file that a Bash command changed), read, named in text, or removed by a Bash command.
 */
export type FileActivity = 'created' | 'edited' | 'viewed' | 'mentioned' | 'deleted'

/**
 * A file (issues #28 and #57). `key` is `file:<url>`. `url` is where the file landed: its real path; for a file that is
 * gone, the real path of its folder plus the name; else the path as spelled. `label` is the absolute path as Claude
 * spelled it; the view shows it relative to the session root.
 */
export type FileRecord = BaseRecord & {
  category: 'file'
  /** A Write of type `create` made the file. Never goes back to false. */
  created: boolean
  /** Edit calls and Write calls of type `update`. */
  edits: number
  /** Read calls, also a Read that answers `file_unchanged`. A Read alone adds a row. */
  views: number
  /** Prompts and replies that named the file. */
  mentions: number
  /** A Bash command removed the file (`bashEditDiff`). A later touch of the file clears it: the file is there again. */
  deleted?: true
  /** The cached answer of `file --mime-type` for a name the type map does not know (`unknown` when the answer was no MIME type). */
  mime?: string
  /** A subagent touched the file. Absent when only the main loop did. */
  bySubagent?: true
}

/** One sighting of a file: which door saw it (`prompt`, `response`, `tool`, ...) and when. */
export type Sighting = { source: string; at: number }
