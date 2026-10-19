// The item service on fakePorts: the checked and the raw writers of the list, what a load keeps of a stored copy, the
// tools and the refresh it builds at start, the session repo its kinds find, the tick, `/track refresh` and the priority
// of a row. The cases of the L3 store and runtime tests moved here; each mirrors the kit test of the same subject.
// Plan: L3 Task 11, D13, D16. L5 Task 8 (K3, K9, K21).
import { expect, test } from 'claude-code/testing'
import { ItemStore } from '../core/infra/item-store'
import type { Kinds } from '../core/infra/kinds'
import type { Json, StoredItem } from '../core/interfaces/items'
import { ghOf } from '../trackers/github/client'
import { fakeConfig } from './fixtures/config-fs'
import type { GitHubRef, ItemRecord, Ref, WebRef } from './fixtures/contracts'
import { GHE_AUTH_STATUS_STDERR } from './fixtures/gh'
import { claimOf, fakeItems, graphqlCalls, promptRow, res, sleep, until } from './fixtures/items'
import { managerWorld } from './fixtures/manager'
import { recordFromRef } from './fixtures/registry'

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
const versionCalls = (calls: string[][], tool: string) => calls.filter(c => c[0] === tool && c[1] === '--version')
const argv0 = (calls: string[][], tool: string) => calls.filter(c => c[0] === tool)

// ---------------------------------------------------------------- the list

test('track merges, drops dismissed keys and queues the new ones for refresh', async () => {
  const t = fakeItems()
  const items = await t.started()
  t.dismissed.add('gh:github.com/acme/web#6')
  await items.track([claimOf(gh(5)), claimOf(gh(6))])
  expect(t.keys()).toEqual(['gh:github.com/acme/web#5'])
  // The capture debounce is armed on the new key: one refresh after it.
  const before = t.w.calls.length
  await t.w.clock.advance(1010)
  await until(() => t.w.calls.length > before, 'the refresh')
  expect(t.w.calls.some(c => c[1] === 'api')).toBe(true)
})

test('track with nothing to keep writes nothing', async () => {
  const t = fakeItems()
  const items = await t.started()
  t.dismissed.add('gh:github.com/acme/web#6')
  await items.track([claimOf(gh(6))])
  await items.track([])
  expect(t.w.stateSets.items).toBeUndefined()
})

test('port(owner).track merges claims, drops dismissed keys and queues the added ones for refresh', async () => {
  const t = fakeItems()
  const items = await t.started()
  t.dismissed.add('gh:github.com/acme/web#6')
  await items.port('github').track([claimOf(gh(5)), claimOf(gh(6)), claimOf(web('https://a.example/'))])
  expect(t.keys().sort()).toEqual(['gh:github.com/acme/web#5', 'web:https://a.example/'])
  const before = graphqlCalls(t.w.calls).length
  await t.w.clock.advance(1010)
  await until(() => graphqlCalls(t.w.calls).length === before + 1, 'the refresh of the added keys')
  expect(items.port('web')).toBe(items.port('github')) // every owner sees the same list
})

test('update with an unchanged list writes nothing; with a change it writes and says so', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.track([claimOf(web('https://a.example/'))])
  const writes = t.w.stateSets.items
  expect(await items.update(list => list)).toBe(false)
  expect(t.w.stateSets.items).toBe(writes)
  expect(await items.update(list => list.filter(r => r.key !== 'web:https://a.example/'))).toBe(true)
  expect(t.keys()).toEqual([])
})

