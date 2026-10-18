// LifecycleManager on fakePorts: the end write, the switch (clear carries, resume loads), entry and /track clear.
// The slots and the items host are small fakes. Spec 5.6. Plan: L3 Task 5, Review Focus 1 and 2.
import { expect, test } from 'claude-code/testing'
import { LifecycleManager } from '../core/infra/lifecycle'
import type { ReplayItem, RowEvent } from '../core/interfaces/events'
import type { ItemsHost, Json, StoredItem } from '../core/interfaces/items'
import type { DataSlot } from '../core/interfaces/slots'
import type { Tracker } from '../core/interfaces/tracker'
import { GLOBAL_DEFAULTS } from '../core/lib/global-config'
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

type SetupOpts = {
  items?: Json
  repos?: Json
  seed?: Record<string, Json>
  trackers?: readonly Tracker[]
  /** One log for the slots, the host and the trackers, so a test can read the order across them. */
  log?: string[]
}

function setup(o: SetupOpts = {}) {
  const w = fakePorts({ store: o.seed })
  const log: string[] = o.log ?? []
  const items = slot('items', 'items' in o ? o.items : ['i1'], log)
  const repos = slot('repos', 'repos' in o ? o.repos : ['r1'], log)
  const processes = slot('processes', [], log)
  const auto = slot('auto', { root: '/work' }, log, false)
  const changed: string[] = []
  const ticks = { n: 0 }
  /** Each replay the host got: its batch, and what had loaded before it. */
  const replays: { batch: readonly ReplayItem[]; after: string[] }[] = []
  const captured: RowEvent[] = []
  /** What the item host holds for `list` and `update`. */
  const held = { list: [] as StoredItem[], started: 0, disposed: 0, dismissed: new Set<string>() }
  const host: ItemsHost = {
    slot: items,
    start: async () => {
      held.started++
    },
    capture: async ev => {
      captured.push(ev)
    },
    sessionChanged: async ev => {
      log.push(`host:${ev.kind}`)
      changed.push(`${ev.from}>${ev.to}`)
    },
    tick: async () => {
      ticks.n++
    },
    replay: async batch => {
      replays.push({ batch, after: [...log] })
    },
    dispose: () => {
      held.disposed++
    },
    list: async () => held.list,
    update: async change => {
      const next = change(held.list, held.dismissed)
      const wrote = next !== held.list
      held.list = next
      return wrote
    },
    track: async () => {},
    refresh: () => {},
  }
  const m = new LifecycleManager(
    {
      trackers: o.trackers ?? [],
      items: host,
      extraSlots: [repos, processes, auto],
      dismiss: () => ({
        list: async () => held.dismissed,
        add: async ids => {
          for (const id of ids) held.dismissed.add(id)
        },
      }),
      global: GLOBAL_DEFAULTS,
      paneId: 'track',
    },
    w.ports,
  )
  return { w, m, log, items, repos, processes, auto, changed, ticks, replays, host, captured, held }
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

test('an end that cannot read the session id uses the last id seen, so the next switch is still a clear', async () => {
  const t = setup({ seed: { 'v2:s:sess-1': { items: ['stored'] } } })
  await t.m.entry(t.w.ports) // learns sess-1
  const id = t.w.ports.session.id
  t.w.ports.session.id = async () => {
    throw new Error('over its bound')
  }
  await t.m.end(t.w.ports, 'clear', 1500)
  t.w.ports.session.id = id
  expect(t.w.logs).toEqual(['lifecycle: end could not read the session: over its bound'])
  expect((t.w.store.get('v2:run') as { pendingEnd: { fromId: string } }).pendingEnd.fromId).toBe('sess-1')
  t.items.live = []
  t.w.session.id = 'sess-2'
  await t.m.entry(t.w.ports)
  expect(t.log.filter(x => x.startsWith('host:'))).toEqual(['host:clear'])
  expect(t.items.live).toEqual(['stored', 'i1'])
})

test('an end that cannot read the clock stamps the wall clock and the next switch is still a clear', async () => {
  const t = setup({ seed: { 'v2:s:sess-1': { items: ['stored'] } } })
  await t.m.entry(t.w.ports)
  await t.w.clock.advance(2000)
  t.w.ports.clock.now = async () => {
    throw new Error('no clock')
  }
  await t.m.end(t.w.ports, 'clear', 1500)
  expect(t.w.logs).toEqual(['lifecycle: end could not read the session: no clock'])
  expect((t.w.store.get('v2:run') as { pendingEnd: { at: number } }).pendingEnd.at).toBe(2000)
  t.items.live = []
  t.w.session.id = 'sess-2'
  await t.w.clock.advance(0)
  t.w.ports.clock.now = async () => t.w.clock.now
  await t.m.entry(t.w.ports)
  expect(t.log.filter(x => x.startsWith('host:'))).toEqual(['host:clear'])
  expect(t.items.live).toEqual(['stored', 'i1'])
})

test('an end with no session id ever seen writes nothing, and an exit still disposes', async () => {
  const t = setup()
  t.w.ports.session.id = async () => {
    throw new Error('no id')
  }
  await t.m.end(t.w.ports, 'prompt_input_exit', 1500)
  expect(t.w.logs).toEqual([
    'lifecycle: session load failed in the start: no id',
    'lifecycle: end could not read the session: no id',
  ])
  expect(t.w.store.size).toBe(0)
  expect(t.held.disposed).toBe(1)
})

test('a clear switch carries persist:false slots first, then the persisted slots from the snapshot', async () => {
  const t = setup()
  await t.m.entry(t.w.ports)
  await leave(t, 'sess-2', 'clear')
  t.log.length = 0
  await t.m.entry(t.w.ports)
  expect(t.log).toEqual(['host:clear', 'auto:carry', 'items:carry', 'repos:carry', 'processes:carry'])
  expect(t.changed).toEqual(['sess-1>sess-2'])
})

test('a clear switch skips a slot whose snapshot value is undefined and the store has none', async () => {
  const t = setup({ items: undefined, repos: undefined })
  await t.m.entry(t.w.ports)
  await leave(t, 'sess-2', 'clear')
  t.log.length = 0
  await t.m.entry(t.w.ports)
  expect(t.log).toEqual(['host:clear', 'auto:carry', 'processes:carry'])
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
  expect(t.log).toEqual(['host:resume', 'auto:carry', 'items:load', 'repos:load']) // processes has no stored value
  expect(t.items.live).toEqual(['b-item'])
  expect(t.repos.live).toEqual(['b-repo'])
})

test('a resume switch replays the transcript once, after the stored copy loads', async () => {
  const t = setup({ seed: { 'v2:s:sess-b': { items: ['b-item'] } } })
  await t.m.entry(t.w.ports)
  await leave(t, 'sess-b', 'resume')
  t.items.live = []
  t.w.session.messages = [{ role: 'user', text: 'hello', toolUses: [] }]
  await t.m.entry(t.w.ports)
  expect(t.replays).toHaveLength(1)
  expect(t.replays[0]?.after).toEqual(['host:resume', 'auto:carry', 'items:load']) // the host hears first
  expect(t.replays[0]?.batch).toEqual([
    { kind: 'row', ev: { door: 'prompt', origin: 'replay', isMeta: false, hasMessage: true, text: 'hello' } },
  ])
})

test('a resume switch replays even when the new id has no stored copy', async () => {
  const t = setup()
  await t.m.entry(t.w.ports)
  await leave(t, 'sess-new', 'resume')
  t.items.live = []
  await t.m.entry(t.w.ports)
  expect(t.replays).toHaveLength(1)
  expect(t.replays[0]?.after).toContain('host:resume') // the item host forgot the old session before the replay
})

test('a clear switch and a warm resume do not replay', async () => {
  const t = setup({ seed: { 'v2:s:sess-b': { items: ['b-item'] } } })
  await t.m.entry(t.w.ports)
  await leave(t, 'sess-2', 'clear')
  await t.m.entry(t.w.ports)
  await leave(t, 'sess-b', 'resume')
  await t.m.entry(t.w.ports) // the items slot still holds the carried list
  expect(t.replays).toHaveLength(0)
})

test('a failing replay is logged and the host still hears of the switch', async () => {
  const t = setup()
  await t.m.entry(t.w.ports)
  await leave(t, 'sess-new', 'resume')
  t.items.live = []
  t.w.session.messages = [{ role: 'user', text: 'x', toolUses: [] }]
  t.host.replay = async () => {
    throw new Error('merge failed')
  }
  await t.m.entry(t.w.ports)
  expect(t.w.logs).toEqual(['lifecycle: replay failed in a switch: merge failed'])
  expect(t.changed).toEqual(['sess-1>sess-new'])
})

test('replay hands the collected batch to the item host', async () => {
  const t = setup()
  t.w.session.messages = [{ role: 'assistant', text: 'done', toolUses: [] }]
  await t.m.replay()
  expect(t.replays).toHaveLength(1)
  expect(t.replays[0]?.batch).toHaveLength(1)
})

test('a resume switch to a warm items slot loads nothing', async () => {
  const t = setup({ seed: { 'v2:s:sess-b': { items: ['b-item'] } } })
  await t.m.entry(t.w.ports)
  await leave(t, 'sess-b', 'resume')
  t.log.length = 0
  await t.m.entry(t.w.ports) // the items slot still holds ['i1']
  expect(t.log).toEqual(['host:resume', 'auto:carry'])
})

test('a resume switch to an id with no stored copy starts empty', async () => {
  const t = setup()
  await t.m.entry(t.w.ports)
  await leave(t, 'sess-new', 'resume')
  t.items.live = []
  t.repos.live = []
  t.log.length = 0
  await t.m.entry(t.w.ports)
  expect(t.log).toEqual(['host:resume', 'auto:carry'])
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
  expect(t.log).toEqual(['host:clear', 'auto:carry', 'items:carry'])
  expect(t.items.live).toEqual(['stored'])
  expect(t.auto.live).toEqual({ root: '/kept' })
})

test('a switch after an end ignores a stale v2:run.run that the snapshot has no value for', async () => {
  const t = setup({ seed: { 'v2:run': { run: { auto: { root: '/stale' } } } } }) // an earlier process left it
  await t.m.entry(t.w.ports)
  t.auto.live = undefined // this load never wrote the run-scoped state
  await t.m.end(t.w.ports, 'clear', 100) // too little budget to rewrite v2:run
  t.w.session.id = 'sess-2'
  t.log.length = 0
  await t.m.entry(t.w.ports)
  expect(t.log).not.toContain('auto:carry')
  expect(t.auto.live).toBeUndefined()
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
  expect(t.log).toEqual(['host:clear', 'auto:carry', 'items:carry', 'processes:carry'])
  expect((t.w.store.get('v2:run') as { pendingEnd?: unknown }).pendingEnd).toBeUndefined()
})

/** Makes `store.get` of the listed keys reject until the returned function heals it. */
function unreadable(t: ReturnType<typeof setup>, ...keys: string[]): () => void {
  const { store } = t.w.ports
  const real = store.get.bind(store)
  store.get = async k => {
    if (keys.includes(k)) throw new Error('store timeout')
    return real(k)
  }
  return () => {
    store.get = real
  }
}

test('an end that cannot read the stored copy keeps the live state, so /clear carries it and v2:run is written', async () => {
  const t = setup({ seed: { 'v2:s:sess-1': { items: ['old'] } } })
  await t.m.entry(t.w.ports)
  t.items.live = ['live-a', 'live-b'] // changed since the last flush
  const heal = unreadable(t, 'v2:s:sess-1')
  await t.m.end(t.w.ports, 'clear', 1500)
  heal()
  expect(t.w.logs).toEqual(['store: read of v2:s:sess-1 failed: store timeout'])
  expect((t.w.store.get('v2:run') as { pendingEnd: { fromId: string } }).pendingEnd.fromId).toBe('sess-1')
  t.items.live = []
  t.repos.live = []
  t.auto.live = undefined // $.state is empty in the new session (E6)
  t.w.session.id = 'sess-2'
  await t.m.entry(t.w.ports)
  expect(t.items.live).toEqual(['live-a', 'live-b'])
  expect(t.repos.live).toEqual(['r1'])
  expect(t.auto.live).toEqual({ root: '/work' })
})

test('a v2:run read that fails in a switch is logged and the switch still carries and tells the trackers', async () => {
  const trace: string[] = []
  const t = setup({ log: trace, trackers: [rec('a', 10, trace)], seed: { 'v2:s:sess-1': { items: ['old'] } } })
  await t.m.entry(t.w.ports)
  await leave(t, 'sess-2', 'clear') // the end kept a full snapshot
  t.items.live = []
  t.auto.live = undefined
  const heal = unreadable(t, 'v2:run')
  trace.length = 0
  await t.m.entry(t.w.ports)
  heal()
  expect(t.w.logs.filter(l => l.startsWith('session: switch'))).toEqual([])
  expect(t.w.logs).toContain('store: read of v2:run failed: store timeout')
  expect(trace).toContain('switch:a:clear')
  expect(t.items.live).toEqual(['old', 'i1'])
  expect(t.auto.live).toEqual({ root: '/work' })
  await t.m.entry(t.w.ports) // nothing is left to retry: the new session is already carried
  expect(t.items.live).toEqual(['old', 'i1'])
})

test('a stored copy that cannot be read in a resume switch is logged and the switch still completes', async () => {
  const trace: string[] = []
  const t = setup({ log: trace, trackers: [rec('a', 10, trace)], seed: { 'v2:s:sess-b': { items: ['b-item'] } } })
  await t.m.entry(t.w.ports)
  await leave(t, 'sess-b', 'resume')
  t.items.live = []
  const heal = unreadable(t, 'v2:s:sess-b')
  trace.length = 0
  await t.m.entry(t.w.ports)
  heal()
  expect(t.w.logs).toEqual(['store: read of v2:s:sess-b failed: store timeout'])
  expect(trace).toContain('switch:a:resume')
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

test('entry arms the tick after the check, and each beat gives the item host its share', async () => {
  const t = setup()
  await t.m.entry(t.w.ports)
  expect(t.ticks.n).toBe(0)
  await t.w.clock.advance(GLOBAL_DEFAULTS.refresh.tickMs)
  expect(t.ticks.n).toBe(1)
  await t.w.clock.advance(GLOBAL_DEFAULTS.refresh.tickMs)
  expect(t.ticks.n).toBe(2)
})

test('a second entry within two periods arms nothing', async () => {
  const t = setup()
  await t.m.entry(t.w.ports)
  await t.m.entry(t.w.ports)
  await t.w.clock.advance(GLOBAL_DEFAULTS.refresh.tickMs)
  expect(t.ticks.n).toBe(1) // one interval, not two
})

test('entry arms the tick again when a period was refused (the watchdog)', async () => {
  const t = setup()
  t.w.clock.refuse('every', GLOBAL_DEFAULTS.refresh.tickMs)
  await t.m.entry(t.w.ports)
  await t.w.clock.advance(GLOBAL_DEFAULTS.refresh.tickMs * 2 + 1)
  expect(t.ticks.n).toBe(0)
  await t.m.entry(t.w.ports)
  await t.w.clock.advance(GLOBAL_DEFAULTS.refresh.tickMs)
  expect(t.ticks.n).toBe(1)
})

test('a beat finds a new session id and carries the snapshot before the item host ticks', async () => {
  const t = setup()
  await t.m.entry(t.w.ports)
  await leave(t, 'sess-2', 'clear')
  t.items.live = []
  await t.w.clock.advance(GLOBAL_DEFAULTS.refresh.tickMs)
  expect(t.items.live).toEqual(['i1'])
  expect(t.ticks.n).toBe(1)
})

test('a beat whose session check fails still gives the item host its share', async () => {
  const t = setup()
  await t.m.entry(t.w.ports)
  t.w.ports.session.id = async () => {
    throw new Error('no id')
  }
  await t.m.tick()
  expect(t.ticks.n).toBe(1)
})

// ---------------------------------------------------------------- the start sequence, the events, dispose (Task 8)

/** A tracker that records every event it hears into `log`. It keeps its rows in a data slot of its own. */
function rec(id: string, order: number, log: string[], extra: Partial<Tracker> = {}): Tracker {
  const note = (what: string) => async () => void log.push(`${what}:${id}`)
  return {
    id,
    order,
    config: { defaults: {}, normalise: (_raw, defaults) => defaults },
    init: () => void log.push(`init:${id}`),
    store: ctx => ctx.config.slice(),
    events: {
      start: async (_c, ev) => void log.push(`start:${id}:${ev.cwd ?? '-'}:${ev.cold ? 'cold' : 'warm'}`),
      row: { doors: ['prompt'], run: async (_c, ev) => void log.push(`row:${id}:${ev.text}`) },
      toolCall: { Bash: async (_c, ev) => void log.push(`bash:${id}:${ev.cwdBefore ?? '-'}`) },
      agentSpawn: note('spawn'),
      turnComplete: note('turn'),
      tick: { run: async (_c, ev) => void log.push(`tick:${id}:${ev.now}`) },
      sessionChanged: async (_c, ev) => void log.push(`switch:${id}:${ev.kind}`),
      command: async (_c, ev) => void log.push(`command:${id}:${ev.sub}`),
      dismissed: async (_c, ev) => void log.push(`dismissed:${id}:${ev.ids.join(',')}`),
      replay: async (_c, batch) => void log.push(`replay:${id}:${batch.length}`),
    },
    ...extra,
  }
}

const PANE = { id: 'track', title: 'Tracking', isShown: true, isFocused: false, isPlaced: true }

test('start runs run load, init, start event, the cold load and replay, tick and pane reattach in that order', async () => {
  const trace: string[] = []
  const t = setup({
    log: trace,
    items: [],
    repos: [],
    seed: { 'v2:s:sess-1': { items: ['i-stored'], repos: ['r-stored'] } },
    trackers: [rec('a', 10, trace)],
  })
  t.host.start = async () => void trace.push('items.start')
  t.host.replay = async () => void trace.push('replay')
  const { get } = t.w.ports.store
  t.w.ports.store.get = async k => {
    trace.push(`get:${k}`)
    return get(k)
  }
  const { every } = t.w.ports.clock
  t.w.ports.clock.every = (ms, fn) => {
    trace.push(`every:${ms}`)
    return every(ms, fn)
  }
  t.w.ui.panes = [PANE]
  t.w.ports.ui.invalidate = () => void trace.push('invalidate')
  await t.m.start(t.w.ports, { cwd: '/work', fromSessionStart: true })
  expect(trace).toEqual([
    'get:v2:run',
    'items.start',
    'init:a',
    'start:a:/work:cold',
    'get:v2:s:sess-1',
    'items:load',
    'repos:load',
    'replay',
    'replay:a:0',
    'every:30000',
    'invalidate',
  ])
})

test('start does not touch a pane the engine did not keep, and survives a pane list that fails', async () => {
  const t = setup()
  await t.m.start(t.w.ports, { fromSessionStart: true })
  expect(t.w.ui.invalidated).toBe(0)
  const other = setup()
  other.w.ports.ui.panes = async () => {
    throw new Error('no panes')
  }
  await other.m.start(other.w.ports, { fromSessionStart: true })
  expect(other.w.ui.invalidated).toBe(0)
})

test('a warm start loads nothing and does not replay', async () => {
  const trace: string[] = []
  const t = setup({ log: trace, seed: { 'v2:s:sess-1': { items: ['stored'] } }, trackers: [rec('a', 10, trace)] })
  await t.m.start(t.w.ports, { cwd: '/work', fromSessionStart: true })
  expect(trace).toEqual(['init:a', 'start:a:/work:warm'])
  expect(t.replays).toHaveLength(0)
  expect(t.items.live).toEqual(['i1'])
})

test('ensureStarted runs once; concurrent callers share it; it does not load or replay', async () => {
  const trace: string[] = []
  const t = setup({
    log: trace,
    items: [],
    seed: { 'v2:s:sess-1': { items: ['stored'] } },
    trackers: [rec('a', 10, trace)],
  })
  await Promise.all([t.m.ensureStarted(t.w.ports), t.m.ensureStarted(t.w.ports), t.m.entry(t.w.ports)])
  await t.m.ensureStarted(t.w.ports)
  expect(t.held.started).toBe(1)
  expect(trace).toEqual(['init:a', 'start:a:-:cold'])
  expect(t.replays).toHaveLength(0)
  expect(t.m.watch.lastId).toBe('sess-1')
})

test('session.start after a lazy start runs the start again with the cwd', async () => {
  const trace: string[] = []
  const t = setup({
    log: trace,
    items: [],
    seed: { 'v2:s:sess-1': { items: ['stored'] } },
    trackers: [rec('a', 10, trace)],
  })
  await t.m.ensureStarted(t.w.ports)
  await t.m.start(t.w.ports, { cwd: '/work', fromSessionStart: true })
  expect(trace).toEqual(['init:a', 'start:a:-:cold', 'init:a', 'start:a:/work:cold', 'items:load', 'replay:a:0'])
  expect(t.held.started).toBe(2)
  expect(t.replays).toHaveLength(1) // the load comes with session.start, not with the lazy start
})

test('end before any other hook starts lazily and still writes v2:s:<id>', async () => {
  const trace: string[] = []
  const t = setup({ log: trace, trackers: [rec('a', 10, trace)] })
  await t.m.end(t.w.ports, 'clear', 1500)
  expect(trace).toContain('init:a')
  expect(t.held.started).toBe(1)
  expect(t.w.store.get('v2:s:sess-1')).toEqual({ items: ['i1'], repos: ['r1'], processes: [] })
})

test('start honours a recent pendingEnd of a clear and carries v2:s:<from> and v2:run.run (the reload gap)', async () => {
  const trace: string[] = []
  const t = setup({
    log: trace,
    items: [],
    repos: [],
    seed: {
      'v2:s:sess-0': { items: ['old'] },
      'v2:run': { pendingEnd: { reason: 'clear', fromId: 'sess-0', at: 0 }, run: { auto: { root: '/kept' } } },
    },
  })
  t.w.clock.now = 60000 // exactly two ticks later: still recent
  t.auto.live = undefined
  await t.m.start(t.w.ports, { cwd: '/work', fromSessionStart: true })
  expect(trace).toEqual(['host:clear', 'auto:carry', 'items:carry'])
  expect(t.items.live).toEqual(['old'])
  expect(t.auto.live).toEqual({ root: '/kept' })
  expect(t.replays).toHaveLength(0)
  expect((t.w.store.get('v2:run') as { pendingEnd?: unknown }).pendingEnd).toBeUndefined()
})

test('start honours a recent pendingEnd of a resume and loads the stored copy of the new id', async () => {
  const trace: string[] = []
  const t = setup({
    log: trace,
    items: [],
    repos: [],
    seed: {
      'v2:s:sess-1': { items: ['mine'] },
      'v2:run': { pendingEnd: { reason: 'resume', fromId: 'sess-0', at: 10 } },
    },
  })
  t.w.clock.now = 20
  t.auto.live = undefined
  await t.m.start(t.w.ports, { fromSessionStart: true })
  expect(trace).toEqual(['host:resume', 'items:load'])
  expect(t.items.live).toEqual(['mine'])
  expect(t.replays).toHaveLength(1)
})

test('start ignores a stale or exit pendingEnd', async () => {
  const cases: Record<string, Json> = {
    'older than two ticks': { reason: 'clear', fromId: 'sess-0', at: 0 },
    'an exit reason': { reason: 'prompt_input_exit', fromId: 'sess-0', at: 50000 },
    'the same session': { reason: 'clear', fromId: 'sess-1', at: 50000 },
    'a malformed record': { reason: 'clear', fromId: 'sess-0' },
  }
  for (const [name, pendingEnd] of Object.entries(cases)) {
    const trace: string[] = []
    const t = setup({
      log: trace,
      items: [],
      repos: [],
      seed: { 'v2:s:sess-1': { items: ['mine'] }, 'v2:run': { pendingEnd } },
    })
    t.w.clock.now = 60001
    await t.m.start(t.w.ports, { fromSessionStart: true })
    expect([name, trace]).toEqual([name, ['items:load']]) // loaded as a cold start; no switch, no carry
    expect(t.m.watch.lastId).toBe('sess-1')
  }
})

test('start ignores a pendingEnd on a later start of the load', async () => {
  const trace: string[] = []
  const t = setup({ log: trace, items: [], repos: [] })
  await t.m.start(t.w.ports, { fromSessionStart: true })
  t.w.store.set('v2:run', { pendingEnd: { reason: 'clear', fromId: 'sess-0', at: 0 } })
  await t.m.start(t.w.ports, { fromSessionStart: true })
  expect(trace).not.toContain('host:clear')
  expect(t.m.watch.lastId).toBe('sess-1')
})

test('a second start finds a switch that came between the starts, and loads nothing twice', async () => {
  const trace: string[] = []
  const t = setup({ log: trace, items: [], repos: [], seed: { 'v2:s:sess-2': { items: ['two'] } } })
  await t.m.ensureStarted(t.w.ports)
  t.w.session.id = 'sess-2' // a /resume nobody saw
  await t.m.start(t.w.ports, { fromSessionStart: true })
  expect(trace).toEqual(['host:resume', 'items:load'])
  expect(t.replays).toHaveLength(1)
})

test('a failing step of the start is logged and the start still completes', async () => {
  const trace: string[] = []
  const t = setup({ log: trace, items: [], trackers: [rec('a', 10, trace)] })
  const { get } = t.w.ports.store
  t.w.ports.store.get = async k => {
    if (k === 'v2:run') throw new Error('store down')
    return get(k)
  }
  t.host.start = async () => {
    throw new Error('no tools')
  }
  t.w.ports.store.keys = async () => {
    throw new Error('no keys')
  }
  await t.m.start(t.w.ports, { fromSessionStart: true })
  expect(t.w.logs).toEqual([
    'store: read of v2:run failed: store down',
    'lifecycle: legacy sweep failed in the start: no keys',
    'lifecycle: item runtime failed in the start: no tools',
  ])
  expect(trace).toContain('start:a:-:cold') // the trackers still started
})

test('a session id that cannot be read fails the load step, not the start', async () => {
  const t = setup({ items: [] })
  t.w.ports.session.id = async () => {
    throw new Error('no id')
  }
  await t.m.start(t.w.ports, { fromSessionStart: true })
  expect(t.w.logs).toEqual(['lifecycle: session load failed in the start: no id'])
})

test('the legacy sweep runs once per load, however many starts', async () => {
  const t = setup({ seed: { 's:old': [], index: [] } })
  await t.m.start(t.w.ports, { fromSessionStart: true })
  expect([...t.w.store.keys()]).toEqual([])
  t.w.store.set('s:later', [])
  await t.m.start(t.w.ports, { fromSessionStart: true })
  expect(t.w.store.has('s:later')).toBe(true)
})

test('a restore during a switch writes without a session check', async () => {
  const log: string[] = []
  const rows = rec('rows', 40, log, {
    data: {
      restore: async (ctx, value, how) => {
        log.push(`restore:${how}`)
        await ctx.data.update(() => value) // would wait for itself if it ran the session check (Review Focus 2)
      },
    },
  })
  const t = setup({ log, trackers: [rows] })
  await t.m.entry(t.w.ports)
  t.w.state.set('rows', ['r1'])
  await leave(t, 'sess-2', 'clear')
  t.w.state.delete('rows')
  await t.m.entry(t.w.ports)
  expect(t.w.state.get('rows')).toEqual(['r1'])
  expect(log).toContain('restore:carry')
})

test('the host trackers own slots: they are stored with the others and carried by a switch', async () => {
  const log: string[] = []
  const rows = rec('rows', 40, log, { data: { restore: async (ctx, v) => void (await ctx.data.update(() => v)) } })
  const t = setup({ log, trackers: [rows] })
  await t.m.entry(t.w.ports)
  t.w.state.set('rows', ['r1'])
  await t.m.end(t.w.ports, 'clear', 1500)
  expect(t.w.store.get('v2:s:sess-1')).toEqual({ items: ['i1'], repos: ['r1'], processes: [], rows: ['r1'] })
})

test('a switch tells the item host first and the trackers last', async () => {
  const log: string[] = []
  const t = setup({ log, trackers: [rec('a', 10, log)] })
  await t.m.entry(t.w.ports)
  await leave(t, 'sess-2', 'clear')
  log.length = 0
  await t.m.entry(t.w.ports)
  expect(log[0]).toBe('host:clear') // before any slot carries
  expect(log.at(-1)).toBe('switch:a:clear') // after the data moved
})

test('end on prompt_input_exit disposes the trackers; a clear does not', async () => {
  let disposed = 0
  const tracker = rec('a', 10, [], { dispose: () => void disposed++ })
  const t = setup({ trackers: [tracker] })
  await t.m.end(t.w.ports, 'clear', 1500)
  expect(disposed).toBe(0)
  expect(t.held.disposed).toBe(0)
  await t.m.end(t.w.ports, 'prompt_input_exit', 1500)
  expect(disposed).toBe(1)
  expect(t.held.disposed).toBe(1)
})

test('logout and other dispose too; a host that fails to dispose is logged', async () => {
  const t = setup()
  t.host.dispose = () => {
    throw new Error('stuck')
  }
  await t.m.end(t.w.ports, 'other', 1500)
  expect(t.w.logs).toEqual(['lifecycle: item dispose failed in the end: stuck'])
  const u = setup()
  await u.m.end(u.w.ports, 'logout', 1500)
  expect(u.held.disposed).toBe(1)
})

test('row runs the capture step before the row handlers; a door nobody declared reaches capture only', async () => {
  const log: string[] = []
  const t = setup({ log, trackers: [rec('a', 10, log)] })
  t.host.capture = async ev => void log.push(`capture:${ev.door}`)
  const ev = { door: 'prompt', origin: 'composer', isMeta: false, hasMessage: true, text: 'hello' }
  await t.m.row(t.w.ports, ev)
  await t.m.row(t.w.ports, { ...ev, door: 'notice', text: 'n' })
  expect(log.filter(x => /^(capture|row):/.test(x))).toEqual(['capture:prompt', 'row:a:hello', 'capture:notice'])
})

test('a capture that throws is logged and the row handlers still run', async () => {
  const log: string[] = []
  const t = setup({ log, trackers: [rec('a', 10, log)] })
  t.host.capture = async () => {
    throw new Error('scan failed')
  }
  await t.m.row(t.w.ports, { door: 'prompt', origin: 'composer', isMeta: false, hasMessage: true, text: 'x' })
  expect(t.w.logs).toEqual(['lifecycle: capture failed in a row: scan failed'])
  expect(log).toContain('row:a:x')
})

test('toolCall, agentSpawn, turnComplete and command reach the declared handlers after the entry', async () => {
  const log: string[] = []
  const t = setup({ log, trackers: [rec('a', 10, log)] })
  await t.m.toolCall(t.w.ports, { tool: 'Bash', input: {}, result: null, cwdBefore: '/before' })
  await t.m.toolCall(t.w.ports, { tool: 'Read', input: {}, result: null })
  await t.m.agentSpawn(t.w.ports, { input: {}, answer: {} })
  await t.m.turnComplete(t.w.ports, { input: {} })
  await t.m.command(t.w.ports, { sub: 'refresh', args: '', wait: true })
  expect(log.filter(x => !x.startsWith('init') && !x.startsWith('start'))).toEqual([
    'bash:a:/before',
    'spawn:a',
    'turn:a',
    'command:a:refresh',
  ])
})

test('wants is right before start, and false for a tool no tracker declared', () => {
  const t = setup({ trackers: [rec('a', 10, []), rec('b', 20, [], { events: {} })] })
  expect(t.m.wants('Bash')).toBe(true)
  expect(t.m.wants('Skill')).toBe(false)
  expect(t.held.started).toBe(0)
})

test('dismiss adds the ids, drops the item keys and emits dismissed', async () => {
  const log: string[] = []
  const t = setup({ log, trackers: [rec('a', 10, log)] })
  const rows = [{ key: 'k1' }, { key: 'k2' }] as unknown as StoredItem[]
  t.held.list = rows
  await t.m.dismiss(t.w.ports, ['k1', 'rp:x'])
  expect([...t.held.dismissed]).toEqual(['k1', 'rp:x'])
  expect(t.held.list.map(r => r.key)).toEqual(['k2'])
  expect(log).toContain('dismissed:a:k1,rp:x')
  const kept = t.held.list
  await t.m.dismiss(t.w.ports, ['nothing'])
  expect(t.held.list).toBe(kept) // no key matched: the list is the same one, so no write
})

test('flushNow writes the session copy at once', async () => {
  const t = setup()
  await t.m.entry(t.w.ports)
  await t.m.flushNow()
  expect(t.w.store.get('v2:s:sess-1')).toEqual({ items: ['i1'], repos: ['r1'], processes: [] })
})

test('a beat gives the trackers their tick after the item host, with engine time', async () => {
  const log: string[] = []
  const t = setup({ log, trackers: [rec('a', 10, log)] })
  await t.m.entry(t.w.ports)
  await t.w.clock.advance(GLOBAL_DEFAULTS.refresh.tickMs)
  await t.w.clock.advance(GLOBAL_DEFAULTS.refresh.tickMs)
  expect(log.filter(x => x.startsWith('tick:'))).toEqual(['tick:a:30000', 'tick:a:60000'])
  expect(t.ticks.n).toBe(2)
})

test('a beat whose item host fails still ticks the trackers', async () => {
  const log: string[] = []
  const t = setup({ log, trackers: [rec('a', 10, log)] })
  t.host.tick = async () => {
    throw new Error('refresh failed')
  }
  await t.m.tick()
  expect(t.w.logs).toEqual(['lifecycle: item tick failed in a beat: refresh failed'])
  expect(log.filter(x => x.startsWith('tick:'))).toEqual(['tick:a:0'])
})

test('hostCtx reaches the item host once per start', async () => {
  const t = setup()
  let seen: unknown
  t.host.start = async ctx => {
    seen = ctx
  }
  await t.m.entry(t.w.ports)
  expect((seen as { id: string }).id).toBe('items')
})
