// What the questions tracker reads of an AskUserQuestion or an ExitPlanMode call (issue #71): the questions word for word,
// the answers from the structured result, the state of the call, and the parts of one answer. Pure. The inputs are
// captures of Claude Code 2.1.306 (tests/fixtures/questions.ts).
import { expect, test } from 'claude-code/testing'
import type { ToolCallEvent } from '../core/interfaces/events'
import type { Json } from '../core/interfaces/items'
import { answerParts, askCall, planCall } from '../trackers/questions/parse'
import type { QuestionItem } from '../trackers/questions/types'
import {
  ANSWERED_ASK,
  LIVE_ASK,
  LIVE_ESC,
  LIVE_PLAN_APPROVED,
  LIVE_PLAN_EMPTY,
  LIVE_PLAN_REJECTED,
  LIVE_QUESTIONS,
  PLAN,
  PLAN_FILE,
  replayed,
} from './fixtures/questions'

const item = (over: Partial<QuestionItem> = {}): QuestionItem => ({
  question: 'Which?',
  header: 'Pick',
  multiSelect: false,
  options: [{ label: 'A' }, { label: 'B, C' }, { label: 'D' }],
  ...over,
})

// ---------------------------------------------------------------- the questions, word for word

test('askCall keeps the questions, the headers, multiSelect and every option with its label, description and preview', () => {
  const call = askCall(ANSWERED_ASK)
  expect(call?.id).toBe('toolu_ask_2')
  expect(call?.kind).toBe('ask')
  expect(call?.items?.map(i => [i.question, i.header, i.multiSelect])).toEqual([
    ['Where should the records live?', 'Storage', false],
    ['Which checks should run?', 'Checks', true],
  ])
  expect(call?.items?.[0]?.options).toEqual([
    { label: 'State only', description: 'Keep them in the plugin state.', preview: 'state.set(records)' },
    { label: 'State and store', description: 'Also write them to the plugin store.' },
  ])
  // An option with no preview keeps no preview key: nothing is added to what the engine gave.
  expect(call?.items?.[0]?.options[1]).not.toHaveProperty('preview')
})

test('askCall reads the questions from the input when the result has none (a declined call)', () => {
  const call = askCall(LIVE_ESC)
  expect(call?.items?.map(i => i.question)).toEqual(['Ship it?'])
  expect(call?.items?.[0]?.options.map(o => o.label)).toEqual(['Yes', 'No'])
})

test('askCall keeps the kind and the helper line of a question, and drops an item that is not a question', () => {
  const ev: ToolCallEvent = {
    tool: 'AskUserQuestion',
    toolUseId: 't1',
    input: {
      questions: [
        { question: 'Name?', header: 'Name', kind: 'text', description: 'Your name.', multiSelect: false, options: [] },
        { header: 'no question text' },
        'not an object',
        { question: 'Pick?', header: 'P', multiSelect: false, options: [{ label: 'x' }, { nolabel: true }, 7] },
      ],
    } as unknown as Json,
    result: { result: { answers: { 'Name?': 'Ada' } } } as unknown as Json,
  }
  const call = askCall(ev)
  expect(call?.items?.map(i => i.question)).toEqual(['Name?', 'Pick?'])
  expect(call?.items?.[0]).toMatchObject({ kind: 'text', description: 'Your name.', answer: 'Ada' })
  expect(call?.items?.[1]?.options).toEqual([{ label: 'x' }])
})

test('askCall keeps what a text and a number question say of their control: the placeholder, the range, the step, the default and the unit', () => {
  const questions = [
    { question: 'Name?', header: 'Name', kind: 'text', placeholder: 'e.g. Ada', multiSelect: false, options: [] },
    {
      question: 'How wide?',
      header: 'Width',
      kind: 'number',
      min: 1,
      max: 10,
      step: 0.5,
      defaultValue: 0,
      unit: 'px',
      multiSelect: false,
      options: [],
    },
    // Nothing that is not a string or a finite number is kept, and an empty string is a string.
    {
      question: 'Odd?',
      header: 'Odd',
      kind: 'number',
      min: '1',
      max: null,
      step: Number.NaN,
      unit: 7,
      placeholder: '',
      options: [],
    },
  ]
  const ev: ToolCallEvent = {
    tool: 'AskUserQuestion',
    toolUseId: 't1',
    input: { questions } as unknown as Json,
    result: { result: { questions, answers: { 'Name?': 'Ada', 'How wide?': '4' } } } as unknown as Json,
  }
  const [name, width, odd] = askCall(ev)?.items ?? []
  expect(name).toMatchObject({ kind: 'text', placeholder: 'e.g. Ada', answer: 'Ada' })
  expect(name).not.toHaveProperty('min')
  expect(width).toMatchObject({ kind: 'number', min: 1, max: 10, step: 0.5, defaultValue: 0, unit: 'px', answer: '4' })
  expect(width).not.toHaveProperty('placeholder')
  expect(odd).toEqual({
    question: 'Odd?',
    header: 'Odd',
    multiSelect: false,
    kind: 'number',
    placeholder: '',
    options: [],
  })
})