test('update gives change the dismissed set of the run, read again before the write', async () => {
  const t = fakeItems()
  const items = await t.started()
  const seen: string[][] = []
  let first = true
  await items.update((list, dismissed) => {
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
  const t = fakeItems()
  const items = await t.started()
  const checks = t.watch.checks
  await items.update(list => [...list, asStored(rec(web('https://c.example/')))])
  expect(t.watch.checks).toBe(checks + 1)
  t.watch.gen = 3
  expect(await items.update(list => [...list, asStored(rec(web('https://d.example/')))], { since: 2 })).toBe(false)
  expect(t.keys()).toEqual(['web:https://c.example/'])
})

test('a checked write before the runtime started says so', async () => {
  const t = fakeItems()
  await expect(t.items.update(list => list)).rejects.toThrow('items: not started')
  await expect(t.items.track([])).rejects.toThrow('items: not started')
  expect(t.keys()).toEqual([])
  expect(t.persisted).toEqual([])
})

test('every write calls persisted(); before start there is nobody to tell', async () => {
  const t = fakeItems()
  await t.items.slot.restore(asJson([rec(web('https://e.example/'))]), 'carry') // before start: no signal
  expect(t.persisted).toEqual([])
  const items = await t.started()
  await items.slot.restore(asJson([rec(web('https://f.example/'))]), 'carry')
  expect(t.persisted).toEqual(['items'])
  await items.slot.clear?.()
  expect(t.persisted).toEqual(['items', 'items'])
})

test('the store refresh passes its keys on, or none for every item', () => {
  const kicks: (readonly string[] | undefined)[] = []
  const store = new ItemStore({
    atom: { get: async () => [], update: async fn => fn([]) },
    kinds: {} as Kinds,
    dismiss: { list: async () => new Set(), add: async () => {} },
    current: async () => 0,
    cap: () => 100,
    persisted: () => {},
    kick: keys => void kicks.push(keys),
    started: () => false,
  })
  store.refresh(['a'])
  store.refresh()
  expect(kicks).toEqual([['a'], undefined])
})

test('a prompt row captured through the service reaches the same writer', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.capture(promptRow('see https://docs.example/a'))
  expect(t.keys()).toEqual(['web:https://docs.example/a'])
  expect(t.persisted.length).toBeGreaterThan(0)
})

// ---------------------------------------------------------------- the slot

test('settle unites the stored copy under the live list, less the dismissed keys, and moves old web rows of artifact URLs', async () => {
  const t = fakeItems()
  const items = await t.started()
  t.dismissed.add('web:https://gone.example/')
  const stored = [rec(web('https://stored.example/'), 'prompt', 1), rec(web('https://gone.example/'), 'prompt', 1)]
  const live = [rec(web('https://live.example/'), 'prompt', 2)]
  const settled = (await items.slot.settle(asJson(live), asJson(stored))) as unknown as ItemRecord[]
  expect(settled.map(r => r.key).sort()).toEqual(['web:https://live.example/', 'web:https://stored.example/'])
  const old = rec(web('https://claude.ai/artifact/D3zR4h4m4W1diV3brT2Mbo'))
  const moved = (await items.slot.settle(asJson([old]), undefined)) as unknown as ItemRecord[]
  expect(moved.map(r => r.category)).toEqual(['artifact'])
  expect(await items.slot.settle(undefined, undefined)).toEqual([])
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
  const t = fakeItems()
  const items = await t.started()
  t.dismissed.add('web:https://dismissed.example/')
  const stored = [
    { ...rec(web('https://kept.example/')), refreshedAt: 99 },
    rec(gh(7), 'auto'),
    rec(web('https://dismissed.example/')),
    { ...rec(gh(8)), error: { kind: 'not-found', message: 'x', at: 1 } } as ItemRecord,
    jira('acme.atlassian.net', 'ISS-1', ['prompt']),
    jira('vertice.atlassian.net', 'ISS-2', ['tool']),
  ]
  await items.slot.restore(asJson(stored), 'load')
  expect(t.keys().sort()).toEqual(['jira:acme.atlassian.net/ISS-1', 'web:https://kept.example/'])
  expect(t.list().find(r => r.key === 'web:https://kept.example/')?.refreshedAt).toBeUndefined()
})

test('jira restore: no site drops the tool-only items, a site keeps its own, an unknown acli keeps every item', async () => {
  const tool = jira('x.atlassian.net', 'A-1', ['tool'])
  const noSite = fakeItems({
    run: argv => (argv[0] === 'acli' && argv[2] === 'auth' ? res('', 1, 'not logged in') : undefined),
  })
  await (await noSite.started()).slot.restore(asJson([tool, jira('x.atlassian.net', 'A-2', ['prompt'])]), 'load')
  expect(noSite.keys()).toEqual(['jira:x.atlassian.net/A-2'])
  const same = fakeItems({
    run: argv => (argv[0] === 'acli' && argv[2] === 'auth' ? res('Site: X.atlassian.net\n') : undefined),
  })
  await (await same.started()).slot.restore(asJson([tool]), 'load')
  expect(same.keys()).toEqual(['jira:x.atlassian.net/A-1'])
})

test('jira restore: the site of a tool-only item is compared with the active site in any case', async () => {
  const t = fakeItems() // acli answers `Site: acme.atlassian.net`
  const mixed = { ...jira('ACME.atlassian.net', 'ISS-1', ['tool']), key: 'jira:acme.atlassian.net/ISS-1' }
  await (await t.started()).slot.restore(asJson([mixed, jira('other.atlassian.net', 'ISS-2', ['tool'])]), 'load')
  expect(t.keys()).toEqual(['jira:acme.atlassian.net/ISS-1'])
})

test('restore carry unites the value with the live list', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.track([claimOf(web('https://live.example/'))])
  await items.slot.restore(asJson([rec(web('https://carried.example/'))]), 'carry')
  expect(t.keys().sort()).toEqual(['web:https://carried.example/', 'web:https://live.example/'])
  await items.slot.restore(asJson([]), 'carry') // an empty value changes nothing
  expect(t.keys().length).toBe(2)
})

