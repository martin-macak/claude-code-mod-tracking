// TrackerHost on fakePorts with fake trackers: init and store, contexts, slots, the bus fill, timers and dispose.
// Spec 5.5, 5.8, 6 and 7 (the OCP proof). Plan: L3 Task 8, decisions D1, D11, D15, D16.
import { expect, test } from 'claude-code/testing'
import type { Json, JsonObject } from '../core/interfaces/items'
import type { TrackerContext } from '../core/interfaces/tracker'
import type { TurnPort, TurnTarget } from '../core/interfaces/turns'
import { GLOBAL_DEFAULTS } from '../core/lib/global-config'
import { fakePorts } from './fixtures/ports'
import { fake, hostWorld as setup } from './fixtures/tracker-host'

test('init runs in order; a throwing init marks the tracker failed and its handlers never run', async () => {
  const log: string[] = []
  const ran: string[] = []
  const t = setup([
    fake('b', 20, {
      init: () => {
        log.push('init:b')
      },
      events: { command: async () => void ran.push('b') },
    }),
    fake('a', 10, {
      init: () => {
        log.push('init:a')
        throw new Error('no tool')
      },
      events: { command: async () => void ran.push('a') },
    }),
  ])
  await t.host.init()
  expect(log).toEqual(['init:a', 'init:b'])
  expect(t.host.failed()).toEqual(['a'])
  expect(t.w.logs).toEqual(['host: init of a failed: no tool'])
  t.host.fill(t.bus)
  await t.bus.emit('command', { sub: '', args: '', wait: true }, t.w.ports)
  expect(ran).toEqual(['b'])
})

test('a tracker that fails after the bus was filled has its handlers skipped from then on', async () => {
  const ran: string[] = []
  let boom = false
  const t = setup([
    fake('a', 10, {
      init: () => {
        if (boom) throw new Error('second init failed')
      },
      events: { command: async () => void ran.push('a') },
    }),
  ])
  await t.host.init()
  t.host.fill(t.bus)
  boom = true
  await t.host.init()
  await t.bus.emit('command', { sub: '', args: '', wait: true }, t.w.ports)
  expect(ran).toEqual([])
  expect(t.host.failed()).toEqual(['a'])
  await t.host.init() // a failed tracker is not asked again
  expect(t.w.logs).toEqual(['host: init of a failed: second init failed'])
})

test('store runs after init and keeps the slice in memory; no fs call', async () => {
  const order: string[] = []
  const t = setup([
    fake('a', 10, {
      init: () => void order.push('init'),
      store: ctx => {
        order.push('store')
        return ctx.config.slice()
      },
    }),
  ])
  await t.host.init()
  expect(order).toEqual(['init', 'store'])
  expect(t.host.stored().get('a')).toEqual({ enabled: true })
  expect(Object.keys(t.w.files)).toEqual([])
  expect(t.w.calls).toEqual([])
})

test('a throwing store marks the tracker failed too', async () => {
  const t = setup([
    fake('a', 10, {
      store: () => {
        throw new Error('bad slice')
      },
    }),
  ])
  await t.host.init()
  expect(t.host.failed()).toEqual(['a'])
  expect(t.host.stored().has('a')).toBe(false)
})

test('a tracker with the id items is refused', async () => {
  const t = setup([fake('items', 10), fake('ok', 20)])
  await t.host.init()
  expect(t.host.failed()).toEqual(['items'])
  expect(t.w.logs).toEqual(['host: init of items failed: the id items belongs to the item list'])
  expect(t.host.slots()).toEqual([])
})

test('ctx.data reads and writes the family member of the tracker id', async () => {
  const t = setup([fake('rows', 10)])
  await t.host.init()
  const ctx = t.host.ctx('rows', t.w.ports)
  expect(await ctx.data.get()).toBeUndefined()
  expect(await ctx.data.update(cur => [...((cur as string[] | undefined) ?? []), 'x'])).toEqual(['x'])
  expect(t.w.state.get('rows')).toEqual(['x'])
  expect(await ctx.data.get()).toEqual(['x'])
})

test('a persisted write calls persisted(owner); a persist:false write does not', async () => {
  const t = setup([fake('kept', 10), fake('run', 20, { persist: false })])
  await t.host.init()
  await t.host.ctx('kept', t.w.ports).data.update(() => ['a'])
  await t.host.ctx('run', t.w.ports).data.update(() => ['b'])
  expect(t.persisted).toEqual(['kept'])
})

test('data.update runs the session check first; a context with guard false skips it', async () => {
  const t = setup([fake('a', 10)])
  await t.host.init()
  await t.host.ctx('a', t.w.ports).data.update(() => [])
  expect(t.watch.checks).toBe(1)
  await t.host.ctx('a', t.w.ports, { guard: false }).data.update(() => [])
  expect(t.watch.checks).toBe(1)
})

