// Registry: keys, record conversion, merge, dedupe, caps, re-key, carry-over, hydrate. Pure.
import { expect, test } from 'claude-code/testing'
import { PAGE_CODE_URL, PAGE_ID, PAGE_KEY, PAGE_URL, PAGE_UUID, PAIRS } from './fixtures/artifacts'
import type {
  ArtifactRecord,
  ArtifactRef,
  FileActivity,
  FileRecord,
  GitHubRecord,
  GitHubRef,
  GitHubToolApi,
  ItemRecord,
  JiraNode,
  JiraRecord,
  JiraRef,
  JiraToolApi,
  ToolStatus,
  WebRecord,
  WebRef,
} from './fixtures/contracts'
import { artifactOrigin, fileKey, keyOf } from './fixtures/keys'
import { LIMITS } from './fixtures/limits'
import {
  carryOver,
  hydrate,
  markArtifactDeleted,
  mergeFiles,
  mergeRefs,
  mergeResults,
  recordFromFile,
  recordFromRef,
  rekeyArtifacts,
  resolveBareRefs,
  unionRecords,
} from './fixtures/registry'

const ghRef = (over: Partial<GitHubRef> = {}): GitHubRef => ({
  category: 'github',
  host: 'github.com',
  owner: 'acme',
  repo: 'web',
  number: 5,
  type: 'pr',
  ...over,
})
const jiraRef = (over: Partial<JiraRef> = {}): JiraRef => ({
  category: 'jira',
  site: 'Acme.Atlassian.net',
  issueKey: 'ISS-1',
  url: 'https://Acme.Atlassian.net/browse/ISS-1',
  trackOnly: false,
  ...over,
})
const webRef = (over: Partial<WebRef> = {}): WebRef => ({
  category: 'web',
  url: 'https://X.example/a#frag',
  label: 'X doc',
  ...over,
})
/** A mention of the observed page, by its base58 URL. */
const artifactRef = (over: Partial<ArtifactRef> = {}): ArtifactRef => ({
  category: 'artifact',
  uuid: PAGE_UUID,
  url: PAGE_URL,
  label: PAGE_ID,
  ...over,
})
/** The same page by its UUID URL, as the claude.ai/code app links it. */
const codeRef = (over: Partial<ArtifactRef> = {}): ArtifactRef =>
  artifactRef({ url: PAGE_CODE_URL, label: PAGE_UUID, ...over })
/** What a publish of the page gives: its title. */
const publishRef = (over: Partial<ArtifactRef> = {}): ArtifactRef =>
  artifactRef({ label: 'Probe Page 29', titled: true, ...over })
const s = (at: number, source: 'prompt' | 'response' | 'tool' | 'publish' = 'prompt') => ({ source, at })
const art = (list: readonly ItemRecord[]): ArtifactRecord => list[0] as ArtifactRecord
const unresolved = (n: number): GitHubRef => ({ category: 'github', host: 'github.com', number: n, type: 'unknown' })

test('keyOf: github resolved lower-cases host, owner, repo', () => {
  expect(keyOf(ghRef({ host: 'GitHub.com', owner: 'ACME', repo: 'Web' }))).toBe('gh:github.com/acme/web#5')
})
test('keyOf: github unresolved', () => {
  expect(keyOf(unresolved(7))).toBe('gh:?#7')
})
test('keyOf: jira lower-cases the site only', () => {
  expect(keyOf(jiraRef())).toBe('jira:acme.atlassian.net/ISS-1')
})
test('keyOf: web drops the fragment and normalizes the URL', () => {
  expect(keyOf(webRef())).toBe('web:https://x.example/a')
  expect(keyOf(webRef({ url: 'https://x.example/a' }))).toBe('web:https://x.example/a')
})
test('keyOf: an artifact is keyed by its UUID, so both URL forms share a key', () => {
  expect(keyOf(artifactRef())).toBe(PAGE_KEY)
  expect(keyOf(codeRef())).toBe(PAGE_KEY)
  for (const [, uuid] of PAIRS) expect(keyOf(artifactRef({ uuid }))).toBe(`art:${uuid}`)
})

test('recordFromRef: github pr and issue URL fall back to host/owner/repo', () => {
  const pr = recordFromRef(ghRef(), s(10)) as GitHubRecord
  expect(pr).toMatchObject({
    key: 'gh:github.com/acme/web#5',
    category: 'github',
    url: 'https://github.com/acme/web/pull/5',
    label: 'acme/web#5',
    sources: ['prompt'],
    firstSeen: 10,
    lastSeen: 10,
    seenCount: 1,
    number: 5,
    type: 'pr',
  })
  expect(recordFromRef(ghRef({ type: 'issue' }), s(1)).url).toBe('https://github.com/acme/web/issues/5')
  expect(recordFromRef(ghRef({ type: 'unknown' }), s(1)).url).toBe('https://github.com/acme/web/issues/5')
})
test('recordFromRef: github keeps the URL as written', () => {
  expect(recordFromRef(ghRef({ url: 'https://github.com/acme/web/pull/5/files' }), s(1)).url).toBe(
    'https://github.com/acme/web/pull/5/files',
  )
})
test('recordFromRef: unresolved github has empty url and #N label', () => {
  const r = recordFromRef(unresolved(9), s(1)) as GitHubRecord
  expect(r).toMatchObject({ key: 'gh:?#9', url: '', label: '#9' })
  expect('owner' in r).toBe(false)
})
test('recordFromRef: jira label is the key, children empty', () => {
  const r = recordFromRef(jiraRef({ trackOnly: true }), s(1)) as JiraRecord
  expect(r).toMatchObject({
    key: 'jira:acme.atlassian.net/ISS-1',
    label: 'ISS-1',
    children: [],
    trackOnly: true,
    issueKey: 'ISS-1',
    site: 'Acme.Atlassian.net',
  })
})
test('recordFromRef: web label is ref.label', () => {
  expect(recordFromRef(webRef(), s(1, 'response'))).toMatchObject({
    key: 'web:https://x.example/a',
    label: 'X doc',
    sources: ['response'],
  })
})
test('recordFromRef: artifact keeps URL and label; the origin follows the source', () => {
  const mention = recordFromRef(artifactRef(), s(1, 'response'))
  expect(mention).toEqual({
    key: PAGE_KEY,
    category: 'artifact',
    url: PAGE_URL,
    label: PAGE_ID,
    sources: ['response'],
    firstSeen: 1,
    lastSeen: 1,
    seenCount: 1,
  })
  expect(artifactOrigin(mention)).toBe('mentioned')
  expect(artifactOrigin(recordFromRef(publishRef(), s(1, 'publish')))).toBe('published')
})

