// The questions tracker through a LifecycleManager over fakePorts (issue #71): the capture of AskUserQuestion and ExitPlanMode
// calls, the turn, the caps, the replay without duplicates, `/clear` and `/resume`, `/track qa`, the copy key and the prompt
// lines. The parts it is made of have tests of their own (questions-parse, -log, -markdown, -sections, -prompt).
import { expect, test } from 'claude-code/testing'
import { NO_VIEW } from '../core/infra/views'
import type { ConfigService } from '../core/interfaces/config'
import type { ToolCallEvent } from '../core/interfaces/events'
import type { Json, JsonObject } from '../core/interfaces/items'
import type { Tracker } from '../core/interfaces/tracker'
import type { RowRef } from '../core/interfaces/view'
import { reasonSet } from '../core/lib/reasons'
import { questionsTracker } from '../trackers/questions'
import { asCalls } from '../trackers/questions/log'
import { callMarkdown } from '../trackers/questions/markdown'
import type { QuestionCall } from '../trackers/questions/types'
import { fakeConfig } from './fixtures/config-fs'
import { managerWorld } from './fixtures/manager'
import {
  ANSWERED_ASK,
  LIVE_ASK,
  LIVE_ESC,
  LIVE_PLAN_APPROVED,
  LIVE_PLAN_REJECTED,
  LIVE_QUESTIONS,
  messageOf,
  PLAN,
} from './fixtures/questions'

const NOW = 1_800_000_000_000

type Setup = {
  /** The config file: `{ trackers: { questions: { ... } } }`. */
  file?: JsonObject
  /** The config service itself, for a test that changes the file after the start. Wins over `file`. */
  config?: (specs: readonly Tracker[]) => ConfigService
  messages?: ReturnType<typeof messageOf>[]
  store?: Record<string, Json>
  session?: string
}

/**
 * A config that learns of an edit at the next `refresh()` only, as the real manager does when the file changes between two
 * checks: `edit` stages the new file, and a view reads the old one until the refresh.
 */
function lagging(specs: readonly Tracker[], file: JsonObject) {
  const cfg = fakeConfig({ specs, file })
  const real = cfg.refresh.bind(cfg)
  let staged: JsonObject | undefined
  return Object.assign(cfg, {
    edit: (next: JsonObject) => {
      staged = next
    },
    refresh: async () => {
      if (staged !== undefined) cfg.set(staged)
      staged = undefined
      return real()
    },
  })
}

const ref = (id: string): RowRef => ({
  id,
  owner: 'questions',
  group: 'list:questions',
  can: { dismiss: false, priority: false },
})

function setup(o: Setup = {}) {
  const t = managerWorld({
    trackers: () => [questionsTracker()],
    ...(o.config
      ? { config: o.config }
      : o.file
        ? { config: specs => fakeConfig({ specs, file: o.file as JsonObject }) }
        : {}),
    fake: {
      now: NOW,
      session: {
        cwd: '/work',
        ...(o.session ? { id: o.session } : {}),
        ...(o.messages ? { messages: o.messages } : {}),
      },
      ...(o.store ? { store: o.store } : {}),
    },
  })
  const calls = (): QuestionCall[] => asCalls(t.w.state.get('questions') as Json | undefined)
  const hear = (ev: ToolCallEvent) => t.m.toolCall(t.w.ports, ev)
  const start = (turnId: string) => t.m.turnStart(t.w.ports, { turnId, text: 'go' })
  const end = (turnId: string) =>
    t.m.turnComplete(t.w.ports, { input: { turnId, reason: 'answer', durationMs: 1, answer: '' } as Json })
  const qa = async (args = '') => (await t.m.track(t.w.ports, `qa ${args}`.trim())).text
  const begin = () => t.m.start(t.w.ports, { cwd: '/work', fromSessionStart: true })
  return { ...t, calls, hear, start, end, qa, begin }
}

// ---------------------------------------------------------------- capture

