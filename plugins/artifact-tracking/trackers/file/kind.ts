// The item kind of Markdown files (issue #28): its key, its record, and the counters a second sighting adds up.
// A file is track-only, so it has no refresh. Plan: L5 Task 4 (K17: the static item class goes). Task 5 adds `scan`;
// Task 8 the tool calls and the stat of a mention.

import type { Claim, ItemKind, Json, KindContext, ScanMode } from '../../core/interfaces/items'
import { foldRecords, type KindTable } from '../../core/lib/records'
import { FILE_DEFAULTS } from './config'
import { mdCandidates } from './files'
import type { FileActivity, FileRecord } from './types'

/** The item key of a Markdown file, `file:<path>`, where `path` is where the file landed (issue #28). */
export const fileKey = (path: string): string => `file:${path}`

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
    firstSeen: s.at,
    lastSeen: s.at,
    seenCount: 1,
  }
}

/**
 * The `.md` paths a prompt or reply names, as spelled: one `mentioned` claim each, at most `maxMentionsPerRow`. Path and
 * label hold the spelling here. The stat of the file, which re-keys the claim to where it landed, is Task 8's `accept`.
 */
function scanMentions(text: string, mode: ScanMode, ctx: KindContext): Claim[] {
  if (mode !== 'full') return []
  const max: Json | undefined = ctx.config.slice().maxMentionsPerRow
  return mdCandidates(text, typeof max === 'number' ? max : FILE_DEFAULTS.maxMentionsPerRow).map(name => ({
    category: 'file',
    key: fileKey(name),
    source: ctx.source,
    at: ctx.now,
    fields: { path: name, label: name, activity: 'mentioned', bySubagent: false },
  }))
}

const onlyFile: KindTable = category => (category === 'file' ? fileKind : undefined)

export const fileKind: ItemKind<FileRecord> = {
  category: 'file',
  rank: 80,
  scan: scanMentions,
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
}