test('data.update with since drops the write after a bump and returns undefined', async () => {
  const t = setup([fake('a', 10)])
  await t.host.init()
  const ctx = t.host.ctx('a', t.w.ports)
  const since = await ctx.current()
  t.watch.gen++
  expect(ctx.generation).toBe(1) // a getter: it reads the live value
  expect(await ctx.data.update(() => ['late'], { since })).toBeUndefined()
  expect(t.w.state.has('a')).toBe(false)
  expect(t.persisted).toEqual([])
  expect(await ctx.data.update(() => ['now'], { since: 1 })).toEqual(['now'])
})

test('ctx.clock.after timers are cancelled at dispose', async () => {
  const fired: string[] = []
  const t = setup([
    fake('a', 10, {
      init: ctx => {
        ctx.clock.after(1000, () => void fired.push('a-late'))
        ctx.clock.after(10, () => void fired.push('a-soon'))
      },
    }),
  ])
  await t.host.init()
  await t.w.clock.advance(10)
  expect(fired).toEqual(['a-soon'])
  t.host.dispose()
  await t.w.clock.advance(5000)
  expect(fired).toEqual(['a-soon'])
})

test('a timer the tracker cancels early does not fire, and dispose does not trip over it', async () => {
  const fired: string[] = []
  const t = setup([
    fake('a', 10, {
      init: ctx => {
        ctx.clock.after(100, () => void fired.push('x')).cancel()
      },
    }),
  ])
  await t.host.init()
  await t.w.clock.advance(500)
  t.host.dispose()
  expect(fired).toEqual([])
})

test('dispose calls each tracker dispose once and survives a throw', async () => {
  const calls: string[] = []
  const t = setup([
    fake('a', 10, {
      dispose: () => {
        calls.push('a')
        throw new Error('stuck')
      },
    }),
    fake('b', 20, { dispose: () => void calls.push('b') }),
    fake('c', 30),
  ])
  await t.host.init()
  t.host.dispose()
  t.host.dispose()
  expect(calls).toEqual(['a', 'b'])
  expect(t.w.logs).toEqual(['host: dispose of a failed: stuck'])
})

test('a new fake tracker gets init, events and a slot with no other change', async () => {
  const seen: string[] = []
  const extra = fake('extra', 15, {
    init: () => void seen.push('init'),
    events: { toolCall: { Grep: async (_ctx, ev) => void seen.push(`grep:${ev.tool}`) } },
    data: {
      restore: async (ctx, value) => {
        await ctx.data.update(() => value)
      },
    },
  })
  const t = setup([fake('a', 10), extra])
  await t.host.init()
  t.host.fill(t.bus)
  await t.bus.emit('toolCall', { tool: 'Grep', input: {}, result: null }, t.w.ports)
  expect(seen).toEqual(['init', 'grep:Grep'])
  expect(t.host.slots().map(s => s.id)).toEqual(['extra'])
  expect(t.bus.wants('Grep')).toBe(true)
})

test('slots: id, persist flag, default settle and empty, restore and clear through the context', async () => {
  const t = setup([
    fake('kept', 10, {
      data: {
        restore: async (ctx, value, how) => {
          await ctx.data.update(() => [how, value] as Json)
        },
        clear: async ctx => {
          await ctx.data.update(() => [])
        },
      },
    }),
    fake('run', 20, { persist: false, data: { restore: async () => {} } }),
    fake('nodata', 30),
  ])
  await t.host.init()
  const [kept, run] = t.host.slots()
  expect(kept?.id).toBe('kept')
  expect(kept?.persist).toBe(true)
  expect(run?.persist).toBe(false)
  expect(t.host.slots()).toHaveLength(2)
  expect(kept?.empty(undefined)).toBe(true)
  expect(kept?.empty([])).toBe(false) // no empty() in the spec: only undefined is empty
  expect(await kept?.settle(['live'], ['stored'])).toEqual(['live']) // the default: the live value wins
  await kept?.restore('v', 'carry')
  expect(await kept?.read()).toEqual(['carry', 'v'])
  await kept?.clear?.()
  expect(await kept?.read()).toEqual([])
  expect(run?.clear).toBeUndefined()
  expect(t.watch.checks).toBe(0) // slot contexts write without the session check
  expect(t.persisted).toEqual(['kept', 'kept'])
})

test('a slot uses the spec empty and settle when the tracker has them', async () => {
  const t = setup([
    fake('rows', 10, {
      data: {
        empty: v => !Array.isArray(v) || v.length === 0,
        settle: async (_ctx, live, stored) => [...((stored as string[]) ?? []), ...((live as string[]) ?? [])],
        restore: async () => {},
      },
    }),
  ])
  await t.host.init()
  const [slot] = t.host.slots()
  expect(slot?.empty([])).toBe(true)
  expect(slot?.empty(['x'])).toBe(false)
  expect(await slot?.settle(['live'], ['stored'])).toEqual(['stored', 'live'])
})

