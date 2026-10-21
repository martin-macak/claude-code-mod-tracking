// The prompt lines of the file tracker: one data line per Markdown file, in the order of the pane. The path is below the
// session root when it can be. A file name is text from outside, so it is quoted and clipped. Pure.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.11. Plan: L7 Task 5 (S5, S9).

import type { ViewContext } from '../../core/interfaces/view'
import { relativeToRoot } from '../../core/lib/paths'
import { promptLine, promptRecords, quoted } from '../../core/lib/prompt-text'
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

/** One line per tracked file that the person has not dismissed. The composer caps the list. */
export function filePrompt(ctx: Pick<ViewContext, 'items' | 'isDismissed' | 'root'>): readonly string[] {
  return promptRecords(ctx, fileKind.decode).map(r =>
    promptLine(`file: ${quoted(ctx.root ? relativeToRoot(r.label, ctx.root) : r.label, PATH_MAX)}`, factsOf(r), ''),
  )
}
