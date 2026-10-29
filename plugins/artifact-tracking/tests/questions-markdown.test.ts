// The Markdown of a call (issue #71): what `/track qa` prints and the copy key puts on the clipboard. Word for word, with the
// chosen option marked, typed text tagged, and secrets masked unless masking is off. Pure.
import { expect, test } from 'claude-code/testing'
import { capCalls } from '../trackers/questions/log'
import {
  callMarkdown,
  QA_USAGE,
  qaMarkdown,
  qaScreen,
  qaStub,
  qaText,
  SCREEN_LIMIT,
  stubRange,
} from '../trackers/questions/markdown'
import { askCall, planCall } from '../trackers/questions/parse'
import { answerText, masker, shownItem } from '../trackers/questions/present'
import { MASKED } from '../trackers/questions/secrets'
import type { QuestionCall, QuestionItem } from '../trackers/questions/types'
import { LIVE_ASK, LIVE_PLAN_REJECTED, PLAN, PLAN_FILE } from './fixtures/questions'
import { expectLinear } from './fixtures/scaling'

const AT = Date.UTC(2026, 9, 21, 21, 41)
const stamped = (
  body: NonNullable<ReturnType<typeof askCall>>,
  n: number,
  over: Partial<QuestionCall> = {},
): QuestionCall => ({
  ...body,
  n,
  at: AT,
  ...over,
})
const item = (over: Partial<QuestionItem> = {}): QuestionItem => ({
  question: 'Where should the records live?',
  header: 'Storage',
  multiSelect: false,
  options: [
    { label: 'State only', description: 'Keep them in the plugin state.', preview: 'state.set(records)' },
    { label: 'State and store' },
  ],
  answer: 'State only',
  ...over,
})
const callOf = (items: QuestionItem[], over: Partial<QuestionCall> = {}): QuestionCall => ({
  id: 'toolu_1',
  n: 3,
  kind: 'ask',
  state: 'answered',
  at: AT,
  turn: 7,
  items,
  ...over,
})

test('one answered question: the heading, the question, every option with its description and preview, the pick marked', () => {
  expect(callMarkdown(callOf([item({ notes: 'keep it simple' })]), true)).toBe(
    [
      '## Q3 · turn 7 · answered · 2026-10-21 21:41 UTC',
      '',
      '### Storage',
      '',
      'Where should the records live?',
      '',
      '- [x] **State only**: Keep them in the plugin state.',
      '  ```',
      '  state.set(records)',
      '  ```',
      '- [ ] **State and store**',
      '',
      '> Notes: keep it simple',
    ].join('\n'),
  )
})

test('typed text is tagged as typed, and a multi-select marks each label it holds', () => {
  const q = item({
    multiSelect: true,
    options: [{ label: 'Lint' }, { label: 'Tests, all' }, { label: 'E2E' }],
    answer: 'Lint, "Tests, all", "typed, with comma"',
  })
  const md = callMarkdown(callOf([q]), true)
  expect(md).toContain('- [x] **Lint**\n- [x] **Tests, all**\n- [ ] **E2E**\n- [x] Other (typed): typed, with comma')
})

test('a blank question says so, and notes with no option say so', () => {
  const blank = callMarkdown(callOf([item({ answer: undefined })], { state: 'partial' }), true)
  expect(blank).toContain('_Left blank._')
  expect(blank).not.toContain('[x]')
  const notes = callMarkdown(callOf([item({ answer: '(notes only)', notes: 'maybe' })], { state: 'partial' }), true)
  expect(notes).toContain('_Notes only, no option picked._')
  expect(notes).toContain('> Notes: maybe')
})

test('a text with several lines keeps them: a typed answer under its item, notes as a quote', () => {
  const q = item({ multiSelect: true, options: [{ label: 'A' }], answer: '"one\ntwo"', notes: 'n1\nn2' })
  // The engine quotes a piece only for a comma, but a piece that is no label is typed text whatever it holds.
  const md = callMarkdown(callOf([q]), true)
  expect(md).toContain('- [x] Other (typed): one\n  two')
  expect(md).toContain('> Notes: n1\n> n2')
})

