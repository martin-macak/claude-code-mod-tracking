// Kit tests of the turn ledger through the real hooks (issue #69, PR 1): `turn.start` and `turn.complete`, the rows and the
// tool calls between them, `/track turn [n]`, and the band part with its Button. The engine raises the events in the order a
// live run showed (design study, comment 2). The rules themselves run in tests/turns.test.ts and tests/turn-ledger.test.ts.
// The kit's `$.tool.call` drops `agentId`, so a subagent's own rows come in as `session.append` rows with an `agentId`.

import type { On } from 'claude-code'
import { type Engine, expect } from 'claude-code/testing'
import { test } from './fixtures/kit'
import { BG_START_MAIN } from './fixtures/notices'
import { handleFor, mountPane, rowsOf } from './fixtures/pane'
import { BAND, prompt, quiet, response, START, track, world } from './fixtures/world'

const A = 'https://one.example/a'
const B = 'https://two.example/b'
const C = 'https://three.example/c'

type Mounted = {
  find(q: unknown): Promise<unknown>
  findAll(q: unknown): Promise<{ key?: string; text?: string; props: Record<string, unknown> }[]>
  press(q: { key: string }): Promise<void>
  unmount(): Promise<void>
}
const mountBand = ($: Engine) => $.ui.mount({ ...BAND, surface: 'terminal' } as never) as unknown as Promise<Mounted>
/** Stands for the engine's own band, which the hook returns inside its Box as next(e). */
const engineBand = (on: On) => on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))

const start = ($: Engine, turnId: string, text = 'go', agentId?: string) =>
  $.turn.start({ turnId, text, ...(agentId !== undefined ? { agentId } : {}) } as never)
const end = ($: Engine, turnId: string, reason = 'answer') =>
  $.turn.complete({ turnId, reason, isAborted: reason === 'aborted', durationMs: 5, answer: '' } as never)
const turnText = async ($: Engine, n = '') => (await track($, `turn ${n}`.trim())).text ?? ''

test('turn.start passes through with its turn id, and a turn with a prompt row, a response and an end is listed by /track turn', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  expect(await turnText($)).toBe('No turn tracked yet.')
  await $.session.append(prompt(`look at ${A}`)) // the prompt row comes before turn.start
  expect(await start($, 'turn-1', `look at ${A}`)).toEqual({ turnId: 'turn-1' })
  await $.session.append(response(`and ${B}`))
  await end($, 'turn-1')
  await quiet(w.calls)
  const text = await turnText($)
  expect(text.split('\n')[0]).toMatch(/^Turn 1 · answer · \d\d:\d\d · "look at https:\/\/one\.example\/a" · 2 new$/)
  expect(text).toMatch(/\n {2}new {4}one\.example\/a.* {2}mentioned/)
  expect(text).toMatch(/\n {2}new {4}two\.example\/b.* {2}mentioned$/)
  expect(await turnText($, '1')).toBe(text)
})

test('the second turn lists the item it saw again; /track turn 1 and /track turn 2 list their own items', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.session.append(prompt(`one ${A}`))
  await start($, 'turn-1', `one ${A}`)
  await end($, 'turn-1')
  await $.session.append(prompt(`two ${A} and ${C}`))
  await start($, 'turn-2', `two ${A} and ${C}`)
  await end($, 'turn-2')
  await quiet(w.calls)
  const first = await turnText($, '1')
  const second = await turnText($, '2')
  expect(first).toContain('1 new')
  expect(first).not.toContain('three.example')
  expect(second.split('\n')[0]).toMatch(/ · 1 new, 1 seen again$/)
  expect(second).toMatch(/\n {2}new {4}three\.example\/c/)
  expect(second).toMatch(/\n {2}again {2}one\.example\/a/)
})

test("a subagent's own turn.start opens no record, and its rows go to the turn that spawned it, also after it ended", async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  w.fake.spawnId = 'agent-7'
  await start($, 'turn-1', 'spawn one')
  await $.agent.spawn({ tool_use_id: 'tu_agent', subagentType: 'general-purpose', background: true } as never)
  await start($, 'sub-turn', 'sub work', 'agent-7') // the sub's start: not a main turn
  await end($, 'turn-1')
  await $.session.append({ ...response(`sub says ${A}`), agentId: 'agent-7' }) // the sub works on after the main end
  await quiet(w.calls)
  const text = await turnText($)
  expect(text.split('\n')[0]).toMatch(/^Turn 1 · answer · /)
  expect(text).toContain('late (subagent)')
  expect(await turnText($, '2')).toBe('No turn 2 yet. The last is turn 1.')
})

test('a task notice wakes the main loop: the wake takes no ordinal and its work goes to the turn that started the task', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  w.fake.spawnId = 'afe3f379'
  await start($, 'turn-1', 'spawn one')
  await $.agent.spawn({ tool_use_id: 'tu_agent1', subagentType: 'general-purpose', background: true } as never)
  await end($, 'turn-1')
  const notice = '<task-notification>\n<task-id>afe3f379</task-id>\n<tool-use-id>tu_agent1</tool-use-id>\ndone'
  await $.session.append(prompt(notice, 'task-notification'))
  await start($, 'wake-1', notice)
  await $.session.append(response(`spare one ${A}`))
  await end($, 'wake-1')
  await $.session.append(prompt('next question'))
  await start($, 'turn-2', 'next question')
  await end($, 'turn-2')
  await quiet(w.calls)
  const first = await turnText($, '1')
  expect(first).toContain('1 wake')
  expect(first).toContain('one.example/a')
  expect((await turnText($)).split('\n')[0]).toMatch(/^Turn 2 · /) // the next prompt is turn 2, not 3
})