test('an AskUserQuestion call is kept word for word, with its number, the time of its sighting and the state', async () => {
  const t = setup()
  await t.hear(ANSWERED_ASK)
  const [call] = t.calls()
  expect(call).toMatchObject({ id: 'toolu_ask_2', n: 1, kind: 'ask', state: 'answered', at: NOW })
  expect(call?.items?.map(i => [i.question, i.header, i.multiSelect, i.answer, i.notes])).toEqual([
    ['Where should the records live?', 'Storage', false, 'State only', 'keep it simple'],
    ['Which checks should run?', 'Checks', true, 'Lint, E2E', undefined],
  ])
  expect(call?.items?.[0]?.options).toEqual(LIVE_QUESTIONS[0].options)
  expect(call?.items?.[0]?.preview).toBe('state.set(records)')
})

test('the live capture of the engine: notes with no option make a partial call; Esc a declined one', async () => {
  const t = setup()
  await t.hear(LIVE_ASK)
  await t.hear(LIVE_ESC)
  expect(t.calls().map(c => [c.n, c.state])).toEqual([
    [1, 'partial'],
    [2, 'declined'],
  ])
  expect(t.calls()[0]?.items?.[1]?.answer).toBe('Lint, "Tests, all", "typed, with comma"')
})

test('a call that carries the turn of its ledger: a call made in turn 2 says 2, and a call with no turn says none', async () => {
  const t = setup()
  await t.hear({ ...ANSWERED_ASK, toolUseId: 'before' })
  await t.start('turn-1')
  await t.end('turn-1')
  await t.start('turn-2')
  await t.hear({ ...ANSWERED_ASK, toolUseId: 'during' })
  await t.end('turn-2')
  expect(t.calls().map(c => [c.id, c.turn])).toEqual([
    ['before', undefined],
    ['during', 2],
  ])
})

test('a plugin that asks with $.ui.ask reaches the same hook, and its call says so', async () => {
  const t = setup()
  await t.hear({ ...ANSWERED_ASK, toolUseId: 'toolu_plugin_01x' })
  expect(t.calls()[0]).toMatchObject({ id: 'toolu_plugin_01x', plugin: true })
})

test('a plan the person approved and a plan the person rejected are kept, with the plan and the words of the person', async () => {
  const t = setup()
  await t.hear(LIVE_PLAN_APPROVED)
  await t.hear(LIVE_PLAN_REJECTED)
  expect(t.calls().map(c => [c.kind, c.state, c.plan])).toEqual([
    ['plan', 'answered', PLAN],
    ['plan', 'declined', PLAN],
  ])
  expect(t.calls()[1]?.refusal).toContain('the user said:\nUse fewer steps')
})

test('the id of a call is the key: the same call heard twice is one record', async () => {
  const t = setup()
  await t.hear(ANSWERED_ASK)
  await t.hear(ANSWERED_ASK)
  expect(t.calls()).toHaveLength(1)
})

test('a call that no question can be read from adds nothing, and a tool the tracker did not declare is not heard', async () => {
  const t = setup()
  await t.hear({ tool: 'AskUserQuestion', toolUseId: 'x', input: {} as Json, result: null as unknown as Json })
  await t.hear({ ...ANSWERED_ASK, tool: 'Read', toolUseId: 'y' })
  expect(t.calls()).toEqual([])
  expect(t.m.wants('AskUserQuestion')).toBe(true)
  expect(t.m.wants('ExitPlanMode')).toBe(true)
  expect(t.m.wants('Read')).toBe(false)
})

test('every call has the reason created, and the number goes on from the highest', async () => {
  const t = setup()
  await t.hear({ ...ANSWERED_ASK, toolUseId: 'a' })
  await t.hear({ ...ANSWERED_ASK, toolUseId: 'b' })
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  const rows = sections.find(s => s.id === 'questions')?.rows ?? []
  expect(rows.map(r => [r.id, r.reasons])).toEqual([
    ['b', reasonSet('created')],
    ['a', reasonSet('created')],
  ])
  expect(rows.map(r => r.cells.name?.text)).toEqual(['Q2', 'Q1'])
})

test('a tracker the config turned off keeps nothing', async () => {
  const t = setup({ file: { trackers: { questions: { enabled: false } } } })
  await t.m.entry(t.w.ports)
  await t.hear(ANSWERED_ASK)
  expect(t.calls()).toEqual([])
})

