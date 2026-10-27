// What Claude did with a file, as one rank (issue #57): written (made, edited or removed), only named, or only read. The cap
// (`capRank`), the sort of the section, the dim row, the `/track` text and the prompt all read this one rule, so they cannot
// drift apart. It imports types only: the item kind and the row view both depend on it, and it depends on neither. Pure.

import type { FileRecord } from './types'

/** The facts of a record that tell what Claude did with the file. */
type Activity = Pick<FileRecord, 'created' | 'edits' | 'deleted' | 'mentions'>

/** True for a file that was written: made, edited or removed. A file that was only read or named is not. */
export const isWritten = (r: Pick<FileRecord, 'created' | 'edits' | 'deleted'>): boolean =>
  r.created || r.edits > 0 || r.deleted === true

/**
 * How much a file is worth to keep and to show: 2 for a file that was written (made, edited or removed), 1 for a file that
 * was only named, 0 for a file that was only read. The cap drops the lowest rank first; the section lists the highest first.
 */
export const fileRank = (r: Activity): 0 | 1 | 2 => (isWritten(r) ? 2 : r.mentions > 0 ? 1 : 0)

/**
 * True for a file that was only read: a view, no write, no mention, and no mark of the person. The `/track` text counts it and
 * does not list it. The person's `high` mark keeps a file in the list: the pane pins such a row, and a pinned row is never
 * hidden (R12). The mark of the record is the whole level of a file: the file kind has no rule that sets one (tests/file-rows.test.ts).
 */
export const isOnlyRead = (r: Activity & Pick<FileRecord, 'views' | 'priority'>): boolean =>
  r.views > 0 && fileRank(r) === 0 && r.priority !== 'high'

/** The line that counts the files the `/track` text and the prompt do not list: `1 more file read only`. */
export const readOnlyLine = (n: number): string => `${n} more ${n === 1 ? 'file' : 'files'} read only`
