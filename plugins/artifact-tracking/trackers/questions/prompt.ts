// The prompt lines of the questions tracker (issue #71): one line for each call, newest first, so the cap of the composer drops
// the oldest. A line holds the headers and the chosen labels only. The question, the typed text and the notes never go in it:
// the person wrote them, and the model must not read a secret from them. A label and a header are text from outside, so the
// line is plain and quoted. Pure.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.11.

import type { Json } from '../../core/interfaces/items'
import type { ViewContext } from '../../core/interfaces/view'
import { promptLine } from '../../core/lib/prompt-text'
import { asCalls } from './log'
import { answerParts } from './parse'
import { stateWord } from './present'
import type { QuestionCall, QuestionItem } from './types'

const TEXT_MAX = 150

/** `header: label, label`. A typed answer says `typed answer` and nothing of its text. */
function answerOf(q: QuestionItem, declined: boolean): string {
  const head = q.header === '' ? 'Question' : q.header
  if (declined) return `${head}: declined`
  if (q.answer === undefined) return `${head}: blank`
  const parts = answerParts(q)
  if (parts.notesOnly) return `${head}: notes only`
  const said = [...parts.chosen, ...(parts.typed.length > 0 ? ['typed answer'] : [])]
  return `${head}: ${said.join(', ')}`
}

function lineOf(c: QuestionCall): string {
  const facts = [stateWord(c), ...(c.turn !== undefined ? [`turn ${c.turn}`] : [])]
  if (c.kind === 'plan') return promptLine(`plan: Q${c.n}`, facts)
  const text = (c.items ?? []).map(q => answerOf(q, c.state === 'declined')).join('; ')
  return promptLine(`question: Q${c.n}`, facts, text, TEXT_MAX)
}

/** `Tracker.prompt`. A plan line holds no text: the plan is the model's own work, and `Q3` is enough to find it. */
export function questionsPrompt(ctx: Pick<ViewContext, 'data'>): readonly string[] {
  return asCalls(ctx.data as Json | undefined)
    .map(lineOf)
    .reverse()
}