test('mergeRefs: URL and bare #N for the same item end as one record (Review Focus 2)', () => {
  const urlRef = ghRef({ owner: 'ACME', repo: 'Web', type: 'issue', url: 'https://github.com/ACME/Web/issues/5' })
  const bare = ghRef({ owner: 'acme', repo: 'web', type: 'unknown' }) // bare #5, already resolved to the session repo
  const a = mergeRefs([], [urlRef], s(1))
  const b = mergeRefs(a.list, [bare], s(2, 'response'))
  expect(b.list.length).toBe(1)
  expect(b.added).toEqual([])
  expect(b.list[0]).toMatchObject({
    seenCount: 2,
    lastSeen: 2,
    firstSeen: 1,
    sources: ['prompt', 'response'],
    type: 'issue',
  })
})
test('mergeRefs: known key adds source once and bumps counts', () => {
  const a = mergeRefs([], [webRef()], s(1)).list
  const b = mergeRefs(a, [webRef()], s(5)).list
  expect(b[0]).toMatchObject({ sources: ['prompt'], seenCount: 2, lastSeen: 5, firstSeen: 1 })
})
test('mergeRefs: an unknown type takes a known type, a known type is kept', () => {
  const a = mergeRefs([], [ghRef({ type: 'unknown' })], s(1)).list
  const b = mergeRefs(a, [ghRef({ type: 'pr' })], s(2)).list
  expect((b[0] as GitHubRecord).type).toBe('pr')
  const c = mergeRefs(b, [ghRef({ type: 'unknown' })], s(3)).list
  expect((c[0] as GitHubRecord).type).toBe('pr')
})
test('mergeRefs: new key is appended and reported in added; input list is not mutated', () => {
  const a = mergeRefs([], [webRef()], s(1)).list
  const copy = JSON.parse(JSON.stringify(a)) as ItemRecord[]
  const b = mergeRefs(a, [webRef({ url: 'https://y.example/' }), jiraRef()], s(2))
  expect(b.added).toEqual(['web:https://y.example/', 'jira:acme.atlassian.net/ISS-1'])
  expect(b.list.length).toBe(3)
  expect(a).toEqual(copy)
})
test('mergeRefs: the same ref twice in one call is one record', () => {
  const r = mergeRefs([], [webRef(), webRef()], s(1))
  expect(r.list.length).toBe(1)
  expect(r.added).toEqual(['web:https://x.example/a'])
})
test('mergeRefs: cap drops the smallest lastSeen, never a record added in this call', () => {
  const old = (n: number, at: number): ItemRecord => recordFromRef(webRef({ url: `https://o${n}.example/` }), s(at))
  const list = [old(1, 50), old(2, 10), old(3, 30)]
  const r = mergeRefs(list, [webRef({ url: 'https://new.example/' })], s(1), 3) // new lastSeen is the smallest of all
  expect(r.list.map(x => x.key).sort()).toEqual([
    'web:https://new.example/',
    'web:https://o1.example/',
    'web:https://o3.example/',
  ])
})
test('mergeRefs: default cap is LIMITS.maxItems', () => {
  let list: ItemRecord[] = []
  for (let i = 0; i < LIMITS.maxItems; i++)
    list = mergeRefs(list, [webRef({ url: `https://h${i}.example/` })], s(i + 1)).list
  const r = mergeRefs(list, [webRef({ url: 'https://extra.example/' })], s(0))
  expect(r.list.length).toBe(LIMITS.maxItems)
  expect(r.list.some(x => x.key === 'web:https://extra.example/')).toBe(true)
  expect(r.list.some(x => x.key === 'web:https://h0.example/')).toBe(false)
})

const fileRec = (name: string, at: number, kind: FileActivity = 'created', bySubagent = false): FileRecord =>
  recordFromFile({ path: `/work/${name}.md`, label: `/work/${name}.md`, kind, bySubagent }, s(at))

