// The item kind of Markdown files (issue #28): its key, its record, and the counters a second sighting adds up.
// A file is track-only, so it has no refresh. A successful Write, Edit or Read result is one sighting of the file it
// touched; a name in a prompt or a reply is a mention, and `accept` keeps those that exist (and are not ignored).
// Plan: L5 Task 4 (K17: the static item class goes). Task 5 adds `scan`; Task 8 the tool calls and the stat of a mention.

import type { ToolCallEvent } from '../../core/interfaces/events'
import type { Claim, CoreReason, ItemKind, Json, JsonObject, KindContext, ScanMode } from '../../core/interfaces/items'
import { reasonSet } from '../../core/lib/reasons'
import { foldRecords, type KindTable } from '../../core/lib/records'
import { FILE_DEFAULTS } from './config'
import { mdCandidates, touchFromToolResult } from './files'
import { fileRow } from './rows'
import { FileSight, type SightCache } from './sight'
import type { FileActivity, FileRecord } from './types'

/** The item key of a Markdown file, `file:<path>`, where `path` is where the file landed (issue #28). */
export const fileKey = (path: string): string => `file:${path}`

/** Why a file is tracked, by how it was touched: made it, edited it, read it, or only named it. */
export const fileReason = (activity: FileActivity): CoreReason =>
  activity === 'created' ? 'created' : activity === 'edited' ? 'updated' : activity === 'viewed' ? 'read' : 'mentioned'

/** What a file claim carries: where the file landed, the path as spelled, how it was touched and by whom. */
export type FileFields = { path: string; label: string; activity: FileActivity; bySubagent?: boolean }

/** One sighting of a Markdown file: `path` is where it landed, `label` the absolute path as spelled (issue #28). */
export function fileRecord(
  hit: { path: string; label: string; kind: FileActivity; bySubagent: boolean },
  s: { source: string; at: number },
): FileRecord {
  return {
    key: fileKey(hit.path),
    category: 'file',
    url: hit.path,
    label: hit.label,
    created: hit.kind === 'created',
    edits: hit.kind === 'edited' ? 1 : 0,
    views: hit.kind === 'viewed' ? 1 : 0,
    mentions: hit.kind === 'mentioned' ? 1 : 0,
    ...(hit.bySubagent ? { bySubagent: true as const } : {}),
    sources: [s.source],
    reasons: reasonSet(fileReason(hit.kind)),
    firstSeen: s.at,
    lastSeen: s.at,
    seenCount: 1,
  }
}

/**
 * The `.md` paths a prompt or reply names, as spelled: one `mentioned` claim each, at most `maxMentionsPerRow`. Path and
 * label hold the spelling here. The stat of the file, which re-keys the claim to where it landed, is `accept`.
 * Only conversation text counts: a lookup (`/track prio`, a PR body) names no file.
 */
function scanMentions(text: string, mode: ScanMode, ctx: KindContext): Claim[] {
  if (mode !== 'full' || ctx.purpose !== 'capture') return []
  const max: Json | undefined = ctx.config.slice().maxMentionsPerRow
  return mdCandidates(text, typeof max === 'number' ? max : FILE_DEFAULTS.maxMentionsPerRow).map(name => ({
    category: 'file',
    key: fileKey(name),
    source: ctx.source,
    reason: 'mentioned',
    at: ctx.now,
    fields: { path: name, label: name, activity: 'mentioned', bySubagent: false },
  }))
}

const onlyFile: KindTable = category => (category === 'file' ? fileKind : undefined)

// ---------------------------------------------------------------- sightings of the world

/** The environment (HOME, the config dir, the memory setting) is read once per load: the load's facts key its cache. */
const caches = new WeakMap<object, SightCache>()

function sightOf(ctx: KindContext): FileSight {
  let cache = caches.get(ctx.facts)
  if (!cache) {
    cache = {}
    caches.set(ctx.facts, cache)
  }
  return new FileSight({ env: ctx.env, fs: ctx.fs, session: ctx.session, facts: ctx.facts, clock: ctx.clock }, cache)
}

/** The claim of a record the sighting service made: where the file landed, the spelling, how it was touched. */
function claimOf(rec: FileRecord, activity: FileActivity, bySubagent: boolean, source: string, at: number): Claim {
  const fields: FileFields = { path: rec.url, label: rec.label, activity, ...(bySubagent ? { bySubagent } : {}) }
  return {
    category: 'file',
    key: rec.key,
    source,
    reason: fileReason(activity),
    at,
    fields: fields as unknown as JsonObject,
  }
}

/** A Write, Edit or Read result: one sighting of the file it touched. */
const onTool =
  (tool: 'Write' | 'Edit' | 'Read') =>
  async (ev: ToolCallEvent, ctx: KindContext): Promise<readonly Claim[]> => {
    const touch = touchFromToolResult(tool, ev.result)
    if (!touch) return []
    const sight = sightOf(ctx)
    const bySubagent = ev.agentId !== undefined
    const at = sight.at()
    const rec = await sight.sighting(await sight.ctxFor(ev.agentId), touch.spelled, touch.kind, bySubagent, {
      source: 'tool',
      at,
    })
    return rec ? [claimOf(rec, touch.kind, bySubagent, 'tool', at)] : []
  }

export const fileKind: ItemKind<FileRecord> = {
  category: 'file',
  rank: 80,
  scan: scanMentions,
  fromTool: { Write: onTool('Write'), Edit: onTool('Edit'), Read: onTool('Read') },
  /** A mention counts when the file is there and not ignored. The claim then names where the file landed. */
  async accept(claims, ctx) {
    const mentions = claims.filter(c => (c.fields as unknown as FileFields).activity === 'mentioned')
    if (mentions.length === 0) return claims
    const sight = sightOf(ctx)
    const fctx = await sight.ctxFor()
    const landed = new Map<Claim, Claim | null>()
    for (const c of mentions) {
      const rec = await sight.sighting(fctx, (c.fields as unknown as FileFields).path, 'mentioned', false, {
        source: ctx.source,
        at: c.at,
      })
      landed.set(c, rec && claimOf(rec, 'mentioned', false, c.source, c.at))
    }
    return claims.flatMap(c => (landed.has(c) ? (landed.get(c) ? [landed.get(c)!] : []) : [c]))
  },
  decode: item => (item.category === 'file' ? (item as FileRecord) : null),
  merge(cur, seen) {
    const f = seen.fields as unknown as FileFields
    // A Read alone never adds a row (today's `withoutLoneViews`).
    if (cur === null && f.activity === 'viewed') return null
    const rec = fileRecord({ path: f.path, label: f.label, kind: f.activity, bySubagent: f.bySubagent === true }, seen)
    return cur === null ? rec : (foldRecords(cur, rec, onlyFile) as FileRecord)
  },
  /** Two sightings of one file: the counters add up, and `created` and `bySubagent` never go back. */
  fold(winner, loser, out) {
    out.created = winner.created || loser.created
    out.edits = winner.edits + loser.edits
    out.views = winner.views + loser.views
    out.mentions = winner.mentions + loser.mentions
    if (winner.bySubagent || loser.bySubagent) out.bySubagent = true
    return out
  },
  row: fileRow,
}
