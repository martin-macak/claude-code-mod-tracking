// LifecycleManager on fakePorts: the end write, the switch (clear carries, resume loads), entry and /track clear.
// The slots and the items host are small fakes. Spec 5.6. Plan: L3 Task 5, Review Focus 1 and 2.
import { expect, test } from 'claude-code/testing'
import { GLOBAL_DEFAULTS } from '../core/infra/global-defaults'
import { LifecycleManager } from '../core/infra/lifecycle'
import type { Json } from '../core/interfaces/items'
import type { DataSlot } from '../core/interfaces/slots'
import { fakePorts } from './fixtures/ports'

type TestSlot = DataSlot & { live: Json | undefined; log: string[]; cleared: number }

/** A slot over a plain array. `settle` puts the stored array under the live one, like the register slots do. */
function slot(id: string, live: Json | undefined, log: string[], persist = true): TestSlot {
  const s: TestSlot = {
    id,
    persist,
    live,
    log,
    cleared: 0,
    read: async () => s.live,
    empty: v => v === undefined || (Array.isArray(v) && v.length === 0),
    settle: async (l, stored) => (Array.isArray(l) && Array.isArray(stored) ? [...stored, ...l] : (l ?? stored)),
    restore: async (v, how) => {
      log.push(`${id}:${how}`)
      s.live = v
    },
    clear: async () => {
      s.cleared++
      s.live = persist ? [] : s.live
    },
  }
  return s
}

function setup(o: { items?: Json; repos?: Json; seed?: Record<string, Json>; fail?: boolean } = {}) {
  const w = fakePorts({ store: o.seed })
  const log: string[] = []
  const items = slot('items', 'items' in o ? o.items : ['i1'], log)
  const repos = slot('repos', 'repos' in o ? o.repos : ['r1'], log)
  const processes = slot('processes', [], log)
  const auto = slot('auto', { root: '/work' }, log, false)
  const changed: string[] = []
  const m = new LifecycleManager(
    {
      items: {
        slot: items,
        sessionChanged: async ev => {
          log.push(`host:${ev.kind}`)
          changed.push(`${ev.from}>${ev.to}`)
        },
      },
      extraSlots: [repos, processes, auto],
      global: GLOBAL_DEFAULTS,
    },
    w.ports,
  )
  return { w, m, log, items, repos, processes, auto, changed }
}

/** Plays a `/clear` or `/resume`: `session.end` sees the leaving id, then the id changes. */
async function leave(t: ReturnType<typeof setup>, to: string, reason: 'clear' | 'resume') {
  await t.m.end(t.w.ports, reason, 1500)
  t.w.session.id = to
}

test('end writes before it resolves and keeps the snapshot', async () => {
  const t = setup()
  await t.m.entry(t.w.ports) // learns sess-1
  await t.m.end(t.w.ports, 'clear', 1500)
  expect(t.w.store.get('v2:s:sess-1')).toEqual({ items: ['i1'], repos: ['r1'], processes: [] })
  expect(t.w.store.get('v2:run')).toEqual({
    pendingEnd: { reason: 'clear', fromId: 'sess-1', at: 0 },
    run: { auto: { root: '/work' } },
  })
  t.items.live = [] // the session resets after end; the snapshot still holds the leaving data
  t.w.session.id = 'sess-2'
  await t.m.entry(t.w.ports)
  expect(t.items.live).toEqual(['i1'])
})

test('end stamps the pending end with engine time', async () => {
  const t = setup()
  await t.w.clock.advance(4000)
  await t.m.end(t.w.ports, 'resume', 1500)
  expect((t.w.store.get('v2:run') as { pendingEnd: { at: number } }).pendingEnd.at).toBe(4000)
})

test('end with a budget under 200 ms writes nothing and the switch still carries', async () => {
  const t = setup()
  await t.m.entry(t.w.ports)
  await t.m.end(t.w.ports, 'clear', 100)
  expect(t.w.storeSets).toBe(0)
  t.items.live = []
  t.w.session.id = 'sess-2'
  await t.m.entry(t.w.ports)
  expect(t.items.live).toEqual(['i1'])
})

