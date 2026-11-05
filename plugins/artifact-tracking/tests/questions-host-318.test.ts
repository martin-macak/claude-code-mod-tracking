// What the questions tracker reads of the shapes of Claude Code 2.1.318 (issue #312, tests/fixtures/questions-host-318.ts): the
// answer of the spike's permission-prompt host with `response` and `followUp`, the annotation `unanswered`, and a plan edited
// with Ctrl+G. The captures are in docs/knowledge-base/claude-code-mods/sources/spikes-2026-11-05-hosts. No real host was observed.
import { expect, test } from 'claude-code/testing'
import type { ToolCallEvent } from '../core/interfaces/events'
import type { Json } from '../core/interfaces/items'
import type { ViewContext } from '../core/interfaces/view'
import { callMarkdown } from '../trackers/questions/markdown'
import { answerParts, askCall, planCall } from '../trackers/questions/parse'
import { answerText, masker, shownItem } from '../trackers/questions/present'
import { questionsPrompt } from '../trackers/questions/prompt'
import { callRow } from '../trackers/questions/rows'
import type { QuestionCall } from '../trackers/questions/types'
import { HOST_FOLLOW_UP, HOST_NO_ANSWER_TEXT, PLAN_EDITED } from './fixtures/questions-host-318'

const AT = Date.UTC(2026, 10, 5, 6, 44)
const QUESTION = 'Which database should we use?'
const TEXT = 'The user replied in the chat instead.'
const stamped = (body: NonNullable<ReturnType<typeof askCall>>): QuestionCall => ({ ...body, n: 1, at: AT, turn: 1 })
const promptLines = (calls: readonly QuestionCall[]) =>
  questionsPrompt({ data: calls as unknown as Json } as ViewContext)

/**
 * The shape the output schema of 2.1.318 documents, built from its words, not from a capture: "The model does not see this field;
 * put the text it should read in `answers`." So `answers` holds the text for the model and the annotation holds the reason.
 */
const documented = (
  answer: string | undefined,
  unanswered: unknown,
  header = 'DB',
  question = QUESTION,
): ToolCallEvent => {
  const asked = {
    question,
    header,
    kind: 'choice',
    options: [{ label: 'Postgres' }, { label: 'SQLite' }],
    multiSelect: false,
  }
  return {
    tool: 'AskUserQuestion',
    toolUseId: 'toolu_documented',
    input: { questions: [asked], tool: 'AskUserQuestion', tool_use_id: 'toolu_documented' },
    result: {
      ref: 1,
      result: {
        questions: [asked],
        answers: answer === undefined ? {} : { [question]: answer },
        annotations: { [question]: { unanswered } as Json },
      },
      text: 'ignored',
    },
  } as ToolCallEvent
}

test('the host of the spike: an answer keeps the response and the follow-up beside it', () => {
  const call = askCall(HOST_FOLLOW_UP)
  expect(call).toMatchObject({
    state: 'answered',
    followUp: true,
    response: 'Host response: please also consider caching.',
  })
  expect(call?.items?.[0]?.answer).toBe('Postgres')
})

test('the host of the spike: a reason with no text in answers is no blank question', () => {
  const call = askCall(HOST_NO_ANSWER_TEXT)
  expect(call).toMatchObject({ state: 'partial', followUp: true, response: 'Let us talk about this first.' })
  const [q] = call?.items ?? []
  expect(q).toMatchObject({ unanswered: 'replied_in_chat' })
  expect(q).not.toHaveProperty('answer')
  if (q === undefined || call === undefined) return

  expect(answerText(shownItem(q, masker(true)))).toBe('(replied in chat)')

  const md = callMarkdown(stamped(call), true)
  expect(md).toContain('_Not answered here: the person replied in the chat._')
  expect(md).not.toContain('_Left blank._')

  const [child] = callRow(stamped(call), masker(true)).children ?? []
  expect(child?.facets?.status).toEqual({ label: 'replied in chat', token: 'none' })

  expect(promptLines([stamped(call)]).join('\n')).toContain('DB: replied in chat')
})

