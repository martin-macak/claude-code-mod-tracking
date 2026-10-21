// The turn lineage of slot rows (issue #133, P1b of #69): the turn of an event reaches the tracker handler as `ctx.turn`, the
// handler stamps its rows and tells the ledger which rows the event named, and `Traceable.turnsOf` hands the stamps to the
// pane. The orders are those of a live run (design study of #69, comment 2). A recording tracker stands in for a slot
// tracker; the real ones are in tests/slot-turns-trackers.test.ts and the kit spike in tests/slot-turns-wiring.test.tsx.
import { expect, test } from 'claude-code/testing'
import { TurnLedgerService } from '../core/infra/turn-ledger'
import type { Json } from '../core/interfaces/items'
import type { Traceable } from '../core/interfaces/reasons'
import type { Tracker } from '../core/interfaces/tracker'
import type { TurnPort } from '../core/interfaces/turns'
import { hasTurns, isTraceable } from '../core/lib/reasons'
import { rowSightings } from '../core/lib/turn-span'
import { emptyLedger, openTurn } from '../core/lib/turns'
import { BG_START_MAIN } from './fixtures/notices'
import { row as treeRow } from './fixtures/sections'
import { type Cfg, fake } from './fixtures/tracker-host'
import { turnWorld } from './fixtures/turn-world'

const NOTICE = '<task-notification>\n<task-id>butoa45ib</task-id>\n<tool-use-id>tu_bg1</tool-use-id>\ndone'

/** What a recording tracker saw of one event. */
type Seen = { kind: string; ord: number | undefined }

/**
 * A slot tracker of one row, `rec:1`. It records `ctx.turn` of the events it hears and, for the kinds in `notesOn`, tells the
 * ledger that the event added the row. `turns` makes it answer `turnsOf`, and `sections` draws the row.
 */
function recorder(o: { notesOn?: readonly string[]; turns?: 'span' | 'throws' | 'none' } = {}) {
  const seen: Seen[] = []
  const hear = (kind: string) => async (ctx: { turn?: TurnPort }) => {
    seen.push({ kind, ord: ctx.turn?.ord })
    if (ctx.turn && o.notesOn?.includes(kind))
      await ctx.turn.note(
        rowSightings(ctx.turn.ord, [{ id: 'rec:1', category: 'rec', reason: 'created', held: undefined }]),
      )
  }
  const own = {
    reasonsOf: () => undefined,
    ...(o.turns === 'span'
      ? { turnsOf: (_d: unknown, id: string) => (id === 'rec:1' ? { first: 2, last: 4 } : undefined) }
      : {}),
    ...(o.turns === 'throws'
      ? {
          turnsOf: () => {
            throw new Error('turnsOf broke')
          },
        }
      : {}),
  } satisfies Traceable
  const tracker = fake('rec', 99, {
    events: {
      toolCall: { Bash: hear('toolCall') },
      row: { doors: ['prompt', 'response'], run: hear('row') },
      agentSpawn: hear('agentSpawn'),
      turnComplete: hear('turnComplete'),
    },
    sections: () => [
      { id: 'rec', title: 'Rec', rows: [treeRow('rec:1', { type: 'rec', name: 'one' }, { owner: 'rec' })] },
    ],
  }) as Tracker<Cfg, Json> & Traceable
  Object.assign(tracker, own)
  return { tracker, seen }
}

function world(o: { notesOn?: readonly string[]; turns?: 'span' | 'throws' | 'none' } = {}) {
  const r = recorder(o)
  return { ...turnWorld({ trackers: () => [], extra: [r.tracker] }), ...r }
}

// ---------------------------------------------------------------- the turn reaches the handler

test('a tool call in a running turn reaches the handler with the ordinal of that turn', async () => {
  const t = world()
  await t.start('turn-1', 'one')
  await t.bash()
  await t.end('turn-1')
  await t.start('turn-2', 'two')
  await t.bash()
  expect(t.seen.filter(s => s.kind === 'toolCall')).toEqual([
    { kind: 'toolCall', ord: 1 },
    { kind: 'toolCall', ord: 2 },
  ])
})

