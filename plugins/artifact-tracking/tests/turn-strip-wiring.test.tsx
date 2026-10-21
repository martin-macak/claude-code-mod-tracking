// Kit tests of the per-answer strip through the real hooks (issue #69, P2): `turn.complete` returns the text line, the
// `TurnDuration` render draws the counts and an open Button, `ui.turnStrip` picks which. The engine raises the events in the
// order of a live TUI turn (design study, comment 2, L86 to L99): prompt row, `turn.start`, response, the `turn_duration`
// row (inside `turn.complete`'s `next`), the end, then the render of the duration line with that row's uuid as `requestId`.
// The rules run in tests/turn-strip.test.ts and tests/turn-ledger.test.ts.

import type { On, SessionAppendInput } from 'claude-code'
import { type Engine, expect, mock } from 'claude-code/testing'
import { test } from './fixtures/kit'
import { mountPane, rowsOf } from './fixtures/pane'
import { prompt, quiet, response, START, sleep, world } from './fixtures/world'

const A = 'https://one.example/a'
const B = 'https://two.example/b'
const C = 'https://three.example/c'

type Mounted = {
  find(q: unknown): Promise<unknown>
  findAll(q: unknown): Promise<{ key?: string; text?: string; props: Record<string, unknown> }[]>
  press(q: { key: string }): Promise<void>
  unmount(): Promise<void>
}

/** The `TurnDuration` line of the TUI as the kit draws it: the viewport says which layout it is. */
const mountDuration = ($: Engine, requestId: string, isFullscreen = true) =>
  $.ui.mount({
    plugin: 'artifact-tracking',
    component: 'TurnDuration',
    requestId,
    viewport: { columns: 100, rows: 30, isFullscreen },
    props: { word: 'Cogitated', durationMs: 300 },
    surface: 'terminal',
  } as never) as unknown as Promise<Mounted>
/** Stands for the engine's own duration line, which the hook returns inside its Box as next(e). */
const engineLine = (on: On) => on('ui.render', () => ({ type: 'Text', props: {}, children: ['Cogitated for 0s'] }))

/** The config file under `HOME = /home/u`, with `global.ui.turnStrip` set to `mode`. */
const CONFIG = '/home/u/.config/claude-code/mods/tracker/config.json'
const configured = (mode: string) => ({
  disk: { [CONFIG]: JSON.stringify({ version: 1, global: { ui: { turnStrip: mode } } }) },
})
/** The kit world with the config file set. */
function stripWorld(on: On, mode?: string, extra: Parameters<typeof world>[1] = {}) {
  const w = world(on, { ...(mode === undefined ? {} : configured(mode)), ...extra })
  mock.env(on, { HOME: '/home/u' })
  return w
}

const start = ($: Engine, turnId: string, text = 'go', agentId?: string) =>
  $.turn.start({ turnId, text, ...(agentId !== undefined ? { agentId } : {}) } as never)
const end = ($: Engine, turnId: string, reason = 'answer', agentId?: string) =>
  $.turn.complete({
    turnId,
    reason,
    isAborted: reason === 'aborted',
    durationMs: 5,
    answer: '',
    ...(agentId !== undefined ? { agentId } : {}),
  } as never) as Promise<{ text: string }>
/** The `turn_duration` notice row. The engine appends it inside `turn.complete`; the kit can only send it before. */
const durationRow = (uuid: string): SessionAppendInput =>
  ({
    door: 'notice',
    origin: { kind: 'engine' },
    uuid,
    message: { type: 'system', name: 'turn_duration', content: [{ type: 'text', text: '' }] },
  }) as SessionAppendInput

/** One TUI turn that tracks `urls`, ending as `reason`. Returns what the `turn.complete` hook returned. */
async function turn($: Engine, n: number, urls: string[], reason = 'answer') {
  await $.session.append(prompt(`see ${urls.join(' and ')}`))
  await start($, `turn-${n}`, `see ${urls.join(' and ')}`)
  await $.session.append(response('ok'))
  if (reason === 'answer') await $.session.append(durationRow(`row-${n}`))
  return end($, `turn-${n}`, reason)
}

test('off by default: a turn that tracked links ends with the answer as it was, and no line is added', async ($, on) => {
  const w = stripWorld(on)
  await $.session.start(START)
  expect(await turn($, 1, [A, B])).toEqual({ text: '' }) // what the engine gave: the hook returns it unchanged
  await quiet(w.calls)
})

test('text: turn.complete returns one line with the counts and the command, "seen again" and never "updated"', async ($, on) => {
  const w = stripWorld(on, 'text')
  await $.session.start(START)
  expect(await turn($, 1, [A, B])).toEqual({ text: '+2 new · /track turn 1' })
  const second = await turn($, 2, [A, C])
  expect(second.text).toBe('+1 new · 1 seen again · /track turn 2')
  expect(second.text).not.toContain('updated')
  await quiet(w.calls)
})

