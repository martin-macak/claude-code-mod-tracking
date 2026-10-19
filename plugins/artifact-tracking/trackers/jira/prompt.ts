// The prompt lines of the jira tracker: one data line per work item, in the order of the pane. Children are not listed.
// The summary is text from outside, so it is quoted and clipped. The type and the status are names that a Jira admin
// sets, so they are outside text too: `promptLine` clips them to 30 characters and strips parentheses and quotes. Pure.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.11. Plan: L7 Task 4 (S5, S9, S18).

import type { ViewContext } from '../../core/interfaces/view'
import { promptLine, promptRecords } from '../../core/lib/prompt-text'
import { jiraKind } from './kind'

const SUMMARY_MAX = 100

/** One line per tracked work item that the person has not dismissed. The composer caps the list. */
export function jiraPrompt(ctx: Pick<ViewContext, 'items' | 'isDismissed'>): readonly string[] {
  return promptRecords(ctx, jiraKind.decode).map(r =>
    promptLine(`jira: ${r.issueKey}`, [r.issueType ?? '', r.status ?? ''], r.summary ?? '', SUMMARY_MAX),
  )
}
