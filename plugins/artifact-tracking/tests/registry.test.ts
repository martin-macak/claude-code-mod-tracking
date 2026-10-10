// Registry: keys, record conversion, merge, dedupe, caps, re-key, carry-over, hydrate. Pure.
import { expect, test } from 'claude-code/testing'
import type { GitHubRecord, GitHubRef, GitHubToolApi, ItemRecord, JiraRecord, JiraRef, JiraToolApi, ToolStatus, WebRecord, WebRef } from '../hooks/contracts'
import { LIMITS } from '../hooks/contracts'
import { GitHubItem } from '../hooks/model/github-item'
import { JiraItem } from '../hooks/model/jira-item'
import { WebLink } from '../hooks/model/web-link'
import { hydrate, keyOf, mergeRefs, mergeResults, recordFromRef, resolveBareRefs, unionRecords } from '../hooks/model/registry'

const ghRef = (over: Partial<GitHubRef> = {}): GitHubRef => ({ category: 'github', host: 'github.com', owner: 'acme', repo: 'web', number: 5, type: 'pr', ...over })
const jiraRef = (over: Partial<JiraRef> = {}): JiraRef => ({ category: 'jira', site: 'Acme.Atlassian.net', issueKey: 'ISS-1', url: 'https://Acme.Atlassian.net/browse/ISS-1', trackOnly: false, ...over })
const webRef = (over: Partial<WebRef> = {}): WebRef => ({ category: 'web', url: 'https://X.example/a#frag', label: 'X doc', ...over })
const s = (at: number, source: 'prompt' | 'response' | 'tool' = 'prompt') => ({ source, at })
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

test('recordFromRef: github pr and issue URL fall back to host/owner/repo', () => {
  const pr = recordFromRef(ghRef(), s(10)) as GitHubRecord
  expect(pr).toMatchObject({ key: 'gh:github.com/acme/web#5', category: 'github', url: 'https://github.com/acme/web/pull/5', label: 'acme/web#5', sources: ['prompt'], firstSeen: 10, lastSeen: 10, seenCount: 1, number: 5, type: 'pr' })
  expect(recordFromRef(ghRef({ type: 'issue' }), s(1)).url).toBe('https://github.com/acme/web/issues/5')
  expect(recordFromRef(ghRef({ type: 'unknown' }), s(1)).url).toBe('https://github.com/acme/web/issues/5')
})
test('recordFromRef: github keeps the URL as written', () => {
  expect(recordFromRef(ghRef({ url: 'https://github.com/acme/web/pull/5/files' }), s(1)).url).toBe('https://github.com/acme/web/pull/5/files')
})
test('recordFromRef: unresolved github has empty url and #N label', () => {
  const r = recordFromRef(unresolved(9), s(1)) as GitHubRecord
  expect(r).toMatchObject({ key: 'gh:?#9', url: '', label: '#9' })
  expect('owner' in r).toBe(false)
})
test('recordFromRef: jira label is the key, children empty', () => {
  const r = recordFromRef(jiraRef({ trackOnly: true }), s(1)) as JiraRecord
  expect(r).toMatchObject({ key: 'jira:acme.atlassian.net/ISS-1', label: 'ISS-1', children: [], trackOnly: true, issueKey: 'ISS-1', site: 'Acme.Atlassian.net' })
})
test('recordFromRef: web label is ref.label', () => {
  expect(recordFromRef(webRef(), s(1, 'response'))).toMatchObject({ key: 'web:https://x.example/a', label: 'X doc', sources: ['response'] })
})