test('the slot reads the live list, knows empty, and clear empties the list', async () => {
  const t = fakeItems()
  const items = await t.started()
  expect(items.slot.id).toBe('items')
  expect(items.slot.persist).toBe(true)
  expect(items.slot.empty(await items.slot.read())).toBe(true)
  await items.track([claimOf(web('https://live.example/'))])
  expect(items.slot.empty(await items.slot.read())).toBe(false)
  expect(items.slot.empty(undefined)).toBe(true)
  await items.slot.clear?.()
  expect(t.keys()).toEqual([])
})

test('restore during a switch writes without a session check (Review Focus 2)', async () => {
  const t = fakeItems()
  const items = await t.started()
  // The check is single flight: during a switch it would wait for the switch itself. This one never answers.
  t.watch.check = () => new Promise<boolean>(() => {})
  await items.slot.restore(asJson([rec(web('https://a.example/'))]), 'carry')
  await items.slot.restore(asJson([rec(web('https://b.example/'))]), 'load')
  await items.slot.clear?.()
  await items.slot.restore(asJson([rec(web('https://c.example/'))]), 'carry')
  expect(t.keys()).toEqual(['web:https://c.example/'])
  // The checked writers do wait for it.
  let done = false
  void items
    .update(list => list)
    .then(() => {
      done = true
    })
  await sleep(15)
  expect(done).toBe(false)
})

// ---------------------------------------------------------------- the kinds that are on

test('items: a disabled kind claims its spans and drops them; its tool is never probed', async () => {
  const t = fakeItems({ live: id => id !== 'github' })
  const items = await t.started()
  await items.capture(promptRow('see https://github.com/acme/web/issues/5 and https://example.com/a'))
  expect(t.keys()).toEqual(['web:https://example.com/a'])
  expect(argv0(t.w.calls, 'gh')).toEqual([])
  expect(argv0(t.w.calls, 'acli').length).toBeGreaterThan(0) // jira is on: its probe ran
})

