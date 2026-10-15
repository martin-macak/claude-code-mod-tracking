// Pure functions over lists of ItemRecord: keys, conversion, merge, dedupe, caps, re-key (spec 6.2, 10).
// No input list or record is mutated.

import type {
  FileActivity,
  FileRecord,
  GitHubRecord,
  GitHubRef,
  HydratedItem,
  ItemRecord,
  JiraRecord,
  JiraRef,
  Ref,
  RepoRef,
  Sighting,
  Source,
  Tools,
  WebRecord,
  WebRef,
} from '../contracts'
import { AUTO_SOURCES, LIMITS } from '../contracts'
import { FileItem } from './file-item'
import { GitHubItem } from './github-item'
import { cloneNodes, JiraItem } from './jira-item'
import { fileKey, keyOf } from './keys'
import { WebLink } from './web-link'

// ---------------------------------------------------------------- keys

// ---------------------------------------------------------------- record from ref

const githubUrl = (host: string, owner: string, repo: string, type: string, n: number): string =>
  `https://${host}/${owner}/${repo}/${type === 'pr' ? 'pull' : 'issues'}/${n}`

function githubRecord(ref: GitHubRef, s: Sighting): GitHubRecord {
  const base = { sources: [s.source], firstSeen: s.at, lastSeen: s.at, seenCount: 1 }
  const host = ref.host.toLowerCase()
  if (!ref.owner || !ref.repo) {
    return {
      key: keyOf(ref),
      category: 'github',
      url: ref.url ?? '',
      label: `#${ref.number}`,
      ...base,
      host,
      number: ref.number,
      type: ref.type,
    }
  }
  const owner = ref.owner.toLowerCase()
  const repo = ref.repo.toLowerCase()
  return {
    key: keyOf(ref),
    category: 'github',
    url: ref.url ?? githubUrl(host, owner, repo, ref.type, ref.number),
    label: `${owner}/${repo}#${ref.number}`,
    ...base,
    host,
    owner,
    repo,
    number: ref.number,
    type: ref.type,
  }
}

function jiraRecord(ref: JiraRef, s: Sighting): JiraRecord {
  return {
    key: keyOf(ref),
    category: 'jira',
    url: ref.url,
    label: ref.issueKey,
    sources: [s.source],
    firstSeen: s.at,
    lastSeen: s.at,
    seenCount: 1,
    site: ref.site,
    issueKey: ref.issueKey,
    trackOnly: ref.trackOnly,
    children: [],
  }
}

function webRecord(ref: WebRef, s: Sighting): WebRecord {
  return {
    key: keyOf(ref),
    category: 'web',
    url: ref.url,
    label: ref.label,
    sources: [s.source],
    firstSeen: s.at,
    lastSeen: s.at,
    seenCount: 1,
  }
}

export function recordFromRef(ref: Ref, s: Sighting): ItemRecord {
  switch (ref.category) {
    case 'github':
      return githubRecord(ref, s)
    case 'jira':
      return jiraRecord(ref, s)
    case 'web':
      return webRecord(ref, s)
  }
}

// ---------------------------------------------------------------- helpers

function cloneRecord<R extends ItemRecord>(rec: R): R {
  const out = { ...rec, sources: [...rec.sources] } as R
  if (rec.error) out.error = { ...rec.error }
  if (rec.via) out.via = [...rec.via]
  if (out.category === 'jira') out.children = cloneNodes((rec as JiraRecord).children)
  return out
}

const unionSources = (a: readonly Source[], b: readonly Source[]): Source[] => [...new Set([...a, ...b])]

const hasAutoSource = (rec: ItemRecord): boolean => rec.sources.some(s => AUTO_SOURCES.has(s))

/**
 * Drops the records with the smallest lastSeen until `cap` is met. Keys in `keep` never go.
 * Only records without an auto source count against `cap`, and only they are evicted (spec A11):
 * auto-only items have their own cap, `maxAutoItems`, enforced at the source.
 */
