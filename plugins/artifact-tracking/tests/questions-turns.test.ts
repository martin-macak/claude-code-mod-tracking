// The turn lineage of the Questions rows (issue #201, after #133): `/track turn n` lists each Q&A call by its key, and never by
// the words of its cells. The model reads the reply of `/track turn`, so a label built from the cells would send the typed
// answer to the model. The tests run the real LifecycleManager over fakePorts: no engine, no model. They check order and
// causality (`start`, the call, `end`, then the reply), never wall time.

import { expect, test } from 'claude-code/testing'
import type { ToolCallEvent } from '../core/interfaces/events'
import type { Json } from '../core/interfaces/items'
import type { SectionSpec } from '../core/interfaces/view'
import { PaneSession } from '../hooks/pane-session'
import { turnLabels } from '../hooks/pane-text'
import { questionsTracker } from '../trackers/questions'
import { questionTurnsOf } from '../trackers/questions/turns'
import { fakeConfig } from './fixtures/config-fs'
import { fakePorts } from './fixtures/ports'
import { LIVE_PLAN_APPROVED } from './fixtures/questions'
import { section, row as treeRow } from './fixtures/sections'
import { turnWorld } from './fixtures/turn-world'

const QUESTION = 'Which codename should the release use?'
const ANSWER = 'bluefalcon-typed-answer'
const NOTES = 'private-note-text'
const HEADER = 'Codename'

const ask = (id: string, extra: Partial<ToolCallEvent> = {}, answer = ANSWER): ToolCallEvent => {
  const questions = [
    {
      question: QUESTION,
      header: HEADER,
      multiSelect: false,
      options: [{ label: 'Generate', description: 'Make one.' }],
    },
  ]
  return {
    tool: 'AskUserQuestion',
    toolUseId: id,
    input: { questions, tool: 'AskUserQuestion', tool_use_id: id } as unknown as Json,
    result: {
      ref: 1,
      result: { questions, answers: { [QUESTION]: answer }, annotations: { [QUESTION]: { notes: NOTES } } },
      text: 'The user answered.',
    } as unknown as Json,
    ...extra,
  }
}

const SECRET_ANSWER = 'password: hunter2'
const SECRET_PLAN = 'Rotate the launch-code-vault before the freeze'
const plan = (id: string): ToolCallEvent => {
  const body = `# ${SECRET_PLAN}\n\n1. Do it.\n`
  return {
    tool: 'ExitPlanMode',
    toolUseId: id,
    input: { plan: body, tool: 'ExitPlanMode', tool_use_id: id } as unknown as Json,
    result: { ref: 1, result: { plan: body, isAgent: false }, text: 'User has approved your plan.' } as unknown as Json,
  }
}

/** `extra` adds to the config file, for example `{ global: { ui: { turnStrip: 'text' } } }`. */
const world = (mask = true, maxCalls = 100, extra: Record<string, unknown> = {}) =>
  turnWorld({
    trackers: () => [questionsTracker()],
    config: specs => fakeConfig({ specs, file: { ...extra, trackers: { questions: { mask, maxCalls } } } as never }),
  })

const hear = (t: ReturnType<typeof world>, ev: ToolCallEvent) => t.m.toolCall(t.w.ports, ev)

/** The lines of a `/track turn` reply below its header, split into words. */
const entries = async (t: ReturnType<typeof world>, args: string) =>
  (await t.text(args))
    .split('\n')
    .slice(1)
    .map(l => l.trim().split(/\s+/))

test('two calls of turn 1 are listed as new, each by its key only', async () => {
  const t = world()
  await t.start('turn-1', 'ask things')
  await hear(t, ask('toolu_a'))
  await hear(t, ask('toolu_b'))
  await t.end('turn-1')
  expect(t.rec(1).new).toEqual([
    { k: 'toolu_a', c: 'question', r: 'created' },
    { k: 'toolu_b', c: 'question', r: 'created' },
  ])
  expect((await t.text('turn 1')).split('\n')[0]).toMatch(/ · 2 new$/)
  expect(await entries(t, 'turn 1')).toEqual([
    ['new', 'Q1', 'created'],
    ['new', 'Q2', 'created'],
  ])
})