test('what the handler notes lists in /track turn: the row is new, with its reason, under the turn that ran the call', async () => {
  const t = world({ notesOn: ['toolCall'] })
  await t.start('turn-1', 'one')
  await t.end('turn-1')
  await t.start('turn-2', 'two')
  await t.bash()
  await t.end('turn-2')
  expect(t.rec(2).new).toEqual([{ k: 'rec:1', c: 'rec', r: 'created' }])
  expect(t.rec(1).new).toEqual([])
  expect(await t.text('turn 2')).toMatch(/^Turn 2 · answer · \d\d:\d\d · "two" · 1 new\n {2}new {4}rec one {2}created$/)
})

test('an event that no turn owns reaches the handler with no turn: a call before any turn, a turn end, a tick', async () => {
  const t = world({ notesOn: ['toolCall', 'turnComplete'] })
  await t.bash() // no turn opened yet
  await t.start('turn-1', 'one')
  await t.end('turn-1') // turnComplete is not an event a turn stamps
  await t.m.tick()
  expect(t.seen).toEqual([
    { kind: 'toolCall', ord: undefined },
    { kind: 'turnComplete', ord: undefined },
  ])
  expect(await t.text('turn')).toMatch(/nothing tracked$/)
})

test('a row of the person that comes before its turn.start carries the ordinal that turn will get; the turn adopts what the handler noted', async () => {
  const t = world({ notesOn: ['row'] })
  await t.prompt('go')
  expect(t.seen).toEqual([{ kind: 'row', ord: 1 }])
  expect(t.ledger().pending).toMatchObject({ ord: 1, new: [{ k: 'rec:1', c: 'rec', r: 'created' }] })
  await t.start('turn-1', 'go')
  expect(t.rec(1).new).toEqual([{ k: 'rec:1', c: 'rec', r: 'created' }])
})

test('an agent spawn reaches the handler with the turn that made it', async () => {
  const t = world({ notesOn: ['agentSpawn'] })
  await t.start('turn-1', 'spawn')
  await t.spawn('agent-1', 'tu_agent1')
  expect(t.seen).toEqual([{ kind: 'agentSpawn', ord: 1 }])
  expect(t.rec(1).new).toEqual([{ k: 'rec:1', c: 'rec', r: 'created' }])
})

test('a spawn that no turn owns reaches the handler with no turn, but the agent still maps to the newest turn for the wake of its end', async () => {
  const t = world({ notesOn: ['agentSpawn'] })
  await t.start('turn-1', 'one')
  await t.end('turn-1')
  await t.spawn('agent-1', 'tu_agent1') // the main loop spawns it with no turn running
  expect(t.seen.filter(s => s.kind === 'agentSpawn')).toEqual([{ kind: 'agentSpawn', ord: undefined }])
  expect(t.rec(1).new).toEqual([]) // the handler had no turn to note into
  expect(t.ledger().agents).toEqual([['agent-1', 1]]) // the fallback stays for the wake correlation
})

test('a subagent that spawns after its parent turn ended reaches the handler with the turn of its parent, not the running one', async () => {
  const t = world({ notesOn: ['agentSpawn'] })
  await t.start('turn-1', 'spawn')
  await t.spawn('agent-1', 'tu_agent1')
  await t.end('turn-1')
  await t.start('turn-2', 'something else')
  await t.spawn('agent-2', 'tu_agent2', { parentAgentId: 'agent-1' }) // a child of the sub, while turn 2 runs
  expect(t.seen.filter(s => s.kind === 'agentSpawn')).toEqual([
    { kind: 'agentSpawn', ord: 1 },
    { kind: 'agentSpawn', ord: 1 },
  ])
  expect(t.rec(2).new).toEqual([])
})