test('a Bash call that went to the background maps its id, so the wake of its task goes to the turn that ran it', async ($, on) => {
  const w = world(on)
  await $.session.start(START)
  await start($, 'turn-1', 'run it')
  w.fake.tools.Bash = { ...BG_START_MAIN.result } // the engine wraps it as { ref, result, text } for the hook
  await $.tool.call({ tool: 'Bash', command: 'sleep 1', tool_use_id: 'tu_bg1' } as never)
  await end($, 'turn-1')
  await $.session.append(prompt('another question'))
  await start($, 'turn-2', 'another question')
  await end($, 'turn-2')
  const notice = '<task-notification>\n<task-id>butoa45ib</task-id>\n<tool-use-id>tu_bg1</tool-use-id>\ndone'
  await $.session.append(prompt(notice, 'task-notification'))
  await start($, 'wake-1', notice)
  await $.session.append(response(`spare ${A}`))
  await end($, 'wake-1')
  await quiet(w.calls)
  const first = await turnText($, '1') // the turn that ran the command, not the newest one
  expect(first).toContain('1 wake')
  expect(first).toContain('one.example/a')
  expect(await turnText($, '2')).not.toContain('wake')
})

test('an aborted turn is committed with the engine word aborted', async ($, on) => {
  world(on)
  await $.session.start(START)
  await start($, 'turn-1', 'go')
  await end($, 'turn-1', 'aborted')
  expect((await turnText($)).split('\n')[0]).toMatch(/^Turn 1 · aborted · /)
})

test('the band shows the newest turn that tracked anything with its Button on the digit 9, and nothing for a session with no turn', async ($, on) => {
  const w = world(on)
  engineBand(on)
  await $.session.start(START)
  const before = await mountBand($)
  expect(await before.find({ text: 'turn 1' })).toBeUndefined()
  await before.unmount()
  // The prompt row comes before its turn.start: the band counts the two links and has no turn part yet. With no Button to
  // draw, it never asks which panes are open.
  await $.session.append(prompt(`see ${A} and ${B}`))
  const reads = w.paneReads.length
  const counted = await mountBand($)
  expect(await counted.find({ text: 'Links 2' })).toBeDefined()
  expect(await counted.find({ text: 'turn 1' })).toBeUndefined()
  expect(w.paneReads).toHaveLength(reads)
  await counted.unmount()
  await start($, 'turn-1', 'see')
  await end($, 'turn-1')
  await start($, 'turn-2', 'an empty turn')
  await end($, 'turn-2')
  await quiet(w.calls)
  const band = await mountBand($)
  expect(await band.find({ text: 'turn 1 +2 new' })).toBeDefined() // turn 2 tracked nothing: the band keeps turn 1
  expect(await band.find({ text: 'engine band' })).toBeDefined()
  const [open] = await band.findAll({ key: 'turn-open' })
  expect(open?.props).toMatchObject({ hotkey: '9', plain: true, label: 'open' })
  await band.unmount()
})

test('the band keeps the turn words and draws no Button while the pane is open: ctrl+x Tab then goes straight to the pane', async ($, on) => {
  const w = world(on, { panes: ['track'] })
  engineBand(on)
  await $.session.start(START)
  await $.session.append(prompt(`see ${A}`))
  await start($, 'turn-1', 'see')
  await end($, 'turn-1')
  await quiet(w.calls)
  const band = await mountBand($)
  expect(await band.find({ text: 'turn 1 +1 new' })).toBeDefined()
  expect(await band.findAll({ key: 'turn-open' })).toEqual([])
  await band.unmount()
})

test('the band Button opens /track with the pane focused and the first entry of the turn selected', async ($, on) => {
  const w = world(on, { isolateState: true })
  engineBand(on)
  await $.session.start(START)
  await $.session.append(prompt(`one ${C}`))
  await start($, 'turn-1', 'one')
  await end($, 'turn-1')
  await $.session.append(prompt(`two ${A} and ${B}`))
  await start($, 'turn-2', 'two')
  await end($, 'turn-2')
  await quiet(w.calls)
  const band = await mountBand($)
  await band.press({ key: 'turn-open' })
  await quiet(w.calls)
  expect(w.opened).toHaveLength(1) // ui.open({ focus: true }), the call that gives the pane the keys
  expect(w.opened[0]).toMatchObject({ id: 'track', focus: true })
  const pane = await mountPane($)
  const selected = rowsOf(await pane.drawn()).filter(r => r.selected)
  expect(selected).toHaveLength(1)
  expect(selected[0]!.text).toContain('one.example') // the first entry of turn 2: the first link of its prompt
  expect(await handleFor(pane, 'three.example')).toBeDefined() // turn 1's item is listed too, and not selected
  await pane.unmount()
  await band.unmount()
})
