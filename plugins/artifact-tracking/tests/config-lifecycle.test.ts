// The config file in the lifecycle: the start reads it first and writes it once after the store phase, the toggles of a
// load, the values read at call time, the beat that re-arms the tick, and the flush delay. Fake trackers on fakePorts,
// a `fakeConfig` unless a test needs the real ConfigManager over a fake fs. Plan: L4 Task 5 (decisions C4, C5, C16).
import { expect, test } from 'claude-code/testing'
import { ConfigManager } from '../core/infra/config-manager'
import { LifecycleManager } from '../core/infra/lifecycle'
import type { ConfigSource } from '../core/interfaces/config'
import type { HostContext, ItemsHost, JsonObject } from '../core/interfaces/items'
import type { Ports } from '../core/interfaces/ports'
import type { Tracker } from '../core/interfaces/tracker'
import { fakeConfig, fakeConfigFs } from './fixtures/config-fs'
import { fakePorts } from './fixtures/ports'
import { fake as fakeTracker, hostWorld } from './fixtures/tracker-host'

/** A tracker with a numeric key `n` in its slice. `store` and `init` leave a line in `log`. */
function probe(id: string, order: number, log: string[], extra: Partial<Tracker> = {}): Tracker {
  return {
    id,
    order,
    config: { defaults: { enabled: true, n: 1 }, normalise: (raw, defaults) => ({ ...defaults, ...raw }) },
    init: () => void log.push(`init:${id}`),
    store: ctx => {
      log.push(`store:${id}`)
      return ctx.config.slice()
    },
    events: {
      start: async () => void log.push(`start:${id}`),
      command: async (_c, ev) => void log.push(`command:${id}:${ev.sub}`),
    },
    ...extra,
  }
}

const P = '/h/.config/claude-code/mods/tracker/config.json'

/** An item host with a small list. `ctx` is the context the start gave it. */
function stubHost(): ItemsHost & { ctx?: HostContext } {
  const host: ItemsHost & { ctx?: HostContext } = {
    slot: {
      id: 'items',
      persist: true,
      read: async () => ['i1'],
      empty: () => false,
      settle: async live => live,
      restore: async () => {},
    },
    start: async ctx => {
      host.ctx = ctx
    },
    capture: async () => {},
    replay: async () => {},
    tick: async () => {},
    sessionChanged: async () => {},
    dispose: () => {},
    list: async () => [],
    update: async () => false,
    track: async () => {},
    refresh: () => {},
  }
  return host
}

function setup(
  o: { trackers?: readonly Tracker[]; file?: JsonObject; log?: string[]; env?: Record<string, string> } = {},
) {
  const w = fakePorts(o.env ? { env: o.env } : {})
  const trackers = o.trackers ?? []
  const cfg = fakeConfig({ specs: trackers, ...(o.file ? { file: o.file } : {}) })
  const host = stubHost()
  const dismissed: { ports: Ports; config: ConfigSource }[] = []
  const m = new LifecycleManager(
    {
      trackers,
      items: host,
      dismiss: (ports, config) => {
        dismissed.push({ ports, config })
        return { list: async () => new Set(), add: async () => {} }
      },
      config: () => cfg,
      paneId: 'track',
    },
    w.ports,
  )
  return { w, m, cfg, host, dismissed }
}

/** The same world over the real ConfigManager and a fake fs, for the tests of the write. */
function setupReal(o: { trackers?: readonly Tracker[]; seed?: Record<string, string> } = {}) {
  const w = fakePorts({ env: { HOME: '/h' } })
  const fs = fakeConfigFs(o.seed)
  const trackers = o.trackers ?? [probe('t', 10, [])]
  const m = new LifecycleManager(
    {
      trackers,
      items: stubHost(),
      dismiss: () => ({ list: async () => new Set(), add: async () => {} }),
      config: p => new ConfigManager({ fs: fs.fs, env: p.env, specs: trackers, log: p.log }),
      paneId: 'track',
    },
    w.ports,
  )
  return { w, m, fs }
}