test('a fence is longer than any run of backticks that the text holds', () => {
  const q = item({ options: [{ label: 'A', preview: 'before\n```ts\ncode\n```\nafter' }], answer: 'A' })
  const md = callMarkdown(callOf([q]), true)
  expect(md).toContain('  ````\n  before\n  ```ts\n  code\n  ```\n  after\n  ````')
})

test('a declined call quotes the words of the engine, and a call with no header uses the number of the question', () => {
  const md = callMarkdown(
    callOf([item({ header: '', answer: undefined })], {
      state: 'declined',
      refusal: "The user doesn't want to proceed.\nStop.",
    }),
    true,
  )
  expect(md).toContain('## Q3 · turn 7 · declined')
  expect(md).toContain('### Question 1')
  expect(md).toContain("> Declined: The user doesn't want to proceed.\n> Stop.")
})

test('the follow-up, the response and the AFK answer are told', () => {
  const md = callMarkdown(
    callOf([item({ answer: undefined })], {
      state: 'partial',
      followUp: true,
      response: 'Let us talk',
      afkTimeoutMs: 90_000,
    }),
    true,
  )
  expect(md).toContain('_The person asked for another round._')
  expect(md).toContain('> Response: Let us talk')
  expect(md).toContain('_The dialog answered itself after 90 s with nobody there._')
})

test('the heading names a plugin, an agent, a replay and a cut; a replayed call has no time', () => {
  const md = callMarkdown(
    callOf([item()], { plugin: true, agentId: 'agent-1', replayed: true, cut: true, turn: undefined }),
    true,
  )
  expect(md.split('\n')[0]).toBe('## Q3 · answered · asked by a plugin · agent agent-1 · texts cut to fit')
})

test('an approved plan: the plan in a fence. A rejected one: the plan and the words of the person', () => {
  const approved = planCall({ ...LIVE_PLAN_REJECTED, result: { result: { plan: PLAN } } as never })
  const md = callMarkdown(stamped(approved!, 4, { turn: 2 }), true)
  // The file of the plan follows the plan, as the pane tells it (the input names it: the result here has none).
  expect(md).toBe(
    `## Q4 · turn 2 · plan approved · 2026-10-21 21:41 UTC\n\n\`\`\`\n${PLAN.trimEnd()}\n\`\`\`\n\nFile: ${PLAN_FILE}`,
  )
  const rejected = callMarkdown(stamped(planCall(LIVE_PLAN_REJECTED)!, 5), true)
  expect(rejected).toContain('plan rejected')
  expect(rejected).toContain('```\n# Plan')
  // The words are the structured error, so they keep the engine's own `Error:` mark (the display text has none).
  expect(rejected).toContain("> Rejected: Error: The user doesn't want to proceed")
  expect(rejected).toContain('the user said:\n> Use fewer steps')
})

test('the plan file is in the export like in the pane: masked by default, as it is, with no file no line', () => {
  const file = '/plans/password=hunter2/plan.md'
  const withFile = callOf([], { kind: 'plan', plan: PLAN, planFile: file })
  const masked = callMarkdown(withFile, true)
  expect(masked).toContain(`File: /plans/password=${MASKED}`)
  expect(masked).not.toContain('hunter2')
  expect(callMarkdown(withFile, false)).toContain(`File: ${file}`)
  expect(callMarkdown(callOf([], { kind: 'plan', plan: PLAN }), true)).not.toContain('File:')
  // A plan with no text still names its file, and a rejected one tells the file before the words of the person.
  const bare = callMarkdown(callOf([], { kind: 'plan', planFile: file }), false)
  expect(bare).toContain(`_The engine gave no plan text._\n\nFile: ${file}`)
  const refused = callMarkdown(
    callOf([], { kind: 'plan', state: 'declined', plan: PLAN, planFile: file, refusal: 'No.' }),
    false,
  )
  expect(refused.indexOf('File:')).toBeLessThan(refused.indexOf('> Rejected: No.'))
})