test('mergeRefs: URL and bare #N for the same item end as one record (Review Focus 2)', () => {
  const urlRef = ghRef({ owner: 'ACME', repo: 'Web', type: 'issue', url: 'https://github.com/ACME/Web/issues/5' })
  const bare = ghRef({ owner: 'acme', repo: 'web', type: 'unknown' }) // bare #5, already resolved to the session repo
  const a = mergeRefs([], [urlRef], s(1))
  const b = mergeRefs(a.list, [bare], s(2, 'response'))
  expect(b.list.length).toBe(1)
  expect(b.added).toEqual([])
  expect(b.list[0]).toMatchObject({ seenCount: 2, lastSeen: 2, firstSeen: 1, sources: ['prompt', 'response'], type: 'issue' })
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
  expect(r.list.map((x) => x.key).sort()).toEqual(['web:https://new.example/', 'web:https://o1.example/', 'web:https://o3.example/'])
})
test('mergeRefs: default cap is LIMITS.maxItems', () => {
  let list: ItemRecord[] = []
  for (let i = 0; i < LIMITS.maxItems; i++) list = mergeRefs(list, [webRef({ url: `https://h${i}.example/` })], s(i + 1)).list
  const r = mergeRefs(list, [webRef({ url: 'https://extra.example/' })], s(0))
  expect(r.list.length).toBe(LIMITS.maxItems)
  expect(r.list.some((x) => x.key === 'web:https://extra.example/')).toBe(true)
  expect(r.list.some((x) => x.key === 'web:https://h0.example/')).toBe(false)
})

test('mergeResults: takes status fields, keeps sightings, clears an absent error', () => {
  const base = { ...(recordFromRef(ghRef(), s(1)) as GitHubRecord), seenCount: 4, lastSeen: 9, sources: ['prompt', 'tool'] as GitHubRecord['sources'], error: { kind: 'failed' as const, message: 'x', at: 1 } }
  const refreshed: GitHubRecord = { ...(recordFromRef(ghRef(), s(1)) as GitHubRecord), label: 'WRONG', url: 'WRONG', seenCount: 1, lastSeen: 1, sources: ['response'],
    title: 'T', state: 'open', stateReason: 'X', isDraft: true, reviewDecision: 'APPROVED', checks: 'failure', refreshedAt: 100 }
  const out = mergeResults([base], [refreshed])
  expect(out.length).toBe(1)
  const r = out[0] as GitHubRecord
  expect(r).toMatchObject({ title: 'T', state: 'open', stateReason: 'X', isDraft: true, reviewDecision: 'APPROVED', checks: 'failure', refreshedAt: 100, seenCount: 4, lastSeen: 9, sources: ['prompt', 'tool'], label: 'acme/web#5', url: 'https://github.com/acme/web/pull/5' })
  expect('error' in r).toBe(false)
})
test('mergeResults: takes an error, jira fields and children', () => {
  const base = recordFromRef(jiraRef(), s(1)) as JiraRecord
  const refreshed: JiraRecord = { ...base, summary: 'S', issueType: 'Epic', status: 'Done', statusCategory: 'done', refreshedAt: 5,
    children: [{ key: 'ISS-2', summary: 'c', issueType: 'Story', status: 'To Do', children: [] }], error: { kind: 'not-found', message: 'gone', at: 5 } }
  const r = mergeResults([base], [refreshed])[0] as JiraRecord
  expect(r).toMatchObject({ summary: 'S', issueType: 'Epic', status: 'Done', statusCategory: 'done', refreshedAt: 5, error: { kind: 'not-found' } })
  expect(r.children.length).toBe(1)
})
test('mergeResults: drops refreshed records whose key is gone; keeps untouched records', () => {
  const a = recordFromRef(webRef(), s(1))
  const b = recordFromRef(webRef({ url: 'https://b.example/' }), s(1))
  const out = mergeResults([a], [b])
  expect(out.map((x) => x.key)).toEqual([a.key])
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
  expect(out[0]).toMatchObject({ key: 'gh:github.com/acme/web#5', host: 'github.com', owner: 'acme', repo: 'web', label: 'acme/web#5', url: 'https://github.com/acme/web/issues/5' })
})
test('resolveBareRefs: uses pull in the URL for a pr', () => {
  const rec = { ...(recordFromRef(unresolved(5), s(1)) as GitHubRecord), type: 'pr' as const }
  expect(resolveBareRefs([rec], { host: 'github.com', owner: 'a', repo: 'b' })[0]!.url).toBe('https://github.com/a/b/pull/5')
})
test('resolveBareRefs: folds into an existing target', () => {
  const target = { ...(recordFromRef(ghRef({ type: 'issue' }), s(10)) as GitHubRecord), sources: ['response' as const], seenCount: 2, lastSeen: 20, title: 'kept', refreshedAt: 5 }
  const bare = { ...(recordFromRef(unresolved(5), s(3)) as GitHubRecord), sources: ['prompt' as const], seenCount: 3, lastSeen: 15 }
  const out = resolveBareRefs([bare, target], { host: 'github.com', owner: 'acme', repo: 'web' })
  expect(out.length).toBe(1)
  expect(out[0]).toMatchObject({ key: target.key, sources: ['response', 'prompt'], seenCount: 5, firstSeen: 3, lastSeen: 20, title: 'kept' })
})
test('resolveBareRefs: leaves other records alone and does not mutate input', () => {
  const w = recordFromRef(webRef(), s(1))
  const bare = recordFromRef(unresolved(5), s(1))
  const copy = JSON.parse(JSON.stringify([w, bare])) as ItemRecord[]
  const out = resolveBareRefs([w, bare], { host: 'github.com', owner: 'a', repo: 'b' })
  expect(out[0]).toEqual(w)
  expect([w, bare]).toEqual(copy)
})