test('ctx.config reads the config at call time', async () => {
  const seen: { slice(): Readonly<JsonObject>; global(): { refresh: { tickMs: number } } }[] = []
  const log: string[] = []
  const t = setup({ trackers: [probe('t', 10, log, { init: ctx => void seen.push(ctx.config) })] })
  await t.m.ensureStarted(t.w.ports)
  const config = seen[0]
  expect(config?.slice().n).toBe(1)
  t.cfg.set({ trackers: { t: { n: 2 } }, global: { refresh: { tickMs: 60000 } } })
  expect(config?.slice().n).toBe(2) // the same ctx, no new init
  expect(config?.global().refresh.tickMs).toBe(60000)
})

test('a disabled tracker runs store but no init, no handler, no command', async () => {
  const log: string[] = []
  const t = hostWorld([probe('t', 10, log), probe('u', 20, log)], { file: { trackers: { t: { enabled: false } } } })
  await t.host.init()
  t.host.fill(t.bus)
  await t.bus.emit('command', { sub: 'x', args: '', wait: true }, t.w.ports)
  expect(log).toEqual(['store:t', 'init:u', 'store:u', 'command:u:x'])
  expect(t.host.stored().has('t')).toBe(true)
  expect(t.host.stored().get('t')).toEqual({ enabled: false, n: 1 })
})

test('a disabled tracker still holds its slot, so the data is carried and stored', async () => {
  const data = { empty: () => true, restore: async () => {} }
  const t = hostWorld([probe('t', 10, [], { data })], { file: { trackers: { t: { enabled: false } } } })
  await t.host.init()
  expect(t.host.slots().map(s => s.id)).toEqual(['t'])
})

test('live is false for a disabled or a failed tracker', async () => {
  const log: string[] = []
  const boom = probe('bad', 30, log, {
    init: () => {
      throw new Error('no')
    },
  })
  const t = hostWorld([probe('ok', 10, log), probe('off', 20, log), boom], {
    file: { trackers: { off: { enabled: false } } },
  })
  await t.host.init()
  expect([t.host.live('ok'), t.host.live('off'), t.host.live('bad')]).toEqual([true, false, false])
  expect(t.host.live('nobody')).toBe(true) // nothing turned an unknown id off
})

test('the toggles are read at the first init of a load only', async () => {
  const log: string[] = []
  const t = hostWorld([probe('t', 10, log)])
  await t.host.init()
  t.cfg.set({ trackers: { t: { enabled: false } } })
  await t.host.init()
  expect(t.host.live('t')).toBe(true)
  const late = hostWorld([probe('t', 10, [])])
  late.cfg.set({ trackers: { t: { enabled: false } } })
  await late.host.init() // off at the first init: it stays off when the file turns it on again
  late.cfg.set({ trackers: { t: { enabled: true } } })
  await late.host.init()
  expect(late.host.live('t')).toBe(false)
})

test('hostCtx.trackers reads live and the slice', async () => {
  const t = hostWorld([probe('t', 10, []), probe('u', 20, [])], { file: { trackers: { u: { enabled: false } } } })
  const { trackers } = t.host.hostCtx(t.w.ports)
  expect(trackers.live('t')).toBe(true)
  expect(trackers.live('u')).toBe(false)
  expect(trackers.slice('t')).toEqual({ enabled: true, n: 1 })
  t.cfg.set({ trackers: { t: { n: 7 } } })
  expect(trackers.slice('t').n).toBe(7) // the slice is read per call; live was fixed by the first read
  expect(trackers.live('u')).toBe(false)
  expect(trackers.slice('nobody')).toEqual({})
})

test('a tracker the host built with the plain fake still gets its slice from the config', async () => {
  const t = hostWorld([fakeTracker('a', 10)])
  await t.host.init()
  expect(t.host.stored().get('a')).toEqual({ enabled: true })
})

test('start refreshes first and reconciles after init', async () => {
  const log: string[] = []
  const t = setup({ trackers: [probe('t', 10, log)], log })
  const { refresh, reconcile } = t.cfg
  t.cfg.refresh = async () => {
    log.push('refresh')
    return refresh()
  }
  t.cfg.reconcile = async stored => {
    log.push('reconcile')
    return reconcile(stored)
  }
  await t.m.start(t.w.ports, { fromSessionStart: true })
  expect(log).toEqual(['refresh', 'init:t', 'store:t', 'reconcile', 'start:t'])
  expect(t.cfg.reconciled[0]?.get('t')).toEqual({ enabled: true, n: 1 })
})

