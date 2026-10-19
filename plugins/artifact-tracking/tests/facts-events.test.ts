// Fact change events: Facts tells the bus when a value changes, and the bus starts the trackers that declared the name
// before `publish` returns. Core carries the event, so no tracker calls another (spec 5.5).
// Plan: L5 Task 11, K14.
import { expect, test } from 'claude-code/testing'
import { EventBus } from '../core/infra/bus'
import { Facts } from '../core/infra/facts'
import type { FactEvent } from '../core/interfaces/events'
import type { Json } from '../core/interfaces/items'
import type { Tracker, TrackerEvents } from '../core/interfaces/tracker'
import { fakeConfig } from './fixtures/config-fs'
import { type ManagerOpts, managerWorld } from './fixtures/manager'
import { fake, hostWorld } from './fixtures/tracker-host'

/** A tracker that declares fact handlers and nothing else. */
function watcher(id: string, order: number, facts: NonNullable<TrackerEvents['facts']>): Tracker {
  return {
    id,
    order,
    config: {
      defaults: { enabled: true },
      normalise: (raw, defaults) => ({ ...defaults, enabled: raw.enabled !== false }),
    },
    init: () => {},
    store: ctx => ctx.config.slice(),
    events: { facts },
  }
}

/** Lets the rejected promise of a handler reach the bus's catch. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** A started manager over the trackers; `seen` collects what the handler named `x.y` of tracker `t` heard. */
async function started(trackers: (seen: FactEvent[]) => Tracker[], config?: ManagerOpts['config']) {
  const seen: FactEvent[] = []
  const t = managerWorld({ trackers: () => trackers(seen), config })
  await t.m.ensureStarted(t.w.ports)
  return { ...t, seen }
}

test('a fact change starts the subscribed handler before publish returns', async () => {
  const t = await started(seen => [watcher('t', 10, { 'x.y': (_c, ev) => void seen.push(ev) })])
  t.m.facts.publish('x.y', 1)
  expect(t.seen).toEqual([{ name: 'x.y', value: 1, previous: undefined }])
})

test('an equal value emits nothing; a changed value carries the previous one', async () => {
  const t = await started(seen => [watcher('t', 10, { 'x.y': (_c, ev) => void seen.push(ev) })])
  t.m.facts.publish('x.y', { a: [1] })
  t.m.facts.publish('x.y', { a: [1] })
  expect(t.seen).toHaveLength(1)
  t.m.facts.publish('x.y', { a: [2] })
  expect(t.seen[1]).toEqual({ name: 'x.y', value: { a: [2] }, previous: { a: [1] } })
})

test('a handler of another name does not run', async () => {
  const t = await started(seen => [watcher('t', 10, { 'x.y': (_c, ev) => void seen.push(ev) })])
  t.m.facts.publish('x.z', 1)
  expect(t.seen).toEqual([])
})

test('a throwing handler logs one line and the others run', async () => {
  const t = await started(seen => [
    watcher('t', 10, {
      'x.y': () => {
        throw new Error('boom')
      },
    }),
    watcher('u', 20, { 'x.y': (_c, ev) => void seen.push(ev) }),
  ])
  t.m.facts.publish('x.y', 1)
  await flush()
  expect(t.w.logs.filter(l => l.startsWith('bus: fact'))).toEqual(['bus: fact failed in t: boom'])
  expect(t.seen).toHaveLength(1)
})

test('a tracker the config turned off hears no fact', async () => {
  const t = await started(
    seen => [watcher('t', 10, { 'x.y': (_c, ev) => void seen.push(ev) })],
    specs => fakeConfig({ specs, file: { trackers: { t: { enabled: false } } } }),
  )
  t.m.facts.publish('x.y', 1)
  expect(t.seen).toEqual([])
})

test('a handler gets the context of its own tracker', async () => {
  const ids: string[] = []
  const t = await started(() => [watcher('t', 10, { 'x.y': c => void ids.push(c.id) })])
  t.m.facts.publish('x.y', 1)
  expect(ids).toEqual(['t'])
})

// ---------------------------------------------------------------- Facts alone

/** A Facts that records the events it raises. */
function recording() {
  const events: FactEvent[] = []
  return { facts: new Facts({ onChange: ev => void events.push(ev) }), events }
}

test('Facts: the first publish has no previous value; the read already sees the new one', () => {
  const heard: (Json | undefined)[] = []
  const events: FactEvent[] = []
  const facts: Facts = new Facts({
    onChange: ev => {
      events.push(ev)
      heard.push(facts.read(ev.name))
    },
  })
  facts.publish('a', 'one')
  expect(events).toEqual([{ name: 'a', value: 'one', previous: undefined }])
  expect(heard).toEqual(['one'])
})

test('Facts: withdrawing a present fact emits, withdrawing a missing one does not', () => {
  const { facts, events } = recording()
  facts.publish('a', undefined)
  expect(events).toEqual([])
  facts.publish('a', 1)
  facts.publish('a', undefined)
  expect(events[1]).toEqual({ name: 'a', value: undefined, previous: 1 })
  facts.publish('a', undefined)
  expect(events).toHaveLength(2)
})

test('Facts: a value edited in place and published again still counts as a change', () => {
  const { facts, events } = recording()
  const list: Json[] = ['main']
  facts.publish('branches', list)
  list.push('feat/x')
  facts.publish('branches', list)
  expect(events).toHaveLength(2)
})

test('Facts: after an in-place edit the event still carries the earlier publish as previous', () => {
  const { facts, events } = recording()
  const list: Json[] = ['main']
  facts.publish('branches', list)
  list.push('feat/x')
  facts.publish('branches', list)
  expect(events[1]).toEqual({ name: 'branches', value: ['main', 'feat/x'], previous: ['main'] })
  expect(events[1]?.previous).not.toBe(events[1]?.value)
  list.push('feat/y') // a later edit must not reach an event that was sent already
  expect(events[1]?.previous).toEqual(['main'])
})

test('Facts: with no onChange a publish only stores', () => {
  const facts = new Facts()
  facts.publish('a', 1)
  expect(facts.read('a')).toBe(1)
})

// ---------------------------------------------------------------- the bus kind

test('the fact kind filters by name; a handler with no name filter hears every fact', async () => {
  const bus = new EventBus({ log: () => {} })
  const heard: string[] = []
  bus.add('fact', 'named', 1, ev => void heard.push(`named:${(ev as FactEvent).name}`), { names: ['x.y'] })
  bus.add('fact', 'any', 2, ev => void heard.push(`any:${(ev as FactEvent).name}`))
  await bus.emit('fact', { name: 'x.y', value: 1, previous: undefined }, null)
  await bus.emit('fact', { name: 'x.z', value: 1, previous: undefined }, null)
  expect(heard).toEqual(['named:x.y', 'any:x.y', 'any:x.z'])
})

test('fill: a fact handler is added under its name and writes with the session check', async () => {
  const heard: string[] = []
  const t = hostWorld([
    fake('a', 10, {
      events: {
        facts: {
          'x.y': async ctx => {
            heard.push('x.y')
            await ctx.data.update(() => ['x'])
          },
          'x.z': async () => void heard.push('x.z'),
        },
      },
    }),
  ])
  await t.host.init()
  t.host.fill(t.bus)
  await t.bus.emit('fact', { name: 'x.y', value: 1, previous: undefined }, t.w.ports)
  expect(heard).toEqual(['x.y'])
  expect(t.watch.checks).toBe(1)
})
