// The Markdown of the calls (issue #71): the reply of `/track qa [n]` and the text of the copy key. It is made to paste into an
// issue, a PR or a doc: every question word for word, every option with its description and preview, the chosen option
// marked, typed text tagged, the notes quoted. Secrets are masked unless the config turns masking off. Pure.

import { type Masker, masker, type ShownItem, shownItem, shownResponse, stateWord } from './present'
import type { QuestionCall } from './types'

export const QA_USAGE = 'Usage: /track qa [n]'
export const NO_CALLS = 'No questions asked in this session.'

/** A fence of backticks that no run of backticks in `text` can close. */
function fenceOf(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length))
  return '`'.repeat(Math.max(3, longest + 1))
}

/** The lines of a text, each with `lead` in front. The first line gets `first` instead. An empty line gets no trailing space. */
const lines = (text: string, lead: string, first = lead): string[] =>
  text.split('\n').map((l, i) => ((i === 0 ? first : lead) + l).trimEnd())

/** A text in a fence, inside a list item (two spaces of indent) or at the left margin. */
function fenced(text: string, indent: string): string[] {
  const fence = fenceOf(text)
  return [indent + fence, ...text.split('\n').map(l => (l === '' ? '' : indent + l)), indent + fence]
}

const time = (at: number): string => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`

/** The heading line: the number, the turn, the state, who asked, whether the texts were cut, and when. */
function headingOf(call: QuestionCall): string {
  const word = call.kind === 'plan' ? `plan ${stateWord(call)}` : stateWord(call)
  return [
    `## Q${call.n}`,
    ...(call.turn !== undefined ? [`turn ${call.turn}`] : []),
    word,
    ...(call.plugin ? ['asked by a plugin'] : []),
    ...(call.agentId !== undefined ? [`agent ${call.agentId}`] : []),
    ...(call.cut ? ['texts cut to fit'] : []),
    // A replayed call has the time of the replay, which says nothing of when the question was asked.
    ...(call.replayed ? [] : [time(call.at)]),
  ].join(' · ')
}

function itemLines(s: ShownItem, i: number, declined: boolean): string[] {
  const out = [
    '',
    `### ${s.header === '' ? `Question ${i + 1}` : s.header}`,
    '',
    ...lines(s.question, ''),
    ...(s.description ? [`_${s.description}_`] : []),
    // What a text and a number question say of their control, as the engine gave it.
    ...(s.placeholder !== undefined ? lines(s.placeholder, '', 'Placeholder: ') : []),
    ...(s.limits.length > 0
      ? [s.limits.map(l => `${l.name.charAt(0).toUpperCase()}${l.name.slice(1)}: ${l.value}`).join(' · ')]
      : []),
  ]
  if (s.options.length > 0 || s.typed.length > 0) out.push('')
  for (const o of s.options) {
    out.push(`- [${o.chosen ? 'x' : ' '}] **${o.label}**${o.description ? `: ${o.description}` : ''}`)
    if (o.preview !== undefined && o.preview !== '') out.push(...fenced(o.preview, '  '))
  }
  for (const t of s.typed) out.push(...lines(t, '  ', '- [x] Other (typed): '))
  const tail: string[] = []
  if (!declined && s.blank) tail.push('_Left blank._')
  if (s.notesOnly) tail.push('_Notes only, no option picked._')
  if (s.notes !== undefined && s.notes !== '') tail.push(...lines(s.notes, '> ', '> Notes: '))
  if (tail.length > 0) out.push('', ...tail)
  return out
}

/** One call as Markdown. `mask` false shows the secrets. */
export function callMarkdown(call: QuestionCall, mask: boolean): string {
  const m: Masker = masker(mask)
  const out = [headingOf(call)]
  const refusal =
    call.refusal === undefined
      ? []
      : lines(m(call.refusal), '> ', `> ${call.kind === 'plan' ? 'Rejected' : 'Declined'}: `)
  if (call.kind === 'plan') {
    out.push(
      '',
      ...(call.plan === undefined ? ['_The engine gave no plan text._'] : fenced(m(call.plan.trimEnd()), '')),
    )
    if (refusal.length > 0) out.push('', ...refusal)
    return out.join('\n')
  }
  const items = call.items ?? []
  for (const [i, q] of items.entries()) out.push(...itemLines(shownItem(q, m), i, call.state === 'declined'))
  if (call.followUp) out.push('', '_The person asked for another round._')
  const response = shownResponse(call, m)
  if (response !== undefined) out.push('', ...lines(response, '> ', '> Response: '))
  if (call.afkTimeoutMs !== undefined)
    out.push('', `_The dialog answered itself after ${Math.round(call.afkTimeoutMs / 1000)} s with nobody there._`)
  if (refusal.length > 0) out.push('', ...refusal)
  return out.join('\n')
}

/** Every call, under one title, in the order they were asked. */
export function qaMarkdown(calls: readonly QuestionCall[], mask: boolean): string {
  return ['# Questions and answers', ...calls.map(c => callMarkdown(c, mask))].join('\n\n')
}

/** The calls the session still keeps, for a message: the numbers, or the first and the last. */
const kept = (calls: readonly QuestionCall[]): string =>
  calls.length <= 8 ? calls.map(c => c.n).join(', ') : `${calls[0]!.n} to ${calls.at(-1)!.n}`

/**
 * The reply of `/track qa [n]`. No argument: every call. A number: that call, with no title. Anything else is the usage.
 * `n` is the number of the call, which stays when the older calls drop.
 */
export function qaText(calls: readonly QuestionCall[], args: string, mask: boolean): string {
  const arg = args.trim()
  if (arg !== '' && !/^[1-9]\d{0,8}$/.test(arg)) return QA_USAGE
  if (calls.length === 0) return NO_CALLS
  if (arg === '') return qaMarkdown(calls, mask)
  const found = calls.find(c => c.n === Number(arg))
  return found === undefined ? `No call ${arg}. Calls kept: ${kept(calls)}.` : callMarkdown(found, mask)
}