test('port.scan and rowIdOf: a kind that is off still owns its spans, so its URL is no claim and no web claim', async () => {
  const t = fakeItems({ live: id => id !== 'github' })
  const url = 'https://github.com/acme/web/issues/5'
  const items = await t.started()
  expect(items.port('x').scan(url, { mode: 'full', purpose: 'capture' })).toEqual([])
  expect(items.port('x').scan(`${url} and https://example.com/a`, { mode: 'full', purpose: 'capture' })).toMatchObject([
    { key: 'web:https://example.com/a' },
  ])
  // A web row for the same URL (an old stored copy) is not what the lookup names: github owns the URL.
  await items.slot.restore(asJson([rec(web(url))]), 'carry')
  expect(t.keys()).toEqual([`web:${url}`])
  expect(await items.rowIdOf(url)).toBeUndefined()
})

test('items-service: the item service reads live from TrackerHost', async () => {
  const w = managerWorld({
    config: specs => fakeConfig({ specs, file: { trackers: { web: { enabled: false } } } }),
  })
  await w.m.row(w.w.ports, promptRow('see https://docs.example/a'))
  expect(w.keys()).toEqual([])
  await w.m.row(w.w.ports, promptRow('see https://github.com/cli/cli/pull/14640'))
  expect(w.keys()).toEqual(['gh:github.com/cli/cli#14640'])
})

test('start drops the records of a kind that is off, in one write', async () => {
  const t = fakeItems({ live: id => id !== 'web' })
  t.w.state.set('items', [rec(web('https://docs.example/a')), rec(gh(5))] as unknown as Json)
  const items = await t.started()
  expect(t.w.stateSets.items).toBe(1)
  expect(t.keys()).toEqual(['gh:github.com/acme/web#5'])
  await items.start(t.hostCtx)
  expect(t.w.stateSets.items).toBe(1) // nothing left to drop: no second write
})

test("capture awaits each live kind's prepare before the scan", async () => {
  const t = fakeItems()
  const items = await t.started()
  expect(t.facts.read('session.repo')).toBeUndefined() // not looked up yet
  await items.capture(promptRow('see issue #5'))
  expect(t.keys()).toEqual(['gh:github.com/acme/web#5'])
  expect(t.facts.read('session.repo')).toEqual({ host: 'github.com', owner: 'acme', repo: 'web' })
})

// ---------------------------------------------------------------- the tools and the refresh

test('start probes gh and acli once and publishes the statuses once', async () => {
  const t = fakeItems()
  expect(t.items.ready).toBe(false)
  await t.items.start(t.hostCtx)
  expect(t.items.ready).toBe(true)
  await until(() => t.w.state.has('tools'), 'the published statuses')
  expect(versionCalls(t.w.calls, 'gh').length).toBe(1)
  expect(versionCalls(t.w.calls, 'acli').length).toBe(1)
  const tools = t.w.state.get('tools') as unknown as Record<string, { available: boolean | null }>
  expect(tools.gh?.available).toBe(true)
  expect(tools.acli?.available).toBe(true)
  expect(t.w.stateSets.tools).toBe(1)
  await t.items.settle() // nothing the pane shows changed: no second write (A22)
  expect(t.w.stateSets.tools).toBe(1)
})

test('a second start keeps the tools and the coordinator (D16)', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.capture(promptRow('see https://github.com/cli/cli/pull/14640'))
  await items.start(t.hostCtx)
  expect(versionCalls(t.w.calls, 'gh').length).toBe(1)
  // The capture debounce armed by the first start's coordinator still fires once.
  const before = graphqlCalls(t.w.calls).length
  await t.w.clock.advance(1010)
  await until(() => graphqlCalls(t.w.calls).length === before + 1, 'one refresh')
  await sleep(10)
  expect(graphqlCalls(t.w.calls).length).toBe(before + 1)
})

test('the tools of a tracker are the handles it declared, after the start', async () => {
  const t = fakeItems()
  expect(t.items.tools('github')).toBeUndefined() // before the start
  const items = await t.started()
  expect(items.tools('github')?.handle('gh')?.id).toBe('gh')
  expect(items.tools('github')?.handle('acli')).toBeUndefined() // another tracker's
  expect(items.tools('jira')?.handle('acli')?.id).toBe('acli')
  expect(items.tools('nobody')?.handle('gh')).toBeUndefined()
})