// ---------------------------------------------------------------- masking

const KEY = `ghp_${'a1b2c3d4e5'.repeat(4)}`

test('a secret in any text is masked by default, and shows when masking is off', () => {
  const q = item({ options: [{ label: 'A', preview: `export TOKEN=${KEY}` }], answer: 'A', notes: `use ${KEY}` })
  const masked = callMarkdown(callOf([q]), true)
  expect(masked).not.toContain(KEY)
  expect(masked).toContain(`> Notes: use ${MASKED}`)
  expect(masked).toContain(`TOKEN=${MASKED}`)
  expect(callMarkdown(callOf([q]), false)).toContain(`> Notes: use ${KEY}`)
})

test('the typed answer and the notes of a question that asks for a password are masked whole', () => {
  const q = item({
    question: 'What is the database password?',
    header: 'Login',
    options: [{ label: 'A' }],
    answer: 'hunter2',
    notes: 'it is hunter2',
  })
  const md = callMarkdown(callOf([q]), true)
  expect(md).not.toContain('hunter2')
  expect(md).toContain(`- [x] Other (typed): ${MASKED}`)
  expect(md).toContain(`> Notes: ${MASKED}`)
  expect(callMarkdown(callOf([q]), false)).toContain('hunter2')
})

test('the freeform response of a call with a question that asks for a secret is masked whole, and a call with none keeps it', () => {
  const asks = callOf([item({ question: 'What is the password?', header: 'Login', options: [], answer: 'x' })], {
    response: 'it is hunter2',
  })
  const md = callMarkdown(asks, true)
  expect(md).not.toContain('hunter2')
  expect(md).toContain(`> Response: ${MASKED}`)
  expect(callMarkdown(asks, false)).toContain('> Response: it is hunter2')
  expect(callMarkdown(callOf([item()], { response: 'it is hunter2' }), true)).toContain('> Response: it is hunter2')
  // The mark that a cut leaves says it too, when the words are gone.
  const cut = callOf([item({ sensitive: true })], { response: 'it is hunter2' })
  expect(callMarkdown(cut, true)).toContain(`> Response: ${MASKED}`)
  // An empty response stays empty: there is nothing to hide, and the line does not say [masked].
  const empty = callMarkdown(callOf([item({ sensitive: true })], { response: '' }), true)
  expect(empty).toContain('> Response:')
  expect(empty).not.toContain(MASKED)
})

test('a text question and a number question tell their control: the placeholder and the range, as the engine gave them', () => {
  const text = item({ kind: 'text', options: [], answer: 'Ada', placeholder: 'e.g. Ada' })
  const number = item({
    kind: 'number',
    options: [],
    answer: '4',
    min: 1,
    max: 10,
    step: 0.5,
    defaultValue: 0,
    unit: 'px',
  })
  const md = callMarkdown(callOf([text, number]), true)
  expect(md).toContain('Placeholder: e.g. Ada')
  expect(md).toContain('Min: 1 · Max: 10 · Step: 0.5 · Default: 0 · Unit: px')
  // A question with none of them says nothing of it, and a part that is absent is left out.
  expect(callMarkdown(callOf([item()]), true)).not.toMatch(/Placeholder|Min:|Unit:/)
  expect(callMarkdown(callOf([item({ kind: 'number', options: [], answer: '3', max: 5 })]), true)).toContain('Max: 5\n')
})

test('the placeholder goes through the mask like the question: a secret in it never shows by default', () => {
  const q = item({ kind: 'text', options: [], answer: 'x', placeholder: `token ${KEY}` })
  expect(callMarkdown(callOf([q]), true)).not.toContain(KEY)
  expect(callMarkdown(callOf([q]), false)).toContain(KEY)
})

test('the helper text of a question counts when it asks for a secret: the typed answer and the notes are masked whole', () => {
  const q = item({
    question: 'Enter the value?',
    header: 'Value',
    description: 'Production password',
    options: [],
    answer: 'hunter2',
    notes: 'it is hunter2',
  })
  const md = callMarkdown(callOf([q]), true)
  expect(md).not.toContain('hunter2')
  expect(md).toContain(`- [x] Other (typed): ${MASKED}`)
  expect(callMarkdown(callOf([{ ...q, description: 'The value' }]), true)).toContain('hunter2')
})