// ---------------------------------------------------------------- the caps

test('a session keeps at most the number of calls the config names, the oldest drop first, and the numbers stay', async () => {
  const t = setup({ file: { trackers: { questions: { maxCalls: 2 } } } })
  for (const id of ['a', 'b', 'c']) await t.hear({ ...ANSWERED_ASK, toolUseId: id })
  expect(t.calls().map(c => [c.id, c.n])).toEqual([
    ['b', 2],
    ['c', 3],
  ])
  expect(await t.qa('1')).toBe('No call 1. Calls kept: 2, 3.')
})

test('a session keeps at most the bytes the config names: the oldest drop first', async () => {
  const t = setup({ file: { trackers: { questions: { maxBytes: 8192 } } } })
  const big = (id: string): ToolCallEvent => ({
    ...ANSWERED_ASK,
    toolUseId: id,
    result: {
      result: {
        questions: LIVE_QUESTIONS,
        answers: { 'Where should the records live?': 'State only', 'Which checks should run?': 'Lint' },
        annotations: { 'Where should the records live?': { notes: 'n'.repeat(3000) } },
      },
    } as unknown as Json,
  })
  for (const id of ['a', 'b', 'c', 'd']) await t.hear(big(id))
  expect(JSON.stringify(t.calls()).length).toBeLessThanOrEqual(8192)
  expect(t.calls().at(-1)?.id).toBe('d')
  expect(t.calls().length).toBeLessThan(4)
})

test('a call cut to fit the byte cap keeps its sign of a question that asked for a secret: /track qa still masks the answer', async () => {
  const t = setup({ file: { trackers: { questions: { maxBytes: 8192 } } } })
  const questions = [
    {
      question: `${'x'.repeat(6000)} What is the password?`,
      header: 'Login',
      multiSelect: false,
      options: [{ label: 'A', preview: 'p'.repeat(60_000) }],
    },
  ]
  await t.hear({
    ...ANSWERED_ASK,
    toolUseId: 'huge',
    input: { questions } as unknown as Json,
    result: {
      result: {
        questions,
        answers: { [questions[0]!.question]: 'hunter2' },
        annotations: { [questions[0]!.question]: { notes: 'it is hunter2' } },
      },
    } as unknown as Json,
  })
  const [kept] = t.calls()
  expect(kept?.cut).toBe(true)
  expect(kept?.items?.[0]?.question).not.toMatch(/password/) // the cut took the words
  expect(JSON.stringify(kept)).toContain('hunter2') // the record is word for word as far as the cut allows
  const text = await t.qa('1')
  expect(text).not.toContain('hunter2')
  expect(text).toContain('Other (typed): [masked]')
})

test('the defaults are 100 calls and 256 KiB', () => {
  const tracker = questionsTracker()
  expect(tracker.config.defaults).toMatchObject({ maxCalls: 100, maxBytes: 262144, mask: true, enabled: true })
})

// ---------------------------------------------------------------- replay, /clear and /resume

test('a cold start with a transcript builds the calls from it, in order, and says they were read back', async () => {
  const t = setup({ messages: [messageOf(ANSWERED_ASK), messageOf(LIVE_ESC), messageOf(LIVE_PLAN_APPROVED)] })
  await t.begin()
  expect(t.calls().map(c => [c.n, c.id, c.state, c.replayed])).toEqual([
    [1, 'toolu_ask_2', 'answered', true],
    [2, 'toolu_ask_esc', 'declined', true],
    [3, 'toolu_plan_2', 'answered', true],
  ])
  expect(t.calls()[0]?.items?.[0]?.answer).toBe('State only')
  expect(t.calls()[2]?.plan).toBe(PLAN) // from the stored record: the transcript keeps the arguments of the model
})

test('a replay adds no call twice: the transcript read again, or a call that was heard live, stays one record', async () => {
  const t = setup({ messages: [messageOf(ANSWERED_ASK)] })
  await t.hear(ANSWERED_ASK)
  await t.m.replay()
  await t.m.replay()
  expect(t.calls()).toHaveLength(1)
  expect(t.calls()[0]).not.toHaveProperty('replayed') // the call that was seen live wins
})