test('text: a turn that tracked nothing returns what the engine gave, so the engine adds no row', async ($, on) => {
  stripWorld(on, 'text')
  await $.session.start(START)
  await $.session.append(prompt('hello there'))
  await start($, 'turn-1', 'hello there')
  expect(await end($, 'turn-1')).toEqual({ text: '' })
})

test('text: a subagent turn.complete is left alone, and so is the wake of a task', async ($, on) => {
  const w = stripWorld(on, 'text')
  await $.session.start(START)
  w.fake.spawnId = 'agent-7'
  await $.session.append(prompt(`see ${A}`))
  await start($, 'turn-1', `see ${A}`)
  await $.agent.spawn({ tool_use_id: 'tu_agent', subagentType: 'general-purpose', background: true } as never)
  expect(await end($, 'turn-1')).toEqual({ text: '+1 new · /track turn 1' })
  expect(await end($, 'sub-turn', 'answer', 'agent-7')).toEqual({ text: '' }) // a subagent's end: no strip of its own
  const notice = '<task-notification>\n<task-id>agent-7</task-id>\n<tool-use-id>tu_agent</tool-use-id>\ndone'
  await $.session.append(prompt(notice, 'task-notification'))
  await start($, 'wake-1', notice)
  await $.session.append(response(`spare ${B}`))
  expect(await end($, 'wake-1')).toEqual({ text: '' }) // its work is turn 1's; no line for the wake
})

test('text: a turn that ends aborted gets the line too', async ($, on) => {
  stripWorld(on, 'text')
  await $.session.start(START)
  expect(await turn($, 1, [A], 'aborted')).toEqual({ text: '+1 new · /track turn 1' })
})

test('text and off draw nothing on the duration line: the engine line stays as it was', async ($, on) => {
  engineLine(on)
  const w = stripWorld(on, 'text')
  await $.session.start(START)
  await turn($, 1, [A])
  const line = await mountDuration($, 'row-1')
  expect(await line.find({ text: 'Cogitated for 0s' })).toBeDefined()
  expect(await line.findAll({ key: 'turn-strip-open' })).toEqual([])
  expect(await line.find({ text: '+1 new' })).toBeUndefined()
  await line.unmount()
  await quiet(w.calls)
})

test('interactive: the duration line of an answer shows the counts and an open Button on the fullscreen layout, and turn.complete adds no text line', async ($, on) => {
  engineLine(on)
  const w = stripWorld(on, 'interactive')
  await $.session.start(START)
  expect(await turn($, 1, [A, B])).toEqual({ text: '' }) // the duration line carries it
  const line = await mountDuration($, 'row-1')
  expect(await line.find({ text: 'Cogitated for 0s' })).toBeDefined()
  expect(await line.find({ text: '+2 new' })).toBeDefined()
  const [open] = await line.findAll({ key: 'turn-strip-open' })
  expect(open?.props).toMatchObject({ plain: true, label: 'open' })
  await line.unmount()
  await quiet(w.calls)
})

test('interactive: on the main screen the line shows the counts and no Button', async ($, on) => {
  engineLine(on)
  stripWorld(on, 'interactive')
  await $.session.start(START)
  await turn($, 1, [A])
  const line = await mountDuration($, 'row-1', false)
  expect(await line.find({ text: '+1 new' })).toBeDefined()
  expect(await line.findAll({ key: 'turn-strip-open' })).toEqual([])
  await line.unmount()
})

test('interactive: each duration line finds its own turn by the uuid of its row', async ($, on) => {
  engineLine(on)
  stripWorld(on, 'interactive')
  await $.session.start(START)
  await turn($, 1, [A])
  await turn($, 2, [B, C])
  const first = await mountDuration($, 'row-1')
  expect(await first.find({ text: '+1 new' })).toBeDefined()
  await first.unmount()
  const second = await mountDuration($, 'row-2')
  expect(await second.find({ text: '+2 new' })).toBeDefined()
  await second.unmount()
  const unknown = await mountDuration($, 'row-of-another-session')
  expect(await unknown.find({ text: 'Cogitated for 0s' })).toBeDefined()
  expect(await unknown.findAll({ key: 'turn-strip-open' })).toEqual([])
  await unknown.unmount()
})

test('interactive: an aborted turn has no duration line, so it gets the text line instead', async ($, on) => {
  stripWorld(on, 'interactive')
  await $.session.start(START)
  expect(await turn($, 1, [A], 'aborted')).toEqual({ text: '+1 new · /track turn 1' })
})