test('a subagent call after its turn ended reaches the handler with the spawning turn, and its entry is late', async () => {
  const t = world({ notesOn: ['toolCall'] })
  await t.start('turn-1', 'spawn')
  await t.spawn('agent-1', 'tu_agent1')
  await t.end('turn-1')
  await t.start('turn-2', 'something else')
  await t.bash('ls', { agentId: 'agent-1' }) // the sub works on, while turn 2 runs
  expect(t.seen.filter(s => s.kind === 'toolCall')).toEqual([{ kind: 'toolCall', ord: 1 }])
  expect(t.rec(1).new).toEqual([{ k: 'rec:1', c: 'rec', r: 'created', late: true }])
  expect(t.rec(2).new).toEqual([])
  expect(await t.text('turn 1')).toMatch(/\n {2}new {4}rec one {2}created · late \(subagent\)$/)
})

test('the work of a wake goes to the turn that started the task: its handler gets that ordinal, not the newest one', async () => {
  const t = world({ notesOn: ['toolCall'] })
  await t.start('turn-1', 'run it')
  await t.bash('sleep 1', { toolUseId: 'tu_bg1' }, BG_START_MAIN as unknown as Json) // maps the call id to turn 1
  await t.end('turn-1')
  await t.prompt('next question')
  await t.start('turn-2', 'next question')
  await t.end('turn-2')
  await t.m.row(t.w.ports, {
    door: 'prompt',
    origin: 'task-notification',
    isMeta: true,
    hasMessage: true,
    text: NOTICE,
  })
  await t.start('wake-1', NOTICE)
  await t.bash()
  expect(t.seen.filter(s => s.kind === 'toolCall').map(s => s.ord)).toEqual([1, 1])
})

// ---------------------------------------------------------------- the port

test('the port of a turn never rejects: a fault of the ledger is logged and the tracker goes on', async () => {
  const logs: string[] = []
  const svc = new TurnLedgerService({
    atom: {
      get: async () => openTurn(emptyLedger(), { turnId: 't1', text: 'x', session: 's', at: 0 }),
      update: async () => {
        throw new Error('write refused')
      },
    } as never,
    persisted: () => {},
    redraw: () => {},
    sessionId: async () => 's',
    wall: () => 0,
    log: line => void logs.push(line),
  })
  const port = svc.portOf({ ord: 1 })
  expect(port.ord).toBe(1)
  await expect(
    port.note(rowSightings(1, [{ id: 'rec:1', category: 'rec', reason: 'created', held: undefined }])),
  ).resolves.toBeUndefined()
  expect(logs.join('\n')).toContain('write refused')
})

test('a note of a turn the ledger does not keep changes nothing', async () => {
  const t = world()
  const before = JSON.stringify(t.ledger())
  await t.m.turns
    .portOf({ ord: 9 })
    .note(rowSightings(9, [{ id: 'rec:1', category: 'rec', reason: 'created', held: undefined }]))
  expect(JSON.stringify(t.ledger())).toBe(before)
})

// ---------------------------------------------------------------- turnsOf on the pane row

test('Traceable.turnsOf puts the first and the last turn on the pane row of the tracker', async () => {
  const t = world({ turns: 'span' })
  const [row] = await t.rows()
  expect(row).toMatchObject({ id: 'rec:1', turns: { first: 2, last: 4 } })
})

test('a tracker without turnsOf works as before: its rows carry no turns, and the guards say so', async () => {
  const t = world({ turns: 'none' })
  const [row] = await t.rows()
  expect(row?.turns).toBeUndefined()
  expect(isTraceable(t.tracker)).toBe(true)
  expect(hasTurns(t.tracker)).toBe(false)
})

test('a tracker that has turnsOf and ignores ctx.turn works too: its handler never notes, the turn lists nothing of it', async () => {
  const t = world({ turns: 'span' })
  expect(hasTurns(t.tracker)).toBe(true)
  await t.start('turn-1', 'one')
  await t.bash()
  await t.end('turn-1')
  expect(t.rec(1).new).toEqual([])
  expect(await t.text('turn 1')).toMatch(/nothing tracked$/)
})

test('a turnsOf that throws loses the turns of its rows and not the section', async () => {
  const t = world({ turns: 'throws' })
  const [row] = await t.rows()
  expect(row).toMatchObject({ id: 'rec:1' })
  expect(row?.turns).toBeUndefined()
  expect(t.w.logs.join('\n')).toContain('turnsOf')
})