test('the documented shape: the text in answers with a reason is no typed answer, and the call stays partial', () => {
  const call = askCall(documented(TEXT, 'replied_in_chat'))
  expect(call).toMatchObject({ state: 'partial' })
  const [q] = call?.items ?? []
  expect(q).toMatchObject({ unanswered: 'replied_in_chat', answer: TEXT })
  if (q === undefined || call === undefined) return
  expect(answerParts(q)).toEqual({ chosen: [], typed: [], notesOnly: false })

  const s = shownItem(q, masker(true))
  expect(s).toMatchObject({ blank: false, unanswered: 'replied_in_chat', unansweredText: TEXT, typed: [] })
  expect(answerText(s)).toBe(`(replied in chat) ${TEXT}`)

  const md = callMarkdown(stamped(call), true)
  expect(md).not.toContain('Other (typed)')
  expect(md).not.toContain('_Left blank._')
  const reason = md.indexOf('_Not answered here: the person replied in the chat._')
  const text = md.indexOf(`> Text: ${TEXT}`)
  expect(reason).toBeGreaterThan(-1)
  expect(text).toBeGreaterThan(reason)

  const row = callRow(stamped(call), masker(true))
  const [child] = row.children ?? []
  expect(row.facets?.status).toEqual({ label: 'partial', token: 'done' })
  expect(child?.facets?.status).toEqual({ label: 'replied in chat', token: 'none' })
  const detail = (child?.detail?.() ?? []).map(l => `${l.label}|${l.cell.text}`)
  expect(detail).toContain('answer|(replied in chat)')
  expect(detail).toContain(`text|${TEXT}`)
  expect(detail.some(l => l.startsWith('typed|'))).toBe(false)
})

test('the prompt line names the reason and holds no word of the text in answers', () => {
  const call = askCall(documented(TEXT, 'replied_in_chat'))
  if (call === undefined) throw new Error('no call')
  const line = promptLines([stamped(call)]).join('\n')
  expect(line).toContain('DB: replied in chat')
  expect(line).not.toContain('instead')
  expect(line).not.toContain('typed answer')
})

for (const [reason, word, sentence] of [
  ['skipped', 'skipped', '_Skipped._'],
  ['replied_in_chat', 'replied in chat', '_Not answered here: the person replied in the chat._'],
  ['dismissed', 'dismissed', '_Dismissed._'],
] as const) {
  test(`the reason ${reason} shows as its own word, with a text in answers and with none`, () => {
    for (const answer of [TEXT, undefined]) {
      const call = askCall(documented(answer, reason))
      if (call === undefined) throw new Error('no call')
      expect(call.state).toBe('partial')
      const [child] = callRow(stamped(call), masker(true)).children ?? []
      expect(child?.facets?.status).toEqual({ label: word, token: 'none' })
      const md = callMarkdown(stamped(call), true)
      expect(md).toContain(sentence)
      expect(md).not.toContain('_Left blank._')
      expect(md.includes(`> Text: ${TEXT}`)).toBe(answer !== undefined)
      expect(promptLines([stamped(call)]).join('\n')).toContain(`DB: ${word}`)
    }
  })
}

test('an unknown reason counts as absent, as the output schema says: a text is typed, and no text is blank', () => {
  const withText = askCall(documented(TEXT, 'wandered_off'))
  expect(withText).toMatchObject({ state: 'answered' })
  expect(withText?.items?.[0]).not.toHaveProperty('unanswered')
  const typed = withText?.items?.[0]
  if (typed !== undefined) expect(answerParts(typed).typed).toEqual([TEXT])

  const blank = askCall(documented(undefined, 'wandered_off'))
  expect(blank).toMatchObject({ state: 'partial' })
  expect(blank?.items?.[0]).not.toHaveProperty('unanswered')
  if (blank !== undefined) expect(callMarkdown(stamped(blank), true)).toContain('_Left blank._')
})

test('a text in answers that equals a label is no pick when the question has a reason', () => {
  const call = askCall(documented('Postgres', 'skipped'))
  if (call === undefined) throw new Error('no call')
  expect(call.state).toBe('partial')
  const md = callMarkdown(stamped(call), true)
  expect(md).toContain('- [ ] **Postgres**')
  expect(md).toContain('> Text: Postgres')
})

test('the text in answers of a question that asks for a secret is masked whole', () => {
  const call = askCall(documented('my-private-words', 'skipped', 'Token', 'Which API token should we use?'))
  if (call === undefined) throw new Error('no call')
  const md = callMarkdown(stamped(call), true)
  expect(md).not.toContain('my-private-words')
  expect(callMarkdown(stamped(call), false)).toContain('my-private-words')
})

test('a plan edited with Ctrl+G shows the edited plan of the result, not the plan of the input', () => {
  const call = planCall(PLAN_EDITED)
  expect(call).toMatchObject({ state: 'answered' })
  expect(JSON.stringify(PLAN_EDITED.input)).not.toContain('EDITED-BY-SPIKE-312')
  if (call === undefined) throw new Error('no call')
  expect(callMarkdown(stamped(call), true)).toContain('EDITED-BY-SPIKE-312 marker line')
})
