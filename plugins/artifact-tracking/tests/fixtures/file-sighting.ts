// Markdown file sightings (issue #28): how a sighting joins the item list. The sighting service itself lives in
// `trackers/file/sight.ts` (re-exported here). Since layer L5 the file kind makes claims of the sightings and the item
// service merges them; the joins below serve the unit tests of the old path, over the registry binding. No production code
// calls them, so they left the tracker folder with the other test bindings (plan L5, Task 15).
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.8. Plan: L3 Task 11, L5 Tasks 8 and 15.

import type { ItemStorePort } from '../../core/interfaces/items'
import { type FileTouch, mdCandidates } from '../../trackers/file/files'
import type { FileSight } from '../../trackers/file/sight'
import type { FileRecord, ItemRecord, Source } from './contracts'
import { mergeFiles } from './registry'

export { type FileCtx, type FileEnv, FileSight, type SightCache, type SightDeps } from '../../trackers/file/sight'

/** Drops the views of files that no earlier sighting tracks: a Read alone never adds a row. */
export function withoutLoneViews(list: readonly ItemRecord[], recs: readonly FileRecord[]): FileRecord[] {
  const known = new Set(list.map(i => i.key))
  return recs.filter(r => {
    if (r.views > 0) return known.has(r.key)
    known.add(r.key)
    return true
  })
}

/**
 * Merges file sightings into the list. A dismissed key never comes back, and a list that would not change is not
 * written. `cap` is `global.store.maxItems`; the default is today's.
 */
export async function addFiles(
  items: Pick<ItemStorePort, 'update'>,
  recs: readonly FileRecord[],
  cap?: number,
): Promise<void> {
  await items.update((stored, dismissed) => {
    const list = stored as unknown as ItemRecord[]
    const wanted = withoutLoneViews(
      list,
      recs.filter(r => !dismissed.has(r.key)),
    )
    return wanted.length === 0 ? stored : (mergeFiles(list, wanted, cap) as unknown as typeof stored)
  })
}

/** A Write, Edit or Read result: one sighting of the file it touched. */
export async function captureFileTouch(
  sight: FileSight,
  items: Pick<ItemStorePort, 'update'>,
  t: FileTouch,
  agentId: string | undefined,
  cap?: number,
): Promise<void> {
  const ctx = await sight.ctxFor(agentId)
  const rec = await sight.sighting(ctx, t.spelled, t.kind, agentId !== undefined, { source: 'tool', at: sight.at() })
  if (rec) await addFiles(items, [rec], cap)
}

/** The `.md` files a prompt or reply names, at most `max` of them (`cap`: the item cap). Most rows name none: no read then. */
export async function captureMentions(
  sight: FileSight,
  items: Pick<ItemStorePort, 'update'>,
  text: string,
  source: Source,
  max?: number,
  cap?: number,
): Promise<void> {
  if (mdCandidates(text, max).length === 0) return
  const recs = await sight.mentionRecords(await sight.ctxFor(), text, { source, at: sight.at() }, max)
  if (recs.length > 0) await addFiles(items, recs, cap)
}
