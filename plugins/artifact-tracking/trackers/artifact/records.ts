// Artifact rows outside the kind's merge: the delete mark of a publish tool call, the re-home of an old web row (R13)
// and the origin. Pure: no input list or record is mutated. Moved from `hooks/model/registry.ts` and `keys.ts`.
// Plan: L5 Task 4.

import type { StoredItem } from '../../core/interfaces/items'
import { hostPath } from '../../core/lib/links'
import { type BaseRecord, cloneRecord } from '../../core/lib/records'
import { artifactKeyOf, parseArtifactUrl } from './artifact-url'
import type { ArtifactOrigin, ArtifactRecord } from './types'

/** An artifact is `published` once the session's Artifact tool wrote it, else `mentioned`. */
export function artifactOrigin(rec: { sources: readonly string[] }): ArtifactOrigin {
  return rec.sources.includes('publish') ? 'published' : 'mentioned'
}

/** Marks the artifact row `key` deleted (R12). The input list comes back when no row has the key or it is marked. */
export function markArtifactDeleted<R extends StoredItem>(list: R[], key: string): R[] {
  const at = list.findIndex(r => r.key === key)
  const rec = list[at]
  if (rec?.category !== 'artifact' || rec.deleted) return list
  const out = [...list]
  out[at] = { ...cloneRecord(rec), deleted: true }
  return out
}

/**
 * The artifact row an old web row stands for (R13): a web record of an artifact URL. null: not an artifact URL.
 * A web label that is host and path is no name, so the artifact row shows its id instead.
 */
export function artifactFromWeb(rec: BaseRecord): ArtifactRecord | null {
  const ref = parseArtifactUrl(rec.url, rec.label === hostPath(rec.url) ? undefined : rec.label)
  if (!ref) return null
  return { ...cloneRecord(rec), key: artifactKeyOf(ref), category: 'artifact', url: ref.url, label: ref.label }
}
