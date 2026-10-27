// The rows of the Questions section (issue #71): one summary row for each call and one child row for each question. The
// summary row says the number of the call, its first question with the answer, the kind, the state and the turn. A child row
// says the header, the answer and its state. The detail of each row holds every word of the record, and the cells and the
// detail go through the mask. Pure: it reads the record and writes nothing.

import type { Cell, DetailLine, RowStatus, TreeRow } from '../../core/interfaces/view'
import { textCells } from '../../core/lib/rows'
import {
  answerText,
  callWord,
  firstLine,
  type Masker,
  type ShownItem,
  STATE_TOKEN,
  shownItem,
  shownResponse,
  stateWord,
} from './present'
import { itemRowId, questionReasons } from './reasons'
import type { QuestionCall } from './types'

/** A detail line is cut by the pane at 500 cells. A line of this many characters fits in that, a wide character included. */
const CHUNK = 240

const OPTION_OK = 'success' as const

/** The lines of a text: one line for each line of the text, and each line cut in pieces that the pane can draw. Only the first has the label. */
function textLines(label: string, text: string, cell: Omit<Cell, 'text'> = {}): DetailLine[] {
  const out: DetailLine[] = []
  for (const source of text.split('\n')) {
    const points = [...source]
    const parts =
      points.length === 0
        ? ['']
        : Array.from({ length: Math.ceil(points.length / CHUNK) }, (_, i) =>
            points.slice(i * CHUNK, (i + 1) * CHUNK).join(''),
          )
    for (const part of parts) out.push({ ...(out.length === 0 ? { label } : {}), cell: { ...cell, text: part } })
  }
  return out
}

const time = (at: number): string => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`

/** The words of the status cell of a question row. */
function itemStatus(call: QuestionCall, s: ShownItem): RowStatus {
  if (call.state === 'declined') return { label: 'declined', token: 'gone' }
  // A blank question or notes with no option waits for nothing: the dialog is closed. The label shows the gap, the token says no state.
  if (s.blank) return { label: 'blank', token: 'none' }
  return s.notesOnly ? { label: 'notes only', token: 'none' } : { label: 'answered', token: 'done' }
}

/** The detail of one question: the question, every option with its description and preview, the pick, the typed text, the notes. */
function itemDetail(s: ShownItem): DetailLine[] {
  const out = textLines('question', s.question)
  if (s.description !== undefined && s.description !== '') out.push(...textLines('about', s.description))
  if (s.placeholder !== undefined) out.push(...textLines('placeholder', s.placeholder))
  for (const l of s.limits) out.push(...textLines(l.name, l.value))
  for (const o of s.options) {
    out.push(
      ...textLines(
        'option',
        `[${o.chosen ? 'x' : ' '}] ${o.label}${o.description ? `: ${o.description}` : ''}`,
        o.chosen ? { fg: OPTION_OK } : {},
      ),
    )
    if (o.preview !== undefined && o.preview !== '') out.push(...textLines('preview', o.preview))
  }
  for (const t of s.typed) out.push(...textLines('typed', t, { fg: OPTION_OK }))
  if (s.preview !== undefined && !s.options.some(o => o.preview === s.preview))
    out.push(...textLines('selected', s.preview))
  if (s.notes !== undefined && s.notes !== '') out.push(...textLines('notes', s.notes))
  if (s.blank) out.push({ label: 'answer', cell: { text: '(left blank)', dim: true } })
  return out
}

/** What the summary row says of the call in one line. */
function summaryOf(call: QuestionCall, m: Masker): string {
  if (call.kind === 'plan') return firstLine(m(call.plan ?? '')).replace(/^#+\s*/, '') || 'Plan'
  const items = call.items ?? []
  const first = items[0] === undefined ? undefined : shownItem(items[0], m)
  if (first === undefined) return ''
  const answer = call.state === 'declined' ? '(declined)' : answerText(first)
  return `${first.header === '' ? 'Question 1' : first.header} → ${answer}${items.length > 1 ? ` (+${items.length - 1})` : ''}`
}

/** The detail of a summary row: when, the id, who asked, and what the call says beyond its questions. The core adds the turns line from `TreeRow.turns`. */
function callDetail(call: QuestionCall, m: Masker): DetailLine[] {
  const out: DetailLine[] = [
    { label: 'asked', cell: { text: call.replayed ? 'not known (read back from the transcript)' : time(call.at) } },
    { label: 'call', cell: { text: call.id } },
    ...(call.plugin ? [{ label: 'by', cell: { text: 'a plugin (the engine does not name it)' } }] : []),
    ...(call.agentId !== undefined ? [{ label: 'agent', cell: { text: call.agentId } }] : []),
    ...(call.cut ? [{ label: 'cut', cell: { text: 'the texts were cut to fit the byte cap' } }] : []),
  ]
  if (call.kind === 'plan') {
    out.push(
      ...(call.plan === undefined
        ? textLines('plan', '(the engine gave no plan text)', { dim: true })
        : textLines('plan', m(call.plan.trimEnd()))),
    )
    if (call.planFile !== undefined) out.push(...textLines('file', m(call.planFile)))
    if (call.refusal !== undefined) out.push(...textLines('rejected', m(call.refusal)))
    return out
  }
  if (call.followUp) out.push({ label: 'follow-up', cell: { text: 'the person asked for another round' } })
  const response = shownResponse(call, m)
  if (response !== undefined) out.push(...textLines('response', response))
  if (call.afkTimeoutMs !== undefined)
    out.push({
      label: 'away',
      cell: { text: `the dialog answered itself after ${Math.round(call.afkTimeoutMs / 1000)} s` },
    })
  if (call.refusal !== undefined) out.push(...textLines('declined', m(call.refusal)))
  return out
}

/** The summary row of one call, with a child row for each question. */
export function callRow(call: QuestionCall, m: Masker): TreeRow {
  const status: RowStatus = { label: stateWord(call), token: STATE_TOKEN[call.state] }
  const children = (call.items ?? []).map((q, i): TreeRow => {
    const s = shownItem(q, m)
    const st = itemStatus(call, s)
    return {
      id: itemRowId(call.id, i),
      owner: 'questions',
      cells: textCells({ key: s.header === '' ? `Question ${i + 1}` : s.header, title: answerText(s), status: st }),
      can: { dismiss: false, priority: false },
      reasons: questionReasons(),
      facets: { status: st },
      detail: () => itemDetail(s),
    }
  })
  return {
    id: call.id,
    owner: 'questions',
    cells: textCells({
      // `/track turn` prints this cell to the model (issue #201, `turnLabels`): it must stay a key and never hold a word of the call.
      key: `Q${call.n}`,
      title: summaryOf(call, m),
      type: callWord(call),
      status,
    }),
    // The badge is for the eye. The core puts `turns` on the row from `Traceable.turnsOf` (`turns.ts`), never from a cell.
    ...(call.turn !== undefined ? { extras: [{ text: `T${call.turn}`, dim: true }] } : {}),
    ...(children.length > 0 ? { children } : {}),
    can: { dismiss: false, priority: false },
    reasons: questionReasons(),
    // A replayed call has the time of the replay, which is no first sighting of the call.
    facets: {
      status,
      ...(call.replayed ? {} : { firstSeen: call.at }),
      kind: callWord(call),
    },
    detail: () => callDetail(call, m),
  }
}
