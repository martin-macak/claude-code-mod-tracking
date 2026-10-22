// What a call looks like to a person (issue #71): its questions with the masking applied, the words of its state and its
// answers. The pane, the `/track qa` text, the copy key and the prompt lines all read these, so a secret is masked in one
// place. The record keeps every word; only these functions mask, and only when `mask` is on. Pure.

import type { StatusToken } from '../../core/interfaces/view'
import { stripControl } from '../../core/lib/prompt-text'
import { answerParts } from './parse'
import { isSensitive, MASKED, maskSecrets } from './secrets'
import type { QuestionCall, QuestionItem, QuestionState } from './types'

export type ShownOption = {
  label: string
  description?: string
  preview?: string
  /** The person picked this option. */
  chosen: boolean
}

export type ShownItem = {
  question: string
  header: string
  description?: string
  multiSelect: boolean
  options: ShownOption[]
  /** The text the person typed, one entry for each piece. */
  typed: string[]
  notes?: string
  /** The preview of the option the person picked, as the engine reported it. */
  preview?: string
  /** The answer is the engine's word for notes with no option. */
  notesOnly: boolean
  /** The question has no answer and no notes-only mark: the person left it blank. */
  blank: boolean
}

/** A text through the mask. `whole` hides all of it: the answer of a question that asks for a secret. */
export type Masker = (text: string, whole?: boolean) => string

export const masker =
  (on: boolean): Masker =>
  (text, whole = false) =>
    !on ? text : whole && text !== '' ? MASKED : maskSecrets(text)

/**
 * True when the question asks for a secret. The words say it, or, after a cut to the byte cap that may have taken them, the
 * mark `sensitive` of the record.
 */
export const asksForSecret = (item: QuestionItem): boolean =>
  item.sensitive === true || isSensitive(item.question, item.header)

/**
 * The text that the person typed beside the questions of a call (`response`), ready to show. It answers no question in
 * particular, so when any question of the call asks for a secret it may hold that secret, and it is hidden whole.
 */
export function shownResponse(call: Pick<QuestionCall, 'items' | 'response'>, mask: Masker): string | undefined {
  return call.response === undefined ? undefined : mask(call.response, (call.items ?? []).some(asksForSecret))
}

/** One question of a call, ready to show. A question that asks for a secret hides its typed text and its notes whole. */
export function shownItem(item: QuestionItem, mask: Masker): ShownItem {
  const parts = answerParts(item)
  const secret = asksForSecret(item)
  const picked = new Set(parts.chosen)
  return {
    question: mask(item.question),
    header: mask(item.header),
    ...(item.description !== undefined ? { description: mask(item.description) } : {}),
    multiSelect: item.multiSelect,
    options: item.options.map(o => ({
      label: mask(o.label),
      ...(o.description !== undefined ? { description: mask(o.description) } : {}),
      ...(o.preview !== undefined ? { preview: mask(o.preview) } : {}),
      chosen: picked.has(o.label),
    })),
    typed: parts.typed.map(t => mask(t, secret)),
    ...(item.notes !== undefined ? { notes: mask(item.notes, secret) } : {}),
    ...(item.preview !== undefined ? { preview: mask(item.preview) } : {}),
    notesOnly: parts.notesOnly,
    blank: item.answer === undefined,
  }
}

/** The labels the person picked, then the typed text tagged as typed: `Lint, E2E, typed: custom`. */
export function answerText(s: ShownItem): string {
  if (s.blank) return '(blank)'
  if (s.notesOnly) return '(notes only)'
  return [...s.options.filter(o => o.chosen).map(o => o.label), ...s.typed.map(t => `typed: ${t}`)]
    .map(t => stripControl(t))
    .join(', ')
}

/** The word of a state on the status cell. A plan is approved or rejected: it has no questions to leave blank. */
export const stateWord = (call: Pick<QuestionCall, 'kind' | 'state'>): string =>
  call.kind === 'plan' ? (call.state === 'answered' ? 'approved' : 'rejected') : call.state

/**
 * The status token of a state: an answered call is done, and so is a partial one (the dialog closed, so nothing waits for the
 * blank answer; the label `partial` shows the gap), a declined call is gone.
 */
export const STATE_TOKEN: Readonly<Record<QuestionState, StatusToken>> = {
  answered: 'done',
  partial: 'done',
  declined: 'gone',
}

/** The first line of a text, plain, for a row. */
export const firstLine = (text: string): string => stripControl(text.split('\n').find(l => l.trim() !== '') ?? '')