test('start re-keys web rows of artifact URLs on a warm list (R13)', async () => {
  const t = fakeItems()
  t.w.state.set('items', [
    {
      key: 'web:https://claude.ai/artifact/D3zR4h4m4W1diV3brT2Mbo',
      category: 'web',
      url: 'https://claude.ai/artifact/D3zR4h4m4W1diV3brT2Mbo',
      label: 'x',
      sources: ['response'],
      firstSeen: 1,
      lastSeen: 1,
      seenCount: 1,
    },
  ] as never)
  await t.started()
  expect(t.list().map(r => r.category)).toEqual(['artifact'])
})

test('tick finds the repo and kicks the coordinator', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.capture(promptRow('see https://github.com/acme/web/issues/9'))
  expect(graphqlCalls(t.w.calls).length).toBe(0)
  await items.tick()
  await until(() => graphqlCalls(t.w.calls).length === 1, 'the tick refresh')
  expect(t.facts.read('session.repo')).toEqual({ host: 'github.com', owner: 'acme', repo: 'web' })
  await until(() => (t.list()[0] as { title?: string } | undefined)?.title === 'Web nine', 'the saved title')
})

test('a tick whose repo lookup fails still kicks the refresh', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.capture(promptRow('see https://github.com/acme/web/issues/9'))
  const spy = items as unknown as { prepare(): Promise<void> }
  spy.prepare = () => Promise.reject(new Error('boom'))
  await items.tick()
  await until(() => graphqlCalls(t.w.calls).length === 1, 'the tick refresh')
})

test('kick open refreshes the due items', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.capture(promptRow('see https://github.com/acme/web/issues/9'))
  items.kick('open')
  await until(() => graphqlCalls(t.w.calls).length === 1, 'the refresh')
})

test('refreshAll waits for a run in flight, then runs once more', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const t = fakeItems({
    run: async argv => {
      if (argv[1] === 'api') await gate
      return undefined
    },
  })
  const items = await t.started()
  await items.capture(promptRow('see https://github.com/acme/web/issues/9'))
  items.kick('open') // a run starts and waits at the gate
  await until(() => graphqlCalls(t.w.calls).length === 1, 'the first run')
  let done = false
  const all = items.refreshAll().then(() => {
    done = true
  })
  await sleep(15)
  expect(done).toBe(false)
  release()
  await all
  expect(done).toBe(true)
  expect(graphqlCalls(t.w.calls).length).toBe(2)
})

test('refreshAll resets every tool, forces a run and waits for it', async () => {
  const t = fakeItems({
    run: argv => (argv[1] === 'auth' && argv.includes('ghe.corp') ? res('', 1, 'not logged in') : undefined),
  })
  const items = await t.started()
  await items.capture(promptRow('see https://github.com/acme/web/issues/9'))
  const client = ghOf(items.tools('github')!, { slice: () => ({}), global: () => t.cfg.global() }, () => 0)!
  expect(await client.checkHost('ghe.corp')).toBe(false)
  expect(client.isHostAuthed('ghe.corp')).toBe(false) // the denial is cached
  await items.refreshAll()
  expect(client.isHostAuthed('ghe.corp')).toBeUndefined() // the tool class forgot it, not only its handle
  expect(graphqlCalls(t.w.calls).length).toBe(1) // forced: the fresh item was asked once, and the run is done
  expect((t.list()[0] as { title?: string }).title).toBe('Web nine')
})