test('an item that the byte cut marked sensitive masks its typed answer and its notes whole, whatever its words say now', () => {
  const q = item({
    question: 'Which one?',
    header: 'Pick',
    options: [{ label: 'A' }],
    answer: 'hunter2',
    notes: 'it is hunter2',
  })
  const open = callMarkdown(callOf([q]), true)
  expect(open).toContain('hunter2') // nothing in the words asks for a secret
  const marked = callMarkdown(callOf([{ ...q, sensitive: true }]), true)
  expect(marked).not.toContain('hunter2')
  expect(marked).toContain(`- [x] Other (typed): ${MASKED}`)
  expect(marked).toContain(`> Notes: ${MASKED}`)
  expect(callMarkdown(callOf([{ ...q, sensitive: true }]), false)).toContain('hunter2') // the config toggle still shows it
})

test('a call that was cut and asked for a secret before the cut masks the answer in the export', () => {
  const long = (question: string): QuestionCall =>
    callOf(
      [
        item({
          question,
          header: 'Login',
          options: [{ label: 'A', preview: 'p'.repeat(100_000) }],
          answer: 'hunter2',
          notes: 'it is hunter2',
        }),
      ],
      { id: 'huge' },
    )
  const [kept] = capCalls([long(`${'x'.repeat(400)} What is the password?`)], { maxCalls: 100, maxBytes: 1000 })
  expect(kept?.cut).toBe(true)
  const md = callMarkdown(kept!, true)
  expect(md).not.toContain('hunter2')
  expect(md).toContain(`- [x] Other (typed): ${MASKED}`)
})

