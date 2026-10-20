// applyDiscovery and dropAuto: upsert, quiet steps, prune, caps. Pure.
import { expect, test } from 'claude-code/testing'
import type { Claim } from '../core/interfaces/items'
import { addReason, reasonSet } from '../core/lib/reasons'
import { foldRecords } from '../core/lib/records'
import { applyDiscovery, dropAuto } from '../trackers/github/discovered'
import { githubKind } from '../trackers/github/kind'
import { isLanePr } from '../trackers/github/lane-pr'
import type { GitHubRecord, GitHubRef, ItemRecord, Ref, WebRef } from './fixtures/contracts'
import { discovered } from './fixtures/gh-discovery'
import { claimsOf, isAutoOnly, keyOf, prKey } from './fixtures/keys'
import { LIMITS } from './fixtures/limits'
import { DISCOVERED, LANE, named, reasonsOfSources } from './fixtures/reasons'
import { buildRecord } from './fixtures/registry'

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
  reasons: reasonsOfSources(['prompt']),
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
  sources: [],
  reasons: DISCOVERED,
  via: [K7],
  firstSeen: 1,
  lastSeen: 1,
  seenCount: 0,
})

test('prKey is the item key of the PR', () => {
  expect(prKey(discovered({ number: 7 }))).toBe(K7)
})

/** A mentioned record that discovery found too. */
const found = (n: number, over: Partial<GitHubRecord> = {}) =>
  mentioned(n, { reasons: addReason(reasonSet('mentioned'), 'discovered'), ...over })

test('isAutoOnly: discovered is the only reason', () => {
  expect(isAutoOnly(autoWeb(1))).toBe(true)
  expect(isAutoOnly(mentioned(1, LANE))).toBe(true)
  expect(isAutoOnly(found(1, { lane: true }))).toBe(false)
  expect(isAutoOnly(mentioned(1))).toBe(false)
})