test('a failed tracker has no slot', async () => {
  const t = setup([
    fake('bad', 10, {
      init: () => {
        throw new Error('x')
      },
      data: { restore: async () => {} },
    }),
  ])
  await t.host.init()
  expect(t.host.slots()).toEqual([])
})

test('fill: each declared event reaches the bus, row by door and toolCall by tool', async () => {
  const got: string[] = []
  const rec = (what: string) => async (_ctx: TrackerContext<JsonObject, Json>, ev: unknown) => {
    got.push(`${what}:${JSON.stringify(ev)}`)
  }
  const t = setup([
    fake('a', 10, {
      events: {
        start: rec('start'),
        row: { doors: ['prompt'], run: rec('row') },
        toolCall: { Bash: rec('bash'), Monitor: rec('monitor') },
        agentSpawn: rec('spawn'),
        turnComplete: rec('turn'),
        sessionChanged: rec('switch'),
        command: rec('command'),
        dismissed: rec('dismissed'),
        replay: rec('replay'),
      },
    }),
  ])
  await t.host.init()
  t.host.fill(t.bus)
  t.host.fill(t.bus) // a second fill adds nothing
  const via = t.w.ports
  await t.bus.emit('row', { door: 'prompt' }, via)
  await t.bus.emit('row', { door: 'response' }, via)
  await t.bus.emit('toolCall', { tool: 'Bash' }, via)
  await t.bus.emit('toolCall', { tool: 'Read' }, via)
  for (const kind of [
    'start',
    'agentSpawn',
    'turnComplete',
    'sessionChanged',
    'command',
    'dismissed',
    'replay',
  ] as const)
    await t.bus.emit(kind, { k: kind }, via)
  expect(got).toEqual([
    'row:{"door":"prompt"}',
    'bash:{"tool":"Bash"}',
    'start:{"k":"start"}',
    'spawn:{"k":"agentSpawn"}',
    'turn:{"k":"turnComplete"}',
    'switch:{"k":"sessionChanged"}',
    'command:{"k":"command"}',
    'dismissed:{"k":"dismissed"}',
    'replay:{"k":"replay"}',
  ])
})

test('fill: handlers of the start, a switch and a replay write without the session check; others with it', async () => {
  const write = async (ctx: TrackerContext<JsonObject, Json>) => {
    await ctx.data.update(() => ['x'])
  }
  const t = setup([fake('a', 10, { events: { start: write, sessionChanged: write, replay: write, command: write } })])
  await t.host.init()
  t.host.fill(t.bus)
  for (const kind of ['start', 'sessionChanged', 'replay'] as const) await t.bus.emit(kind, {}, t.w.ports)
  expect(t.watch.checks).toBe(0)
  await t.bus.emit('command', {}, t.w.ports)
  expect(t.watch.checks).toBe(1)
})

test('fill: a tick handler runs only when the scheduler says it is due, with the tracker period', async () => {
  const ran: number[] = []
  const t = setup(
    [
      fake('a', 10, { events: { tick: { run: async (_c, ev) => void ran.push(ev.now) } } }),
      fake('b', 20, { events: { tick: { everyMs: () => 90000, run: async () => void ran.push(-1) } } }),
    ],
    { due: false },
  )
  await t.host.init()
  t.host.fill(t.bus)
  await t.bus.emit('tick', { now: 5 }, t.w.ports)
  expect(ran).toEqual([])
  expect(t.dues).toEqual(['a:30000', 'b:90000']) // the default period is the global tick
})

test('fill: a tick handler runs when due', async () => {
  const ran: number[] = []
  const t = setup([fake('a', 10, { events: { tick: { run: async (_c, ev) => void ran.push(ev.now) } } })])
  await t.host.init()
  t.host.fill(t.bus)
  await t.bus.emit('tick', { now: 7 }, t.w.ports)
  expect(ran).toEqual([7])
})

test('a handler gets the ports of its own dispatch', async () => {
  const other = fakePorts({ session: { id: 'sess-other' } })
  const ids: string[] = []
  const t = setup([fake('a', 10, { events: { command: async ctx => void ids.push(await ctx.session.id()) } })])
  await t.host.init()
  t.host.fill(t.bus)
  await t.bus.emit('command', {}, other.ports)
  expect(ids).toEqual(['sess-other'])
})