export function enforceCap(list: ItemRecord[], cap: number, keep: ReadonlySet<string> = new Set()): ItemRecord[] {
  const excess = list.filter(rec => !hasAutoSource(rec)).length - cap
  if (excess <= 0) return list
  const victims = list
    .map((rec, i) => ({ rec, i }))
    .filter(({ rec }) => !hasAutoSource(rec) && !keep.has(rec.key))
    .sort((x, y) => x.rec.lastSeen - y.rec.lastSeen || x.i - y.i)
    .slice(0, excess)
    .map(({ i }) => i)
  const drop = new Set(victims)
  return list.filter((_, i) => !drop.has(i))
}

/**
 * Folds sightings of `b` into `a`: union of sources (a first), sum of seenCount, min firstSeen, max lastSeen.
 * Status fields come from the record with the newer `refreshedAt`. A tie keeps `a`.
 */
function fold(a: ItemRecord, b: ItemRecord): ItemRecord {
  const winner = (b.refreshedAt ?? -Infinity) > (a.refreshedAt ?? -Infinity) ? b : a
  const loser = winner === a ? b : a
  const out = cloneRecord(winner)
  out.sources = unionSources(a.sources, b.sources)
  const via = [...new Set([...(a.via ?? []), ...(b.via ?? [])])]
  if (via.length > 0) out.via = via
  else delete out.via
  out.seenCount = a.seenCount + b.seenCount
  out.firstSeen = Math.min(a.firstSeen, b.firstSeen)
  out.lastSeen = Math.max(a.lastSeen, b.lastSeen)
  if (out.category === 'github' && out.type === 'unknown' && loser.category === 'github') out.type = loser.type
  return out
}

// ---------------------------------------------------------------- merge

export function mergeRefs(
  list: readonly ItemRecord[],
  refs: readonly Ref[],
  s: Sighting,
  cap: number = LIMITS.maxItems,
): { list: ItemRecord[]; added: string[] } {
  const out: ItemRecord[] = list.map(cloneRecord)
  const index = new Map<string, number>(out.map((r, i) => [r.key, i]))
  const added: string[] = []
  for (const ref of refs) {
    const key = keyOf(ref)
    const at = index.get(key)
    if (at === undefined) {
      index.set(key, out.length)
      out.push(recordFromRef(ref, s))
      added.push(key)
      continue
    }
    const rec = out[at]!
    if (!rec.sources.includes(s.source)) rec.sources.push(s.source)
    rec.seenCount += 1
    rec.lastSeen = s.at
    if (rec.category === 'github' && ref.category === 'github' && rec.type === 'unknown') rec.type = ref.type
  }
  return { list: enforceCap(out, cap, new Set(added)), added }
}

