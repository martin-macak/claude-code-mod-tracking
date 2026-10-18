// EventBus: kind to handlers, in tracker order, isolated, sequential or parallel by kind. Pure.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.5. Plan decision D11 sets the modes.
import { expect, test } from 'claude-code/testing'
import { EventBus, MODE } from '../core/infra/bus'

const make = () => {
  const logs: string[] = []
  return { bus: new EventBus({ log: line => logs.push(line) }), logs }
}

/** A promise that stays open until `open()` runs. */
const gate = () => {
  let open = () => {}
  const wait = new Promise<void>(resolve => {
    open = resolve
  })
  return { wait, open }
}

test('sequential kinds run in tracker order', async () => {
  const { bus } = make()
  const seen: number[] = []
  for (const order of [30, 10, 20]) bus.add('command', `t${order}`, order, () => void seen.push(order))
  await bus.emit('command', { sub: 'x', args: '', wait: false }, null)
  expect(seen).toEqual([10, 20, 30])
})

test('a sequential kind finishes one handler before it starts the next', async () => {
  const { bus } = make()
  const g = gate()
  const trace: string[] = []
  bus.add('sessionChanged', 'first', 10, async () => {
    trace.push('first start')
    await g.wait
    trace.push('first end')
  })
  bus.add('sessionChanged', 'second', 20, () => void trace.push('second start'))
  const done = bus.emit('sessionChanged', { from: 'a', to: 'b', kind: 'clear' }, null)
  await Promise.resolve()
  expect(trace).toEqual(['first start'])
  g.open()
  await done
  expect(trace).toEqual(['first start', 'first end', 'second start'])
})

test('handlers with the same order run in the order they were added', async () => {
  const { bus } = make()
  const seen: string[] = []
  for (const owner of ['a', 'b', 'c']) bus.add('start', owner, 5, () => void seen.push(owner))
  await bus.emit('start', { cold: true }, null)
  expect(seen).toEqual(['a', 'b', 'c'])
})

test('parallel kinds start every handler before any finishes', async () => {
  const { bus } = make()
  const g = gate()
  const started: string[] = []
  const finished: string[] = []
  for (const owner of ['a', 'b']) {
    bus.add(
      'toolCall',
      owner,
      1,
      async () => {
        started.push(owner)
        await g.wait
        finished.push(owner)
      },
      { tools: ['Bash'] },
    )
  }
  const done = bus.emit('toolCall', { tool: 'Bash' }, null)
  expect(started).toEqual(['a', 'b'])
  expect(finished).toEqual([])
  g.open()
  await done
  expect(finished).toEqual(['a', 'b'])
})

test('MODE: start, agentSpawn, sessionChanged, command and dismissed are sequential; the rest are parallel', () => {
  const sequential = Object.entries(MODE)
    .filter(([, mode]) => mode === 'sequential')
    .map(([kind]) => kind)
    .sort()
  expect(sequential).toEqual(['agentSpawn', 'command', 'dismissed', 'sessionChanged', 'start'])
  const parallel = Object.entries(MODE)
    .filter(([, mode]) => mode === 'parallel')
    .map(([kind]) => kind)
    .sort()
  expect(parallel).toEqual(['replay', 'row', 'tick', 'toolCall', 'turnComplete'])
})

test('a throwing handler logs one line with its owner; the others still run', async () => {
  const { bus, logs } = make()
  const ran: string[] = []
  bus.add('command', 'repos', 10, () => {
    throw new Error('boom')
  })
  bus.add('command', 'auto', 20, () => void ran.push('auto'))
  await bus.emit('command', { sub: 'x', args: '', wait: false }, null)
  expect(logs).toEqual(['bus: command failed in repos: boom'])
  expect(ran).toEqual(['auto'])
})

test('a rejecting parallel handler is logged and does not stop its siblings', async () => {
  const { bus, logs } = make()
  const ran: string[] = []
  bus.add('turnComplete', 'files', 1, async () => {
    await Promise.resolve()
    throw new Error('late')
  })
  bus.add('turnComplete', 'auto', 2, () => void ran.push('auto'))
  await bus.emit('turnComplete', { input: {} }, null)
  expect(logs).toEqual(['bus: turnComplete failed in files: late'])
  expect(ran).toEqual(['auto'])
})

test('a handler that throws a plain value is logged as text', async () => {
  const { bus, logs } = make()
  bus.add('tick', 'jira', 1, () => {
    throw 'plain'
  })
  await bus.emit('tick', { now: 1 }, null)
  expect(logs).toEqual(['bus: tick failed in jira: plain'])
})

test('a handler gets the event and the via value of the emit', async () => {
  const { bus } = make()
  const via = { ports: 'p' }
  const ev = { now: 7 }
  const got: unknown[] = []
  bus.add('tick', 'auto', 1, (e, v) => void got.push(e, v))
  await bus.emit('tick', ev, via)
  expect(got[0]).toBe(ev)
  expect(got[1]).toBe(via)
})

test('toolCall reaches only the trackers that declared the tool', async () => {
  const { bus } = make()
  const seen: string[] = []
  bus.add('toolCall', 'files', 1, () => void seen.push('files'), { tools: ['Write', 'Edit', 'Read'] })
  bus.add('toolCall', 'processes', 2, () => void seen.push('processes'), { tools: ['Bash', 'Monitor'] })
  await bus.emit('toolCall', { tool: 'Bash' }, null)
  expect(seen).toEqual(['processes'])
  await bus.emit('toolCall', { tool: 'Skill' }, null)
  expect(seen).toEqual(['processes'])
  expect(bus.wants('Bash')).toBe(true)
  expect(bus.wants('Read')).toBe(true)
  expect(bus.wants('Skill')).toBe(false)
})

test('a toolCall handler with no tool filter takes every tool', async () => {
  const { bus } = make()
  const seen: string[] = []
  expect(bus.wants('Anything')).toBe(false)
  bus.add('toolCall', 'any', 1, e => void seen.push((e as { tool: string }).tool))
  expect(bus.wants('Anything')).toBe(true)
  await bus.emit('toolCall', { tool: 'Anything' }, null)
  expect(seen).toEqual(['Anything'])
})

test('row reaches only the declared doors', async () => {
  const { bus } = make()
  const seen: string[] = []
  bus.add('row', 'files', 1, () => void seen.push('files'), { doors: ['prompt', 'response'] })
  bus.add('row', 'processes', 2, () => void seen.push('processes'), { doors: ['tool-result'] })
  await bus.emit('row', { door: 'tool-result', text: '' }, null)
  expect(seen).toEqual(['processes'])
  await bus.emit('row', { door: 'queue', text: '' }, null)
  expect(seen).toEqual(['processes'])
})

test('an event with no matching handler resolves', async () => {
  const { bus, logs } = make()
  await bus.emit('dismissed', { ids: ['a'] }, null)
  await bus.emit('toolCall', { tool: 'Bash' }, null)
  expect(logs).toEqual([])
})
