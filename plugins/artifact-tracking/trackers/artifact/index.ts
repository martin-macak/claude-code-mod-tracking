// The artifact tracker: pages that Claude publishes with the Artifact tool (issue #29). A publish tracks the page with
// source `publish`. A delete marks its row. A dismissed or unknown artifact gets no row. Errors, refusals and other
// actions change nothing. It keeps no data and hears no event of its own: its kind reads the Artifact tool call, and its
// rows live in the shared item list, where core claims the mentions of an artifact URL in text.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.8. Plan: L3 Task 12, L5 Task 8.

import type { Json } from '../../core/interfaces/items'
import type { Tracker } from '../../core/interfaces/tracker'
import { type ArtifactConfig, artifactConfig } from './config'
import { artifactKind } from './kind'

export { type ArtifactConfig, artifactConfig, artifactKind }

export function artifactTracker(): Tracker<ArtifactConfig, Json> {
  return {
    id: 'artifact',
    order: 40,
    config: artifactConfig,
    kinds: [artifactKind],
    init: () => {},
    store: ctx => ctx.config.slice(),
  }
}
