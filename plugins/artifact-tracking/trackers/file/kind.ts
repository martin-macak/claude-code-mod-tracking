// The item kind of files (issues #28 and #57): its key, its record, and the counters a second sighting adds up. A file is
// track-only, so it has no refresh. A successful Read, Write, Edit or NotebookEdit result is one sighting of the file it
// touched, of any type, and a Bash call that the engine reports as an edit, a create or a delete (`bashEditDiff`) is one
// sighting of each file it names. A name in a prompt or a reply is a mention, and `accept` keeps those that exist (and are
// not ignored). With `scope: "md"` only `.md` files count, as before issue #57.
// Plan: L5 Task 4 (K17: the static item class goes). Task 5 adds `scan`; Task 8 the tool calls and the stat of a mention.

import type { ToolCallEvent } from '../../core/interfaces/events'
import type { Claim, CoreReason, ItemKind, JsonObject, KindContext, ScanMode } from '../../core/interfaces/items'
import { dropReason, reasonSet } from '../../core/lib/reasons'
import { foldRecords, type KindTable } from '../../core/lib/records'
import { fileRank } from './activity'
import { bashTouches } from './bash'
import { FILE_DEFAULTS, type FileConfig } from './config'
import { type FileTouch, isMd, pathCandidates, touchFromToolResult } from './files'
import { fileRow } from './rows'
import { FileSight, type SightCache } from './sight'
import type { FileActivity, FileRecord } from './types'

/** The item key of a file, `file:<path>`, where `path` is where the file landed (issue #28). */
export const fileKey = (path: string): string => `file:${path}`

/** Why a file is tracked, by how it was touched: made it, edited it, removed it, read it, or only named it. */
const REASON_OF: Readonly<Record<FileActivity, CoreReason>> = {
  created: 'created',
  edited: 'updated',
  deleted: 'deleted',
  viewed: 'read',
  mentioned: 'mentioned',
}
export const fileReason = (activity: FileActivity): CoreReason => REASON_OF[activity]

/** What a file claim carries: where the file landed, the path as spelled, how it was touched and by whom. */
export type FileFields = { path: string; label: string; activity: FileActivity; bySubagent?: boolean }

/** The part of the config that a sighting reads: the scope, the Bash switch and the limit of mentions. */
export type FileSettings = Pick<FileConfig, 'scope' | 'bashEdits' | 'maxMentionsPerRow'>

/** Whatever holds the slice of the file config: a kind context or a tracker context. A value out of range reads as the default. */
export function settingsOf(ctx: { readonly config: { slice(): { readonly [key: string]: unknown } } }): FileSettings {
  const c = ctx.config.slice()
  return {
    scope: c.scope === 'md' ? 'md' : 'all',
    bashEdits: c.bashEdits !== false,
    maxMentionsPerRow: typeof c.maxMentionsPerRow === 'number' ? c.maxMentionsPerRow : FILE_DEFAULTS.maxMentionsPerRow,
  }
}

/** One sighting of a file: `path` is where it landed, `label` the absolute path as spelled (issue #28). */
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
    ...(hit.kind === 'deleted' ? { deleted: true as const } : {}),
    ...(hit.bySubagent ? { bySubagent: true as const } : {}),
    sources: [s.source],
    reasons: reasonSet(fileReason(hit.kind)),
    firstSeen: s.at,
    lastSeen: s.at,
    seenCount: 1,
  }
}

/**
 * The paths a prompt or reply names, as spelled: one `mentioned` claim each, at most `maxMentionsPerRow`. Path and
 * label hold the spelling here. The stat of the file, which re-keys the claim to where it landed, is `accept`.
 * Only conversation text counts: a lookup (`/track prio`, a PR body) names no file.
 */
function scanMentions(text: string, mode: ScanMode, ctx: KindContext): Claim[] {
  if (mode !== 'full' || ctx.purpose !== 'capture') return []
  const { maxMentionsPerRow, scope } = settingsOf(ctx)
  return pathCandidates(text, maxMentionsPerRow, scope).map(name => ({
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

/**
 * What one finished call touched: one file for a file tool, the files of `bashEditDiff` for Bash (when `bashEdits` is on), and
 * only `.md` files with `scope: "md"`. Any other tool touched nothing. The one place that decides it: the kind reads it for the
 * sighting, and the tracker reads it to start the type lookup.
 */
export function touchesOf(
  tool: string,
  ev: Pick<ToolCallEvent, 'result' | 'input'>,
  settings: Pick<FileSettings, 'scope' | 'bashEdits'>,
): readonly FileTouch[] {
  const touched =
    tool === 'Bash'
      ? settings.bashEdits
        ? bashTouches(ev.result)
        : []
      : [touchFromToolResult(tool, ev.result, ev.input)].flatMap(t => (t ? [t] : []))
  return settings.scope === 'all' ? touched : touched.filter(t => isMd(t.spelled))
}

/** A finished call: one sighting of each file it touched. */
const onTool =
  (tool: string) =>
  async (ev: ToolCallEvent, ctx: KindContext): Promise<readonly Claim[]> => {
    const touches = touchesOf(tool, ev, settingsOf(ctx))
    if (touches.length === 0) return []
    const sight = sightOf(ctx)
    const bySubagent = ev.agentId !== undefined
    const at = sight.at()
    const fctx = await sight.ctxFor(ev.agentId)
    // One stat for each file, in parallel: a Bash call can name up to 200 files, and the hook waits for them. The claims keep
    // the order of the touches.
    const recs = await Promise.all(
      touches.map(t => sight.sighting(fctx, t.spelled, t.kind, bySubagent, { source: 'tool', at })),
    )
    return recs.flatMap((rec, i) => (rec ? [claimOf(rec, touches[i]!.kind, bySubagent, 'tool', at)] : []))
  }

export const fileKind: ItemKind<FileRecord> = {
  category: 'file',
  rank: 80,
  scan: scanMentions,
  fromTool: {
    Write: onTool('Write'),
    Edit: onTool('Edit'),
    Read: onTool('Read'),
    NotebookEdit: onTool('NotebookEdit'),
    Bash: onTool('Bash'),
  },
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
    const rec = fileRecord({ path: f.path, label: f.label, kind: f.activity, bySubagent: f.bySubagent === true }, seen)
    return cur === null ? rec : (foldRecords(cur, rec, onlyFile) as FileRecord)
  },
  /**
   * Two sightings of one file: the counters add up, and `created` and `bySubagent` never go back. The file is deleted when the
   * sighting with the later `lastSeen` says so: a later create, edit, read or mention puts it back. A cached MIME type stays.
   */
  fold(winner, loser, out) {
    out.created = winner.created || loser.created
    out.edits = winner.edits + loser.edits
    out.views = winner.views + loser.views
    out.mentions = winner.mentions + loser.mentions
    if (winner.bySubagent || loser.bySubagent) out.bySubagent = true
    const mime = winner.mime ?? loser.mime
    if (mime !== undefined) out.mime = mime
    const later = loser.lastSeen >= winner.lastSeen ? loser : winner
    if (later.deleted) {
      out.deleted = true
      return out
    }
    delete out.deleted
    // The file is there: `deleted` is no reason to track it any more (the pane filters and views read the reasons).
    const reasons = dropReason(out.reasons, 'deleted')
    return reasons === undefined ? out : { ...out, reasons }
  },
  capOf: config => (typeof config.maxFiles === 'number' ? config.maxFiles : FILE_DEFAULTS.maxFiles),
  /** The cap drops a file that was only read first, then one that was only named, then one that was written. */
  capRank: fileRank,
  row: fileRow,
}