test('a manual refresh resets the tool class of each lane, not only its handle', async () => {
  const t = fakeItems({
    run: argv => (argv[1] === 'auth' && argv.includes('ghe.corp') ? res('', 1, 'not logged in') : undefined),
  })
  const items = await t.started()
  const client = ghOf(items.tools('github')!, { slice: () => ({}), global: () => t.cfg.global() }, () => 0)!
  expect(await client.checkHost('ghe.corp')).toBe(false)
  expect(client.isHostAuthed('ghe.corp')).toBe(false) // the denial is cached
  items.kick('manual')
  expect(client.isHostAuthed('ghe.corp')).toBeUndefined() // the lane called GhTool.reset, which forgets denied hosts
})

test('a refresh that finds an item gone drops it and keeps it in the dismiss list', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.capture(promptRow('see https://github.com/acme/web/issues/404'))
  expect(t.keys()).toEqual(['gh:github.com/acme/web#404'])
  await items.refreshAll()
  expect(t.keys()).toEqual([])
  expect(t.dismissed.has('gh:github.com/acme/web#404')).toBe(true)
})

test('a refusing dismiss list does not fail the refresh', async () => {
  const t = fakeItems()
  const items = await t.started()
  t.dismiss.add = () => Promise.reject(new Error('refused'))
  await items.capture(promptRow('see https://github.com/acme/web/issues/404'))
  await items.refreshAll()
  expect(t.keys()).toEqual([])
})

test('a stored record of a malformed shape is never due and does not stop the run for the others', async () => {
  const t = fakeItems()
  const bad = {
    key: 'gh:github.com/acme/web#7',
    category: 'github', // no number: the kind does not decode it
    url: 'https://github.com/acme/web/issues/7',
    label: '#7',
    sources: ['prompt'],
    firstSeen: 1,
    lastSeen: 1,
    seenCount: 1,
  }
  t.w.state.set('items', [bad] as never)
  const items = await t.started()
  await items.capture(promptRow('see https://github.com/acme/web/issues/9'))
  await items.refreshAll()
  const list = t.list() as unknown as { key: string; title?: string }[]
  expect(list.find(r => r.key === 'gh:github.com/acme/web#9')?.title).toBe('Web nine') // the good record refreshed
  expect(list.find(r => r.key === bad.key)).toEqual(bad) // the bad one is left as it was
})

test('only the kinds with a refresh spec have a lane: a web link makes no call, an issue does', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.capture(promptRow('see https://docs.example/a and https://github.com/acme/web/issues/9'))
  expect(t.keys().sort()).toEqual(['gh:github.com/acme/web#9', 'web:https://docs.example/a'])
  await items.refreshAll()
  const record = t.list().find(r => r.key === 'gh:github.com/acme/web#9') as { title?: string }
  expect(record.title).toBe('Web nine') // the github lane filled the status
  expect(t.list().find(r => r.category === 'web')).not.toHaveProperty('refreshedAt') // the web link has no lane
})

// ---------------------------------------------------------------- the session repo (the github kind's prepare)

test('prepare publishes session.repo and github.hosts, once per session', async () => {
  const t = fakeItems()
  const items = await t.started()
  expect(t.facts.read('session.repo')).toBeUndefined()
  const lookups = () => t.w.calls.filter(c => c[0] === 'gh' && c[1] === 'repo').length
  await items.prepare()
  await items.prepare()
  expect(t.facts.read('session.repo')).toEqual({ host: 'github.com', owner: 'acme', repo: 'web' })
  expect(t.facts.read('github.hosts')).toEqual([])
  expect(lookups()).toBe(0) // the git remote answered: gh repo view was not needed
})

test('a session with no repo has no fact, and a lookup that fails has none too', async () => {
  const t = fakeItems({ remote: null, run: argv => (argv[1] === 'repo' ? res('', 1, 'no repo') : undefined) })
  const items = await t.started()
  await items.prepare()
  expect(t.facts.read('session.repo')).toBeUndefined()
  expect(t.facts.read('github.hosts')).toEqual([]) // published: the lookup ended
  const u = fakeItems({
    remote: null,
    run: argv => (argv[1] === 'repo' ? Promise.reject(new Error('cannot start')) : undefined),
  })
  await (await u.started()).prepare()
  expect(u.facts.read('session.repo')).toBeUndefined()
  expect(u.facts.read('github.hosts')).toEqual([])
})