test('interactive: refusal and error are treated like an aborted turn: the text line, never a strip on a duration line (inference, not run)', async ($, on) => {
  engineLine(on)
  stripWorld(on, 'interactive')
  await $.session.start(START)
  for (const [n, reason, want] of [
    [1, 'refusal', '+1 new · /track turn 1'],
    [2, 'error', '1 seen again · /track turn 2'], // the second turn names the same link again
  ] as const) {
    await $.session.append(prompt(`see ${A}`))
    await start($, `turn-${n}`, `see ${A}`)
    await $.session.append(durationRow(`row-${n}`)) // even if a build drew a duration line for it
    expect(await end($, `turn-${n}`, reason)).toEqual({ text: want })
    const line = await mountDuration($, `row-${n}`)
    expect(await line.findAll({ key: 'turn-strip-open' })).toEqual([]) // shown once
    await line.unmount()
  }
})

test('interactive: an answer whose duration row never reached the mod gets the text line, so the strip is not lost', async ($, on) => {
  stripWorld(on, 'interactive')
  await $.session.start(START)
  await $.session.append(prompt(`see ${A}`))
  await start($, 'turn-1', `see ${A}`)
  expect(await end($, 'turn-1')).toEqual({ text: '+1 new · /track turn 1' }) // no row was appended
})

test('interactive: the row hook may finish after the turn.complete hook, as it did live (2.1.306): the strip still pairs with its turn', async ($, on) => {
  engineLine(on)
  let release = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  // The engine keeps the duration row until the turn.complete hook has resumed: the row hook enters first and ends last.
  on('session.append', async (_$, e, next) => {
    if (e.message.name === 'turn_duration') await gate
    return next(e)
  })
  const w = stripWorld(on, 'interactive')
  await $.session.start(START)
  await $.session.append(prompt(`see ${A}`))
  await start($, 'turn-1', `see ${A}`)
  const row = $.session.append(durationRow('row-1')) // in flight: the hook has entered, its next is held
  await sleep(50)
  expect(await end($, 'turn-1')).toEqual({ text: '' }) // the commit runs now, before the row hook has finished
  release()
  await row
  await quiet(w.calls)
  const line = await mountDuration($, 'row-1')
  expect(await line.find({ text: '+1 new' })).toBeDefined()
  expect(await line.findAll({ key: 'turn-strip-open' })).toHaveLength(1)
  await line.unmount()
})

test('interactive: the duration row of a subagent, and a row that no turn.complete took, pair with no turn', async ($, on) => {
  engineLine(on)
  stripWorld(on, 'interactive')
  await $.session.start(START)
  await $.session.append(prompt(`see ${A}`))
  await start($, 'turn-1', `see ${A}`)
  await $.session.append({ ...durationRow('sub-row'), agentId: 'agent-7' } as SessionAppendInput)
  // The turn ends with no row of its own: the text line steps in, and the subagent's row names no record.
  expect(await end($, 'turn-1')).toEqual({ text: '+1 new · /track turn 1' })
  const sub = await mountDuration($, 'sub-row')
  expect(await sub.findAll({ key: 'turn-strip-open' })).toEqual([])
  await sub.unmount()
  // A row of a turn that never ended must not pair with the next turn.
  await $.session.append(prompt(`see ${B}`))
  await start($, 'turn-2', `see ${B}`)
  await $.session.append(durationRow('lost-row'))
  await start($, 'turn-3', 'go') // the next main turn.start drops the row nobody took
  await $.session.append(response(`see ${C}`))
  expect(await end($, 'turn-3')).toEqual({ text: '+1 new · /track turn 3' }) // no row of its own: the text line steps in
})

test('interactive: the open Button opens /track on the first entry of its own turn, with the pane focused', async ($, on) => {
  engineLine(on)
  const w = stripWorld(on, 'interactive', { isolateState: true })
  await $.session.start(START)
  await turn($, 1, [C])
  await turn($, 2, [A, B])
  await quiet(w.calls)
  const line = await mountDuration($, 'row-1') // turn 1's line, though turn 2 is the newest
  await line.press({ key: 'turn-strip-open' })
  await quiet(w.calls)
  expect(w.opened).toHaveLength(1) // ui.open({ focus: true }), the call that gives the pane the keys
  expect(w.opened[0]).toMatchObject({ id: 'track', focus: true })
  const pane = await mountPane($)
  const selected = rowsOf(await pane.drawn()).filter(r => r.selected)
  expect(selected).toHaveLength(1)
  expect(selected[0]!.text).toContain('three.example') // the entry of turn 1
  await pane.unmount()
  await line.unmount()
})

test('a bad ui.turnStrip reads as off: no line, no strip', async ($, on) => {
  engineLine(on)
  stripWorld(on, 'loud')
  await $.session.start(START)
  expect(await turn($, 1, [A])).toEqual({ text: '' })
  const line = await mountDuration($, 'row-1')
  expect(await line.findAll({ key: 'turn-strip-open' })).toEqual([])
  await line.unmount()
})
