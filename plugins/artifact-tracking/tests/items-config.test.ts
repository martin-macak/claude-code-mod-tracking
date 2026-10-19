// The item runtime reads its numbers from the config views at the moment it needs them: a changed file shows at the
// next refresh, the next row or the next merge, with no restart (decision C5). Each test uses a value that is not the
// default. Plan: L4 Task 7 (C12).
import { expect, test } from 'claude-code/testing'
import type { Claim } from '../core/interfaces/items'
import type { GitHubRef, ItemRecord, Ref, WebRef } from '../hooks/contracts'
import { recordFromRef } from '../hooks/model/registry'
import { graphqlCalls, itemsWorld, promptRow, replayRow, sleep, until } from './fixtures/items'

const gh = (owner: string, repo: string, n: number): GitHubRef => ({
  category: 'github',
  host: 'github.com',
  owner,
  repo,
  number: n,
  type: 'issue',
})
const rec = (ref: Ref, at = 10): ItemRecord => recordFromRef(ref, { source: 'prompt', at })
const web = (i: number): WebRef => ({ category: 'web', url: `https://h${i}.example/`, label: `h${i}` })
const claims = (from: number, n: number): Claim[] =>
  Array.from({ length: n }, (_, i) => web(from + i)) as unknown as Claim[]
const threeIssues = (at = 10) => [
  rec(gh('acme', 'web', 5), at),
  rec(gh('acme', 'web', 9), at),
  rec(gh('cli', 'cli', 14640), at),
]

test('a changed github slice reaches the next refresh with no restart', async () => {
  const t = itemsWorld()
  t.w.state.set('items', threeIssues() as unknown as never)
  const rt = await t.started()
  await rt.refreshAll()
  expect(graphqlCalls(t.w.calls).length).toBe(1) // chunkSize 50: one call for the three items
  t.cfg.set({ trackers: { github: { chunkSize: 2 } } })
  await rt.refreshAll()
  expect(graphqlCalls(t.w.calls).length).toBe(1 + 2)
})

test('a changed staleMs reaches the due check of the next run', async () => {
  const t = itemsWorld()
  t.w.clock.now = 400_000
  t.w.state.set('items', threeIssues().map(r => ({ ...r, refreshedAt: 300_000 })) as unknown as never) // 100 s old
  const rt = await t.started()
  rt.kick('open')
  await sleep(20) // lets the run go by
  expect(graphqlCalls(t.w.calls).length).toBe(0) // under the default 300000: not due
  t.cfg.set({ global: { refresh: { staleMs: 30000 } } })
  rt.kick('open')
  await until(() => graphqlCalls(t.w.calls).length === 1, 'the refresh')
})

test('maxMentionsPerRow 1 keeps one mention', async () => {
  const t = itemsWorld({ file: { trackers: { file: { maxMentionsPerRow: 1 } } } })
  t.w.files['/work/a.md'] = '# a'
  t.w.files['/work/b.md'] = '# b'
  const rt = await t.started()
  await rt.capture(promptRow('please read a.md and b.md'))
  expect(t.keys()).toEqual(['file:/work/a.md'])
})

test('maxMentionsPerRow 0 keeps no mention', async () => {
  const t = itemsWorld({ file: { trackers: { file: { maxMentionsPerRow: 0 } } } })
  t.w.files['/work/a.md'] = '# a'
  const rt = await t.started()
  await rt.capture(promptRow('please read a.md'))
  expect(t.keys()).toEqual([])
})

test('with the default maxMentionsPerRow two mentions are kept', async () => {
  const t = itemsWorld()
  t.w.files['/work/a.md'] = '# a'
  t.w.files['/work/b.md'] = '# b'
  const rt = await t.started()
  await rt.capture(promptRow('please read a.md and b.md'))
  expect(t.keys().sort()).toEqual(['file:/work/a.md', 'file:/work/b.md'])
})

test('a replay follows maxMentionsPerRow too', async () => {
  const t = itemsWorld({ file: { trackers: { file: { maxMentionsPerRow: 1 } } } })
  t.w.files['/work/a.md'] = '# a'
  t.w.files['/work/b.md'] = '# b'
  const rt = await t.started()
  await rt.replay([replayRow('prompt', 'please read a.md and b.md')])
  expect(t.keys()).toEqual(['file:/work/a.md'])
})

test('the merge cap follows global.store.maxItems', async () => {
  const t = itemsWorld({ file: { global: { store: { maxItems: 200 } } } })
  const rt = await t.started()
  await rt.track(claims(0, 200), 'prompt')
  expect(t.list().length).toBe(200)
  await rt.track(claims(200, 1), 'prompt') // one more: the oldest goes (a record added in the same call never does)
  expect(t.list().length).toBe(200)
})

test('with the default maxItems the same 201 records stay', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  await rt.track(claims(0, 200), 'prompt')
  await rt.track(claims(200, 1), 'prompt')
  expect(t.list().length).toBe(201)
})

test('shortRefKeywords from the file reach capture', async () => {
  const t = itemsWorld({ file: { trackers: { github: { shortRefKeywords: ['ticket'] } } } })
  const rt = await t.started()
  await rt.capture(promptRow('see issue #5'))
  expect(t.keys()).toEqual([])
  await rt.capture(promptRow('see ticket #5'))
  expect(t.keys()).toEqual(['gh:github.com/acme/web#5'])
})

test('shortRefKeywords from the file reach the replay', async () => {
  const t = itemsWorld({ file: { trackers: { github: { shortRefKeywords: ['ticket'] } } } })
  const rt = await t.started()
  await rt.replay([replayRow('prompt', 'see issue #5'), replayRow('response', 'done with ticket #5')])
  expect(t.keys()).toEqual(['gh:github.com/acme/web#5'])
})

test('the default keywords make issue #5 a short ref', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  await rt.capture(promptRow('see issue #5'))
  expect(t.keys()).toEqual(['gh:github.com/acme/web#5'])
})
