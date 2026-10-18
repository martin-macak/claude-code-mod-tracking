// The item list of the item runtime on fakePorts: the checked writers (`update`, `track`), the raw writer behind the
// `items` slot, and what a load keeps of a stored copy. Plan: L3 Task 11, Review Focus 2.
import { expect, test } from 'claude-code/testing'
import type { Json, StoredItem } from '../core/interfaces/items'
import type { GitHubRef, ItemRecord, Ref, WebRef } from '../hooks/contracts'
import { ItemStore, storedForLoad } from '../hooks/items/store'
import { recordFromRef } from '../hooks/model/registry'
import { itemsWorld, promptRow, sleep, until } from './fixtures/items'

const gh = (n: number, over: Partial<GitHubRef> = {}): GitHubRef => ({
  category: 'github',
  host: 'github.com',
  owner: 'acme',
  repo: 'web',
  number: n,
  type: 'issue',
  ...over,
})
const web = (url: string): WebRef => ({ category: 'web', url, label: url })
const rec = (ref: Ref, source: 'prompt' | 'response' | 'tool' | 'auto' = 'prompt', at = 10): ItemRecord =>
  recordFromRef(ref, { source, at })
const asJson = (list: ItemRecord[]) => list as unknown as Json
const asStored = (r: ItemRecord) => r as unknown as StoredItem

test('track merges, drops dismissed keys and queues the new ones for refresh', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  t.dismissed.add('gh:github.com/acme/web#6')
  await rt.track([gh(5), gh(6)] as never, 'prompt')
  expect(t.keys()).toEqual(['gh:github.com/acme/web#5'])
  // The capture debounce is armed on the new key: one refresh after it.
  const before = t.w.calls.length
  await t.w.clock.advance(1010)
  await until(() => t.w.calls.length > before, 'the refresh')
  expect(t.w.calls.some(c => c[1] === 'api')).toBe(true)
})

test('track with nothing to keep writes nothing', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  t.dismissed.add('gh:github.com/acme/web#6')
  await rt.track([gh(6)] as never, 'prompt')
  await rt.track([], 'prompt')
  expect(t.w.stateSets.items).toBeUndefined()
})

test('update with an unchanged list writes nothing; with a change it writes and says so', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  await rt.track([web('https://a.example/')] as never, 'prompt')
  const writes = t.w.stateSets.items
  expect(await rt.update(list => list)).toBe(false)
  expect(t.w.stateSets.items).toBe(writes)
  expect(await rt.update(list => list.filter(r => r.key !== 'web:https://a.example/'))).toBe(true)
  expect(t.keys()).toEqual([])
})

test('update gives change the dismissed set of the run, read again before the write', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  const seen: string[][] = []
  let first = true
  await rt.update((list, dismissed) => {
    seen.push([...dismissed])
    if (first) {
      first = false
      t.dismissed.add('x') // an x press while the first call ran
    }
    return [...list, asStored(rec(web('https://b.example/')))]
  })
  expect(seen).toEqual([[], ['x']])
})

test('update runs the session check first and drops a write for an older generation', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  const checks = t.watch.checks
  await rt.update(list => [...list, asStored(rec(web('https://c.example/')))])
  expect(t.watch.checks).toBe(checks + 1)
  t.watch.gen = 3
  expect(await rt.update(list => [...list, asStored(rec(web('https://d.example/')))], { since: 2 })).toBe(false)
  expect(t.keys()).toEqual(['web:https://c.example/'])
})

test('a checked write before the runtime started says so', async () => {
  const t = itemsWorld()
  await expect(t.rt.update(list => list)).rejects.toThrow('items: not started')
  await expect(t.rt.track([], 'prompt')).rejects.toThrow('items: not started')
})

test('every write calls persisted(); before start there is nobody to tell', async () => {
  const t = itemsWorld()
  await t.rt.slot.restore(asJson([rec(web('https://e.example/'))]), 'carry') // before start: no context, no signal
  expect(t.persisted).toEqual([])
  const rt = await t.started()
  await rt.slot.restore(asJson([rec(web('https://f.example/'))]), 'carry')
  expect(t.persisted).toEqual(['items'])
  await rt.slot.clear?.()
  expect(t.persisted).toEqual(['items', 'items'])
})

test('settle unites the stored copy under the live list, less the dismissed keys, and moves old web rows of artifact URLs', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  t.dismissed.add('web:https://gone.example/')
  const stored = [rec(web('https://stored.example/'), 'prompt', 1), rec(web('https://gone.example/'), 'prompt', 1)]
  const live = [rec(web('https://live.example/'), 'prompt', 2)]
  const settled = (await rt.slot.settle(asJson(live), asJson(stored))) as unknown as ItemRecord[]
  expect(settled.map(r => r.key).sort()).toEqual(['web:https://live.example/', 'web:https://stored.example/'])
  const old = rec(web('https://claude.ai/artifact/D3zR4h4m4W1diV3brT2Mbo'))
  const moved = (await rt.slot.settle(asJson([old]), undefined)) as unknown as ItemRecord[]
  expect(moved.map(r => r.category)).toEqual(['artifact'])
  expect(await rt.slot.settle(undefined, undefined)).toEqual([])
})