test('a resume with a stored copy and the transcript: each call is one record, and the stored one keeps its turn and time', async () => {
  const stored: QuestionCall = {
    id: 'toolu_ask_2',
    n: 1,
    kind: 'ask',
    state: 'answered',
    at: 123,
    turn: 4,
    items: [
      {
        question: 'Where should the records live?',
        header: 'Storage',
        multiSelect: false,
        options: [],
        answer: 'State only',
      },
    ],
  }
  const t = setup({
    session: 'sess-b',
    store: { 'v2:s:sess-b': { questions: [stored] as unknown as Json }, 'v2:index': ['sess-b'] },
    messages: [messageOf(ANSWERED_ASK), messageOf(LIVE_ESC)],
  })
  await t.begin()
  expect(t.calls().map(c => [c.id, c.n, c.turn, c.at === 123, c.replayed])).toEqual([
    ['toolu_ask_2', 1, 4, true, undefined],
    ['toolu_ask_esc', 2, undefined, false, true],
  ])
})

// A stored copy that the cap cut: the transcript still holds the calls that the cap dropped. They stay dropped.
const keptCall = (id: string, n: number): QuestionCall => ({
  id,
  n,
  kind: 'ask',
  state: 'answered',
  at: 1,
  turn: n,
  items: [],
})
const resumeCapped = (ids: string[]) =>
  setup({
    file: { trackers: { questions: { maxCalls: 2 } } },
    session: 'sess-b',
    store: {
      'v2:s:sess-b': { questions: [keptCall('b', 2), keptCall('c', 3)] as unknown as Json },
      'v2:index': ['sess-b'],
    },
    messages: ids.map(id => messageOf({ ...ANSWERED_ASK, toolUseId: id })),
  })

test('a resume does not bring back the calls that the cap dropped, and keeps the newer ones', async () => {
  const t = resumeCapped(['a', 'b', 'c'])
  await t.begin()
  expect(t.calls().map(c => [c.id, c.n, c.replayed])).toEqual([
    ['b', 2, undefined],
    ['c', 3, undefined],
  ])
})

test('a resume adds a call that the transcript has after the stored ones, and drops the oldest by the cap', async () => {
  const t = resumeCapped(['a', 'b', 'c', 'd'])
  await t.begin()
  expect(t.calls().map(c => [c.id, c.n, c.replayed])).toEqual([
    ['c', 3, undefined],
    ['d', 4, true],
  ])
})

// The caps may leave only calls that the transcript lacks: the `$.ui.ask` of another plugin is not in it. None of their ids
// is in the transcript, so the ids alone cannot tell a copy that the caps cut from a copy that has seen no transcript. The
// first call that stays keeps the id of the newest transcript call that the caps dropped (its watermark), in the stored copy.
const PLUGIN_ID = (n: number) => `toolu_plugin_${n}`
const askOf = (id: string): ToolCallEvent => ({ ...ANSWERED_ASK, toolUseId: id })

/** A session that heard `heard` live and left with `/resume`, then a new load of its stored copy with `transcript`. */
async function resumedWith(maxCalls: number, heard: string[], transcript: string[]) {
  const file = { trackers: { questions: { maxCalls } } }
  const before = setup({ file, session: 'sess-b' })
  await before.m.entry(before.w.ports)
  for (const id of heard) await before.hear(askOf(id))
  await before.m.end(before.w.ports, 'resume', 1500)
  const t = setup({
    file,
    session: 'sess-b',
    store: Object.fromEntries(before.w.store),
    messages: transcript.map(id => messageOf(askOf(id))),
  })
  await t.begin()
  return t
}

test('a resume whose stored copy holds only plugin calls keeps them, and brings back none that the cap dropped', async () => {
  const t = await resumedWith(2, ['a', 'b', PLUGIN_ID(1), PLUGIN_ID(2)], ['a', 'b'])
  expect(t.calls().map(c => [c.id, c.n, c.replayed])).toEqual([
    [PLUGIN_ID(1), 3, undefined],
    [PLUGIN_ID(2), 4, undefined],
  ])
})

