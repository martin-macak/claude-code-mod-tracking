// Markdown file sightings (issue #28): how a sighting joins the item list. The sighting service itself lives in
// `sight.ts` (re-exported here). Since layer L5 the file kind makes claims of the sightings and the item service merges
// them; the joins below serve the unit tests of the old path and the registry bindings.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.8. Plan: L3 Task 11, L5 Task 8.

import type { ItemStorePort } from '../../core/interfaces/items'
import type { FileRecord, ItemRecord, Source } from '../../hooks/contracts'
import { mergeFiles } from '../../hooks/model/registry'
import { type FileTouch, mdCandidates } from './files'
import type { FileSight } from './sight'

export { type FileCtx, type FileEnv, FileSight, type SightCache, type SightDeps } from './sight'

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
