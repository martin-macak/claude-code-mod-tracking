// The words that the two modes of the file preview share (issue #57, L2, and issue #254, L3; m9 of the review of #289): a notice block, the
// first line of a CLI's stderr, the size of a file, and the type word of a row. A leaf: `preview.ts` (the view and the secret rule) and
// `git-diff.ts` (the diff) both import it, and it imports neither. Pure: no state, no I/O.

import type { PreviewBlock } from '../../core/interfaces/preview'
import { firstLine } from '../../core/lib/text'
import { fileTypeOf } from './file-type'
import type { FileRecord } from './types'

/** One line of words that says what the person cannot see. `warning` is for a failure, `info` for a case. */
export const notice = (text: string, tone: 'info' | 'warning' = 'info'): PreviewBlock => ({
  kind: 'notice',
  text,
  tone,
})

/** One line of a CLI's stderr, for a notice: the first line, or `exit N` when it said nothing. */
export const failureOf = (stderr: string, exitCode: number): string => firstLine(stderr) || `exit ${exitCode}`

const UNITS = ['B', 'KB', 'MB', 'GB'] as const

/**
 * `12 B`, `2.0 KB`, `293 KB`, `1.5 MB`: three digits at most, one decimal below 100. The unit steps up at the rounded value, so
 * 1,048,575 bytes read `1.0 MB` and not `1024 KB`, and 102,350 bytes read `100 KB` and not `100.0 KB`.
 */
export function sizeText(bytes: number): string {
  let n = bytes
  let unit = 0
  while (n >= 1023.5 && unit < UNITS.length - 1) {
    n /= 1024
    unit++
  }
  if (unit === 0) return `${bytes} B`
  return `${n >= 99.95 ? Math.round(n) : n.toFixed(1)} ${UNITS[unit]}`
}

/** The MIME type that `file` answered for the row, or undefined when it did not ask, or answered `unknown`. */
export const mimeOf = (rec: FileRecord): string | undefined =>
  rec.mime !== undefined && rec.mime !== 'unknown' ? rec.mime : undefined

/** The type word that a notice about a binary file gives: the MIME type when `file` answered one, else the type of the map. */
export const kindOf = (rec: FileRecord): string => mimeOf(rec) ?? fileTypeOf(rec)
