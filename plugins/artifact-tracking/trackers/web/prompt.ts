// The prompt lines of the web tracker: one data line per link, in the order of the pane. A link shows host and path
// only: a query or a userinfo can hold a token. The label is text from outside, so it is quoted and clipped. Pure.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.11. Plan: L7 Task 5 (S5, S9).

import type { ViewContext } from '../../core/interfaces/view'
import { hostPath } from '../../core/lib/links'
import { hostAndPath, promptLine, promptRecords } from '../../core/lib/prompt-text'
import { webKind } from './kind'
import type { WebRecord } from './types'

const LABEL_MAX = 80

/**
 * The label, for `promptLine` to quote. It adds nothing, and is left out, when it only repeats the link: the host and
 * path, the URL, or the clipped host and path that the kind gives a link with no text.
 */
function labelOf(r: WebRecord, shown: string): string {
  const repeats = r.label === shown || r.label === r.url || r.label === hostPath(r.url)
  return repeats ? '' : r.label
}

/** One line per tracked link that the person has not dismissed. The composer caps the list. */
export function webPrompt(ctx: Pick<ViewContext, 'items' | 'isDismissed'>): readonly string[] {
  return promptRecords(ctx, webKind.decode).map(r => {
    const shown = hostAndPath(r.url)
    return promptLine(`web: ${shown}`, [], labelOf(r, shown), LABEL_MAX)
  })
}
