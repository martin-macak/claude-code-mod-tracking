// An Artifact tool call as an event (issue #29; the table of the design study, §3). Pure: no `$`, no I/O.
// The `tool.call` hook and the resume backfill both call it, so a live call and its transcript copy agree.

import { dig, isRecord } from '../../core/lib/json'
import { basename } from '../../core/lib/porcelain'
import type { ArtifactRef } from '../../hooks/contracts'
import { keyOf } from '../../hooks/model/keys'
import { clipLabel, parseArtifactUrl } from './artifact-url'

export type ArtifactEvent = { kind: 'published'; ref: ArtifactRef } | { kind: 'deleted'; key: string }

const text = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? clipLabel(v) : ''
  return s === '' ? undefined : s
}

/** The page a publish names, with its title. Without a title the label is `fallback`, else the id. */
function published(url: unknown, title: string | undefined, fallback?: string): ArtifactEvent | null {
  const ref = typeof url === 'string' ? parseArtifactUrl(url) : null
  if (!ref) return null
  if (title) return { kind: 'published', ref: { ...ref, label: title, titled: true } }
  return { kind: 'published', ref: fallback ? { ...ref, label: fallback } : ref }
}

/**
 * The event of one call: `input` as the model gave it, `ran` as `next(e)` resolved (or a transcript tool use).
 * First match wins:
 * - an error, a deny, or a result that is not an object: nothing;
 * - `delete` with `artifact_delete.deleted`: deleted;
 * - any action but publish (omitted means publish), or an `opened` result: nothing;
 * - `asset: true` with an asset result: published, no title (an asset's file name is not the page's name);
 * - `created_from_type` with `url`: published, with its title;
 * - `url` with `artifact_id` or `path`: published, titled `result.title`, else the title input, else the file name.
 */
export function artifactEvent(input: unknown, ran: unknown): ArtifactEvent | null {
  if (!isRecord(ran) || ran.isError || ran.deny) return null
  const result = ran.result
  if (!isRecord(result)) return null
  const call = isRecord(input) ? input : {}
  if (call.action === 'delete') {
    const del = result.artifact_delete
    if (!isRecord(del) || del.deleted !== true || typeof del.url !== 'string') return null
    const ref = parseArtifactUrl(del.url)
    return ref ? { kind: 'deleted', key: keyOf(ref) } : null
  }
  if ((call.action !== undefined && call.action !== 'publish') || result.opened === true) return null
  if (call.asset === true) {
    if (!isRecord(result.asset_upload) && !isRecord(result.asset_uploads) && !isRecord(result.asset_copy)) return null
    const url = dig(result, 'written', 'url') ?? dig(result, 'asset_uploads', 'url') ?? dig(result, 'asset_copy', 'url')
    return published(url, undefined)
  }
  if (result.created_from_type === true) return published(result.url, text(result.title) ?? text(call.title))
  if (typeof result.artifact_id !== 'string' && typeof result.path !== 'string') return null
  const file = typeof call.file_path === 'string' && call.file_path !== '' ? text(basename(call.file_path)) : undefined
  return published(result.url, text(result.title) ?? text(call.title), file)
}