test('a throwing slot in end is logged, never thrown, and the switch falls back to the stored copy', async () => {
  const t = setup({ seed: { 'v2:s:sess-1': { items: ['stored'] } } })
  await t.m.entry(t.w.ports)
  t.items.settle = async () => {
    throw new Error('settle failed')
  }
  await t.m.end(t.w.ports, 'clear', 1500)
  expect(t.w.logs).toEqual(['lifecycle: end of sess-1 failed: settle failed'])
  t.items.live = []
  t.w.session.id = 'sess-2'
  await t.m.entry(t.w.ports)
  expect(t.items.live).toEqual(['stored'])
})

test('end first checks the session, so an unseen switch is carried before the next one is saved', async () => {
  const t = setup()
  await t.m.entry(t.w.ports)
  await leave(t, 'sess-2', 'clear')
  t.items.live = [] // the new session is empty
  await t.m.end(t.w.ports, 'clear', 1500) // no hook ran in sess-2: end itself finds the switch
  expect(t.w.store.get('v2:s:sess-2')).toEqual({ items: ['i1'], repos: ['r1'], processes: [] })
})

test('a clear switch carries persist:false slots first, then the persisted slots from the snapshot', async () => {
  const t = setup()
  await t.m.entry(t.w.ports)
  await leave(t, 'sess-2', 'clear')
  t.log.length = 0
  await t.m.entry(t.w.ports)
  expect(t.log).toEqual(['auto:carry', 'items:carry', 'repos:carry', 'processes:carry', 'host:clear'])
  expect(t.changed).toEqual(['sess-1>sess-2'])
})

test('a clear switch skips a slot whose snapshot value is undefined and the store has none', async () => {
  const t = setup({ items: undefined, repos: undefined })
  await t.m.entry(t.w.ports)
  await leave(t, 'sess-2', 'clear')
  t.log.length = 0
  await t.m.entry(t.w.ports)
  expect(t.log).toEqual(['auto:carry', 'processes:carry', 'host:clear'])
})

test('a resume switch carries persist:false slots and loads v2:s:<new> when the items slot is empty', async () => {
  const t = setup({
    seed: { 'v2:s:sess-b': { items: ['b-item'], repos: ['b-repo'] } },
  })
  await t.m.entry(t.w.ports)
  await leave(t, 'sess-b', 'resume')
  t.items.live = [] // the engine resets the state of a resumed session
  t.repos.live = []
  t.log.length = 0
  await t.m.entry(t.w.ports)
  expect(t.log).toEqual(['auto:carry', 'items:load', 'repos:load', 'host:resume']) // processes has no stored value
  expect(t.items.live).toEqual(['b-item'])
  expect(t.repos.live).toEqual(['b-repo'])
})

test('a resume switch to a warm items slot loads nothing', async () => {
  const t = setup({ seed: { 'v2:s:sess-b': { items: ['b-item'] } } })
  await t.m.entry(t.w.ports)
  await leave(t, 'sess-b', 'resume')
  t.log.length = 0
  await t.m.entry(t.w.ports) // the items slot still holds ['i1']
  expect(t.log).toEqual(['auto:carry', 'host:resume'])
})

test('a resume switch to an id with no stored copy starts empty', async () => {
  const t = setup()
  await t.m.entry(t.w.ports)
  await leave(t, 'sess-new', 'resume')
  t.items.live = []
  t.repos.live = []
  t.log.length = 0
  await t.m.entry(t.w.ports)
  expect(t.log).toEqual(['auto:carry', 'host:resume'])
  expect(t.items.live).toEqual([])
})

test('a switch with no snapshot carries v2:s:<from> and v2:run.run', async () => {
  const t = setup({
    seed: {
      'v2:s:sess-1': { items: ['stored'] },
      'v2:run': { pendingEnd: { reason: 'clear', fromId: 'sess-1', at: 1 }, run: { auto: { root: '/kept' } } },
    },
  })
  t.m.watch.resumeFrom({ reason: 'clear', fromId: 'sess-1', at: 1 }) // a reload lost the module snapshot
  t.w.session.id = 'sess-2'
  t.items.live = []
  t.auto.live = undefined
  t.log.length = 0
  await t.m.entry(t.w.ports)
  expect(t.log).toEqual(['auto:carry', 'items:carry', 'host:clear'])
  expect(t.items.live).toEqual(['stored'])
  expect(t.auto.live).toEqual({ root: '/kept' })
})

