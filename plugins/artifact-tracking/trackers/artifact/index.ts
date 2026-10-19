// The artifact tracker: pages that Claude publishes with the Artifact tool (issue #29). A publish tracks the page with
// source `publish`. A delete marks its row. A dismissed or unknown artifact gets no row. Errors, refusals and other
// actions change nothing. It keeps no data of its own: its rows live in the shared item list, and mentions of an
// artifact URL in text are claimed by the capture funnel of the item runtime until layer L5.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.8. Plan: L3 Task 12.

import type { ToolCallEvent } from '../../core/interfaces/events'
import type { Claim, Json, StoredItem } from '../../core/interfaces/items'
import type { Handler, Tracker } from '../../core/interfaces/tracker'
import type { ItemRecord } from '../../hooks/contracts'
import { markArtifactDeleted } from '../../hooks/model/registry'
import { artifactEvent } from './artifact-tool'
import { type ArtifactConfig, artifactConfig } from './config'

export { type ArtifactConfig, artifactConfig }

/** One Artifact call: `ev.input` as the model gave it, `ev.result` as the tool answered. */
const onArtifact: Handler<ArtifactConfig, Json, ToolCallEvent> = async (ctx, ev) => {
  const found = artifactEvent(ev.input, ev.result)
  if (!found) return
  if (found.kind === 'published') return ctx.items.track([found.ref] as unknown as Claim[], 'publish')
  // No such row: the write would change nothing (A22), and `update` skips it.
  await ctx.items.update(
    list => markArtifactDeleted(list as unknown as ItemRecord[], found.key) as unknown as StoredItem[],
  )
}

export function artifactTracker(): Tracker<ArtifactConfig, Json> {
  return {
    id: 'artifact',
    order: 40,
    config: artifactConfig,
    init: () => {},
    store: ctx => ctx.config.slice(),
    events: { toolCall: { Artifact: onArtifact } },
  }
}