test('a call with no outcome is not a call: a transcript use that stored no result and no error says nothing of the answers', () => {
  // `$.session.messages()` leaves `result` out while a call is in flight or when nothing was stored.
  const inflight = (tool: string): ToolCallEvent => ({
    tool,
    toolUseId: 'toolu_x',
    input: { questions: LIVE_QUESTIONS } as unknown as Json,
    result: { tool, tool_use_id: 'toolu_x', input: {} } as unknown as Json,
  })
  expect(askCall(inflight('AskUserQuestion'))).toBeUndefined()
  expect(planCall(inflight('ExitPlanMode'))).toBeUndefined()
  expect(askCall({ ...inflight('AskUserQuestion'), result: null as unknown as Json })).toBeUndefined()
})

test('a call with no usable question is not a call', () => {
  const none = (input: unknown, result: unknown = {}): ToolCallEvent => ({
    tool: 'AskUserQuestion',
    toolUseId: 't',
    input: input as Json,
    result: result as Json,
  })
  expect(askCall(none({}))).toBeUndefined()
  expect(askCall(none({ questions: [] }))).toBeUndefined()
  expect(askCall(none({ questions: 'x' }))).toBeUndefined()
  expect(askCall(none(null))).toBeUndefined()
  expect(askCall({ tool: 'AskUserQuestion', input: LIVE_ASK.input, result: LIVE_ASK.result })).toBeUndefined() // no id
})

// ---------------------------------------------------------------- the answers, from the structured result

test('the answers, the preview and the notes come from the structured result by question text', () => {
  const call = askCall(ANSWERED_ASK)
  expect(call?.items?.[0]).toMatchObject({
    answer: 'State only',
    preview: 'state.set(records)',
    notes: 'keep it simple',
  })
  expect(call?.items?.[1]?.answer).toBe('Lint, E2E')
  expect(call?.items?.[1]).not.toHaveProperty('notes')
})

test('the live capture: notes with no option read as the engine said, and the typed text with a comma stays whole', () => {
  const call = askCall(LIVE_ASK)
  expect(call?.items?.map(i => i.answer)).toEqual(['(notes only)', 'Lint, "Tests, all", "typed, with comma"'])
  expect(call?.items?.[0]?.notes).toBe('keep it simple')
  expect(call?.items?.map(i => i.question)).toEqual(LIVE_QUESTIONS.map(q => q.question))
})

test('the answers never come from the text of the result', () => {
  const ev: ToolCallEvent = {
    tool: 'AskUserQuestion',
    toolUseId: 't1',
    input: { questions: [LIVE_QUESTIONS[0]] } as unknown as Json,
    result: {
      result: { questions: [LIVE_QUESTIONS[0]], answers: { 'Where should the records live?': 'State only' } },
      text: 'The user answered: "Where should the records live?"="State and store".',
    } as unknown as Json,
  }
  expect(askCall(ev)?.items?.[0]?.answer).toBe('State only')
})

test('a replayed call reads the same answers: the stored record is the whole use', () => {
  const live = askCall(ANSWERED_ASK)
  const back = askCall(replayed(ANSWERED_ASK))
  expect(back).toEqual(live)
})

// ---------------------------------------------------------------- the states

test('answered: every question has an answer', () => {
  expect(askCall(ANSWERED_ASK)?.state).toBe('answered')
})

test('partial: a question left blank is missing from the answers', () => {
  const ev: ToolCallEvent = {
    ...ANSWERED_ASK,
    result: {
      result: { questions: LIVE_QUESTIONS, answers: { 'Which checks should run?': 'Lint' } },
    } as unknown as Json,
  }
  const call = askCall(ev)
  expect(call?.state).toBe('partial')
  expect(call?.items?.[0]).not.toHaveProperty('answer')
  expect(call?.items?.[1]?.answer).toBe('Lint')
})