test('recordFromFile: one activity sets one counter; the key is file:<path>', () => {
  expect(fileRec('a', 1)).toEqual({
    key: 'file:/work/a.md',
    category: 'file',
    url: '/work/a.md',
    label: '/work/a.md',
    created: true,
    edits: 0,
    views: 0,
    mentions: 0,
    sources: ['prompt'],
    firstSeen: 1,
    lastSeen: 1,
    seenCount: 1,
  })
  expect(fileRec('a', 1, 'edited')).toMatchObject({ created: false, edits: 1, views: 0, mentions: 0 })
  expect(fileRec('a', 1, 'viewed')).toMatchObject({ created: false, edits: 0, views: 1, mentions: 0 })
  expect(fileRec('a', 1, 'mentioned', true)).toMatchObject({ mentions: 1, bySubagent: true })
  expect(fileKey('/work/a.md')).toBe('file:/work/a.md')
})
test('mergeFiles: the cap drops the smallest lastSeen and keeps the new file row', () => {
  const old = (n: number, at: number): ItemRecord => recordFromRef(webRef({ url: `https://o${n}.example/` }), s(at))
  const list = [old(1, 50), old(2, 10), old(3, 30)]
  const r = mergeFiles(list, [fileRec('new', 1)], 3) // the new row has the smallest lastSeen of all
  expect(r.map(x => x.key).sort()).toEqual(['file:/work/new.md', 'web:https://o1.example/', 'web:https://o3.example/'])
})
test('mergeFiles: default cap is LIMITS.maxItems', () => {
  let list: ItemRecord[] = []
  for (let i = 0; i < LIMITS.maxItems; i++) list = mergeFiles(list, [fileRec(`f${i}`, i + 1)])
  const r = mergeFiles(list, [fileRec('extra', 0)])
  expect(r.length).toBe(LIMITS.maxItems)
  expect(r.some(x => x.key === 'file:/work/extra.md')).toBe(true)
  expect(r.some(x => x.key === 'file:/work/f0.md')).toBe(false)
})
test('mergeFiles: counters add up, created stays true, first label and firstSeen stay', () => {
  let list = mergeFiles([], [fileRec('a', 1, 'edited')])
  list = mergeFiles(list, [fileRec('a', 3, 'created'), fileRec('a', 4, 'viewed'), fileRec('a', 5, 'edited')])
  list = mergeFiles(list, [fileRec('a', 6, 'mentioned'), fileRec('a', 7, 'viewed')])
  expect(list).toHaveLength(1)
  expect(list[0]).toMatchObject({ created: true, edits: 2, views: 2, mentions: 1, firstSeen: 1, lastSeen: 7 })
  expect(list[0]).toMatchObject({ seenCount: 6, label: '/work/a.md' })
  expect((list[0] as FileRecord).bySubagent).toBeUndefined()
})
test('mergeFiles: one subagent touch marks the row for good', () => {
  let list = mergeFiles([], [fileRec('a', 1, 'created', true)])
  list = mergeFiles(list, [fileRec('a', 2, 'edited')])
  expect(list[0]).toMatchObject({ bySubagent: true, edits: 1 })
})
test('mergeFiles: no input rows returns the list itself; the input list is never changed', () => {
  const list = mergeFiles([], [fileRec('a', 1)])
  expect(mergeFiles(list, [])).toBe(list)
  const before = JSON.stringify(list)
  mergeFiles(list, [fileRec('a', 2, 'edited')])
  expect(JSON.stringify(list)).toBe(before)
})

test('mergeRefs: a UUID mention, then a base58 publish of the same artifact, is one published item', () => {
  const first = mergeRefs([], [codeRef()], s(1, 'response')).list
  const { list, added } = mergeRefs(first, [publishRef()], s(2, 'publish'))
  expect(added).toEqual([])
  expect(list).toHaveLength(1)
  expect(artifactOrigin(art(list))).toBe('published')
  expect(art(list).label).toBe('Probe Page 29')
  expect(art(list).url).toBe(PAGE_URL) // the URL the tool returned
  expect(art(list).seenCount).toBe(2)
})

test('mergeRefs: a publish, then a labelled mention, keeps the title and stays published', () => {
  const first = mergeRefs([], [publishRef()], s(1, 'publish')).list
  const list = mergeRefs(first, [codeRef({ label: 'Design notes' })], s(2, 'response')).list
  expect(list).toHaveLength(1)
  expect(artifactOrigin(art(list))).toBe('published')
  expect(art(list).label).toBe('Probe Page 29')
  expect(art(list).url).toBe(PAGE_URL)
})

test('mergeRefs: an untitled publish keeps the title; a titled one replaces it', () => {
  const first = mergeRefs([], [publishRef()], s(1, 'publish')).list
  const upload = mergeRefs(first, [artifactRef()], s(2, 'publish')).list // an asset upload: no title
  expect(art(upload).label).toBe('Probe Page 29')
  const renamed = mergeRefs(upload, [publishRef({ label: 'Probe Page 30' })], s(3, 'publish')).list
  expect(art(renamed).label).toBe('Probe Page 30')
})

test('mergeRefs: a Markdown label replaces the id of a mentioned artifact, never another label', () => {
  const first = mergeRefs([], [artifactRef()], s(1, 'response')).list
  const named = mergeRefs(first, [codeRef({ label: 'Design notes' })], s(2, 'response')).list
  expect(art(named).label).toBe('Design notes')
  const again = mergeRefs(named, [artifactRef({ label: 'Other words' })], s(3, 'prompt')).list
  expect(art(again).label).toBe('Design notes')
  expect(artifactOrigin(art(again))).toBe('mentioned')
})

test('mergeRefs: a deleted artifact stays deleted after a new sighting', () => {
  const first = markArtifactDeleted(mergeRefs([], [publishRef()], s(1, 'publish')).list, PAGE_KEY)
  const list = mergeRefs(first, [artifactRef()], s(2, 'response')).list
  expect(art(list).deleted).toBe(true)
})

