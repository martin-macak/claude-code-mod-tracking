// The prompt lines of the file tracker: one line that counts the files that were only read, then one data line per file that
// was written, deleted or named, in the order of the pane (issue #57). The count comes first: the composer cuts a long list at
// its end, and the model should still learn that many files were read. The path is below the session root when it can be. A
// file name is text from outside, so it is quoted and clipped. Pure.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.11. Plan: L7 Task 5 (S5, S9).

import type { ViewContext } from '../../core/interfaces/view'
import { relativeToRoot } from '../../core/lib/paths'
import { promptLine, promptRecords, quoted } from '../../core/lib/prompt-text'
import { isOnlyRead, readOnlyLine } from './activity'
import { fileKind } from './kind'
import type { FileRecord } from './types'

const PATH_MAX = 120

/** The strongest reason, then how often the file was edited and viewed. */
function factsOf(r: FileRecord): string[] {
  return [
    r.reasons.strongest,
    ...(r.edits > 0 ? [`edited ${r.edits}`] : []),
    ...(r.views > 0 ? [`viewed ${r.views}`] : []),
    ...(r.bySubagent ? ['by subagent'] : []),
  ]
}

/**
 * One line per file that the person has not dismissed and that was written, deleted or named. A file that was only read is
 * one more in the first line (`file: 3 more files read only`): the model needs the footprint, not every read. The composer
 * caps the list at its end, so the count stays and a data line goes.
 */
export function filePrompt(ctx: Pick<ViewContext, 'items' | 'isDismissed' | 'root'>): readonly string[] {
  const all = promptRecords(ctx, fileKind.decode)
  const lines = all
    .filter(r => !isOnlyRead(r))
    .map(r =>
      promptLine(`file: ${quoted(ctx.root ? relativeToRoot(r.label, ctx.root) : r.label, PATH_MAX)}`, factsOf(r), ''),
    )
  const read = all.length - lines.length
  return read > 0 ? [`file: ${readOnlyLine(read)}`, ...lines] : lines
}