test('partial: notes with no option leave the question without an answer (the live capture)', () => {
  expect(askCall(LIVE_ASK)?.state).toBe('partial')
})

test('partial: a result with no answers at all is a call whose questions were all left blank', () => {
  const ev: ToolCallEvent = {
    ...ANSWERED_ASK,
    result: { result: { questions: LIVE_QUESTIONS, answers: {} } } as unknown as Json,
  }
  expect(askCall(ev)?.state).toBe('partial')
})

test('declined: Esc is an error result, and the words of the engine are kept', () => {
  const call = askCall(LIVE_ESC)
  expect(call?.state).toBe('declined')
  expect(call?.refusal).toContain("The user doesn't want to proceed")
  expect(call?.items?.[0]).not.toHaveProperty('answer')
})

test('declined: the words are the structured error of the result, never the display text beside it', () => {
  const structured = (LIVE_ESC.result as { result: string }).result
  expect(structured.startsWith('Error: ')).toBe(true) // the capture: only the structured string has the prefix
  expect(askCall(LIVE_ESC)?.refusal).toBe(structured)
  const both = { ...LIVE_ESC, result: { isError: true, result: 'the record', text: 'the display' } as unknown as Json }
  expect(askCall(both)?.refusal).toBe('the record')
  const onlyText = { ...LIVE_ESC, result: { isError: true, text: 'the display' } as unknown as Json }
  expect(askCall(onlyText)?.refusal).toBe('the display') // a transcript use that stored the text only
  const neither = { ...LIVE_ESC, result: { isError: true } as unknown as Json }
  expect(askCall(neither)?.refusal).toBe('')
})

test('declined: a call that another hook denied keeps the text of the hook', () => {
  const ev: ToolCallEvent = { ...ANSWERED_ASK, result: { deny: 'blocked by policy' } as unknown as Json }
  const call = askCall(ev)
  expect(call?.state).toBe('declined')
  expect(call?.refusal).toBe('blocked by policy')
})

test('the follow-up, the typed response and the AFK answer are kept as the engine gave them', () => {
  const ev: ToolCallEvent = {
    ...ANSWERED_ASK,
    result: {
      result: {
        questions: LIVE_QUESTIONS,
        answers: {},
        response: 'Let us talk first',
        followUp: true,
        afkTimeoutMs: 60000,
      },
    } as unknown as Json,
  }
  const call = askCall(ev)
  expect(call).toMatchObject({ response: 'Let us talk first', followUp: true, afkTimeoutMs: 60000, state: 'partial' })
})

test('a plugin ask is marked by its id', () => {
  const ev: ToolCallEvent = { ...ANSWERED_ASK, toolUseId: 'toolu_plugin_abc' }
  expect(askCall(ev)).toMatchObject({ id: 'toolu_plugin_abc', plugin: true })
  expect(askCall(ANSWERED_ASK)).not.toHaveProperty('plugin')
})

test('the agent of the call is kept, and the main loop has none', () => {
  expect(askCall({ ...ANSWERED_ASK, agentId: 'agent-1' })?.agentId).toBe('agent-1')
  expect(askCall(ANSWERED_ASK)).not.toHaveProperty('agentId')
})

// ---------------------------------------------------------------- the parts of one answer

test('answerParts: a single pick that is a label, and a typed text that is not', () => {
  expect(answerParts(item({ answer: 'A' }))).toEqual({ chosen: ['A'], typed: [], notesOnly: false })
  expect(answerParts(item({ answer: 'something else' }))).toEqual({
    chosen: [],
    typed: ['something else'],
    notesOnly: false,
  })
})

test('answerParts: a single pick whose label holds a comma is one label', () => {
  expect(answerParts(item({ answer: 'B, C' }))).toEqual({ chosen: ['B, C'], typed: [], notesOnly: false })
})

test('answerParts: a multi-select answer splits at the comma and the space', () => {
  expect(answerParts(item({ multiSelect: true, answer: 'A, D' }))).toEqual({
    chosen: ['A', 'D'],
    typed: [],
    notesOnly: false,
  })
})