test('mergeResults: takes status fields, keeps sightings, clears an absent error', () => {
  const base = {
    ...(recordFromRef(ghRef(), s(1)) as GitHubRecord),
    seenCount: 4,
    lastSeen: 9,
    sources: ['prompt', 'tool'] as GitHubRecord['sources'],
    error: { kind: 'failed' as const, message: 'x', at: 1 },
  }
  const refreshed: GitHubRecord = {
    ...(recordFromRef(ghRef(), s(1)) as GitHubRecord),
    label: 'WRONG',
    url: 'WRONG',
    seenCount: 1,
    lastSeen: 1,
    sources: ['response'],
    title: 'T',
    state: 'open',
    stateReason: 'X',
    isDraft: true,
    reviewDecision: 'APPROVED',
    checks: 'failure',
    refreshedAt: 100,
  }
  const out = mergeResults([base], [refreshed])
  expect(out.length).toBe(1)
  const r = out[0] as GitHubRecord
  expect(r).toMatchObject({
    title: 'T',
    state: 'open',
    stateReason: 'X',
    isDraft: true,
    reviewDecision: 'APPROVED',
    checks: 'failure',
    refreshedAt: 100,
    seenCount: 4,
    lastSeen: 9,
    sources: ['prompt', 'tool'],
    label: 'acme/web#5',
    url: 'https://github.com/acme/web/pull/5',
  })
  expect('error' in r).toBe(false)
})
test('mergeResults: a child keeps the priority the list holds, even when the refresh was fetched earlier', () => {
  const child = (key: string, priority: 'high' | 'low' | 'normal', children: JiraNode[] = []): JiraNode => ({
    key,
    priority,
    summary: key,
    issueType: 'Task',
    status: 'To Do',
    children,
  })
  const base = {
    ...(recordFromRef(jiraRef(), s(1)) as JiraRecord),
    children: [child('A-1', 'high', [child('A-2', 'low')]), child('A-3', 'normal')],
  }
  // A fetched tree carries no mark: acli knows nothing of the person's levels.
  const fresh = (key: string, children: JiraNode[] = []): JiraNode => ({
    key,
    summary: key,
    issueType: 'Task',
    status: 'To Do',
    children,
  })
  const refreshed: JiraRecord = {
    ...base,
    children: [fresh('A-1', [fresh('A-2')]), fresh('A-3'), fresh('A-4')],
    refreshedAt: 100,
  }
  const out = mergeResults([base], [refreshed])[0] as JiraRecord
  expect(out.children.map(c => [c.key, c.priority])).toEqual([
    ['A-1', 'high'],
    ['A-3', 'normal'],
    ['A-4', undefined],
  ])
  expect(out.children[0]?.children.map(c => [c.key, c.priority])).toEqual([['A-2', 'low']])
})

test('mergeResults: drops records refreshed as not-found', () => {
  const base = recordFromRef(jiraRef(), s(1)) as JiraRecord
  const refreshed: JiraRecord = {
    ...base,
    summary: 'S',
    issueType: 'Epic',
    status: 'Done',
    statusCategory: 'done',
    refreshedAt: 5,
    children: [{ key: 'ISS-2', summary: 'c', issueType: 'Story', status: 'To Do', children: [] }],
    error: { kind: 'not-found', message: 'gone', at: 5 },
  }
  expect(mergeResults([base], [refreshed])).toEqual([])
})

test('mergeResults: keeps non-not-found errors', () => {
  const base = recordFromRef(jiraRef(), s(1)) as JiraRecord
  const refreshed: JiraRecord = {
    ...base,
    summary: 'S',
    issueType: 'Epic',
    status: 'Done',
    statusCategory: 'done',
    refreshedAt: 5,
    children: [{ key: 'ISS-2', summary: 'c', issueType: 'Story', status: 'To Do', children: [] }],
    error: { kind: 'failed', message: 'forbidden', at: 5 },
  }
  const r = mergeResults([base], [refreshed])[0] as JiraRecord
  expect(r.error).toMatchObject({ kind: 'failed', message: 'forbidden' })
  expect(r.children.length).toBe(1)
})
test('mergeResults: drops refreshed records whose key is gone; keeps untouched records', () => {
  const a = recordFromRef(webRef(), s(1))
  const b = recordFromRef(webRef({ url: 'https://b.example/' }), s(1))
  const out = mergeResults([a], [b])
  expect(out.map(x => x.key)).toEqual([a.key])
})
test('mergeResults: github type from refresh wins (unknown to pr)', () => {
  const base = recordFromRef(ghRef({ type: 'unknown' }), s(1))
  const refreshed = { ...base, type: 'pr' as const, refreshedAt: 2 }
  expect((mergeResults([base], [refreshed])[0] as GitHubRecord).type).toBe('pr')
})

