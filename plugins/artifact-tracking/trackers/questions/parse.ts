// What the questions tracker reads of an AskUserQuestion or an ExitPlanMode call. Pure: no `$`, no I/O, no clock.
// A call comes in two shapes. Live, `ev.input` is the whole `tool.call` input and `ev.result` the answer of `next(e)`:
// `{ ref, result, text, isError? }`. After a `--resume`, `ev.input` holds the arguments the model gave and `ev.result` is the
// whole transcript use: `{ tool, tool_use_id, input, result, text, isError? }`. In both, `result.result` is the structured
// answer, so this reads the structure and never the text. The one place that reads words is the typed answers of a
// multi-select (`answerParts`): the structured answer joins them in one string.
// Evidence: docs/knowledge-base/claude-code-mods/concepts/questions-and-plans.md.

import type { ToolCallEvent } from '../../core/interfaces/events'
import { isRecord } from '../../core/lib/json'
import type { QuestionCall, QuestionItem, QuestionOption, QuestionState } from './types'

/** What a parse gives. The tracker adds the number, the time, the turn and the replay mark. */
export type CallBody = Omit<QuestionCall, 'n' | 'at' | 'turn' | 'replayed'>

/** The engine's word for a question that got notes and no option. */
export const NOTES_ONLY = '(notes only)'

/** The id prefix of a call that another plugin's `ui.ask` made. */
const PLUGIN_ID = 'toolu_plugin_'

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function optionOf(v: unknown): QuestionOption | undefined {
  if (!isRecord(v) || typeof v.label !== 'string') return undefined
  const { description, preview } = v
  return {
    label: v.label,
    ...(typeof description === 'string' ? { description } : {}),
    ...(typeof preview === 'string' ? { preview } : {}),
  }
}

/** One question as the engine gave it. An entry with no question text is not a question. */
function itemOf(v: unknown): QuestionItem | undefined {
  if (!isRecord(v) || typeof v.question !== 'string') return undefined
  const { kind, description } = v
  return {
    question: v.question,
    header: str(v.header) ?? '',
    multiSelect: v.multiSelect === true,
    ...(typeof kind === 'string' ? { kind } : {}),
    ...(typeof description === 'string' ? { description } : {}),
    options: Array.isArray(v.options) ? v.options.flatMap(o => optionOf(o) ?? []) : [],
  }
}

const itemsOf = (questions: unknown): QuestionItem[] =>
  Array.isArray(questions) ? questions.flatMap(q => itemOf(q) ?? []) : []

/** The tool's own record: `result.result`. A string there is an error text. */
const structuredOf = (result: unknown): unknown => (isRecord(result) ? result.result : undefined)

/**
 * How the engine refused a call: a hook's `deny` text, or an error result with the words of the engine. Absent: the call ran.
 * The words are the structured error, `result.result`, which holds the note of a rejected plan too (live, 2.1.306). The
 * display text beside it is the fallback only, for a transcript use that stored nothing else.
 */
function refusalOf(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined
  if (typeof result.deny === 'string') return result.deny
  if (result.isError !== true) return undefined
  return str(result.result) ?? str(result.text) ?? ''
}

/**
 * True when the answer says how the call ended: a structured result, an error, or a hook's `deny`. A transcript use that
 * stored none of them (the call was in flight, or nothing was stored) says nothing of the answers: reading it would make
 * every question blank.
 */
function outcomeKnown(result: unknown): boolean {
  return isRecord(result) && (result.result !== undefined || result.isError === true || typeof result.deny === 'string')
}

/** The user-facing part of the id and the loop: the same for both kinds of call. */
function headOf(ev: ToolCallEvent): Pick<QuestionCall, 'id' | 'plugin' | 'agentId'> | undefined {
  if (typeof ev.toolUseId !== 'string' || ev.toolUseId === '') return undefined
  return {
    id: ev.toolUseId,
    ...(ev.toolUseId.startsWith(PLUGIN_ID) ? { plugin: true as const } : {}),
    ...(ev.agentId !== undefined ? { agentId: ev.agentId } : {}),
  }
}

/** The answer, the picked preview and the notes of one question, by question text. */
function answered(item: QuestionItem, answers: unknown, annotations: unknown): QuestionItem {
  const answer = isRecord(answers) ? str(answers[item.question]) : undefined
  const note = isRecord(annotations) && isRecord(annotations[item.question]) ? annotations[item.question] : undefined
  const { preview, notes } = isRecord(note) ? note : ({} as Record<string, unknown>)
  return {
    ...item,
    ...(answer !== undefined ? { answer } : {}),
    ...(typeof preview === 'string' ? { preview } : {}),
    ...(typeof notes === 'string' ? { notes } : {}),
  }
}

/** True when the question has an answer that picks or types something. Notes with no option are not an answer. */
function hasAnswer(item: QuestionItem): boolean {
  return item.answer !== undefined && !answerParts(item).notesOnly
}

/**
 * An AskUserQuestion call, or a `ui.ask` of another plugin (it reaches the same hook). The questions come from the
 * result when it holds them, else from the input: a declined call has no questions in its result. Undefined: the call has
 * no id to key it by, no outcome (`outcomeKnown`), or no question that the mod can read.
 */