test('answerParts: a quoted piece holds a comma, and a piece that is no label is typed text', () => {
  const parts = answerParts(item({ multiSelect: true, answer: 'A, "B, C", "typed, with comma", plain typed' }))
  expect(parts).toEqual({ chosen: ['A', 'B, C'], typed: ['typed, with comma', 'plain typed'], notesOnly: false })
})

test('answerParts: an unquoted label that holds a comma still joins when the pieces make a label', () => {
  expect(answerParts(item({ multiSelect: true, answer: 'A, B, C' }))).toEqual({
    chosen: ['A', 'B, C'],
    typed: [],
    notesOnly: false,
  })
})

test('answerParts: a quote with no closing quote is read as it stands', () => {
  expect(answerParts(item({ multiSelect: true, answer: 'A, "open, end' }))).toEqual({
    chosen: ['A'],
    typed: ['"open', 'end'],
    notesOnly: false,
  })
})

test('answerParts: notes only, no answer, and a question that is not a choice', () => {
  expect(answerParts(item({ answer: '(notes only)' }))).toEqual({ chosen: [], typed: [], notesOnly: true })
  expect(answerParts(item())).toEqual({ chosen: [], typed: [], notesOnly: false })
  expect(answerParts(item({ kind: 'text', options: [], answer: 'Ada, Lovelace' }))).toEqual({
    chosen: [],
    typed: ['Ada, Lovelace'],
    notesOnly: false,
  })
  expect(answerParts(item({ kind: 'number', options: [], answer: '42' }))).toEqual({
    chosen: [],
    typed: ['42'],
    notesOnly: false,
  })
})

test('answerParts: a label that is the engine word for notes only is a label', () => {
  const q = item({ options: [{ label: '(notes only)' }], answer: '(notes only)' })
  expect(answerParts(q)).toEqual({ chosen: ['(notes only)'], typed: [], notesOnly: false })
})

// ---------------------------------------------------------------- plans

test('planCall: an approved plan keeps the plan word for word, its file and the state answered', () => {
  const call = planCall(LIVE_PLAN_APPROVED)
  expect(call).toEqual({ id: 'toolu_plan_2', kind: 'plan', state: 'answered', plan: PLAN, planFile: PLAN_FILE })
})

test('planCall: an approval with no plan file keeps no plan', () => {
  const call = planCall(LIVE_PLAN_EMPTY)
  expect(call).toEqual({ id: 'toolu_plan_1', kind: 'plan', state: 'answered', planFile: PLAN_FILE })
})

test('planCall: a rejection is declined, and keeps the plan from the input and the words of the person', () => {
  const call = planCall(LIVE_PLAN_REJECTED)
  expect(call?.state).toBe('declined')
  expect(call?.plan).toBe(PLAN)
  expect(call?.planFile).toBe(PLAN_FILE)
  // The structured error word for word: the note of the person is in it, so the display text is not needed.
  expect(call?.refusal).toBe((LIVE_PLAN_REJECTED.result as { result: string }).result)
  expect(call?.refusal?.endsWith('the user said:\nUse fewer steps')).toBe(true)
})

test('planCall: a plan that a hook denied is declined with the text of the hook', () => {
  const call = planCall({ ...LIVE_PLAN_APPROVED, result: { deny: 'no plans today' } as unknown as Json })
  expect(call).toMatchObject({ state: 'declined', refusal: 'no plans today', plan: PLAN })
})

test('planCall: a replayed approval reads the plan from the stored record, since the transcript keeps the arguments of the model', () => {
  const call = planCall(
    replayed({
      ...LIVE_PLAN_APPROVED,
      input: { tool: 'ExitPlanMode', tool_use_id: 'toolu_plan_2' } as unknown as Json,
    }),
  )
  expect(call).toMatchObject({ id: 'toolu_plan_2', state: 'answered', plan: PLAN, planFile: PLAN_FILE })
})

test('planCall: a teammate that awaits its leader has no outcome yet, so it is not a call', () => {
  const ev: ToolCallEvent = {
    ...LIVE_PLAN_APPROVED,
    result: { result: { plan: PLAN, isAgent: true, awaitingLeaderApproval: true, requestId: 'r1' } } as unknown as Json,
  }
  expect(planCall(ev)).toBeUndefined()
})

test('planCall: a call with no id is not a call', () => {
  expect(planCall({ tool: 'ExitPlanMode', input: {} as Json, result: {} as Json })).toBeUndefined()
})
