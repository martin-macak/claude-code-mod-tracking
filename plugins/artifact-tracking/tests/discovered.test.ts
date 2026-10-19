// applyDiscovery and dropAuto: upsert, quiet steps, prune, caps. Pure.
import { expect, test } from 'claude-code/testing'
import type { Claim } from '../core/interfaces/items'
import type { GitHubRecord, GitHubRef, ItemRecord, WebRef } from '../hooks/contracts'
import { claimsOf, isAutoOnly, keyOf, prKey } from '../hooks/model/keys'
import { buildRecord } from '../hooks/model/registry'
import { applyDiscovery, dropAuto } from '../trackers/github/discovered'
import { discovered } from './fixtures/gh-discovery'
import { LIMITS } from './fixtures/limits'

const AT = 10_000_000
const K7 = 'gh:github.com/acme/web#7'
const K9 = 'gh:github.com/acme/web#9'
const NONE = new Set<string>()

const ghRef = (n: number): GitHubRef => ({
  category: 'github',
  host: 'github.com',
  owner: 'acme',
  repo: 'web',
  number: n,
  type: 'issue',
})
const webRef: WebRef = { category: 'web', url: 'https://example.com/spec', label: 'spec' }

const input = (over: Partial<Parameters<typeof applyDiscovery>[1]> = {}) => ({
  prs: [discovered({ number: 7 })],
  refsByPr: new Map<string, readonly Claim[]>(),
  complete: true,
  dismissed: NONE as ReadonlySet<string>,
  at: AT,
  build: buildRecord,
  ...over,
})

const mentioned = (n: number, over: Partial<GitHubRecord> = {}): GitHubRecord => ({
  key: `gh:github.com/acme/web#${n}`,
  category: 'github',
  url: `https://github.com/acme/web/pull/${n}`,
  label: `acme/web#${n}`,
  sources: ['prompt'],
  firstSeen: 1,
  lastSeen: 2,
  seenCount: 2,
  host: 'github.com',
  owner: 'acme',
  repo: 'web',
  number: n,
  type: 'unknown',
  ...over,
})

const autoWeb = (i: number): ItemRecord => ({
  key: `web:https://x.example/${i}`,
  category: 'web',
  url: `https://x.example/${i}`,
  label: `x${i}`,
  sources: ['pr-body'],
  via: [K7],
  firstSeen: 1,
  lastSeen: 1,
  seenCount: 0,
})

test('prKey is the item key of the PR', () => {
  expect(prKey(discovered({ number: 7 }))).toBe(K7)
})

test('isAutoOnly: every source is an auto source', () => {
  expect(isAutoOnly(autoWeb(1))).toBe(true)
  expect(isAutoOnly(mentioned(1, { sources: ['auto'] }))).toBe(true)
  expect(isAutoOnly(mentioned(1, { sources: ['prompt', 'auto'] }))).toBe(false)
  expect(isAutoOnly(mentioned(1))).toBe(false)
})

test('a new PR: seenCount 0, source auto, status and refreshedAt from the reply, not in added', () => {
  const r = applyDiscovery([], input())
  expect(r.added).toEqual([])
  expect(r.untracked).toBe(0)
  expect(r.list).toHaveLength(1)
  expect(r.list[0]).toMatchObject({
    key: K7,
    category: 'github',
    type: 'pr',
    sources: ['auto'],
    seenCount: 0,
    firstSeen: AT,
    lastSeen: AT,
    refreshedAt: AT,
    title: 'PR 7',
    state: 'open',
    checks: 'success',
    headRefName: 'feat/auto-tracking',
    baseRefName: 'main',
    url: 'https://github.com/acme/web/pull/7',
  })
})

const closingRef = (owner: string, repo: string, number: number) => ({
  host: 'github.com',
  owner,
  repo,
  number,
  url: `https://github.com/${owner}/${repo}/issues/${number}`,
})

test('a PR record keeps the issue keys its closing refs name; a PR that closes nothing has no field', () => {
  const closing = [closingRef('Acme', 'Web', 9), closingRef('other', 'lib', 3)]
  const r = applyDiscovery([], input({ prs: [discovered({ number: 7, closing })] }))
  expect((r.list[0] as GitHubRecord).closes).toEqual([K9, 'gh:github.com/other/lib#3'])
  expect('closes' in applyDiscovery([], input()).list[0]!).toBe(false)
})

test('a change in the closing refs rewrites the PR record; the same refs keep the list object', () => {
  const nine = [closingRef('acme', 'web', 9)]
  const first = applyDiscovery([], input({ prs: [discovered({ closing: nine })] }))
  const same = applyDiscovery(first.list, input({ prs: [discovered({ closing: [...nine] })], at: AT + 30_000 }))
  expect(same.list).toBe(first.list)
  const gone = applyDiscovery(first.list, input({ prs: [discovered({ closing: [] })], at: AT + 30_000 }))
  expect(gone.list).not.toBe(first.list)
  expect('closes' in gone.list[0]!).toBe(false)
  const other = applyDiscovery(first.list, input({ prs: [discovered({ closing: [closingRef('acme', 'web', 8)] })] }))
  expect((other.list[0] as GitHubRecord).closes).toEqual(['gh:github.com/acme/web#8'])
})