test('a new PR: seenCount 0, the lane marker, status and refreshedAt from the reply, not in added', () => {
  const r = applyDiscovery([], input())
  expect(r.added).toEqual([])
  expect(r.untracked).toBe(0)
  expect(r.list).toHaveLength(1)
  expect(r.list[0]).toMatchObject({
    key: K7,
    category: 'github',
    type: 'pr',
    sources: [],
    lane: true,
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

test('a PR record keeps mergeable and mergeStateStatus; a PR with neither has no field (issue #50)', () => {
  const r = applyDiscovery([], input({ prs: [discovered({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })] }))
  expect(r.list[0]).toMatchObject({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })
  const bare = applyDiscovery([], input()).list[0]!
  expect('mergeable' in bare || 'mergeStateStatus' in bare).toBe(false)
})

test('AC5: a PR that changes only its mergeable value is written, and one that changes only mergeStateStatus too', () => {
  const first = applyDiscovery([], input({ prs: [discovered({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })] }))
  const flipped = applyDiscovery(
    first.list,
    input({ prs: [discovered({ mergeable: 'CONFLICTING', mergeStateStatus: 'CLEAN' })], at: AT + 30_000 }),
  )
  expect(flipped.list).not.toBe(first.list)
  expect(flipped.list[0]).toMatchObject({ mergeable: 'CONFLICTING', refreshedAt: AT + 30_000 })
  const status = applyDiscovery(
    first.list,
    input({ prs: [discovered({ mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' })], at: AT + 30_000 }),
  )
  expect(status.list).not.toBe(first.list)
  expect(status.list[0]).toMatchObject({ mergeStateStatus: 'BEHIND' })
  const same = applyDiscovery(
    first.list,
    input({ prs: [discovered({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })], at: AT + 30_000 }),
  )
  expect(same.list).toBe(first.list)
})

test('M3: a fork PR record keeps crossRepo; a change of it alone is written, and a PR that is not a fork has no field', () => {
  const fork = applyDiscovery([], input({ prs: [discovered({ crossRepo: true })] }))
  expect(fork.list[0]).toMatchObject({ crossRepo: true })
  const own = applyDiscovery([], input()).list[0]!
  expect('crossRepo' in own).toBe(false)
  // Only the fork flag differs: the record is current except for it, so it must be written (isCurrent compares it).
  const flagged = applyDiscovery([own], input({ prs: [discovered({ crossRepo: true })] }))
  expect(flagged.list[0]).toMatchObject({ crossRepo: true })
  const same = applyDiscovery(fork.list, input({ prs: [discovered({ crossRepo: true })], at: AT + 30_000 }))
  expect(same.list).toBe(fork.list)
  const cleared = applyDiscovery(fork.list, input({ prs: [discovered()], at: AT + 30_000 }))
  expect(cleared.list).not.toBe(fork.list)
  expect('crossRepo' in cleared.list[0]!).toBe(false)
})

test('a merge value that GitHub stops returning is removed from the record, so a stale conflict cannot stay', () => {
  const first = applyDiscovery(
    [],
    input({ prs: [discovered({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })] }),
  )
  const second = applyDiscovery(first.list, input({ prs: [discovered()], at: AT + 30_000 }))
  expect(second.list).not.toBe(first.list)
  expect('mergeable' in second.list[0]! || 'mergeStateStatus' in second.list[0]!).toBe(false)
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

test('a mentioned PR gains the lane marker with no count change and takes the type pr', () => {
  const list = [mentioned(7)]
  const r = applyDiscovery(list, input())
  expect(r.list[0]).toMatchObject({
    sources: ['prompt'],
    lane: true,
    seenCount: 2,
    lastSeen: 2,
    type: 'pr',
    refreshedAt: AT,
  })
  expect(list[0]?.sources).toEqual(['prompt'])
  expect('lane' in list[0]!).toBe(false)
})

test('body refs: new records get via and seenCount 0 and no source, and are reported in added', () => {
  const refsByPr = new Map<string, readonly Claim[]>([[K7, claimsOf([ghRef(1), webRef], 'pr-body', AT)]])
  const r = applyDiscovery([], input({ refsByPr }))
  expect(r.list.map(x => x.key)).toEqual([K7, 'gh:github.com/acme/web#1', keyOf(webRef)])
  expect(r.list[1]).toMatchObject({ sources: [], via: [K7], seenCount: 0 })
  expect(r.added).toEqual(['gh:github.com/acme/web#1', keyOf(webRef)])
})

test('an existing item named by the body gains discovered and via; both there already keeps the object', () => {
  const refsByPr = new Map<string, readonly Claim[]>([[K7, claimsOf([ghRef(1)], 'pr-body', AT)]])
  const list = [mentioned(1, { type: 'issue' })]
  const first = applyDiscovery(list, input({ refsByPr }))
  const rec = first.list.find(x => x.key === 'gh:github.com/acme/web#1')
  expect(rec).toMatchObject({ sources: ['prompt'], via: [K7], seenCount: 2 })
  expect(rec?.reasons.all).toEqual(['discovered', 'mentioned'])
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

test('prune runs only on a complete reply: a PR that left loses the lane marker, and its auto-only refs go', () => {
  const refsByPr = new Map<string, readonly Claim[]>([[K7, claimsOf([ghRef(1)], 'pr-body', AT)]])
  const first = applyDiscovery([], input({ refsByPr })).list
  const gone = applyDiscovery(first, input({ prs: [], complete: true, at: AT + 1 }))
  expect(gone.list).toEqual([])
  const partial = applyDiscovery(first, input({ prs: [], complete: false, at: AT + 1 }))
  expect(partial.list).toBe(first)
})

test('prune keeps a mentioned item and strips only discovery: the reason, the lane marker and via', () => {
  const list: ItemRecord[] = [found(7, { lane: true }), found(1, { via: [K7], type: 'issue' })]
  const r = applyDiscovery(list, input({ prs: [], complete: true }))
  expect(r.list.map(x => [x.key, x.sources, x.via, x.reasons.all, 'lane' in x])).toEqual([
    [K7, ['prompt'], undefined, ['mentioned'], false],
    ['gh:github.com/acme/web#1', ['prompt'], undefined, ['mentioned'], false],
  ])
})

test('prune: a PR the lane lost keeps discovered while a body of a live PR still names it', () => {
  const nine = discovered({ number: 9 })
  const refs = new Map<string, readonly Claim[]>([[prKey(nine), claimsOf([ghRef(7)], 'pr-body', AT)]])
  const first = applyDiscovery([], input({ prs: [discovered({ number: 7 }), nine], refsByPr: refs })).list
  expect(first.find(x => x.key === K7)).toMatchObject({ lane: true, via: [K9] })
  // The lane stops finding #7, and the body of #9 still lists it: the marker goes, the reason and via stay.
  const second = applyDiscovery(first, input({ prs: [nine], refsByPr: refs, at: AT + 1 }))
  const rec = second.list.find(x => x.key === K7)!
  expect('lane' in rec).toBe(false)
  expect(rec).toMatchObject({ via: [K9], sources: [], reasons: DISCOVERED })
  expect(isLanePr(rec as GitHubRecord)).toBe(false)
})

const bodyRef = (i: number): WebRef => ({ category: 'web', url: `https://x.example/${i}`, label: `x${i}` })

test('prune cuts via to the PRs still in the result', () => {
  const both: ItemRecord = { ...autoWeb(1), via: [K7, K9] }
  const refs = new Map<string, readonly Claim[]>([[K7, claimsOf([bodyRef(1)], 'pr-body', AT)]])
  const r = applyDiscovery([both], input({ prs: [discovered({ number: 7 })], refsByPr: refs }))
  expect(r.list.find(x => x.key === both.key)?.via).toEqual([K7])
})

test('prune follows the body: a ref that an edited body no longer lists loses discovered and via (A12)', () => {
  const body = new Map<string, readonly Claim[]>([[K7, claimsOf([bodyRef(1)], 'pr-body', AT)]])
  const first = applyDiscovery([], input({ refsByPr: body }))
  expect(first.list.find(x => x.key === keyOf(bodyRef(1)))).toMatchObject({ sources: [], via: [K7] })
  // The body is edited: the PR stays in the reply and lists no ref.
  const second = applyDiscovery(first.list, input({ refsByPr: new Map([[K7, []]]) }))
  expect(second.list.map(x => x.key)).toEqual([K7])
  // A mentioned item loses only discovery: its reason and via.
  const kept = applyDiscovery([found(1, { via: [K7], type: 'issue' })], input({ refsByPr: new Map([[K7, []]]) }))
  const rec = kept.list.find(x => x.key === 'gh:github.com/acme/web#1')!
  expect(rec.sources).toEqual(['prompt'])
  expect(rec.via).toBeUndefined()
  // A partial reply deletes nothing.
  const partial = applyDiscovery(first.list, input({ refsByPr: new Map([[K7, []]]), complete: false }))
  expect(partial.list.find(x => x.key === keyOf(bodyRef(1)))).toMatchObject({ sources: [], via: [K7] })
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

test('dropAuto removes discovered and via from the given keys, and deletes a record with no reason left', () => {
  const list: ItemRecord[] = [found(7, { lane: true, via: [K9] }), autoWeb(1), autoWeb(2)]
  const r = dropAuto(list, new Set([K7, autoWeb(1).key]))
  expect(r.map(x => x.key)).toEqual([K7, autoWeb(2).key])
  expect(r[0]).toMatchObject({ sources: ['prompt'], reasons: reasonSet('mentioned') })
  expect(r[0]?.via).toBeUndefined()
})

test('dropAuto leaves the lane marker, which core does not know, and isLanePr reads it as not found by the lane', () => {
  // The state of a load (`withoutAuto`): the marker outlives the reason until the next complete PR step.
  const [kept] = dropAuto([found(7, { lane: true })], new Set([K7]))
  expect((kept as GitHubRecord).lane).toBe(true)
  expect(isLanePr(kept as GitHubRecord)).toBe(false)
  // The lane finds the PR again: reason and marker are set together, and the record is the PR of the lane.
  const again = applyDiscovery([kept!], input()).list[0] as GitHubRecord
  expect(isLanePr(again)).toBe(true)
  expect(again.sources).toEqual(['prompt'])
  // The lane no longer finds it: the stale marker goes with the prune.
  const gone = applyDiscovery([kept!], input({ prs: [] })).list[0] as GitHubRecord
  expect('lane' in gone).toBe(false)
  expect(gone.reasons).toEqual(reasonSet('mentioned'))
})

test('a fold keeps the lane marker of either record, as the union of sources kept auto', () => {
  const table = (category: string) => (category === 'github' ? githubKind : undefined)
  const lane = applyDiscovery([], input()).list[0]!
  // The record the chat made is the newer one, so it wins the fold and its own fields are the base: the marker must join in.
  const chat = { ...named(mentioned(7, { type: 'pr' })), refreshedAt: AT + 1 }
  for (const [a, b] of [
    [lane, chat],
    [chat, lane],
  ] as const) {
    const out = foldRecords(a, b, table) as GitHubRecord
    expect(out.lane).toBe(true)
    expect(out.sources).toEqual(['prompt'])
    expect(out.reasons.all).toEqual(['discovered', 'mentioned'])
  }
  expect('lane' in foldRecords(chat, chat, table)).toBe(false)
})

test('a lane marker that outlived a load stays off when a body ref or a fold adds discovered (#62)', () => {
  const both = applyDiscovery([mentioned(7, { type: 'pr' })], input()).list[0]!
  const [stale] = dropAuto([both], new Set([K7])) // the load: the marker stays, `discovered` goes
  expect((stale as GitHubRecord).lane).toBe(true)
  expect(isLanePr(stale as GitHubRecord)).toBe(false)
  // Another live PR names #7 in its body, and the reply is partial, so no prune clears the marker.
  const nine = discovered({ number: 9 })
  const refs = new Map<string, readonly Claim[]>([[prKey(nine), claimsOf([ghRef(7)], 'pr-body', AT)]])
  const rec = applyDiscovery([stale!], input({ prs: [nine], refsByPr: refs, complete: false, at: AT + 1 })).list.find(
    x => x.key === K7,
  ) as GitHubRecord
  expect(rec.reasons.all).toEqual(['discovered', 'mentioned']) // the body ref did add discovered
  expect(isLanePr(rec)).toBe(false) // and it is not a lane PR again
  expect('lane' in rec).toBe(false)
  expect(rec.via).toEqual([K9])
  // A fold of the stale record with a copy that a body ref made: the stale marker must not join.
  const bodyCopy = applyDiscovery([], input({ prs: [nine], refsByPr: refs })).list.find(x => x.key === K7)!
  const table = (c: string) => (c === 'github' ? githubKind : undefined)
  for (const [a, b] of [
    [stale!, bodyCopy],
    [bodyCopy, stale!],
  ] as const) {
    const out = foldRecords(a, b, table) as GitHubRecord
    expect(out.reasons.all).toContain('discovered')
    expect(isLanePr(out)).toBe(false)
    expect('lane' in out).toBe(false)
  }
})

test('dropAuto with no matching key returns the input list', () => {
  const list: ItemRecord[] = [autoWeb(1)]
  expect(dropAuto(list, new Set(['nope']))).toBe(list)
  expect(keyOf(ghRef(1))).toBe('gh:github.com/acme/web#1')
})

// ---------------------------------------------------------------- reasons (issue #62)

const jiraRef = (n: number): Ref => ({
  category: 'jira',
  site: 'acme.atlassian.net',
  issueKey: `ISS-${n}`,
  url: `https://acme.atlassian.net/browse/ISS-${n}`,
  trackOnly: false,
})

test('reasons: a PR the lane found is discovered; a mentioned PR gains discovered and keeps its mention', () => {
  expect(applyDiscovery([], input()).list[0]?.reasons).toEqual({
    first: 'discovered',
    all: ['discovered'],
    strongest: 'discovered',
  })
  const named = applyDiscovery([mentioned(7)], input()).list[0]
  expect(named?.reasons).toEqual({ first: 'mentioned', all: ['discovered', 'mentioned'], strongest: 'discovered' })
})

test('reasons: a ref in a PR body is discovered, whatever its kind; one that was mentioned keeps its mention', () => {
  const claims = claimsOf([ghRef(1), webRef, jiraRef(4)], 'pr-body', AT)
  const fresh = applyDiscovery([], input({ refsByPr: new Map([[K7, claims]]) }))
  const reasons = fresh.list.filter(x => x.key !== K7).map(x => [x.category, x.reasons])
  const discoveredOnly = { first: 'discovered', all: ['discovered'], strongest: 'discovered' }
  expect(reasons).toEqual([
    ['github', discoveredOnly],
    ['web', discoveredOnly],
    ['jira', discoveredOnly],
  ])
  const named = applyDiscovery([mentioned(1, { type: 'issue' })], input({ refsByPr: new Map([[K7, claims]]) }))
  expect(named.list.find(x => x.key === 'gh:github.com/acme/web#1')?.reasons).toEqual({
    first: 'mentioned',
    all: ['discovered', 'mentioned'],
    strongest: 'discovered',
  })
})

test('reasons: the prune takes discovered away with the last of the lane and via, and a mention stays', () => {
  const refsByPr = new Map<string, readonly Claim[]>([[K7, claimsOf([ghRef(1)], 'pr-body', AT)]])
  const first = applyDiscovery([mentioned(7)], input({ refsByPr })).list
  expect(first.find(x => x.key === K7)?.reasons.all).toEqual(['discovered', 'mentioned'])
  const gone = applyDiscovery(first, input({ prs: [], complete: true, at: AT + 1 }))
  // The mentioned PR stays with its mention only; the ref that only the body named goes.
  expect(gone.list.map(x => [x.key, x.reasons])).toEqual([
    [K7, { first: 'mentioned', all: ['mentioned'], strongest: 'mentioned' }],
  ])
})

test('reasons: dropAuto takes discovered away, and a mention stays', () => {
  const both = applyDiscovery([mentioned(7)], input()).list
  const [kept] = dropAuto(both, new Set([K7]))
  expect(kept?.sources).toEqual(['prompt'])
  expect(kept?.reasons).toEqual({ first: 'mentioned', all: ['mentioned'], strongest: 'mentioned' })
})

// ---------------------------------------------------------------- sources keep channels only (issue #62, R2)

test('sources keep channels only: a PR the lane found has no auto in sources, the reason discovered and the lane marker', () => {
  const rec = applyDiscovery([], input()).list[0] as GitHubRecord
  expect(rec.sources).toEqual([])
  expect(rec.reasons).toEqual({ first: 'discovered', all: ['discovered'], strongest: 'discovered' })
  expect(rec.lane).toBe(true)
  // A mentioned PR the lane then found keeps its channel, and gains the reason and the marker.
  const named = applyDiscovery([mentioned(7)], input()).list[0] as GitHubRecord
  expect(named.sources).toEqual(['prompt'])
  expect(named.lane).toBe(true)
  expect(named.reasons.all).toEqual(['discovered', 'mentioned'])
})

test('sources keep channels only: a body ref has no pr-body in sources, keeps discovered and via, and has no lane marker', () => {
  const refsByPr = new Map<string, readonly Claim[]>([[K7, claimsOf([ghRef(1), webRef], 'pr-body', AT)]])
  const [, issue, web] = applyDiscovery([], input({ refsByPr })).list
  for (const rec of [issue!, web!]) {
    expect(rec.sources).toEqual([])
    expect(rec.reasons).toEqual({ first: 'discovered', all: ['discovered'], strongest: 'discovered' })
    expect(rec.via).toEqual([K7])
  }
  expect('lane' in issue!).toBe(false)
  // A mentioned item that a body names keeps its channel too.
  const body = new Map([[K7, claimsOf([ghRef(1)], 'pr-body', AT)]])
  const named = applyDiscovery([mentioned(1, { type: 'issue' })], input({ refsByPr: body }))
  const rec = named.list.find(x => x.key === 'gh:github.com/acme/web#1')!
  expect(rec.sources).toEqual(['prompt'])
  expect(rec.via).toEqual([K7])
  expect('lane' in rec).toBe(false)
})