test('a config that fails at the start is logged and the start still completes', async () => {
  const log: string[] = []
  const t = setup({ trackers: [probe('t', 10, log)] })
  t.cfg.refresh = async () => {
    throw new Error('no file')
  }
  t.cfg.reconcile = async () => {
    throw new Error('no write')
  }
  await t.m.start(t.w.ports, { fromSessionStart: true })
  expect(t.w.logs).toEqual([
    'lifecycle: config refresh failed in the start: no file',
    'lifecycle: config write failed in the start: no write',
  ])
  expect(log).toContain('start:t')
})

test('a lazy start and session.start in one load write the file once', async () => {
  const t = setupReal()
  await t.m.ensureStarted(t.w.ports)
  await t.m.start(t.w.ports, { fromSessionStart: true })
  expect(t.fs.writes).toHaveLength(1)
  expect(t.fs.writes[0]?.path).toBe(P)
})

test('a lazy start inside end reads the file and never writes it', async () => {
  const t = setupReal()
  await t.m.end(t.w.ports, 'prompt_input_exit', 1500)
  expect(t.fs.calls).toContain(`stat ${P}`)
  expect(t.fs.writes).toHaveLength(0)
  // The next start of the load, if any, writes.
  await t.m.start(t.w.ports, { fromSessionStart: true })
  expect(t.fs.writes).toHaveLength(1)
})

test('refreshConfig answers whether the file changed and a beat with no change does not invalidate', async () => {
  const t = setup({ trackers: [probe('t', 10, [])] })
  await t.m.ensureStarted(t.w.ports)
  expect(await t.m.refreshConfig(t.w.ports)).toBe(false)
  await t.w.clock.advance(30000)
  expect(t.w.ui.invalidated).toBe(0)
  t.cfg.set({ trackers: { t: { n: 3 } } })
  expect(await t.m.refreshConfig(t.w.ports)).toBe(true)
  expect(t.w.ui.invalidated).toBe(1)
})

test('a rejected refresh logs one line and counts as no change', async () => {
  const t = setup()
  await t.m.ensureStarted(t.w.ports)
  t.cfg.refresh = async () => {
    throw new Error('boom')
  }
  expect(await t.m.refreshConfig(t.w.ports)).toBe(false)
  expect(t.w.logs).toEqual(['config: refresh failed: boom'])
  expect(t.w.ui.invalidated).toBe(0)
})

test('a new tickMs seen on the tick re-arms the interval and invalidates the pane', async () => {
  const runs: number[] = []
  const log: string[] = []
  const ticking = probe('t', 10, log, {
    events: { tick: { everyMs: () => 1, run: async (_c, ev) => void runs.push(ev.now) } },
  })
  const t = setup({ trackers: [ticking] })
  await t.m.ensureStarted(t.w.ports)
  await t.w.clock.advance(30000)
  expect(runs).toHaveLength(1)
  t.cfg.set({ global: { refresh: { tickMs: 60000 } } })
  await t.w.clock.advance(30000)
  expect(runs).toHaveLength(2) // this beat sees the change
  expect(t.w.ui.invalidated).toBe(1)
  await t.w.clock.advance(30000)
  expect(runs).toHaveLength(2)
  await t.w.clock.advance(30000)
  expect(runs).toHaveLength(3)
})

test('the flush delay follows global.refresh.flushMs', async () => {
  const t = setup()
  await t.m.ensureStarted(t.w.ports)
  t.cfg.set({ global: { refresh: { flushMs: 5000 } } })
  t.host.ctx?.persisted()
  await t.w.clock.advance(1600)
  expect(t.w.store.has('v2:s:sess-1')).toBe(false)
  await t.w.clock.advance(3500)
  expect(t.w.store.has('v2:s:sess-1')).toBe(true)
})

test('the dismiss factory gets the config', async () => {
  const t = setup()
  await t.m.ensureStarted(t.w.ports)
  await t.m.dismiss(t.w.ports, ['k'])
  expect(t.dismissed).toHaveLength(2) // the host's own list, then the one that dismiss() builds
  for (const d of t.dismissed) expect(d.config).toBe(t.cfg)
  expect(t.m.config).toBe(t.cfg)
})

test('live follows the host', async () => {
  const t = setup({ trackers: [probe('t', 10, [])], file: { trackers: { t: { enabled: false } } } })
  await t.m.ensureStarted(t.w.ports)
  expect(t.m.live('t')).toBe(false)
})
