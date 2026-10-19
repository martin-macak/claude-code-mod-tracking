// The prompt lines of the artifact tracker: one data line per Claude artifact, in the order of the pane. The page shows
// host and path only. The name is text from outside (a page title), so it is quoted and clipped. Pure.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.11. Plan: L7 Task 5 (S5, S9).

import type { ViewContext } from '../../core/interfaces/view'
import { hostAndPath, promptLine, promptRecords } from '../../core/lib/prompt-text'
import { artifactIdOf } from './artifact-url'
import { artifactKind } from './kind'
import { artifactOrigin } from './records'

const NAME_MAX = 80

/** One line per tracked artifact that the person has not dismissed. The composer caps the list. */
export function artifactPrompt(ctx: Pick<ViewContext, 'items' | 'isDismissed'>): readonly string[] {
  return promptRecords(ctx, artifactKind.decode).map(r =>
    promptLine(
      `artifact: ${hostAndPath(r.url)}`,
      [artifactOrigin(r), ...(r.deleted ? ['deleted'] : [])],
      // A label that is the id names nothing: the id is already in the head.
      r.label === artifactIdOf(r.url) ? '' : r.label,
      NAME_MAX,
    ),
  )
}
