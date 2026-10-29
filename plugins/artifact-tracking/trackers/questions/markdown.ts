// The Markdown of the calls (issue #71): the reply of `/track qa [--send] [n]` and the text of the copy key. It is made to paste
// into an issue, a PR or a doc: every question word for word, every option with its description and preview, the chosen option
// marked, typed text tagged, the notes quoted. Secrets are masked unless the config turns masking off. Pure.
// Issue #246: where a surface draws, the reply is a stub (`qaStub`) that names the call numbers, and a `CommandOutput` rewrite
// draws the Markdown of exactly those calls (`stubRange`, `qaScreen`). The stored row and the next request hold the stub only.

import { type Masker, masker, type ShownItem, shownItem, shownResponse, stateWord } from './present'
import type { QuestionCall } from './types'

export const QA_USAGE = 'Usage: /track qa [--send] [n]'
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
    // The file that holds the plan, as the pane tells it, through the same mask.
    if (call.planFile !== undefined) out.push('', ...lines(m(call.planFile), '', 'File: '))
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

/** The word of `qa`'s argument: a whole number, or nothing. Anything else is the usage. */
const NUMBER = /^[1-9]\d{0,8}$/

/**
 * The reply of `/track qa [n]` as the model may read it. No argument: every call. A number: that call, with no title. Anything
 * else is the usage. `n` is the number of the call, which stays when the older calls drop.
 * The text of the whole list and of one call starts with a line break. The engine puts `<plugin>: ` in front of a reply, so a
 * title on the same line draws a literal `#` (issue #246, R6, seen live on 2.1.311). With the break the prefix stands alone and
 * the title is a heading. The usage line and the two short answers have none: they are no Markdown. The break is added here
 * and not in `qaMarkdown` or `callMarkdown`, which the copy key puts on the clipboard.
 */
export function qaText(calls: readonly QuestionCall[], args: string, mask: boolean): string {
  const arg = args.trim()
  if (arg !== '' && !NUMBER.test(arg)) return QA_USAGE
  if (calls.length === 0) return NO_CALLS
  if (arg === '') return `\n${qaMarkdown(calls, mask)}`
  const found = calls.find(c => c.n === Number(arg))
  return found === undefined ? `No call ${arg}. Calls kept: ${kept(calls)}.` : `\n${callMarkdown(found, mask)}`
}

// ---------------------------------------------------------------- the stub and the screen text (issue #246)

/** The calls a stub names: the number of the first and of the last. One call has `from === to`. */
export type CallRange = { readonly from: number; readonly to: number }

/** The most characters that the engine draws of one `CommandOutput` row (observed on 2.1.310: the first 100 000, then a notice). */
export const SCREEN_LIMIT = 100_000
/**
 * What a cut text keeps back for the notice that names the calls left out, and for the line of the calls that are no longer
 * kept. The names are short, and a list of numbers that skip is the longest case, so this is a generous bound.
 */
const NOTICE_ROOM = 600

const TITLE = '# Questions and answers'
/** The words of a stub that `stubRange` finds: `Questions and answers Q1–Q7 (7 calls): drawn on the screen only.` or `Q3 (1 call)`. */
const STUB = /Questions and answers Q(\d{1,9})(?:–Q(\d{1,9}))? \(\d+ calls?\): drawn on the screen only\./

const label = (r: CallRange): string => (r.from === r.to ? `Q${r.from}` : `Q${r.from}–Q${r.to}`)

/** Numbers in ascending order as ranges of consecutive numbers: `[1, 2, 4]` is `Q1–Q2, Q4`. */
const named = (numbers: readonly number[]): string => {
  const runs: { from: number; to: number }[] = []
  for (const n of numbers) {
    const last = runs.at(-1)
    if (last !== undefined && n === last.to + 1) last.to = n
    else runs.push({ from: n, to: n })
  }
  return runs.map(label).join(', ')
}

/**
 * The stub of `/track qa [n]` for a surface that draws: the call numbers, how many calls, and the way to send them. It holds no
 * word of a question, an option, an answer or a note, and it does not say what the model reads: the model holds the Q&A of its
 * own AskUserQuestion calls already (spike #196, S10). `undefined` where the reply stays plain text: the usage line, no call
 * asked, no call `n`. The numbers are the ones `stubRange` reads back.
 */
