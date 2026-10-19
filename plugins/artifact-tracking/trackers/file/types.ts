// The record types of the file tracker. Moved from the shared contract in plan L5, Task 1.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.13.

import type { BaseRecord } from '../../core/lib/records'

/** How a Markdown file was touched: a Write that made it, an Edit or a Write update, a Read, a name in text. */
export type FileActivity = 'created' | 'edited' | 'viewed' | 'mentioned'

/**
 * A Markdown file (issue #28). `key` is `file:<url>`. `url` is where the file landed (its real path, else the
 * lexical one). `label` is the absolute path as Claude spelled it; the view shows it relative to the session root.
 */
export type FileRecord = BaseRecord & {
  category: 'file'
  /** A Write of type `create` made the file. Never goes back to false. */
  created: boolean
  /** Edit calls and Write calls of type `update`. */
  edits: number
  /** Read calls. A Read alone never adds a row. */
  views: number
  /** Prompts and replies that named the file. */
  mentions: number
  /** A subagent wrote, edited or read the file. Absent when only the main loop did. */
  bySubagent?: true
}

/** One sighting of a file: which door saw it (`prompt`, `response`, `tool`, ...) and when. */
export type Sighting = { source: string; at: number }