// The byte cut halves the limit until the call fits, so the cut can fall anywhere in a text. A cut inside a token leaves a
// prefix that is shorter than any pattern needs, so the mask would not know it. The cut stops before the secret instead.
const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}` // 44 characters
/** One question whose answer is the longest text, built so that half of it falls `into` characters into the secret. */
const cutCall = (head: string, secret: string, into: number): QuestionCall => {
  const front = 'w'.repeat(600)
  const L = 2 * (front.length + head.length + into) // twice the position of the cut, the first halving of the limit
  const tail = 'x'.repeat(L - (front.length + head.length + secret.length) - 1)
  return callOf(
    [
      item({
        question: 'Which one?',
        header: 'Pick',
        options: [{ label: 'A' }],
        answer: `${front}${head}${secret} ${tail}`,
      }),
    ],
    { id: 'cut' },
  )
}

test('a token that the limit falls in is dropped whole, and no part of it shows with masking on', () => {
  const [kept] = capCalls([cutCall(' ', TOKEN, 10)], { maxCalls: 100, maxBytes: 1000 })
  expect(kept?.cut).toBe(true)
  expect(kept?.items?.[0]?.answer?.startsWith('w'.repeat(600))).toBe(true) // the text before the secret stays
  expect(kept?.items?.[0]?.answer).not.toContain('ghp_')
  expect(callMarkdown(kept!, true)).not.toContain('ghp_')
})

test('so is the value of a named secret: the name goes with it', () => {
  const [kept] = capCalls([cutCall(' ', 'DB_PASSWORD=hunter2hunter2hunter2', 14)], { maxCalls: 100, maxBytes: 1000 })
  expect(kept?.cut).toBe(true)
  expect(kept?.items?.[0]?.answer).not.toMatch(/PASSWORD|hunter/)
  expect(callMarkdown(kept!, true)).not.toMatch(/PASSWORD|hunter/)
})

test('a secret that ends before the cut stays whole, and the mask still knows it', () => {
  const [kept] = capCalls([cutCall(' ', TOKEN, 60)], { maxCalls: 100, maxBytes: 1000 })
  expect(kept?.items?.[0]?.answer).toContain(TOKEN)
  expect(callMarkdown(kept!, true)).not.toContain(TOKEN)
  expect(callMarkdown(kept!, true)).toContain(MASKED)
})

test('answerText: labels, then typed text tagged, and the words for blank and notes only', () => {
  const m = masker(true)
  const multi = item({ multiSelect: true, options: [{ label: 'A' }, { label: 'B' }], answer: 'A, free' })
  expect(answerText(shownItem(multi, m))).toBe('A, typed: free')
  expect(answerText(shownItem(item({ answer: undefined }), m))).toBe('(blank)')
  expect(answerText(shownItem(item({ answer: '(notes only)' }), m))).toBe('(notes only)')
})

// ---------------------------------------------------------------- the list and one call

test('qaMarkdown: a title, then the calls in order, one blank line between them', () => {
  const calls = [stamped(askCall(LIVE_ASK)!, 1, { turn: 7 }), callOf([item()], { n: 2, id: 'toolu_2' })]
  const md = qaMarkdown(calls, true)
  expect(md.startsWith('# Questions and answers\n\n## Q1 · turn 7 · partial')).toBe(true)
  expect(md).toContain('\n\n## Q2 · turn 7 · answered')
})

test('qaText: no argument is the list, a number is one call without the title, and a wrong word is the usage', () => {
  const calls = [callOf([item()], { n: 1, id: 'a' }), callOf([item()], { n: 4, id: 'b' })]
  // The reply starts with one line break: the engine puts `<plugin>: ` in front, and a title that follows on the same line
  // draws a literal `#` (issue #246, R6). The whole list and one call have it; `qaMarkdown` and `callMarkdown` do not.
  expect(qaText(calls, '', true)).toBe(`\n${qaMarkdown(calls, true)}`)
  expect(qaText(calls, '4', true)).toBe(`\n${callMarkdown(calls[1]!, true)}`)
  expect(qaText(calls, ' 4 ', true)).toBe(`\n${callMarkdown(calls[1]!, true)}`)
  expect(qaText(calls, '2', true)).toBe('No call 2. Calls kept: 1, 4.')
  expect(qaText(calls, 'x', true)).toBe(QA_USAGE)
  expect(qaText(calls, '1 2', true)).toBe(QA_USAGE)
  expect(qaText(calls, '0', true)).toBe(QA_USAGE)
  expect(qaText([], '', true)).toBe('No questions asked in this session.')
  expect(qaText([], '3', true)).toBe('No questions asked in this session.')
})

test('the shared Markdown has no leading line break: the copy key puts it on the clipboard as it is', () => {
  const calls = [callOf([item()], { n: 1, id: 'a' })]
  expect(qaMarkdown(calls, true).startsWith('# Questions and answers')).toBe(true)
  expect(callMarkdown(calls[0]!, true).startsWith('## Q1')).toBe(true)
})

test('the usage line names --send: /track qa [--send] [n]', () => {
  expect(QA_USAGE).toBe('Usage: /track qa [--send] [n]')
})

// ---------------------------------------------------------------- the stub and the screen text (issue #246)

const many = (...ns: number[]): QuestionCall[] => ns.map(n => callOf([item()], { n, id: `id-${n}` }))

test('qaStub: the range of the calls, the count, and the way to send them', () => {
  const calls = many(1, 2, 3, 4, 5, 6, 7)
  expect(qaStub(calls, '')).toBe(
    'Questions and answers Q1–Q7 (7 calls): drawn on the screen only. /track qa --send puts them in the context of the model.',
  )
  expect(qaStub(calls, '3')).toBe(
    'Questions and answers Q3 (1 call): drawn on the screen only. /track qa --send 3 puts it in the context of the model.',
  )
  expect(qaStub(many(2), '')).toBe(
    'Questions and answers Q2 (1 call): drawn on the screen only. /track qa --send 2 puts it in the context of the model.',
  )
  // A range of calls that the caps cut at the front: the numbers stay, and the count is what the list holds.
  expect(qaStub(many(5, 6, 9), ' ')).toContain('Questions and answers Q5–Q9 (3 calls):')
})