export function askCall(ev: ToolCallEvent): CallBody | undefined {
  const head = headOf(ev)
  if (head === undefined || !outcomeKnown(ev.result)) return undefined
  const structured = structuredOf(ev.result)
  const fromResult = isRecord(structured) ? itemsOf(structured.questions) : []
  const asked = fromResult.length > 0 ? fromResult : itemsOf(isRecord(ev.input) ? ev.input.questions : undefined)
  if (asked.length === 0) return undefined
  const refusal = refusalOf(ev.result)
  if (refusal !== undefined) return { ...head, kind: 'ask', state: 'declined', items: asked, refusal }
  const result = isRecord(structured) ? structured : {}
  const items = asked.map(q => answered(q, result.answers, result.annotations))
  const state: QuestionState = items.every(hasAnswer) ? 'answered' : 'partial'
  const { response, afkTimeoutMs } = result
  return {
    ...head,
    kind: 'ask',
    state,
    items,
    ...(typeof response === 'string' ? { response } : {}),
    ...(result.followUp === true ? { followUp: true as const } : {}),
    ...(typeof afkTimeoutMs === 'number' ? { afkTimeoutMs } : {}),
  }
}

/**
 * An ExitPlanMode call. The hook sees the plan and its file in the input before the dialog, and in the result after an
 * approval. The outcome is `isError`: a rejection (with the words of the person in the text) or a hook's `deny` is declined.
 * A teammate that waits for its leader has no outcome yet, and neither has a transcript use that stored none: those are no
 * call. After a `--resume` the transcript keeps the arguments of the model, so the plan comes from the stored record of an
 * approval only.
 */
export function planCall(ev: ToolCallEvent): CallBody | undefined {
  const head = headOf(ev)
  if (head === undefined || !outcomeKnown(ev.result)) return undefined
  const structured = structuredOf(ev.result)
  if (isRecord(structured) && structured.awaitingLeaderApproval === true) return undefined
  const input = isRecord(ev.input) ? ev.input : {}
  const kept = isRecord(structured) ? structured : {}
  const plan = str(input.plan) ?? str(kept.plan)
  const planFile = str(input.planFilePath) ?? str(kept.filePath)
  const refusal = refusalOf(ev.result)
  return {
    ...head,
    kind: 'plan',
    state: refusal === undefined ? 'answered' : 'declined',
    ...(plan !== undefined ? { plan } : {}),
    ...(planFile !== undefined ? { planFile } : {}),
    ...(refusal !== undefined ? { refusal } : {}),
  }
}

export type AnswerParts = {
  /** The option labels the answer holds. */
  chosen: string[]
  /** The text the person typed: what the answer holds that no label names. */
  typed: string[]
  /** The answer is the engine's word for notes with no option. */
  notesOnly: boolean
}

/**
 * The pieces of a multi-select answer. The engine joins them with a comma and a space and puts double quotes round a piece
 * that holds a comma (live, 2.1.306: `Lint, "Tests, all", "typed, with comma"`). A quote with no closing quote is read
 * as plain text.
 */
function pieces(answer: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < answer.length) {
    if (answer[i] === '"') {
      let end = -1
      for (let j = i + 1; j < answer.length && end < 0; j++)
        if (answer[j] === '"' && (j + 1 === answer.length || answer.startsWith(', ', j + 1))) end = j
      if (end >= 0) {
        out.push(answer.slice(i + 1, end))
        i = end + 3 // the closing quote, the comma and the space
        continue
      }
    }
    const next = answer.indexOf(', ', i)
    out.push(answer.slice(i, next < 0 ? answer.length : next))
    if (next < 0) break
    i = next + 2
  }
  return out
}

/** Joins the neighbours that make a label with a comma that the engine did not quote. */
function joined(parts: readonly string[], labels: ReadonlySet<string>): string[] {
  const out: string[] = []
  for (let k = 0; k < parts.length; ) {
    let take = 1
    for (let len = parts.length - k; len >= 2; len--)
      if (labels.has(parts.slice(k, k + len).join(', '))) {
        take = len
        break
      }
    out.push(parts.slice(k, k + take).join(', '))
    k += take
  }
  return out
}

/**
 * What an answer holds: the labels the person picked and the text the person typed. A question with no options (`text`,
 * `number`) holds typed text only. `(notes only)` is the engine's word for notes with no option, unless an option has that
 * label. A single answer that is no label is typed text, and it may hold commas.
 */
export function answerParts(item: QuestionItem): AnswerParts {
  const { answer } = item
  if (answer === undefined) return { chosen: [], typed: [], notesOnly: false }
  const labels = new Set(item.options.map(o => o.label))
  if (answer === NOTES_ONLY && !labels.has(answer)) return { chosen: [], typed: [], notesOnly: true }
  if (item.options.length === 0 || (item.kind !== undefined && item.kind !== 'choice'))
    return { chosen: [], typed: [answer], notesOnly: false }
  const all = item.multiSelect ? joined(pieces(answer), labels) : [answer]
  return {
    chosen: all.filter(p => labels.has(p)),
    typed: all.filter(p => !labels.has(p)),
    notesOnly: false,
  }
}