test('the same reply 30 s later returns the input list object', () => {
  const first = applyDiscovery([], input())
  const second = applyDiscovery(first.list, input({ at: AT + 30_000 }))
  expect(second.list).toBe(first.list)
  expect(second.added).toEqual([])
})

test('a changed field gives a new list with a new record and refreshedAt moved', () => {
  const first = applyDiscovery([], input())
  const second = applyDiscovery(
    first.list,
    input({ prs: [discovered({ number: 7, checks: 'failure' })], at: AT + 30_000 }),
  )
  expect(second.list).not.toBe(first.list)
  expect(second.list[0]).toMatchObject({ checks: 'failure', refreshedAt: AT + 30_000 })
  expect(first.list[0]).toMatchObject({ checks: 'success', refreshedAt: AT })
})

test('the same reply after staleMs / 2 moves refreshedAt', () => {
  const first = applyDiscovery([], input())
  const later = AT + LIMITS.staleMs / 2 + 1
  const second = applyDiscovery(first.list, input({ at: later }))
  expect(second.list).not.toBe(first.list)
  expect(second.list[0]).toMatchObject({ refreshedAt: later })
})

test('a record with an error is refreshed from the reply and loses the error', () => {
  const first = applyDiscovery([], input())
  const broken = [{ ...first.list[0]!, error: { kind: 'failed' as const, message: 'x', at: AT } }]
  const second = applyDiscovery(broken, input({ at: AT + 1 }))
  expect(second.list[0]?.error).toBeUndefined()
})

test('a mentioned PR gains auto with no count change and takes the type pr', () => {
  const list = [mentioned(7)]
  const r = applyDiscovery(list, input())
  expect(r.list[0]).toMatchObject({
    sources: ['prompt', 'auto'],
    seenCount: 2,
    lastSeen: 2,
    type: 'pr',
    refreshedAt: AT,
  })
  expect(list[0]?.sources).toEqual(['prompt'])
})

test('body refs: new records get pr-body, via and seenCount 0, and are reported in added', () => {
  const refsByPr = new Map<string, readonly Claim[]>([[K7, claimsOf([ghRef(1), webRef], 'pr-body', AT)]])
  const r = applyDiscovery([], input({ refsByPr }))
  expect(r.list.map(x => x.key)).toEqual([K7, 'gh:github.com/acme/web#1', keyOf(webRef)])
  expect(r.list[1]).toMatchObject({ sources: ['pr-body'], via: [K7], seenCount: 0 })
  expect(r.added).toEqual(['gh:github.com/acme/web#1', keyOf(webRef)])
})

test('an existing item named by the body gains pr-body and via; both there already keeps the object', () => {
  const refsByPr = new Map<string, readonly Claim[]>([[K7, claimsOf([ghRef(1)], 'pr-body', AT)]])
  const list = [mentioned(1, { type: 'issue' })]
  const first = applyDiscovery(list, input({ refsByPr }))
  const rec = first.list.find(x => x.key === 'gh:github.com/acme/web#1')
  expect(rec).toMatchObject({ sources: ['prompt', 'pr-body'], via: [K7], seenCount: 2 })
  const second = applyDiscovery(first.list, input({ refsByPr, at: AT + 1 }))
  expect(second.list).toBe(first.list)
})

test('a dismissed PR adds nothing, and neither do its refs; a dismissed ref is skipped', () => {
  const refsByPr = new Map<string, readonly Claim[]>([[K7, claimsOf([ghRef(1)], 'pr-body', AT)]])
  const none = applyDiscovery([], input({ refsByPr, dismissed: new Set([K7]) }))
  expect(none.list).toEqual([])
  const some = applyDiscovery([], input({ refsByPr, dismissed: new Set(['gh:github.com/acme/web#1']) }))
  expect(some.list.map(x => x.key)).toEqual([K7])
})

test('prune runs only on a complete reply: a PR that left loses auto, and its auto-only refs go', () => {
  const refsByPr = new Map<string, readonly Claim[]>([[K7, claimsOf([ghRef(1)], 'pr-body', AT)]])
  const first = applyDiscovery([], input({ refsByPr })).list
  const gone = applyDiscovery(first, input({ prs: [], complete: true, at: AT + 1 }))
  expect(gone.list).toEqual([])
  const partial = applyDiscovery(first, input({ prs: [], complete: false, at: AT + 1 }))
  expect(partial.list).toBe(first)
})