export function qaStub(calls: readonly QuestionCall[], args: string): string | undefined {
  const arg = args.trim()
  if (arg !== '' && !NUMBER.test(arg)) return undefined
  if (calls.length === 0) return undefined
  const of = arg === '' ? calls : calls.filter(c => c.n === Number(arg))
  if (of.length === 0) return undefined
  const from = Math.min(...of.map(c => c.n))
  const to = Math.max(...of.map(c => c.n))
  const noun = of.length === 1 ? '1 call' : `${of.length} calls`
  const send = of.length === 1 ? `/track qa --send ${from} puts it` : '/track qa --send puts them'
  return `Questions and answers ${label({ from, to })} (${noun}): drawn on the screen only. ${send} in the context of the model.`
}

/** The calls that a stub names, found by its own words anywhere in the text: the engine puts one or more plugin names in front. */
export function stubRange(shown: string): CallRange | undefined {
  const found = STUB.exec(shown)
  if (found === null) return undefined
  const from = Number(found[1])
  const to = found[2] === undefined ? from : Number(found[2])
  return from <= to ? { from, to } : undefined
}

/**
 * The Markdown that the row draws for the stub of `range`: the calls of the range that the list holds now, so a row of an
 * earlier command draws the same calls after more calls came. `withTitle` is the whole list (`/track qa`), not one call. No
 * line break in front: the rewrite replaces the whole drawn text, the plugin prefix too. `undefined` when the list holds no call
 * of the range (before the slot has loaded after a resume, or after `/track clear`): the row keeps the stub.
 * A number of the range with no call gets one line (the caps dropped it). Past `SCREEN_LIMIT` the newest whole calls stay and
 * the first line names the others. A call that is alone over the limit is kept: the engine cuts it and adds its own notice.
 */
export function qaScreen(
  calls: readonly QuestionCall[],
  range: CallRange,
  withTitle: boolean,
  mask: boolean,
): string | undefined {
  const inRange = calls.filter(c => c.n >= range.from && c.n <= range.to).sort((a, b) => a.n - b.n)
  if (inRange.length === 0) return undefined
  const parts = inRange.map(c => callMarkdown(c, mask))
  // The numbers of the range that no call holds, as ranges, so a range of a million numbers costs no more than a short one.
  const gone: CallRange[] = []
  let next = range.from
  for (const c of inRange) {
    if (c.n > next) gone.push({ from: next, to: c.n - 1 })
    next = c.n + 1
  }
  if (next <= range.to) gone.push({ from: next, to: range.to })
  const goneCount = gone.reduce((sum, r) => sum + (r.to - r.from + 1), 0)
  const goneLine =
    gone.length === 0 ? [] : [`_${gone.map(label).join(', ')} ${goneCount === 1 ? 'is' : 'are'} no longer kept._`]
  const fixed = [...(withTitle ? [TITLE] : []), ...goneLine]
  const head = fixed.join('\n\n').length + (fixed.length > 0 ? 2 : 0)
  const whole = head + parts.reduce((sum, p) => sum + p.length, 0) + 2 * (parts.length - 1)
  if (whole <= SCREEN_LIMIT) return [...fixed, ...parts].join('\n\n')
  // The newest calls first, while they fit; the newest call stays whatever its size.
  const room = SCREEN_LIMIT - head - NOTICE_ROOM
  let first = parts.length - 1
  let used = parts[first]!.length
  while (first > 0 && used + 2 + parts[first - 1]!.length <= room) {
    first--
    used += 2 + parts[first]!.length
  }
  const left = inRange.slice(0, first).map(c => c.n)
  // One call alone is over the limit: nothing is left out. The engine cuts it and adds its own notice.
  if (left.length === 0) return [...fixed, ...parts].join('\n\n')
  const notice = `${named(left)} left out to fit. /track qa ${left[0]} draws one call.`
  return [notice, ...fixed, ...parts.slice(first)].join('\n\n')
}