test('a resume whose stored copy holds only plugin calls adds the transcript calls that come after the dropped ones', async () => {
  const t = await resumedWith(3, ['a', 'b', 'c', PLUGIN_ID(1), PLUGIN_ID(2), PLUGIN_ID(3)], ['a', 'b', 'c', 'd'])
  expect(t.calls().map(c => [c.id, c.replayed])).toEqual([
    [PLUGIN_ID(2), undefined],
    [PLUGIN_ID(3), undefined],
    ['d', true],
  ])
})

test('a resume whose stored copy holds only the calls of a subagent keeps them, and brings back none that the cap dropped', async () => {
  const file = { trackers: { questions: { maxCalls: 1 } } }
  const before = setup({ file, session: 'sess-b' })
  await before.m.entry(before.w.ports)
  await before.hear(askOf('a'))
  await before.hear({ ...askOf('s'), agentId: 'agent-1' })
  await before.m.end(before.w.ports, 'resume', 1500)
  const t = setup({
    file,
    session: 'sess-b',
    store: Object.fromEntries(before.w.store),
    messages: [messageOf(askOf('a'))],
  })
  await t.begin()
  expect(t.calls().map(c => [c.id, c.agentId, c.replayed])).toEqual([['s', 'agent-1', undefined]])
})

test('a stored copy with no watermark and none of the transcript calls cannot tell what the cap dropped: the resume reads all back', async () => {
  const t = setup({
    session: 'sess-b',
    store: {
      'v2:s:sess-b': { questions: [{ ...keptCall(PLUGIN_ID(1), 1), plugin: true }] as unknown as Json },
      'v2:index': ['sess-b'],
    },
    messages: ['x', 'y'].map(id => messageOf(askOf(id))),
  })
  await t.begin()
  expect(t.calls().map(c => [c.id, c.n, c.replayed])).toEqual([
    [PLUGIN_ID(1), 1, undefined],
    ['x', 2, true],
    ['y', 3, true],
  ])
})

test('a watermark that this transcript lacks (the copy came over /clear) reads every call of the new transcript back', async () => {
  const t = setup({
    session: 'sess-b',
    store: {
      'v2:s:sess-b': {
        questions: [{ ...keptCall(PLUGIN_ID(1), 4), plugin: true, watermark: 'of-the-old-session' }] as unknown as Json,
      },
      'v2:index': ['sess-b'],
    },
    messages: ['x', 'y'].map(id => messageOf(askOf(id))),
  })
  await t.begin()
  expect(t.calls().map(c => [c.id, c.replayed])).toEqual([
    [PLUGIN_ID(1), undefined],
    ['x', true],
    ['y', true],
  ])
})

test('/clear carries the calls over, and the next call goes on from their numbers', async () => {
  const t = setup()
  await t.m.entry(t.w.ports) // learns sess-1
  await t.hear({ ...ANSWERED_ASK, toolUseId: 'a' })
  await t.hear({ ...ANSWERED_ASK, toolUseId: 'b' })
  await t.m.end(t.w.ports, 'clear', 1500)
  expect(t.w.store.get('v2:s:sess-1')).toMatchObject({ questions: [{ id: 'a' }, { id: 'b' }] })
  t.w.state.delete('questions') // the engine resets the state of the new session
  t.w.session.id = 'sess-2'
  await t.m.entry(t.w.ports)
  expect(t.calls().map(c => [c.id, c.n])).toEqual([
    ['a', 1],
    ['b', 2],
  ])
  await t.hear({ ...ANSWERED_ASK, toolUseId: 'c' })
  expect(t.calls().map(c => c.n)).toEqual([1, 2, 3])
})

test('/track clear empties the calls', async () => {
  const t = setup()
  await t.hear(ANSWERED_ASK)
  await t.m.track(t.w.ports, 'clear')
  expect(t.calls()).toEqual([])
})