test('an ssh alias is not kept as the session repo; gh repo view resolves it', async () => {
  const t = fakeItems({
    remote: { host: 'github-work', owner: 'o', repo: 'r' },
    run: argv => (argv[1] === 'auth' && argv.includes('github-work') ? res('', 1, GHE_AUTH_STATUS_STDERR) : undefined),
  })
  const items = await t.started()
  await items.prepare()
  expect(t.facts.read('session.repo')).toEqual({ host: 'github.com', owner: 'acme', repo: 'web' })
  expect(t.facts.read('github.hosts')).toEqual([])
})

test('a host that gh knows is kept, with its name in github.hosts', async () => {
  const t = fakeItems({ remote: { host: 'ghe.example', owner: 'o', repo: 'r' } })
  const items = await t.started()
  await items.prepare()
  expect(t.facts.read('session.repo')).toEqual({ host: 'ghe.example', owner: 'o', repo: 'r' })
  expect(t.facts.read('github.hosts')).toEqual(['ghe.example'])
})

test('gh repo view on another host is checked, and dropped when gh is not logged in there', async () => {
  const t = fakeItems({
    remote: null,
    run: argv => {
      if (argv[1] === 'repo') return res('{"nameWithOwner":"o/r"}')
      return undefined
    },
  })
  const items = await t.started()
  await items.prepare()
  expect(t.facts.read('session.repo')).toEqual({ host: 'github.com', owner: 'o', repo: 'r' })
})

test('a non-github host is checked without blocking start', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const t = fakeItems({
    remote: { host: 'ghe.example', owner: 'o', repo: 'r' },
    run: async argv => {
      if (argv[1] === 'auth') await gate
      return undefined
    },
  })
  await t.started() // resolves while the auth answer is outstanding
  const lookup = t.items.prepare()
  await sleep(10)
  expect(t.facts.read('session.repo')).toBeUndefined()
  release()
  await lookup
  expect((t.facts.read('session.repo') as { host: string } | undefined)?.host).toBe('ghe.example')
})

test('sessionChanged resets the repo and publishes the statuses again', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.prepare()
  t.w.state.delete('tools') // a /clear resets $.state
  await items.sessionChanged({ from: 'a', to: 'b', kind: 'clear' })
  expect(t.facts.read('session.repo')).toBeUndefined()
  expect(t.facts.read('github.hosts')).toBeUndefined()
  const tools = t.w.state.get('tools') as unknown as Record<string, unknown>
  expect(Object.keys(tools)).toEqual(['gh', 'acli'])
  await items.prepare() // looked up again for the new session
  expect((t.facts.read('session.repo') as { repo: string } | undefined)?.repo).toBe('web')
})

test('a stored copy load keeps a repo found earlier: only the switch forgets it', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.prepare()
  t.w.session.repo = { host: 'github.com', owner: 'other', repo: 'thing' } // what a new lookup would find
  await items.slot.restore([] as never, 'load') // a cold start after a lazy start is the same session
  await items.prepare()
  expect((t.facts.read('session.repo') as { repo: string } | undefined)?.repo).toBe('web')
  await items.sessionChanged({ from: 'a', to: 'b', kind: 'resume' }) // the manager tells the host first in a switch
  await items.slot.restore([] as never, 'load')
  await items.prepare()
  expect((t.facts.read('session.repo') as { repo: string } | undefined)?.repo).toBe('thing')
})

test('a bare #N of a loaded copy moves to its key once the repo is known', async () => {
  const t = fakeItems()
  const items = await t.started()
  t.w.state.set('items', [
    { ...rec(gh(5), 'prompt'), key: 'gh:?#5', host: 'github.com', owner: undefined, repo: undefined },
  ] as never)
  await items.prepare()
  expect(t.keys()).toEqual(['gh:github.com/acme/web#5'])
})

// ---------------------------------------------------------------- the priority of a row