test('resolveBareRefs: re-keys an unresolved record', () => {
  const list = mergeRefs([], [unresolved(5)], s(3)).list
  const out = resolveBareRefs(list, { host: 'GitHub.com', owner: 'Acme', repo: 'Web' })
  expect(out.length).toBe(1)
  expect(out[0]).toMatchObject({
    key: 'gh:github.com/acme/web#5',
    host: 'github.com',
    owner: 'acme',
    repo: 'web',
    label: 'acme/web#5',
    url: 'https://github.com/acme/web/issues/5',
  })
})
test('resolveBareRefs: uses pull in the URL for a pr', () => {
  const rec = { ...(recordFromRef(unresolved(5), s(1)) as GitHubRecord), type: 'pr' as const }
  expect(resolveBareRefs([rec], { host: 'github.com', owner: 'a', repo: 'b' })[0]!.url).toBe(
    'https://github.com/a/b/pull/5',
  )
})
test('resolveBareRefs: folds into an existing target', () => {
  const target = {
    ...(recordFromRef(ghRef({ type: 'issue' }), s(10)) as GitHubRecord),
    sources: ['response' as const],
    seenCount: 2,
    lastSeen: 20,
    title: 'kept',
    refreshedAt: 5,
  }
  const bare = {
    ...(recordFromRef(unresolved(5), s(3)) as GitHubRecord),
    sources: ['prompt' as const],
    seenCount: 3,
    lastSeen: 15,
  }
  const out = resolveBareRefs([bare, target], { host: 'github.com', owner: 'acme', repo: 'web' })
  expect(out.length).toBe(1)
  expect(out[0]).toMatchObject({
    key: target.key,
    sources: ['response', 'prompt'],
    seenCount: 5,
    firstSeen: 3,
    lastSeen: 20,
    title: 'kept',
  })
})
test('resolveBareRefs: leaves other records alone and does not mutate input', () => {
  const w = recordFromRef(webRef(), s(1))
  const bare = recordFromRef(unresolved(5), s(1))
  const copy = JSON.parse(JSON.stringify([w, bare])) as ItemRecord[]
  const out = resolveBareRefs([w, bare], { host: 'github.com', owner: 'a', repo: 'b' })
  expect(out[0]).toEqual(w)
  expect([w, bare]).toEqual(copy)
})

/** A row that an older version stored as a web link (R13). */
const oldWeb = (url: string, label: string, at = 1): WebRecord => ({
  ...(recordFromRef({ category: 'web', url, label }, s(at, 'response')) as WebRecord),
  via: ['gh:github.com/acme/web#9'],
})

test('rekeyArtifacts: an old web row of an artifact URL becomes an artifact row', () => {
  const [id2, uuid2] = PAIRS[1]
  const named = oldWeb(PAGE_URL, 'Design notes')
  const host = oldWeb(`https://claude.ai/artifact/${id2}`, `claude.ai/artifact/${id2}`)
  const other = recordFromRef(webRef(), s(1))
  const input = [named, other, host]
  const copy = JSON.parse(JSON.stringify(input)) as ItemRecord[]
  const out = rekeyArtifacts(input)
  expect(out.map(r => r.key)).toEqual([PAGE_KEY, keyOf(webRef()), `art:${uuid2}`])
  expect(out[0]).toEqual({
    key: PAGE_KEY,
    category: 'artifact',
    url: PAGE_URL,
    label: 'Design notes',
    sources: ['response'],
    firstSeen: 1,
    lastSeen: 1,
    seenCount: 1,
    via: ['gh:github.com/acme/web#9'],
  })
  expect(out[2]!.label).toBe(id2) // the host-and-path fallback becomes the id
  expect(out[1]).toEqual(other)
  expect(input).toEqual(copy)
})

test('rekeyArtifacts: an old row folds into its artifact twin, which stays published', () => {
  const twin = recordFromRef(publishRef(), s(5, 'publish'))
  const out = rekeyArtifacts([twin, oldWeb(PAGE_CODE_URL, PAGE_CODE_URL, 2)])
  expect(out).toHaveLength(1)
  expect(artifactOrigin(art(out))).toBe('published')
  expect(art(out).label).toBe('Probe Page 29')
  expect(art(out).seenCount).toBe(2)
})

test('rekeyArtifacts: returns the input list when nothing moves', () => {
  const list = [recordFromRef(webRef(), s(1)), recordFromRef(artifactRef(), s(1)), oldWeb('https://claude.ai/new', 'x')]
  expect(rekeyArtifacts(list)).toBe(list)
})

test('unionRecords: folds sightings and takes status from the newer refresh', () => {
  const a = {
    ...(recordFromRef(ghRef(), s(1)) as GitHubRecord),
    sources: ['prompt' as const],
    seenCount: 2,
    lastSeen: 5,
    title: 'old',
    state: 'open' as const,
    refreshedAt: 10,
  }
  const b = {
    ...(recordFromRef(ghRef(), s(3)) as GitHubRecord),
    sources: ['tool' as const],
    seenCount: 1,
    lastSeen: 8,
    title: 'new',
    state: 'merged' as const,
    refreshedAt: 20,
  }
  const out = unionRecords([a], [b])
  expect(out.length).toBe(1)
  expect(out[0]).toMatchObject({
    title: 'new',
    state: 'merged',
    refreshedAt: 20,
    seenCount: 3,
    firstSeen: 1,
    lastSeen: 8,
    sources: ['prompt', 'tool'],
  })
})
test('unionRecords: a refreshed record beats a never-refreshed one; other keys stay', () => {
  const a = { ...(recordFromRef(ghRef(), s(1)) as GitHubRecord), title: 'T', refreshedAt: 1 }
  const b = recordFromRef(ghRef(), s(2))
  const c = recordFromRef(webRef(), s(1))
  const out = unionRecords([b, c], [a])
  expect(out.length).toBe(2)
  expect((out.find(x => x.key === a.key) as GitHubRecord).title).toBe('T')
})
test('unionRecords: caps by smallest lastSeen', () => {
  const mk = (n: number, at: number) => recordFromRef(webRef({ url: `https://u${n}.example/` }), s(at))
  const out = unionRecords([mk(1, 5), mk(2, 1)], [mk(3, 9)], 2)
  expect(out.map(x => x.key).sort()).toEqual(['web:https://u1.example/', 'web:https://u3.example/'])
})