test('unionRecords: folds sightings and takes status from the newer refresh', () => {
  const a = { ...(recordFromRef(ghRef(), s(1)) as GitHubRecord), sources: ['prompt' as const], seenCount: 2, lastSeen: 5, title: 'old', state: 'open' as const, refreshedAt: 10 }
  const b = { ...(recordFromRef(ghRef(), s(3)) as GitHubRecord), sources: ['tool' as const], seenCount: 1, lastSeen: 8, title: 'new', state: 'merged' as const, refreshedAt: 20 }
  const out = unionRecords([a], [b])
  expect(out.length).toBe(1)
  expect(out[0]).toMatchObject({ title: 'new', state: 'merged', refreshedAt: 20, seenCount: 3, firstSeen: 1, lastSeen: 8, sources: ['prompt', 'tool'] })
})
test('unionRecords: a refreshed record beats a never-refreshed one; other keys stay', () => {
  const a = { ...(recordFromRef(ghRef(), s(1)) as GitHubRecord), title: 'T', refreshedAt: 1 }
  const b = recordFromRef(ghRef(), s(2))
  const c = recordFromRef(webRef(), s(1))
  const out = unionRecords([b, c], [a])
  expect(out.length).toBe(2)
  expect((out.find((x) => x.key === a.key) as GitHubRecord).title).toBe('T')
})
test('unionRecords: caps by smallest lastSeen', () => {
  const mk = (n: number, at: number) => recordFromRef(webRef({ url: `https://u${n}.example/` }), s(at))
  const out = unionRecords([mk(1, 5), mk(2, 1)], [mk(3, 9)], 2)
  expect(out.map((x) => x.key).sort()).toEqual(['web:https://u1.example/', 'web:https://u3.example/'])
})

const status = (name: 'gh' | 'acli'): ToolStatus => ({ name, available: true, loggedIn: null, breaker: 'closed' })
const tools = {
  gh: { name: 'gh', isAvailable: true, canCall: () => true, reset() {}, status: () => status('gh'), async refreshItems() {}, isHostAuthed: () => undefined, checkHost: async () => true, defaultRepo: async () => null } as GitHubToolApi,
  acli: { name: 'acli', isAvailable: true, activeSite: undefined, canCall: () => true, reset() {}, status: () => status('acli'), async refreshItems() {}, loadActiveSite: async () => null } as JiraToolApi,
}
test('hydrate: picks the class by category', () => {
  expect(hydrate(recordFromRef(ghRef(), s(1)), tools)).toBeInstanceOf(GitHubItem)
  expect(hydrate(recordFromRef(jiraRef(), s(1)), tools)).toBeInstanceOf(JiraItem)
  const w = hydrate(recordFromRef(webRef(), s(1)), tools)
  expect(w).toBeInstanceOf(WebLink)
  expect(w.toRecord()).toEqual(recordFromRef(webRef(), s(1)) as WebRecord)
})
test('hydrate: round-trips a refreshed record', () => {
  const rec = { ...(recordFromRef(ghRef(), s(1)) as GitHubRecord), title: 'T', checks: 'pending' as const, refreshedAt: 3 }
  expect(hydrate(rec, tools).toRecord()).toEqual(rec)
})