test('qaStub: the plain replies stay plain, so there is no stub for them', () => {
  const calls = many(1, 2)
  expect(qaStub(calls, 'x')).toBeUndefined() // the usage line
  expect(qaStub(calls, '0')).toBeUndefined()
  expect(qaStub(calls, '1 2')).toBeUndefined()
  expect(qaStub([], '')).toBeUndefined() // no questions asked
  expect(qaStub([], '3')).toBeUndefined()
  expect(qaStub(calls, '9')).toBeUndefined() // no call 9
})

test('the stub holds no word of a question, an option, an answer or a note', () => {
  const secret = item({ question: 'Where is SECRETQ?', answer: 'SECRETA', notes: 'SECRETN' })
  const stub = qaStub([callOf([secret], { n: 1 })], '') ?? ''
  for (const word of ['SECRETQ', 'SECRETA', 'SECRETN', 'Storage', 'State only']) expect(stub).not.toContain(word)
})

test('stubRange reads the range back, behind the prefix of one plugin or of two', () => {
  const stub = qaStub(many(1, 2, 3, 4, 5, 6, 7), '')!
  expect(stubRange(stub)).toEqual({ from: 1, to: 7 })
  expect(stubRange(`artifact-tracking: ${stub}`)).toEqual({ from: 1, to: 7 })
  expect(stubRange(`a: b: ${stub}`)).toEqual({ from: 1, to: 7 })
  const one = qaStub(many(3), '')!
  expect(stubRange(`artifact-tracking: ${one}`)).toEqual({ from: 3, to: 3 })
})

test('stubRange: a text with no stub, and a range that runs backwards, are no range', () => {
  expect(stubRange('')).toBeUndefined()
  expect(stubRange('artifact-tracking: \n# Questions and answers\n\n## Q1 · answered')).toBeUndefined() // the whole text
  expect(stubRange('Usage: /track qa [--send] [n]')).toBeUndefined()
  expect(stubRange('Questions and answers Q7–Q2 (3 calls): drawn on the screen only.')).toBeUndefined()
})

test('qaScreen draws exactly the range of the stub, with the title for the whole list', () => {
  const calls = many(1, 2, 3, 4)
  const drawn = qaScreen(calls, { from: 2, to: 3 }, true, true)!
  expect(drawn).toBe(qaMarkdown(calls.slice(1, 3), true)) // no line break in front: the rewrite replaces the whole drawn text
  expect(drawn).toContain('## Q2 ')
  expect(drawn).toContain('## Q3 ')
  expect(drawn).not.toContain('## Q1 ')
  expect(drawn).not.toContain('## Q4 ') // a call that came after the stub is not in the old row
})

test('qaScreen of one call has no title, and a call over a range of one is that call', () => {
  const calls = many(1, 2, 3)
  expect(qaScreen(calls, { from: 2, to: 2 }, false, true)).toBe(callMarkdown(calls[1]!, true))
})

test('qaScreen: a call that the caps dropped since the stub gets one line, in its place', () => {
  const calls = many(3, 4, 5) // Q1 and Q2 went
  const drawn = qaScreen(calls, { from: 1, to: 5 }, true, true)!
  expect(drawn).toContain('_Q1–Q2 are no longer kept._')
  expect(drawn.indexOf('Q1–Q2')).toBeLessThan(drawn.indexOf('## Q3 '))
  expect(qaScreen(many(1, 2, 5), { from: 1, to: 5 }, true, true)).toContain('_Q3–Q4 are no longer kept._')
  expect(qaScreen(many(1, 3), { from: 1, to: 3 }, true, true)).toContain('_Q2 is no longer kept._')
})

test('qaScreen: no call of the range in the list is nothing to draw (the slot has not loaded yet)', () => {
  expect(qaScreen([], { from: 1, to: 3 }, true, true)).toBeUndefined()
  expect(qaScreen(many(8, 9), { from: 1, to: 3 }, true, true)).toBeUndefined()
})