for (const mask of [true, false]) {
  test(`the reply holds no question, header, answer or note, with the mask ${mask ? 'on' : 'off'}`, async () => {
    const t = world(mask)
    await t.start('turn-1', 'go')
    await hear(t, ask('toolu_a'))
    await t.end('turn-1')
    const reply = await t.text('turn 1')
    // QUESTION and NOTES are in the detail only, not in a cell: the proof of the label rule is HEADER and ANSWER (study G3).
    // The other two stay as belt and braces, so nobody trusts them as the proof.
    for (const word of [QUESTION, HEADER, ANSWER, NOTES, 'typed']) expect(reply).not.toContain(word)
    expect(reply).toMatch(/\n {2}new {4}Q1 {2}created$/)
  })
}

test('the label is the same with the mask on and off, also when the mask changes the cells of the row', async () => {
  const [on, off] = [world(true), world(false)]
  for (const t of [on, off]) {
    await t.start('turn-1', 'go')
    await hear(t, ask('toolu_a', {}, SECRET_ANSWER))
    await t.end('turn-1')
  }
  // The precondition: the mask changes the description cell, so a label that read it would differ between the two worlds.
  const cell = async (t: ReturnType<typeof world>) =>
    (await t.rows()).find(r => r.id === 'toolu_a')?.cells.description?.text ?? ''
  expect(await cell(on)).toContain('[masked]')
  expect(await cell(off)).toContain('hunter2')
  const reply = await on.text('turn 1')
  expect(await off.text('turn 1')).toBe(reply) // first: a label that read a masked cell fails here, and only here
  expect(reply).toMatch(/\n {2}new {4}Q1 {2}created$/)
})

test('a plan call is listed by its key too, as a plan, and the reply holds no line of the plan', async () => {
  const t = world()
  await t.start('turn-1', 'go')
  await hear(t, plan('toolu_plan'))
  await hear(t, LIVE_PLAN_APPROVED)
  await t.end('turn-1')
  expect(t.rec(1).new).toEqual([
    { k: 'toolu_plan', c: 'plan', r: 'created' },
    { k: 'toolu_plan_2', c: 'plan', r: 'created' },
  ])
  expect(await entries(t, 'turn 1')).toEqual([
    ['new', 'Q1', 'created'],
    ['new', 'Q2', 'created'],
  ])
  expect(await t.text('turn 1')).not.toContain('launch-code-vault')
})

test('a question and a plan call share the numbers of their keys', async () => {
  const t = world()
  await t.start('turn-1', 'go')
  await hear(t, ask('toolu_a'))
  await hear(t, plan('toolu_plan'))
  await t.end('turn-1')
  expect(await entries(t, 'turn 1')).toEqual([
    ['new', 'Q1', 'created'],
    ['new', 'Q2', 'created'],
  ])
})

test('turnsOf gives the pane row of a call its turn, and a question row below it none', async () => {
  const t = world()
  await t.idle(1)
  await t.start('turn-2', 'go')
  await hear(t, ask('toolu_a'))
  await t.end('turn-2')
  const row = (await t.rows()).find(r => r.id === 'toolu_a')
  expect(row?.turns).toEqual({ first: 2, last: 2 })
  expect(row?.extras).toEqual([{ text: 'T2', dim: true }])
  expect(row?.children?.length).toBeGreaterThan(0)
  expect(row?.children?.every(c => c.turns === undefined)).toBe(true)
})

test('questionTurnsOf: the turn of the call for both ends; no call, no stored list or no turn gives none', () => {
  const stored = [
    { id: 'toolu_a', n: 1, turn: 4 },
    { id: 'toolu_b', n: 2 },
  ] as unknown as Json
  expect(questionTurnsOf(stored, 'toolu_a')).toEqual({ first: 4, last: 4 })
  expect(questionTurnsOf(stored, 'toolu_b')).toBeUndefined()
  expect(questionTurnsOf(stored, 'toolu_a:0')).toBeUndefined()
  expect(questionTurnsOf(stored, 'toolu_none')).toBeUndefined()
  expect(questionTurnsOf(undefined, 'toolu_a')).toBeUndefined()
})

test('questionTurnsOf: a stored turn that is no finite number gives none, as for the other trackers (core turnSpan)', () => {
  const stored = [
    { id: 'toolu_a', n: 1, turn: 'x' },
    { id: 'toolu_b', n: 2, turn: Number.NaN },
  ] as unknown as Json
  expect(questionTurnsOf(stored, 'toolu_a')).toBeUndefined()
  expect(questionTurnsOf(stored, 'toolu_b')).toBeUndefined()
})

test('a call with no turn running lists in none and gets no turns', async () => {
  const t = world()
  await hear(t, ask('toolu_none'))
  expect((await t.rows()).find(r => r.id === 'toolu_none')?.turns).toBeUndefined()
  expect(t.ledger().turns).toEqual([])
})