test('unionRecords: a published artifact wins over a mention in either order: origin, label and URL', () => {
  const m = recordFromRef(codeRef({ label: 'Design notes' }), s(1, 'response'))
  const p = recordFromRef(publishRef(), s(2, 'publish'))
  for (const [a, b] of [
    [m, p],
    [p, m],
  ] as const) {
    const out = unionRecords([a], [b])
    expect(out).toHaveLength(1)
    expect(artifactOrigin(art(out))).toBe('published')
    expect(art(out).label).toBe('Probe Page 29')
    expect(art(out).url).toBe(PAGE_URL)
    expect(art(out).sources.sort()).toEqual(['publish', 'response'])
  }
})

test('unionRecords: a Markdown label beats the id of a mention; deleted survives in either order', () => {
  const bare = recordFromRef(artifactRef(), s(1, 'response'))
  const named = { ...(recordFromRef(codeRef({ label: 'Design notes' }), s(2, 'prompt')) as ArtifactRecord) }
  const gone: ArtifactRecord = { ...(recordFromRef(publishRef(), s(3, 'publish')) as ArtifactRecord), deleted: true }
  expect(art(unionRecords([bare], [named])).label).toBe('Design notes')
  expect(art(unionRecords([named], [bare])).label).toBe('Design notes')
  expect(art(unionRecords([bare], [gone])).deleted).toBe(true)
  expect(art(unionRecords([gone], [bare])).deleted).toBe(true)
})

test('markArtifactDeleted: marks the row; an unknown or deleted key returns the input list', () => {
  const list = mergeRefs([], [publishRef(), webRef()], s(1, 'publish')).list
  const out = markArtifactDeleted(list, PAGE_KEY)
  expect(art(out).deleted).toBe(true)
  expect((list[0] as ArtifactRecord).deleted).toBeUndefined() // input not mutated
  expect(markArtifactDeleted(out, PAGE_KEY)).toBe(out)
  expect(markArtifactDeleted(list, 'art:00000000-0000-0000-0000-000000000000')).toBe(list)
  expect(markArtifactDeleted(list, keyOf(webRef()))).toBe(list)
})

const status = (name: 'gh' | 'acli'): ToolStatus => ({ name, available: true, loggedIn: null, breaker: 'closed' })
const tools = {
  gh: {
    name: 'gh',
    isAvailable: true,
    canCall: () => true,
    reset() {},
    status: () => status('gh'),
    async refreshItems() {},
    isHostAuthed: () => undefined,
    checkHost: async () => true,
    defaultRepo: async () => null,
  } as GitHubToolApi,
  acli: {
    name: 'acli',
    isAvailable: true,
    activeSite: undefined,
    canCall: () => true,
    reset() {},
    status: () => status('acli'),
    async refreshItems() {},
    loadActiveSite: async () => null,
  } as JiraToolApi,
}
// ---------------------------------------------------------------- auto items (spec A11)

const webAt = (i: number, sources: ItemRecord['sources'], over: Partial<WebRecord> = {}): WebRecord => ({
  key: `web:https://e.example/${i}`,
  category: 'web',
  url: `https://e.example/${i}`,
  label: `e${i}`,
  sources,
  firstSeen: i,
  lastSeen: i,
  seenCount: 1,
  ...over,
})
const many = (from: number, n: number, sources: ItemRecord['sources']) =>
  Array.from({ length: n }, (_, i) => webAt(from + i, sources))

test('cap: 500 mentioned plus 100 auto-only items evict nothing', () => {
  const r = unionRecords(many(1, LIMITS.maxItems, ['prompt']), many(1000, LIMITS.maxAutoItems, ['pr-body']))
  expect(r).toHaveLength(LIMITS.maxItems + LIMITS.maxAutoItems)
})

test('cap: 501 mentioned plus 100 auto-only items evict one mentioned item and no auto item', () => {
  const r = unionRecords(many(1, LIMITS.maxItems + 1, ['prompt']), many(1000, LIMITS.maxAutoItems, ['auto']))
  expect(r).toHaveLength(LIMITS.maxItems + LIMITS.maxAutoItems)
  expect(r.filter(x => x.sources.includes('auto'))).toHaveLength(LIMITS.maxAutoItems)
  expect(r.find(x => x.key === 'web:https://e.example/1')).toBeUndefined()
})

test('cap: a mentioned item that also has an auto source is not counted and not evicted', () => {
  const oldest = webAt(0, ['prompt', 'auto'])
  const r = unionRecords([oldest, ...many(1, LIMITS.maxItems, ['prompt'])], [])
  expect(r).toHaveLength(LIMITS.maxItems + 1)
  expect(r.find(x => x.key === oldest.key)).toBeDefined()
})

test('R12: the oldest manual-high item survives the cap; the cap still holds', () => {
  const oldestHigh = webAt(0, ['prompt'], { priority: 'high' })
  const r = unionRecords([oldestHigh, ...many(1, LIMITS.maxItems, ['prompt'])], [])
  expect(r).toHaveLength(LIMITS.maxItems)
  expect(r.find(x => x.key === oldestHigh.key)).toBeDefined()
  expect(r.find(x => x.key === 'web:https://e.example/1')).toBeUndefined()
  const lowOld = webAt(0, ['prompt'], { priority: 'low' })
  expect(unionRecords([lowOld, ...many(1, LIMITS.maxItems, ['prompt'])], []).some(x => x.key === lowOld.key)).toBe(
    false,
  )
})

