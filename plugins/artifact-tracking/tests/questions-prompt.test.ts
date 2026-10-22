// The prompt lines of the questions tracker (issue #71): when the person turns them on, a line holds the headers and the
// chosen labels of a call, and never a question, a typed text or a note. Pure.
import { expect, test } from 'claude-code/testing'
import type { Json } from '../core/interfaces/items'
import type { ViewContext } from '../core/interfaces/view'
import { PROMPT_LINE_MAX } from '../core/lib/prompt-text'
import { questionsConfig } from '../trackers/questions/config'
import { questionsPrompt } from '../trackers/questions/prompt'
import type { QuestionCall, QuestionItem } from '../trackers/questions/types'

const item = (over: Partial<QuestionItem> = {}): QuestionItem => ({
  question: 'Where should the records live?',
  header: 'Storage',
  multiSelect: false,
  options: [{ label: 'State only' }, { label: 'State and store' }],
  answer: 'State only',
  ...over,
})
const call = (id: string, n: number, over: Partial<QuestionCall> = {}): QuestionCall => ({
  id,
  n,
  kind: 'ask',
  state: 'answered',
  at: n,
  turn: 7,
  items: [item()],
  ...over,
})
const lines = (calls: readonly QuestionCall[]) => questionsPrompt({ data: calls as unknown as Json } as ViewContext)

test('a line names the call, its state and turn, and the header and chosen label of each question', () => {
  const two = call('a', 1, {
    items: [
      item(),
      item({
        header: 'Checks',
        multiSelect: true,
        options: [{ label: 'Lint' }, { label: 'E2E' }],
        answer: 'Lint, E2E',
      }),
    ],
  })
  expect(lines([two])).toEqual(['question: Q1 (answered, turn 7) "Storage: State only; Checks: Lint, E2E"'])
})

test('the newest call comes first, so the cap of the composer drops the oldest', () => {
  expect(lines([call('a', 1), call('b', 2)]).map(l => l.slice(0, 12))).toEqual(['question: Q2', 'question: Q1'])
})

test('a typed answer, notes and the text of a question never reach the model', () => {
  const secret = 'hunter2-the-database-password'
  const out = lines([
    call('a', 1, {
      items: [
        item({ question: `Is ${secret} right?`, options: [{ label: 'Yes' }], answer: secret, notes: `note ${secret}` }),
      ],
    }),
  ])
  expect(out).toEqual(['question: Q1 (answered, turn 7) "Storage: typed answer"'])
  expect(out.join('\n')).not.toContain(secret)
})

test('a blank question, notes only and a declined call are named, with no word of what the person wrote', () => {
  const out = lines([
    call('a', 1, {
      state: 'partial',
      items: [item({ answer: undefined }), item({ header: 'Notes', answer: '(notes only)', notes: 'x' })],
    }),
    call('d', 2, { state: 'declined', refusal: 'The user said: no', items: [item({ answer: undefined })] }),
  ])
  expect(out).toEqual([
    'question: Q2 (declined, turn 7) "Storage: declined"',
    'question: Q1 (partial, turn 7) "Storage: blank; Notes: notes only"',
  ])
})

test('a plan has the state and the turn and no text of the plan', () => {
  const out = lines([
    call('p', 3, {
      kind: 'plan',
      items: undefined,
      plan: 'Secret plan text',
      turn: undefined,
      state: 'declined',
      refusal: 'no',
    }),
  ])
  expect(out).toEqual(['plan: Q3 (rejected)'])
})

test('a header or a label from outside is plain text: a newline or a quote cannot break the line', () => {
  const out = lines([
    call('a', 1, {
      items: [
        item({ header: 'Two\nlines "quoted"', options: [{ label: 'Pick "me"\nnow' }], answer: 'Pick "me"\nnow' }),
      ],
    }),
  ])
  expect(out).toHaveLength(1)
  expect(out[0]).not.toContain('\n')
  expect(out[0]?.match(/"/g)).toHaveLength(2)
  expect(out[0]?.length).toBeLessThanOrEqual(PROMPT_LINE_MAX)
})

test('no call, no line; and the prompt block is off by default in the config', () => {
  expect(lines([])).toEqual([])
  expect(questionsConfig.defaults.prompt).toEqual({ enabled: false, maxItems: 20 })
})