const jira = (site: string, key: string, sources: string[]): ItemRecord =>
  ({
    key: `jira:${site}/${key}`,
    category: 'jira',
    url: `https://${site}/browse/${key}`,
    label: key,
    sources,
    firstSeen: 1,
    lastSeen: 1,
    seenCount: 1,
    site,
    issueKey: key,
    trackOnly: false,
    children: [],
  }) as unknown as ItemRecord

test('restore load drops auto sources, foreign tool-only Jira items, not-found and dismissed items, and clears refreshedAt', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  t.dismissed.add('web:https://dismissed.example/')
  const stored = [
    { ...rec(web('https://kept.example/')), refreshedAt: 99 },
    rec(gh(7), 'auto'),
    rec(web('https://dismissed.example/')),
    { ...rec(gh(8)), error: { kind: 'not-found', message: 'x', at: 1 } } as ItemRecord,
    jira('acme.atlassian.net', 'ISS-1', ['prompt']),
    jira('vertice.atlassian.net', 'ISS-2', ['tool']),
  ]
  await rt.slot.restore(asJson(stored), 'load')
  expect(t.keys().sort()).toEqual(['jira:acme.atlassian.net/ISS-1', 'web:https://kept.example/'])
  expect(t.list().find(r => r.key === 'web:https://kept.example/')?.refreshedAt).toBeUndefined()
})

test('storedForLoad is pure: an unknown acli keeps every Jira item, no site drops the tool-only ones', () => {
  const j = jira('x.atlassian.net', 'A-1', ['tool'])
  expect(storedForLoad([j], undefined, new Set()).length).toBe(1)
  expect(storedForLoad([j], null, new Set()).length).toBe(0)
  expect(storedForLoad([j], 'X.atlassian.net', new Set()).length).toBe(1)
})

test('restore carry unites the value with the live list', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  await rt.track([web('https://live.example/')] as never, 'prompt')
  await rt.slot.restore(asJson([rec(web('https://carried.example/'))]), 'carry')
  expect(t.keys().sort()).toEqual(['web:https://carried.example/', 'web:https://live.example/'])
  await rt.slot.restore(asJson([]), 'carry') // an empty value changes nothing
  expect(t.keys().length).toBe(2)
})

test('the slot reads the live list, knows empty, and clear empties the list', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  expect(rt.slot.id).toBe('items')
  expect(rt.slot.persist).toBe(true)
  expect(rt.slot.empty(await rt.slot.read())).toBe(true)
  await rt.track([web('https://live.example/')] as never, 'prompt')
  expect(rt.slot.empty(await rt.slot.read())).toBe(false)
  expect(rt.slot.empty(undefined)).toBe(true)
  await rt.slot.clear?.()
  expect(t.keys()).toEqual([])
})

test('restore during a switch writes without a session check (Review Focus 2)', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  // The check is single flight: during a switch it would wait for the switch itself. This one never answers.
  t.watch.check = () => new Promise<boolean>(() => {})
  await rt.slot.restore(asJson([rec(web('https://a.example/'))]), 'carry')
  await rt.slot.restore(asJson([rec(web('https://b.example/'))]), 'load')
  await rt.slot.clear?.()
  await rt.slot.restore(asJson([rec(web('https://c.example/'))]), 'carry')
  expect(t.keys()).toEqual(['web:https://c.example/'])
  // The checked writers do wait for it.
  let done = false
  void rt
    .update(list => list)
    .then(() => {
      done = true
    })
  await sleep(15)
  expect(done).toBe(false)
})

test('the store refresh passes its keys on, or none for every item', () => {
  const kicks: (readonly string[] | undefined)[] = []
  const store = new ItemStore({
    atom: { get: async () => [], update: async fn => fn([]) },
    host: () => undefined,
    kick: keys => void kicks.push(keys),
  })
  store.refresh(['a'])
  store.refresh()
  expect(kicks).toEqual([['a'], undefined])
})

test('a prompt row captured through the runtime reaches the same writer', async () => {
  const t = itemsWorld()
  const rt = await t.started()
  await rt.capture(promptRow('see https://docs.example/a'))
  expect(t.keys()).toEqual(['web:https://docs.example/a'])
  expect(t.persisted.length).toBeGreaterThan(0)
})
