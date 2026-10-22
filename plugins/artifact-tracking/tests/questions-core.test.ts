// What the questions tracker needs of core (issue #71): the turn of a finished tool call, which a tracker reads from `ctx.turn`
// (issue #133), and a text on the clipboard of the surface. The turn cases are the ones that the tracker relies on: the running
// turn, no turn, a subagent that works on after its turn, and a ledger that fails. The text of `/track qa` is in
// tests/commands.test.ts.
import { expect, test } from 'claude-code/testing'
import type { Json } from '../core/interfaces/items'
import type { Tracker, TrackerContext } from '../core/interfaces/tracker'
import { managerWorld } from './fixtures/manager'
import { fake, hostWorld } from './fixtures/tracker-host'

type Seen = { tool: string; turn?: number; agentId?: string }

/** A tracker that writes the tool calls it hears, with the turn of each (`ctx.turn`). */
function listener(seen: Seen[]): Tracker {
  const hear = (ctx: TrackerContext, ev: { tool: string; agentId?: string }) =>
    void seen.push({
      tool: ev.tool,
      ...(ctx.turn !== undefined ? { turn: ctx.turn.ord } : {}),
      ...(ev.agentId !== undefined ? { agentId: ev.agentId } : {}),
    })
  return {
    id: 'listener',
    order: 5,
    config: { defaults: { enabled: true }, normalise: (_raw, defaults) => defaults },
    init: () => {},
    store: ctx => ctx.config.slice(),
    events: { toolCall: { Marker: hear } },
  }
}

function world() {
  const seen: Seen[] = []
  const t = managerWorld({ extra: [listener(seen)] })
  const call = (extra: { agentId?: string } = {}) =>
    t.m.toolCall(t.w.ports, {
      tool: 'Marker',
      input: { tool: 'Marker' } as Json,
      result: null as unknown as Json,
      ...extra,
    })
  const start = (turnId: string) => t.m.turnStart(t.w.ports, { turnId, text: 'go' })
  const end = (turnId: string) =>
    t.m.turnComplete(t.w.ports, { input: { turnId, reason: 'answer', durationMs: 1, answer: '' } as Json })
  return { ...t, seen, call, start, end }
}

test('a tool call of the running turn reaches the trackers with the ordinal of that turn', async () => {
  const t = world()
  await t.start('turn-1')
  await t.call()
  await t.end('turn-1')
  await t.start('turn-2')
  await t.call()
  expect(t.seen).toEqual([
    { tool: 'Marker', turn: 1 },
    { tool: 'Marker', turn: 2 },
  ])
})

test('a call that no turn runs, such as a plugin that asks with no prompt, has no turn', async () => {
  const t = world()
  await t.call()
  expect(t.seen).toEqual([{ tool: 'Marker' }])
})

test('a call of a subagent that works on after its turn ended carries the turn that spawned it', async () => {
  const t = world()
  await t.start('turn-1')
  await t.m.agentSpawn(t.w.ports, {
    input: { tool_use_id: 'toolu_agent', background: true } as Json,
    answer: { agentId: 'agent-1' } as Json,
  })
  await t.end('turn-1')
  await t.start('turn-2')
  await t.call({ agentId: 'agent-1' })
  expect(t.seen).toEqual([{ tool: 'Marker', turn: 1, agentId: 'agent-1' }])
})

test('a ledger that fails leaves the call without a turn, and the trackers still hear it', async () => {
  const t = world()
  await t.start('turn-1')
  const real = t.m.turns.callTarget.bind(t.m.turns)
  t.m.turns.callTarget = async () => {
    throw new Error('ledger down')
  }
  await t.call()
  t.m.turns.callTarget = real
  expect(t.seen).toEqual([{ tool: 'Marker' }])
  expect(t.w.logs.some(l => l.includes('turns: tool call failed: ledger down'))).toBe(true)
})

// ---------------------------------------------------------------- the clipboard

test('a tracker puts a text on the clipboard through its context, and learns whether it took', async () => {
  const t = hostWorld([fake('t', 1)])
  const ctx = t.host.ctx('t', t.w.ports)
  expect(await ctx.ui.copy('hello\nworld')).toEqual({ isCopied: true })
  expect(t.w.ui.copied).toEqual(['hello\nworld'])
  t.w.ui.copyResult = { isCopied: false, reason: 'no-clipboard' }
  expect(await ctx.ui.copy('again')).toEqual({ isCopied: false, reason: 'no-clipboard' })
  expect(t.w.ui.copied).toEqual(['hello\nworld', 'again'])
})