test('a slot that fails to restore is logged and the other slots and the host still go', async () => {
  const t = setup()
  await t.m.entry(t.w.ports)
  await leave(t, 'sess-2', 'clear')
  t.repos.restore = async () => {
    throw new Error('no state')
  }
  t.log.length = 0
  await t.m.entry(t.w.ports)
  expect(t.w.logs).toEqual(['lifecycle: repos failed in a switch: no state'])
  expect(t.log).toEqual(['auto:carry', 'items:carry', 'processes:carry', 'host:clear'])
  expect((t.w.store.get('v2:run') as { pendingEnd?: unknown }).pendingEnd).toBeUndefined()
})

test('the switch drops the pending end from v2:run and keeps the run values', async () => {
  const t = setup()
  await t.m.entry(t.w.ports)
  await leave(t, 'sess-2', 'clear')
  expect((t.w.store.get('v2:run') as { pendingEnd?: unknown }).pendingEnd).toBeDefined()
  await t.m.entry(t.w.ports)
  expect(t.w.store.get('v2:run')).toEqual({ run: { auto: { root: '/work' } } })
})

test('a switch bumps the generation before its slots restore', async () => {
  const t = setup()
  await t.m.entry(t.w.ports)
  const seen: number[] = []
  t.items.restore = async () => {
    seen.push(t.m.generation)
  }
  await leave(t, 'sess-2', 'clear')
  expect(t.m.generation).toBe(0)
  await t.m.entry(t.w.ports)
  expect(seen).toEqual([1])
})

test('entry runs the session check', async () => {
  const t = setup()
  await t.m.entry(t.w.ports)
  expect(t.m.watch.lastId).toBe('sess-1')
  t.w.session.id = 'sess-2'
  await t.m.entry(t.w.ports)
  expect(t.m.watch.lastId).toBe('sess-2')
  expect(t.m.generation).toBe(1)
})

test('clear empties the persisted slots, bumps the generation and forgets v2:s:<id>; persist:false slots stay', async () => {
  const t = setup({ seed: { 'v2:index': ['sess-1'], 'v2:s:sess-1': { items: ['i1'] } } })
  await t.m.entry(t.w.ports)
  await t.m.clear(t.w.ports)
  expect(t.items.cleared).toBe(1)
  expect(t.repos.cleared).toBe(1)
  expect(t.processes.cleared).toBe(1)
  expect(t.auto.cleared).toBe(0)
  expect(t.auto.live).toEqual({ root: '/work' })
  expect(t.m.generation).toBe(1)
  expect(t.w.store.has('v2:s:sess-1')).toBe(false)
  expect(t.w.store.get('v2:index')).toEqual([])
})

test('clear skips a slot that has no clear()', async () => {
  const t = setup()
  delete (t.repos as { clear?: unknown }).clear
  await t.m.entry(t.w.ports)
  await t.m.clear(t.w.ports)
  expect(t.items.cleared).toBe(1)
})

test('a flush is an entry: it carries a switch that no hook has seen', async () => {
  const t = setup()
  await t.m.entry(t.w.ports)
  await leave(t, 'sess-2', 'clear')
  await t.m.persistence.touch()
  await t.w.clock.advance(GLOBAL_DEFAULTS.refresh.flushMs + 10)
  expect(t.m.watch.lastId).toBe('sess-2')
  expect(t.w.store.get('v2:s:sess-2')).toEqual({ items: ['i1'], repos: ['r1'], processes: [] })
})

test('facts is one store for the load', async () => {
  const t = setup()
  t.m.facts.publish('auto.root', { cwd: '/work' })
  expect(t.m.facts.read('auto.root')).toEqual({ cwd: '/work' })
})