test('ctx.turn is the port of the turn the bus emitted; no port, no turn: a handler of any other event has none (issue #133)', async () => {
  const noted: string[] = []
  const turnPort = (target: TurnTarget): TurnPort => ({
    ord: target.ord,
    note: async () => void noted.push(`${target.ord}${target.late ? ' late' : ''}`),
  })
  const seen: (number | undefined)[] = []
  const hear = async (ctx: TrackerContext) => {
    seen.push(ctx.turn?.ord)
    await ctx.turn?.note({ added: [], seen: [] })
  }
  const tracker = fake('a', 10, { events: { toolCall: { Bash: hear }, command: hear } })
  const t = setup([tracker], { turnPort })
  await t.host.init()
  t.host.fill(t.bus)
  await t.bus.emit('toolCall', { tool: 'Bash' }, t.w.ports, undefined, { ord: 7, late: true })
  await t.bus.emit('toolCall', { tool: 'Bash' }, t.w.ports) // an event no turn owns
  await t.bus.emit('command', { sub: '' }, t.w.ports, undefined, { ord: 8 })
  expect(seen).toEqual([7, undefined, 8])
  expect(noted).toEqual(['7 late', '8'])
  const bare = setup([fake('b', 10, { events: { toolCall: { Bash: hear } } })]) // a host with no turnPort
  await bare.host.init()
  bare.host.fill(bare.bus)
  await bare.bus.emit('toolCall', { tool: 'Bash' }, bare.w.ports, undefined, { ord: 9 })
  expect(seen).toEqual([7, undefined, 8, undefined])
})

test('the context passes the engine through: tools, fs, env, session, facts, items, dismiss', async () => {
  const t = setup([fake('a', 10)])
  t.w.files['/x.md'] = '# x'
  t.w.env.HOME = '/home/me'
  t.w.settings = { autoMemoryDirectory: '/m' }
  t.w.agents.push({ id: 'ag1', status: 'running' })
  t.w.run = argv => ({ exitCode: 0, stdout: `ran ${argv.join(' ')}`, stderr: '' })
  await t.host.init()
  const ctx = t.host.ctx('a', t.w.ports)
  expect((await ctx.tools.run('git', ['git', 'status'], {})).stdout).toBe('ran git status')
  expect((await ctx.fs.stat('/x.md'))?.kind).toBe('file')
  expect(await ctx.fs.exists('/x.md')).toBe(true)
  expect(await ctx.env.get('HOME')).toBe('/home/me')
  expect(await ctx.env.settings()).toEqual({ autoMemoryDirectory: '/m' })
  expect(await ctx.env.agents()).toHaveLength(1)
  expect(await ctx.session.id()).toBe('sess-1')
  expect(await ctx.session.cwd()).toBe('/work')
  expect(await ctx.session.repo()).toBeNull()
  expect(ctx.session.root()).toBeUndefined()
  t.facts.publish('auto.root', { cwd: '/repo' })
  expect(ctx.session.root()).toBe('/repo')
  expect(ctx.facts).toBe(t.facts)
  expect(ctx.items).toBe(t.items)
  expect([...(await ctx.dismiss.list())]).toEqual([])
  expect(ctx.config.slice()).toEqual({ enabled: true })
  expect(Object.isFrozen(ctx.config.slice())).toBe(true)
  expect(ctx.config.global()).toBe(t.cfg.global()) // the config's own view, read at call time
  expect(ctx.config.global()).toEqual(GLOBAL_DEFAULTS)
  expect(await ctx.clock.now()).toBe(0)
  expect(ctx.clock.wall()).toBe(0)
  expect(ctx.id).toBe('a')
  ctx.log('hello')
  expect(t.w.logs).toEqual(['hello'])
})

test('a settings read that fails reads as undefined', async () => {
  const t = setup([fake('a', 10)])
  t.w.ports.settings.read = async () => {
    throw new Error('denied')
  }
  await t.host.init()
  expect(await t.host.ctx('a', t.w.ports).env.settings()).toBeUndefined()
})

test('session.root ignores a root fact without a cwd', async () => {
  const t = setup([fake('a', 10)])
  await t.host.init()
  t.facts.publish('auto.root', { top: '/x' })
  expect(t.host.ctx('a', t.w.ports).session.root()).toBeUndefined()
})

test('ctx of an unknown owner throws', () => {
  const t = setup([])
  expect(() => t.host.ctx('nope', t.w.ports)).toThrow('host: no tracker nope')
})

test('hostCtx has no data and no items, and persisted() signals the owner items', async () => {
  const t = setup([])
  const ctx = t.host.hostCtx(t.w.ports)
  expect('data' in ctx).toBe(false)
  expect('items' in ctx).toBe(false)
  expect(ctx.id).toBe('items')
  expect(ctx.config.slice()).toEqual({})
  ctx.persisted()
  expect(t.persisted).toEqual(['items'])
  t.watch.gen = 4
  expect(ctx.generation).toBe(4)
  expect(await ctx.current()).toBe(4)
})