test('a call that the caps dropped reads by its category and id: no word of it is left to print', async () => {
  const t = world(true, 1)
  await t.start('turn-1', 'go')
  await hear(t, ask('toolu_old'))
  await hear(t, ask('toolu_new'))
  await t.end('turn-1')
  expect(await entries(t, 'turn 1')).toEqual([
    ['new', 'question', 'toolu_old', 'created'],
    ['new', 'Q2', 'created'],
  ])
})

test('a subagent that asks after its turn ended is listed in the turn that spawned it, as late', async () => {
  const t = world()
  await t.start('turn-1', 'spawn')
  await t.spawn('agent-1', 'tu_agent1')
  await t.end('turn-1')
  await t.start('turn-2', 'other')
  await hear(t, ask('toolu_sub', { agentId: 'agent-1' }))
  expect(t.rec(1).new).toEqual([{ k: 'toolu_sub', c: 'question', r: 'created', late: true }])
  expect(t.rec(2).new).toEqual([])
  expect(await t.text('turn 1')).toMatch(/Q1 {2}created · late \(subagent\)$/)
})

test('the band counts a turn that only asked a question as +1 new', async () => {
  const t = world()
  await t.start('turn-1', 'go')
  await hear(t, ask('toolu_a'))
  await t.end('turn-1')
  expect(await t.m.bandTurn()).toMatchObject({ ord: 1, text: '+1 new', keys: ['toolu_a'] })
})

test('the band key 9 selects the call of a turn that only asked a question', async () => {
  const t = world()
  await t.start('turn-1', 'go')
  await hear(t, ask('toolu_a'))
  await t.end('turn-1')
  await new PaneSession().openTurn(t.w.ports, t.m)
  expect(t.w.state.get('selected')).toBe('toolu_a')
  expect(t.w.ui.openedWith).toEqual(['toolu_a'])
  expect(t.w.ui.toasts).toEqual([])
})

test('the strip line counts a turn that only asked a question as +1 new and names the turn', async () => {
  const t = world(true, 100, { global: { ui: { turnStrip: 'text' } } })
  await t.start('turn-1', 'go')
  await hear(t, ask('toolu_a'))
  await t.end('turn-1')
  expect(await t.m.turnStrip('turn-1')).toBe('+1 new · /track turn 1')
})

test('a call id heard twice in turn 1 and once in turn 2 is new in turn 1 and seen again in turn 2; the pane keeps turn 1', async () => {
  const t = world()
  await t.start('turn-1', 'a')
  await hear(t, ask('toolu_a'))
  await hear(t, ask('toolu_a'))
  await t.end('turn-1')
  await t.start('turn-2', 'b')
  await hear(t, ask('toolu_a'))
  await t.end('turn-2')
  expect(t.rec(1).new).toEqual([{ k: 'toolu_a', c: 'question', r: 'created' }])
  expect(t.rec(1).seen).toEqual([])
  expect(t.rec(2).new).toEqual([])
  expect(t.rec(2).seen).toEqual([{ k: 'toolu_a', c: 'question', r: 'created' }])
  expect((await t.rows()).find(r => r.id === 'toolu_a')?.turns).toEqual({ first: 1, last: 1 })
  expect(await entries(t, 'turn 2')).toEqual([['again', 'Q1', 'created']])
})

// The rule lives in `turnLabels`, keyed on `text: 'title'`, so it holds for any section that keeps its rows out of the text.
const labelsOf = (sections: readonly SectionSpec[]) => turnLabels(fakePorts().ports, { paneData: async () => sections })

test('turnLabels: a section with text title lends the name cell of its rows only, and no child row', async () => {
  const secret = treeRow(
    'c1',
    { name: 'Q1', type: 'question', description: 'Codename → typed: bluefalcon' },
    { children: [treeRow('c1:0', { name: 'Codename', type: 'question', description: 'bluefalcon' })] },
  )
  const labels = await labelsOf([section('questions', [secret], { text: 'title', rank: 90 })])
  expect([...labels]).toEqual([['c1', 'Q1']])
})

test('turnLabels: a section with text rows keeps the type, name and description words and the child rows', async () => {
  const open = treeRow(
    'i1',
    { name: 'abc', type: 'question', description: 'Fix the thing' },
    { children: [treeRow('i1:0', { name: 'sub', type: 'question', description: 'Do it' })] },
  )
  const labels = await labelsOf([section('items', [open], {})])
  expect([...labels]).toEqual([
    ['i1', 'question abc Fix the thing'],
    ['i1:0', 'question sub Do it'],
  ])
})
