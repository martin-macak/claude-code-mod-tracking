// Items from a replayed transcript: a `claude --resume` load fires no append hooks, so Replay hands the item runtime
// the rows and tool calls of the transcript as one batch. This turns the batch into records by the same rules the
// live hooks use, and picks the records the list does not already know.
// Transitional (plan Task 11): layer L5 moves these rules into the kinds, and Capture reads replayed rows itself.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.6.1. Plan: L3 Task 11, D7.

import type { ReplayItem } from '../../core/interfaces/events'
import { isRecord } from '../../core/lib/json'
import { artifactEvent } from '../../trackers/artifact/artifact-tool'
import { touchFromToolResult } from '../../trackers/file/files'
import type { FileSight } from '../../trackers/file/sighting'
import { withoutLoneViews } from '../../trackers/file/sighting'
import type { FileRecord, ItemRecord, Ref, Source } from '../contracts'
import { artifactOrigin } from '../model/keys'
import { markArtifactDeleted, mergeFiles, mergeRefs } from '../model/registry'
import { commandArgs, extractRefs } from '../scan/refs'
import { type CaptureDeps, filterToolRefsForSite, keepOpenSessionShortRefs } from './capture'

/**
 * Wrappers of user-role rows that the person did not type. `SessionMessage` has no `isMeta` or `origin`,
 * so the backfill can only skip the wrappers it knows (D3 lets the live hook use the real flags).
 */
export const NOT_TYPED = ['<local-command-stdout>', '<task-notification>', '<system-reminder>', '<teammate-message']

/** The text a transcript message offers, by the rules of its row door. null: skip it. */
export function backfillText(role: 'user' | 'assistant', text: string): string | null {
  if (text === '') return null
  if (role === 'assistant') return text
  if (NOT_TYPED.some(tag => text.includes(tag))) return null
  return text.includes('<command-args>') ? commandArgs(text) : text
}

/** `files: false` skips the file work (mentions and Write, Edit and Read results): the file tracker is off. */
export type ReplayDeps = Pick<CaptureDeps, 'repo' | 'hosts' | 'site' | 'gh'> & { sight: FileSight; files?: boolean }

/**
 * Items from a replayed transcript batch. File rows come from the Write, Edit and Read results and the mentions,
 * artifact rows from the Artifact tool uses, in transcript order. A subagent's transcript stores no result, so its
 * writes and publishes come back from the stored copy only.
 */
export async function itemsFromBatch(d: ReplayDeps, batch: readonly ReplayItem[]): Promise<ItemRecord[]> {
  // In transcript order, so a delete lands after the publish before it.
  const batches: ({ refs: Ref[]; source: Source } | { deleted: string })[] = []
  const fileRecs: FileRecord[] = []
  const opts = { defaultRepo: d.repo() ?? null, githubHosts: d.hosts() }
  const toolSite = await d.site()
  const files = d.files !== false
  const ctx = files ? await d.sight.ctxFor() : undefined
  const at = d.sight.at()
  for (const item of batch) {
    if (item.kind === 'row') {
      const role = item.ev.door === 'prompt' ? 'user' : 'assistant'
      const text = backfillText(role, item.ev.text)
      if (text === null) continue
      const source: Source = role === 'user' ? 'prompt' : 'response'
      batches.push({
        refs: await keepOpenSessionShortRefs(d, extractRefs(text, { mode: 'full', ...opts, strictShortRefs: true })),
        source,
      })
      if (ctx) fileRecs.push(...(await d.sight.mentionRecords(ctx, text, { source, at })))
      continue
    }
    const { tool, input, result: use } = item.ev // `use` is the whole tool use of the transcript
    const t = ctx ? touchFromToolResult(tool, use) : null
    const rec = ctx && t ? await d.sight.sighting(ctx, t.spelled, t.kind, false, { source: 'tool', at }) : null
    if (rec) fileRecs.push(rec)
    if (tool === 'Artifact') {
      const ev = artifactEvent(input, use)
      if (ev?.kind === 'published') batches.push({ refs: [ev.ref], source: 'publish' })
      else if (ev?.kind === 'deleted') batches.push({ deleted: ev.key })
    }
    const text = isRecord(use) && typeof use.text === 'string' ? use.text : ''
    if (!text) continue
    const refs = filterToolRefsForSite(extractRefs(text, { mode: 'urls-only', ...opts }), toolSite)
    if (refs.length > 0) batches.push({ refs, source: 'tool' })
  }
  let list: ItemRecord[] = []
  for (const b of batches) {
    if ('deleted' in b) list = markArtifactDeleted(list, b.deleted)
    else if (b.refs.length > 0) list = mergeRefs(list, b.refs, { source: b.source, at }).list
  }
  return mergeFiles(list, withoutLoneViews(list, fileRecs))
}

/**
 * The records the list does not know yet. A stored key wins over the transcript, except for what only the transcript
 * may know of an artifact: a publish or a delete that landed after the last flush.
 */
export function onlyNew(have: readonly ItemRecord[], fresh: readonly ItemRecord[]): ItemRecord[] {
  const known = new Map(have.map(r => [r.key, r]))
  return fresh.filter(r => {
    const old = known.get(r.key)
    if (!old) return true
    if (r.category !== 'artifact' || old.category !== 'artifact') return false
    return (artifactOrigin(r) === 'published' && artifactOrigin(old) === 'mentioned') || (!!r.deleted && !old.deleted)
  })
}