test('rowIdOf and setPriority: a level by ref, and not-tracked otherwise', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.capture(promptRow('see https://github.com/acme/web/issues/9'))
  const id = await items.rowIdOf('#9')
  expect(id).toBe('gh:github.com/acme/web#9')
  expect(await items.setPriority(id!, 'high')).toBe(true)
  expect((t.list()[0] as { priority?: string }).priority).toBe('high')
  expect(await items.setPriority(id!, 'high')).toBe(false) // no change, no write
  expect(await items.setPriority(id!, undefined)).toBe(true)
  expect((t.list()[0] as { priority?: string }).priority).toBeUndefined()
  expect(await items.rowIdOf('#99')).toBeUndefined()
})

test('setPriority marks a row by its id', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.capture(promptRow('see https://docs.example/a'))
  await items.setPriority('web:https://docs.example/a', 'low')
  expect((t.list()[0] as { priority?: string }).priority).toBe('low')
})

test('setPriority sets a Jira child mark and calls persisted once; a top level does nothing', async () => {
  const t = fakeItems()
  const root = {
    ...jira('acme.atlassian.net', 'ISS-1', ['prompt']),
    children: [{ key: 'ISS-2', summary: 's', issueType: 't', status: 'x', children: [] }],
  }
  t.w.state.set('items', [root] as never)
  const items = await t.started()
  expect(t.persisted).toEqual([])
  const child = 'jira:acme.atlassian.net/ISS-1/ISS-2'
  expect(await items.rowIdOf('iss-2')).toBe(child) // a Jira key in any case names the child
  expect(await items.setPriority(child, 'high')).toBe(true)
  expect(t.persisted).toEqual(['items'])
  expect((t.list()[0] as unknown as { children: { priority?: string }[] }).children[0]?.priority).toBe('high')
  expect(await items.setPriority(child, 'top')).toBe(false)
  expect(t.persisted).toEqual(['items'])
})

test('levels gives the mark of the person, and nothing for an item no rule lifts', async () => {
  const t = fakeItems()
  const items = await t.started()
  await items.capture(promptRow('see https://docs.example/a and https://docs.example/b'))
  await items.setPriority('web:https://docs.example/a', 'low')
  const levels = await items.levels()
  expect(levels.get('web:https://docs.example/a')).toEqual({ level: 'low' })
  expect(levels.get('web:https://docs.example/b')).toEqual({})
})

// ---------------------------------------------------------------- scan and build

test('scan finds the claims of the live kinds with the facts of the call; build makes the record of a claim', async () => {
  const t = fakeItems()
  const items = await t.started()
  const port = items.port('github')
  const claims = port.scan('see #5 and https://docs.example/a', {
    mode: 'full',
    purpose: 'lookup',
    facts: { 'session.repo': { host: 'github.com', owner: 'o', repo: 'r' } },
  })
  expect(claims.map(c => c.key)).toEqual(['gh:github.com/o/r#5', 'web:https://docs.example/a'])
  expect(claims[0]?.source).toBe('scan')
  expect(port.build(claims[1]!)).toMatchObject({ key: 'web:https://docs.example/a', category: 'web' })
  expect(port.build({ ...claims[1]!, category: 'nobody' })).toBeNull()
  const off = fakeItems({ live: id => id !== 'web' })
  const offClaims = (await off.started())
    .port('web')
    .scan('https://docs.example/a', { mode: 'full', purpose: 'lookup' })
  expect(offClaims.map(c => c.key)).toEqual([]) // a kind that is off claims no span
})

test('before start the service does nothing it cannot do', async () => {
  const t = fakeItems()
  const items = t.items
  await items.settle()
  await items.refreshAll()
  await items.tick()
  await items.prepare()
  items.kick('open')
  items.refresh(['k'])
  items.dispose()
  expect(t.w.calls).toEqual([])
  expect(items.ready).toBe(false)
  expect(await items.list()).toEqual([])
})
