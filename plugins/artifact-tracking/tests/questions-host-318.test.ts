// What the questions tracker reads of the captures of Claude Code 2.1.318 (issue #312, tests/fixtures/questions-host-318.ts): the
// answer of a permission-prompt host with `response` and `followUp`, "Chat about this" as a host sends it
// (`unanswered: 'replied_in_chat'`), and a plan edited with Ctrl+G. The captures are in
// docs/knowledge-base/claude-code-mods/sources/spikes-2026-11-05.
import { expect, test } from 'claude-code/testing'
import type { Json } from '../core/interfaces/items'
import type { ViewContext } from '../core/interfaces/view'
import { callMarkdown } from '../trackers/questions/markdown'
import { askCall, planCall } from '../trackers/questions/parse'
import { answerText, masker, shownItem } from '../trackers/questions/present'
import { questionsPrompt } from '../trackers/questions/prompt'
import { callRow } from '../trackers/questions/rows'
import type { QuestionCall } from '../trackers/questions/types'
import { HOST_FOLLOW_UP, HOST_REPLIED_IN_CHAT, PLAN_EDITED } from './fixtures/questions-host-318'

const AT = Date.UTC(2026, 10, 5, 6, 44)
const stamped = (body: NonNullable<ReturnType<typeof askCall>>): QuestionCall => ({ ...body, n: 1, at: AT, turn: 1 })
const promptLines = (calls: readonly QuestionCall[]) =>
  questionsPrompt({ data: calls as unknown as Json } as ViewContext)

test('a host answer keeps the response and the follow-up beside the answer', () => {
  const call = askCall(HOST_FOLLOW_UP)
  expect(call).toMatchObject({
    state: 'answered',
    followUp: true,
    response: 'Host response: please also consider caching.',
  })
  expect(call?.items?.[0]?.answer).toBe('Postgres')
})

test('"Chat about this" from a host is a question the person answered in the chat, not one left blank', () => {
  const call = askCall(HOST_REPLIED_IN_CHAT)
  expect(call).toMatchObject({ state: 'partial', followUp: true, response: 'Let us talk about this first.' })
  const [q] = call?.items ?? []
  expect(q).toMatchObject({ unanswered: 'replied_in_chat' })
  expect(q).not.toHaveProperty('answer')
  if (q === undefined || call === undefined) return

  const s = shownItem(q, masker(true))
  expect(answerText(s)).toBe('(replied in chat)')

  const md = callMarkdown(stamped(call), true)
  expect(md).toContain('_Not answered here: the person replied in the chat._')
  expect(md).not.toContain('_Left blank._')

  const [child] = callRow(stamped(call), masker(true)).children ?? []
  expect(child?.facets?.status).toEqual({ label: 'replied in chat', token: 'none' })

  expect(promptLines([stamped(call)]).join('\n')).toContain('DB: replied in chat')
})

test('a plan edited with Ctrl+G shows the edited plan of the result, not the plan of the input', () => {
  const call = planCall(PLAN_EDITED)
  expect(call).toMatchObject({ state: 'answered' })
  expect(call?.plan).toContain('EDITED-BY-SPIKE-312 marker line')
  expect(JSON.stringify(PLAN_EDITED.input)).not.toContain('EDITED-BY-SPIKE-312')
})