test('prune keeps a mentioned item and strips only its auto sources and via', () => {
  const list: ItemRecord[] = [
    mentioned(7, { sources: ['prompt', 'auto'] }),
    mentioned(1, { sources: ['prompt', 'pr-body'], via: [K7], type: 'issue' }),
  ]
  const r = applyDiscovery(list, input({ prs: [], complete: true }))
  expect(r.list.map(x => [x.key, x.sources, x.via])).toEqual([
    [K7, ['prompt'], undefined],
    ['gh:github.com/acme/web#1', ['prompt'], undefined],
  ])
})

const bodyRef = (i: number): WebRef => ({ category: 'web', url: `https://x.example/${i}`, label: `x${i}` })

test('prune cuts via to the PRs still in the result', () => {
  const both: ItemRecord = { ...autoWeb(1), via: [K7, K9] }
  const refs = new Map<string, readonly Claim[]>([[K7, claimsOf([bodyRef(1)], 'pr-body', AT)]])
  const r = applyDiscovery([both], input({ prs: [discovered({ number: 7 })], refsByPr: refs }))
  expect(r.list.find(x => x.key === both.key)?.via).toEqual([K7])
})

test('prune follows the body: a ref that an edited body no longer lists loses pr-body and via (A12)', () => {
  const body = new Map<string, readonly Claim[]>([[K7, claimsOf([bodyRef(1)], 'pr-body', AT)]])
  const first = applyDiscovery([], input({ refsByPr: body }))
  expect(first.list.find(x => x.key === keyOf(bodyRef(1)))).toMatchObject({ sources: ['pr-body'], via: [K7] })
  // The body is edited: the PR stays in the reply and lists no ref.
  const second = applyDiscovery(first.list, input({ refsByPr: new Map([[K7, []]]) }))
  expect(second.list.map(x => x.key)).toEqual([K7])
  // A mentioned item loses only its auto sources.
  const kept = applyDiscovery(
    [mentioned(1, { sources: ['prompt', 'pr-body'], via: [K7], type: 'issue' })],
    input({ refsByPr: new Map([[K7, []]]) }),
  )
  const rec = kept.list.find(x => x.key === 'gh:github.com/acme/web#1')!
  expect(rec.sources).toEqual(['prompt'])
  expect(rec.via).toBeUndefined()
  // A partial reply deletes nothing.
  const partial = applyDiscovery(first.list, input({ refsByPr: new Map([[K7, []]]), complete: false }))
  expect(partial.list.find(x => x.key === keyOf(bodyRef(1)))).toMatchObject({ sources: ['pr-body'], via: [K7] })
})

test('maxAutoItems: at the cap no new auto-only item is added, untracked counts it, existing ones still update', () => {
  const full: ItemRecord[] = Array.from({ length: LIMITS.maxAutoItems }, (_, i) => autoWeb(i))
  const existing = applyDiscovery([], input({ prs: [discovered({ number: 9 })] })).list[0]!
  const list = [...full.slice(0, LIMITS.maxAutoItems - 1), existing]
  const r = applyDiscovery(
    list,
    input({ prs: [discovered({ number: 9, title: 'renamed' }), discovered({ number: 11 })], complete: false }),
  )
  expect(r.untracked).toBe(1)
  expect(r.list.find(x => x.key === K9)).toMatchObject({ title: 'renamed' })
  expect(r.list.find(x => x.key === 'gh:github.com/acme/web#11')).toBeUndefined()
})

test('a mentioned item does not use the auto budget', () => {
  const full: ItemRecord[] = Array.from({ length: LIMITS.maxAutoItems - 1 }, (_, i) => autoWeb(i))
  const r = applyDiscovery(
    [...full, mentioned(7)],
    input({ prs: [discovered({ number: 7 }), discovered({ number: 11 })], complete: false }),
  )
  expect(r.untracked).toBe(0)
  expect(r.list.find(x => x.key === 'gh:github.com/acme/web#11')).toBeDefined()
})

test('nothing in, nothing out: an empty reply on an empty list returns the input list', () => {
  const list: ItemRecord[] = []
  expect(applyDiscovery(list, input({ prs: [] })).list).toBe(list)
})

test('dropAuto removes auto, pr-body and via from the given keys, and deletes a record with no source left', () => {
  const list: ItemRecord[] = [
    mentioned(7, { sources: ['prompt', 'auto', 'pr-body'], via: [K9] }),
    autoWeb(1),
    autoWeb(2),
  ]
  const r = dropAuto(list, new Set([K7, autoWeb(1).key]))
  expect(r.map(x => x.key)).toEqual([K7, autoWeb(2).key])
  expect(r[0]).toMatchObject({ sources: ['prompt'] })
  expect(r[0]?.via).toBeUndefined()
})

test('dropAuto with no matching key returns the input list', () => {
  const list: ItemRecord[] = [autoWeb(1)]
  expect(dropAuto(list, new Set(['nope']))).toBe(list)
  expect(keyOf(ghRef(1))).toBe('gh:github.com/acme/web#1')
})