test('R12: only the newest maxPinned high items are pinned, so the cap can always be met', () => {
  const highs = Array.from({ length: LIMITS.maxPinned + 1 }, (_, i) => webAt(i, ['prompt'], { priority: 'high' }))
  const r = unionRecords([...highs, ...many(1000, LIMITS.maxItems, ['prompt'])], [])
  expect(r).toHaveLength(LIMITS.maxItems)
  expect(r.find(x => x.key === highs[0]!.key)).toBeUndefined()
  expect(r.filter(x => x.priority === 'high')).toHaveLength(LIMITS.maxPinned)
  const all = unionRecords(
    Array.from({ length: LIMITS.maxItems + 50 }, (_, i) => webAt(i, ['prompt'], { priority: 'high' })),
    [],
  )
  expect(all).toHaveLength(LIMITS.maxItems)
})

test('R12: mergeRefs keeps a high item over a newer unmarked one', () => {
  const list = [webAt(1, ['prompt'], { priority: 'high' }), webAt(2, ['prompt'])]
  const fresh = webRef({ url: 'https://new.example/', label: 'new' })
  expect(mergeRefs(list, [fresh], s(10), 2).list.map(x => x.key)).toEqual(['web:https://e.example/1', keyOf(fresh)])
})

test('mergeRefs applies the same cap rule', () => {
  const list = [webAt(1, ['prompt']), webAt(2, ['prompt']), webAt(3, ['pr-body'])]
  const fresh = webRef({ url: 'https://new.example/', label: 'new' })
  const r = mergeRefs(list, [fresh], s(10), 2)
  expect(r.list.map(x => x.key)).toEqual(['web:https://e.example/2', 'web:https://e.example/3', keyOf(fresh)])
})

test('fold and unionRecords merge via (union, a first); a record without via stays without', () => {
  const a = webAt(1, ['pr-body'], { via: ['k1'] })
  const b = webAt(1, ['pr-body'], { via: ['k2', 'k1'] })
  expect(unionRecords([a], [b])[0]?.via).toEqual(['k1', 'k2'])
  const plain = unionRecords([webAt(2, ['prompt'])], [webAt(2, ['prompt'])])
  expect(plain[0]?.via).toBeUndefined()
})

test('unionRecords keeps the highest priority when one key appears twice', () => {
  const high = webAt(1, ['prompt'], { priority: 'high' })
  const low = webAt(1, ['tool'], { priority: 'low' })
  expect(unionRecords([low], [high])[0]?.priority).toBe('high')
  expect(unionRecords([high], [low])[0]?.priority).toBe('high')
})

test('resolveBareRefs fold keeps the highest priority across merged keys', () => {
  const target = {
    ...(recordFromRef(ghRef({ type: 'issue' }), s(10)) as GitHubRecord),
    priority: 'low' as const,
  }
  const bare = {
    ...(recordFromRef(unresolved(5), s(3)) as GitHubRecord),
    priority: 'high' as const,
  }
  const out = resolveBareRefs([bare, target], { host: 'github.com', owner: 'acme', repo: 'web' })
  expect(out).toHaveLength(1)
  expect(out[0]?.priority).toBe('high')
})

test('a new record has no priority: no mark until the person sets one', () => {
  for (const ref of [ghRef(), jiraRef(), webRef(), unresolved(3)])
    expect('priority' in recordFromRef(ref, s(1))).toBe(false)
  expect('priority' in mergeRefs([], [webRef()], s(1)).list[0]!).toBe(false)
  expect('priority' in unionRecords([webAt(1, ['prompt'])], [])[0]!).toBe(false)
})

test('a set low beats a copy with no mark, in unionRecords both ways and in resolveBareRefs', () => {
  const low = webAt(1, ['prompt'], { priority: 'low' })
  const unset = webAt(1, ['tool'])
  expect(unionRecords([low], [unset])[0]?.priority).toBe('low')
  expect(unionRecords([unset], [low])[0]?.priority).toBe('low')
  const target = { ...(recordFromRef(ghRef({ type: 'issue' }), s(10)) as GitHubRecord), priority: 'low' as const }
  const bare = recordFromRef(unresolved(5), s(3)) as GitHubRecord
  const out = resolveBareRefs([bare, target], { host: 'github.com', owner: 'acme', repo: 'web' })
  expect(out[0]?.priority).toBe('low')
})

test('unionRecords keeps the child marks of the copy that loses the fold', () => {
  const mk = (at: number, refreshedAt: number, root?: 'low', child?: 'high'): JiraRecord => ({
    ...(recordFromRef(jiraRef(), s(at)) as JiraRecord),
    ...(root ? { priority: root } : {}),
    refreshedAt,
    children: [
      { key: 'ISS-2', ...(child ? { priority: child } : {}), summary: '', issueType: '', status: '', children: [] },
    ],
  })
  // The newer copy wins the status fields and the tree; the older one holds the marks.
  const out = unionRecords([mk(1, 10, 'low', 'high')], [mk(2, 20)])[0] as JiraRecord
  expect(out.refreshedAt).toBe(20)
  expect(out.priority).toBe('low')
  expect(out.children[0]?.priority).toBe('high')
})