test('the calls are in the stored copy of the session, which holds nothing else of this tracker', async () => {
  const t = setup()
  await t.m.entry(t.w.ports)
  await t.hear(ANSWERED_ASK)
  await t.m.end(t.w.ports, 'resume', 1500)
  const copy = t.w.store.get('v2:s:sess-1') as { questions?: QuestionCall[] }
  expect(copy.questions?.map(c => c.id)).toEqual(['toolu_ask_2'])
})

// ---------------------------------------------------------------- /track qa

test('/track qa prints every call as Markdown, and /track qa n one call, masked by default', async () => {
  const t = setup()
  await t.hear({ ...ANSWERED_ASK, toolUseId: 'a' })
  await t.hear({ ...LIVE_ESC, toolUseId: 'b' })
  const all = await t.qa()
  expect(all.startsWith('# Questions and answers\n\n## Q1 · answered')).toBe(true)
  expect(all).toContain('\n\n## Q2 · declined')
  expect(await t.qa('2')).toBe(callMarkdown(t.calls()[1]!, true))
  expect(await t.qa('3')).toBe('No call 3. Calls kept: 1, 2.')
  expect(await t.qa('x')).toBe('Usage: /track qa [n]')
  expect(t.w.ui.opened).toBe(0) // no pane, no list
})

test('/track qa with no call says so', async () => {
  const t = setup()
  expect(await t.qa()).toBe('No questions asked in this session.')
})

const KEY = `ghp_${'a1b2c3d4e5'.repeat(4)}`
const secretCall = (): ToolCallEvent => ({
  ...ANSWERED_ASK,
  result: {
    result: {
      questions: LIVE_QUESTIONS,
      answers: { 'Where should the records live?': `in ${KEY}`, 'Which checks should run?': 'Lint' },
    },
  } as unknown as Json,
})

test('a secret in a typed answer is stored word for word and masked in /track qa; the config toggle shows it', async () => {
  const masked = setup()
  await masked.hear(secretCall())
  expect(JSON.stringify(masked.calls())).toContain(KEY) // stored verbatim
  expect(await masked.qa()).not.toContain(KEY)
  expect(await masked.qa()).toContain('[masked]')
  const open = setup({ file: { trackers: { questions: { mask: false } } } })
  await open.hear(secretCall())
  expect(await open.qa()).toContain(KEY)
})

test('/track holds no question, answer or note in any view the person chose: the model reads that reply', async () => {
  const t = setup()
  await t.hear(ANSWERED_ASK)
  await t.hear(LIVE_ESC)
  for (const view of ['list', 'tracker', 'status', 'reason', 'flat']) {
    const text = (await t.m.track(t.w.ports, `view ${view}`)).text
    for (const word of ['Where should', 'State only', 'Lint', 'keep it simple', 'Storage', 'Ship it', 'Declined'])
      expect(text, `${view}: ${word}`).not.toContain(word)
  }
  // The rows are still in the pane: only the text keeps them out.
  const rows = (await t.m.paneData(t.w.ports, NO_VIEW)).find(s => s.id === 'questions')?.rows ?? []
  expect(rows).toHaveLength(2)
})

test('/track qa checks the config file first: a mask switched on a moment ago masks the export at once', async () => {
  let cfg: ReturnType<typeof lagging> | undefined
  const t = setup({ config: specs => (cfg = lagging(specs, { trackers: { questions: { mask: false } } })) })
  await t.hear(secretCall())
  expect(await t.qa('1')).toContain(KEY) // masking is off in the file
  cfg?.edit({ trackers: { questions: { mask: true } } }) // no tick has run since
  const after = await t.qa('1')
  expect(after).not.toContain(KEY)
  expect(after).toContain('[masked]')
  cfg?.edit({ trackers: { questions: { mask: false } } })
  expect(await t.qa('1')).toContain(KEY) // and the other way round
})

// ---------------------------------------------------------------- the copy key

test('the copy key is declared on the letter y, and no key is taken', async () => {
  const t = setup()
  await t.begin()
  expect(questionsTracker().keys).toEqual([{ id: 'copy', key: 'y', label: 'copy', scope: 'row' }])
  expect(t.m.problems()).toEqual([])
  expect(t.m.keys.get('questions.copy')).toMatchObject({ key: 'y', owner: 'questions', scope: 'row' })
})