/** One sighting of a Markdown file: `path` is where it landed, `label` the absolute path as spelled (issue #28). */
export function recordFromFile(
  hit: { path: string; label: string; kind: FileActivity; bySubagent: boolean },
  s: Sighting,
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

/** `fold` for two sightings of one file: the counters add up, and `created` and `bySubagent` never go back. */
function foldFile(a: FileRecord, b: FileRecord): FileRecord {
  const out = fold(a, b) as FileRecord // no file refreshes, so `a` wins the tie: its label and url stay
  out.created = a.created || b.created
  out.edits = a.edits + b.edits
  out.views = a.views + b.views
  out.mentions = a.mentions + b.mentions
  if (a.bySubagent || b.bySubagent) out.bySubagent = true
  return out
}

/**
 * Adds file rows, or folds each into the row with the same key. The cap drops the smallest lastSeen, never a row
 * this call added. No rows: the list itself comes back (A22).
 */
export function mergeFiles(
  list: readonly ItemRecord[],
  recs: readonly FileRecord[],
  cap: number = LIMITS.maxItems,
): ItemRecord[] {
  if (recs.length === 0) return list as ItemRecord[]
  const out: ItemRecord[] = list.map(cloneRecord)
  const index = new Map<string, number>(out.map((r, i) => [r.key, i]))
  const added = new Set<string>()
  for (const rec of recs) {
    const at = index.get(rec.key)
    if (at === undefined) {
      index.set(rec.key, out.length)
      out.push(cloneRecord(rec))
      added.add(rec.key)
      continue
    }
    const old = out[at]!
    if (old.category === 'file') out[at] = foldFile(old, rec)
  }
  return enforceCap(out, cap, added)
}

/** Status fields a refresh writes, per category. */
const STATUS_FIELDS = {
  github: ['title', 'state', 'stateReason', 'isDraft', 'reviewDecision', 'checks'],
  jira: ['summary', 'issueType', 'status', 'statusCategory'],
  web: [],
  file: [],
} as const

export function mergeResults(list: readonly ItemRecord[], refreshed: readonly ItemRecord[]): ItemRecord[] {
  const byKey = new Map(refreshed.map(r => [r.key, r]))
  const removed = new Set(refreshed.filter(r => r.error?.kind === 'not-found').map(r => r.key))
  return list.flatMap(rec => {
    if (removed.has(rec.key)) return []
    const fresh = byKey.get(rec.key)
    const out = cloneRecord(rec)
    if (!fresh) return out
    const dst = out as unknown as Record<string, unknown>
    const src = fresh as unknown as Record<string, unknown>
    for (const f of STATUS_FIELDS[out.category]) if (src[f] !== undefined) dst[f] = src[f]
    if (
      out.category === 'github' &&
      fresh.category === 'github' &&
      (out.type === 'unknown' || fresh.type !== 'unknown')
    )
      out.type = fresh.type
    if (out.category === 'jira' && fresh.category === 'jira') out.children = cloneNodes(fresh.children)
    if (fresh.refreshedAt !== undefined) out.refreshedAt = fresh.refreshedAt
    if (fresh.error) out.error = { ...fresh.error }
    else delete out.error
    return [out]
  })
}

// ---------------------------------------------------------------- bare #N

export function resolveBareRefs(list: readonly ItemRecord[], repo: RepoRef): ItemRecord[] {
  const host = repo.host.toLowerCase()
  const owner = repo.owner.toLowerCase()
  const name = repo.repo.toLowerCase()
  const out: (ItemRecord | null)[] = list.map(cloneRecord)
  const index = new Map<string, number>()
  out.forEach((r, i) => {
    if (r && !r.key.startsWith('gh:?#')) index.set(r.key, i)
  })
  out.forEach((rec, i) => {
    if (rec?.category !== 'github' || !rec.key.startsWith('gh:?#')) return
    const key = `gh:${host}/${owner}/${name}#${rec.number}`
    const moved: GitHubRecord = {
      ...rec,
      key,
      host,
      owner,
      repo: name,
      label: `${owner}/${name}#${rec.number}`,
      url: githubUrl(host, owner, name, rec.type, rec.number),
    }
    const at = index.get(key)
    if (at === undefined) {
      out[i] = moved
      index.set(key, i)
    } else {
      out[at] = fold(out[at]!, moved)
      out[i] = null
    }
  })
  return out.filter((r): r is ItemRecord => r !== null)
}

/** Merge for `/clear` carry-over: fold records with the same key, then cap. */
export function unionRecords(
  a: readonly ItemRecord[],
  b: readonly ItemRecord[],
  cap: number = LIMITS.maxItems,
): ItemRecord[] {
  const out: ItemRecord[] = []
  const index = new Map<string, number>()
  for (const rec of [...a, ...b]) {
    const at = index.get(rec.key)
    if (at === undefined) {
      index.set(rec.key, out.length)
      out.push(cloneRecord(rec))
    } else {
      out[at] = fold(out[at]!, rec)
    }
  }
  return enforceCap(out, cap)
}

// ---------------------------------------------------------------- classes

export function hydrate(rec: ItemRecord, tools: Tools): HydratedItem {
  switch (rec.category) {
    case 'github':
      return new GitHubItem(rec, tools.gh)
    case 'jira':
      return new JiraItem(rec, tools.acli)
    case 'web':
      return new WebLink(rec)
    case 'file':
      return new FileItem(rec)
  }
}