test('qaScreen masks a secret unless the config turns the mask off, as the whole text does', () => {
  const KEY = `ghp_${'a1b2c3d4e5'.repeat(4)}`
  const calls = [callOf([item({ answer: `in ${KEY}` })], { n: 1 })]
  expect(qaScreen(calls, { from: 1, to: 1 }, true, true)).not.toContain(KEY)
  expect(qaScreen(calls, { from: 1, to: 1 }, true, true)).toContain(MASKED)
  expect(qaScreen(calls, { from: 1, to: 1 }, true, false)).toContain(KEY)
})

/** Calls that are each about `chars` characters long in Markdown: a long preview does it. */
const bulky = (ns: number[], chars: number): QuestionCall[] =>
  ns.map(n =>
    callOf([item({ options: [{ label: 'A', preview: 'x'.repeat(chars) }], answer: 'A' })], { n, id: `id-${n}` }),
  )

test('qaScreen past the limit of the row: the newest whole calls stay and the others are named', () => {
  const calls = bulky([1, 2, 3, 4, 5], 30_000) // about 150 000 characters
  const drawn = qaScreen(calls, { from: 1, to: 5 }, true, true)!
  expect(drawn.length).toBeLessThanOrEqual(SCREEN_LIMIT)
  expect(drawn.split('\n')[0]).toBe('Q1–Q2 left out to fit. /track qa 1 draws one call.')
  expect(drawn).not.toContain('## Q1 ')
  expect(drawn).not.toContain('## Q2 ')
  for (const n of [3, 4, 5]) expect(drawn).toContain(callMarkdown(calls[n - 1]!, true)) // whole, never cut in the middle
  // The title comes after the notice. The newest call is always the last.
  expect(drawn.indexOf('# Questions and answers')).toBeGreaterThan(0)
  expect(drawn.endsWith(callMarkdown(calls[4]!, true))).toBe(true)
})

test('qaScreen names calls that are not in a row of numbers, and keeps the newest call whole even when it alone is too long', () => {
  const calls = bulky([2, 4, 7], 60_000)
  const drawn = qaScreen(calls, { from: 2, to: 7 }, true, true)!
  // Only Q7 fits with room for the title: the older calls are named, Q4 and Q2 as two calls (Q3, Q5 and Q6 were never there).
  expect(drawn.split('\n')[0]).toBe('Q2, Q4 left out to fit. /track qa 2 draws one call.')
  expect(drawn).toContain('## Q7 ')
  const huge = bulky([1, 2], 120_000) // each call alone is over the limit: the engine cuts it, with its own notice
  const out = qaScreen(huge, { from: 1, to: 2 }, true, true)!
  expect(out.split('\n')[0]).toBe('Q1 left out to fit. /track qa 1 draws one call.')
  expect(out).toContain(callMarkdown(huge[1]!, true))
})

test('qaScreen: one call that is alone over the limit has no notice, whatever the title: the engine cuts it', () => {
  const calls = bulky([5], 120_000)
  expect(qaScreen(calls, { from: 5, to: 5 }, false, true)).toBe(callMarkdown(calls[0]!, true))
  const withTitle = qaScreen(calls, { from: 5, to: 5 }, true, true)!
  expect(withTitle).toBe(qaMarkdown(calls, true))
  expect(withTitle).not.toContain('left out')
  expect(withTitle).not.toContain('undefined')
})

test('qaScreen of one call that fits has no notice; the text under the limit is drawn whole', () => {
  const calls = bulky([1, 2], 10_000)
  const drawn = qaScreen(calls, { from: 1, to: 2 }, true, true)!
  expect(drawn).toBe(qaMarkdown(calls, true))
  expect(drawn).not.toContain('left out')
})

test('qaScreen: the cost of the cut grows with the size of the calls, not faster', async () => {
  await expectLinear({
    make: k =>
      bulky(
        Array.from({ length: 10 * k }, (_, i) => i + 1),
        20_000,
      ),
    run: calls => {
      qaScreen(calls, { from: 1, to: calls.length }, true, true)
    },
  })
})