const footer = async (t: ReturnType<typeof setup>, id: string) =>
  Object.fromEntries((await t.m.footer(t.w.ports, ref(id), false)).map(k => [k.buttonKey, k.enabled]))

test('the copy key works on the row of a call and on the row of one of its questions, and on no other row', async () => {
  const t = setup()
  await t.begin()
  await t.hear(ANSWERED_ASK)
  expect(await footer(t, 'toolu_ask_2')).toMatchObject({ 'questions.copy': true })
  expect(await footer(t, 'toolu_ask_2:1')).toMatchObject({ 'questions.copy': true })
  expect(await footer(t, 'toolu_other')).toMatchObject({ 'questions.copy': false })
})

test('a press puts the Markdown of the selected call on the clipboard and says so', async () => {
  const t = setup()
  await t.begin()
  await t.hear(ANSWERED_ASK)
  await t.m.runAction(t.w.ports, 'questions', 'copy', 'toolu_ask_2:0')
  expect(t.w.ui.copied).toEqual([callMarkdown(t.calls()[0]!, true)])
  expect(t.w.ui.toasts).toEqual(['Copied Q1 as Markdown'])
})

test('a press copies the masked text, and the unmasked text when the config says so', async () => {
  const masked = setup()
  await masked.begin()
  await masked.hear(secretCall())
  await masked.m.runAction(masked.w.ports, 'questions', 'copy', 'toolu_ask_2')
  expect(masked.w.ui.copied[0]).not.toContain(KEY)
  const open = setup({ file: { trackers: { questions: { mask: false } } } })
  await open.begin()
  await open.hear(secretCall())
  await open.m.runAction(open.w.ports, 'questions', 'copy', 'toolu_ask_2')
  expect(open.w.ui.copied[0]).toContain(KEY)
})

test('a copy that the surface refuses says why, and a copy call that throws says so too', async () => {
  const t = setup()
  await t.begin()
  await t.hear(ANSWERED_ASK)
  t.w.ui.copyResult = { isCopied: false, reason: 'no-clipboard' }
  await t.m.runAction(t.w.ports, 'questions', 'copy', 'toolu_ask_2')
  expect(t.w.ui.toasts).toEqual(['Copy failed: no-clipboard'])
  t.w.ports.ui.copy = async () => {
    throw new Error('engine said no')
  }
  await t.m.runAction(t.w.ports, 'questions', 'copy', 'toolu_ask_2')
  expect(t.w.ui.toasts.at(-1)).toBe('Copy failed: engine said no')
})

test('a press with no call selected copies nothing and tells the person', async () => {
  const t = setup()
  await t.begin()
  await t.m.runAction(t.w.ports, 'questions', 'copy', null)
  expect(t.w.ui.copied).toEqual([])
  expect(t.w.ui.toasts).toEqual(['Select a question to copy it'])
})

// ---------------------------------------------------------------- the prompt lines

test('the model reads nothing of the calls until the person turns the prompt lines on', async () => {
  const t = setup()
  await t.begin()
  await t.hear(ANSWERED_ASK)
  await t.start('turn-1')
  await t.end('turn-1')
  expect(t.m.compose({ traits: [] }, [])).toEqual([])
})

test('with the prompt lines on, a line holds the headers and the chosen labels and no typed text or note', async () => {
  const t = setup({ file: { trackers: { questions: { prompt: { enabled: true } } } } })
  await t.begin()
  await t.hear({
    ...ANSWERED_ASK,
    result: {
      result: {
        questions: LIVE_QUESTIONS,
        answers: { 'Where should the records live?': 'hunter2-typed', 'Which checks should run?': 'Lint' },
        annotations: { 'Where should the records live?': { notes: 'private note' } },
      },
    } as unknown as Json,
  })
  await t.start('turn-1')
  await t.end('turn-1')
  const text = t.m.compose({ traits: [] }, []).at(-1)?.text ?? ''
  expect(text).toContain('question: Q1 (answered) "Storage: typed answer; Checks: Lint"')
  for (const hidden of ['hunter2-typed', 'private note', 'Where should the records live?'])
    expect(text).not.toContain(hidden)
})