test('mergeResults keeps the root mark of the list when a refresh result carries another', () => {
  const base = { ...(recordFromRef(jiraRef(), s(1)) as JiraRecord), priority: 'high' as const }
  const refreshed: JiraRecord = { ...base, priority: 'low', summary: 'New', refreshedAt: 100 }
  const out = mergeResults([base], [refreshed])[0] as JiraRecord
  expect(out.summary).toBe('New')
  expect(out.priority).toBe('high')
  const unset = recordFromRef(jiraRef(), s(1)) as JiraRecord
  expect('priority' in mergeResults([unset], [{ ...unset, priority: 'high', refreshedAt: 100 }])[0]!).toBe(false)
})

test('mergeResults: a child the person reset during a refresh stays unset', () => {
  const kid = (priority?: 'high'): JiraNode => ({
    key: 'A-1',
    ...(priority ? { priority } : {}),
    summary: '',
    issueType: '',
    status: '',
    children: [],
  })
  const now = { ...(recordFromRef(jiraRef(), s(1)) as JiraRecord), children: [kid()] }
  // The refresh started while A-1 was high, so its tree still holds the old mark.
  const refreshed: JiraRecord = { ...now, children: [kid('high')], refreshedAt: 100 }
  const out = mergeResults([now], [refreshed])[0] as JiraRecord
  expect('priority' in out.children[0]!).toBe(false)
})

test('carryOver: the live marks win over the older stored copy, on the root and on a Jira child, absence too', () => {
  const kid = (priority?: 'high'): JiraNode => ({
    key: 'A-1',
    ...(priority ? { priority } : {}),
    summary: '',
    issueType: '',
    status: '',
    children: [],
  })
  const live = { ...(recordFromRef(jiraRef(), s(2)) as JiraRecord), children: [kid()] } // the person reset both
  const stored = {
    ...(recordFromRef(jiraRef(), s(1)) as JiraRecord),
    priority: 'high' as const,
    children: [kid('high')],
  }
  const out = carryOver([live], [stored])[0] as JiraRecord
  expect('priority' in out).toBe(false)
  expect('priority' in out.children[0]!).toBe(false)
  expect(unionRecords([live], [stored])[0]?.priority).toBe('high') // the plain union would bring it back
  const onlyStored = webAt(9, ['prompt'], { priority: 'low' })
  expect(carryOver([live], [onlyStored]).find(r => r.key === onlyStored.key)?.priority).toBe('low')
})

test('a record stored before priority existed reads as no mark and round-trips without one', () => {
  const legacy = recordFromRef(jiraRef(), s(1)) as JiraRecord
  expect('priority' in unionRecords([legacy], [])[0]!).toBe(false)
  expect('priority' in hydrate(legacy, tools).toRecord()).toBe(false)
})

test('mergeRefs and unionRecords copy via, so the output never shares the input array', () => {
  const rec = webAt(1, ['pr-body'], { via: ['k1'] })
  const out = mergeRefs([rec], [], s(5)).list[0]!
  expect(out.via).toEqual(['k1'])
  expect(out.via).not.toBe(rec.via)
})

test('mergeResults and unionRecords keep the closing refs of a PR and never share the array', () => {
  const pr = { ...(recordFromRef(ghRef(), s(1)) as GitHubRecord), closes: ['gh:github.com/acme/web#9'] }
  const merged = mergeResults([pr], [{ ...pr, closes: undefined, title: 'T', refreshedAt: 5 } as GitHubRecord])[0]
  expect((merged as GitHubRecord).closes).toEqual(['gh:github.com/acme/web#9'])
  const union = unionRecords([pr], [])[0] as GitHubRecord
  expect(union.closes).toEqual(pr.closes)
  expect(union.closes).not.toBe(pr.closes)
})

test('mergeResults takes the closing refs a refresh found, an empty list too; none found keeps the stored ones', () => {
  const pr = { ...(recordFromRef(ghRef(), s(1)) as GitHubRecord), closes: ['gh:github.com/acme/web#9'] }
  const fresh = (closes?: string[]) => [{ ...pr, ...(closes ? { closes } : { closes: undefined }), refreshedAt: 5 }]
  expect((mergeResults([pr], fresh(['gh:github.com/acme/web#8']))[0] as GitHubRecord).closes).toEqual([
    'gh:github.com/acme/web#8',
  ])
  expect((mergeResults([pr], fresh([]))[0] as GitHubRecord).closes).toEqual([])
  expect((mergeResults([pr], fresh())[0] as GitHubRecord).closes).toEqual(['gh:github.com/acme/web#9'])
})

test('mergeResults keeps via, headRefName and baseRefName of the stored record', () => {
  const stored: GitHubRecord = {
    key: 'gh:github.com/acme/web#7',
    category: 'github',
    url: 'https://github.com/acme/web/pull/7',
    label: 'acme/web#7',
    sources: ['auto'],
    via: ['gh:github.com/acme/web#9'],
    firstSeen: 1,
    lastSeen: 1,
    seenCount: 0,
    host: 'github.com',
    owner: 'acme',
    repo: 'web',
    number: 7,
    type: 'pr',
    headRefName: 'feat/x',
    baseRefName: 'main',
  }
  const fresh: GitHubRecord = { ...stored, title: 'T', state: 'open', refreshedAt: 50 }
  delete fresh.via
  delete fresh.headRefName
  delete fresh.baseRefName
  const out = mergeResults([stored], [fresh])[0] as GitHubRecord
  expect(out).toMatchObject({
    title: 'T',
    via: ['gh:github.com/acme/web#9'],
    headRefName: 'feat/x',
    baseRefName: 'main',
  })
})
