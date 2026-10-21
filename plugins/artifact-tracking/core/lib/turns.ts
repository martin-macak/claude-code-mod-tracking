// The turn ledger algebra (issue #69): which turn a piece of work belongs to, and how the ledger changes when a turn
// opens, commits, spawns an agent or tracks an item. Pure: no input is mutated, and a call that changes nothing returns its
// input, so a caller can test for a change with `===`. No `$`, no I/O, no tracker named.
//
// The orders it follows were seen in a live run (design study of #69, comment 2):
// - The person's prompt row comes BEFORE the `turn.start` it causes. Its items wait in `pending` and carry the ordinal that
//   the next turn will get (`next`), so the turn adopts them and the stamps agree.
// - A subagent works on after its spawning turn has ended. Its work goes to the turn that spawned it, marked `late`.
// - A finished background task wakes the main loop: a task-notice prompt row, then a `turn.start`. A wake takes no ordinal
//   (owner decision 2). Its work goes to the turn that started the task.
// Three files share the job (review of #136, m4): this one holds the rules above and the caps of a ledger, `turn-entries.ts`
// the lists of one turn and the sightings that fill them, `turn-store.ts` the stored copy. This file imports `turn-entries.ts`
// only; `turn-store.ts` imports both.
// Spec: issue #69, the design study "Show what each turn tracked", sections 4 and 5, and the owner decisions of 2026-10-21.

import type { Sightings, TurnEnd, TurnLedger, TurnRecord, TurnSource, TurnTarget } from '../interfaces/turns'
import { isRecord } from './json'
import { isEmpty, withSightings } from './turn-entries'

/** The turns the ledger keeps. The oldest go first. */
export const MAX_TURNS = 50
/** The agent ids, and the tool call ids, the ledger maps to a turn. The oldest go first. */
export const MAX_MAPPED = 200
/** How much of the person's prompt a record keeps (owner decision of 2026-10-21). */
export const PROMPT_CHARS = 60

export const emptyLedger = (): TurnLedger => ({ next: 1, turns: [], agents: [], calls: [] })

/** The engine's words for how a turn ended. */
const TURN_ENDS: readonly TurnEnd[] = ['answer', 'aborted', 'refusal', 'error']
export const isEnd = (v: unknown): v is TurnEnd => TURN_ENDS.includes(v as TurnEnd)

/** The first `PROMPT_CHARS` characters of a prompt, white space folded to single spaces. Whole characters, never half a pair. */
export const excerpt = (text: string): string => [...text.replace(/\s+/g, ' ').trim()].slice(0, PROMPT_CHARS).join('')

// ---------------------------------------------------------------- a task notice

/** The tag the engine puts at the start of the text of a finished task (a subagent or a background command). */
const NOTICE = '<task-notification>'

/** The text is the notice of a finished task. */
export const isTaskNotice = (text: string): boolean => text.trimStart().startsWith(NOTICE)

/** What names the task that ended: its tool call (`<tool-use-id>`) and its own id (`<task-id>`). Engine text, not a field. */
type Notice = { readonly toolUseId?: string; readonly taskId?: string }

const tagOf = (text: string, tag: string): string | undefined => {
  const hit = new RegExp(`<${tag}>\\s*([^<\\s]+)\\s*</${tag}>`).exec(text)
  return hit?.[1]
}

/** The ids a notice text names. A text with neither gives `{}`. */
export function noticeOf(text: string): Notice {
  const toolUseId = tagOf(text, 'tool-use-id')
  const taskId = tagOf(text, 'task-id')
  return { ...(toolUseId !== undefined ? { toolUseId } : {}), ...(taskId !== undefined ? { taskId } : {}) }
}

// ---------------------------------------------------------------- small reads

export type Pairs = readonly (readonly [string, number])[]

const mapped = (pairs: Pairs, key: string | undefined): number | undefined =>
  key === undefined ? undefined : pairs.find(([k]) => k === key)?.[1]

/** `key` maps to `ord` now: the old pair of the key goes, the oldest pairs past the cap go. */
const put = (pairs: Pairs, key: string, ord: number): Pairs =>
  [...pairs.filter(([k]) => k !== key), [key, ord] as const].slice(-MAX_MAPPED)

/** The record of a turn. */
export const recordOf = (l: TurnLedger, ord: number): TurnRecord | undefined => l.turns.find(r => r.ord === ord)

/** The ordinal of the newest record. */
const latestOrd = (l: TurnLedger): number | undefined => l.turns.at(-1)?.ord

/** The cap of a ledger: the newest turns, the newest pairs. The same ledger comes back when it fits. */
export function capped(l: TurnLedger): TurnLedger {
  if (l.turns.length <= MAX_TURNS && l.agents.length <= MAX_MAPPED && l.calls.length <= MAX_MAPPED) return l
  return {
    ...l,
    turns: l.turns.slice(-MAX_TURNS),
    agents: l.agents.slice(-MAX_MAPPED),
    calls: l.calls.slice(-MAX_MAPPED),
  }
}

// ---------------------------------------------------------------- where work goes

/**
 * The turn that the work of `who` belongs to, or undefined (the work is not stamped).
 * - A subagent: the turn its spawn named. An id the ledger does not know falls back to the running turn, then to the
 *   newest one. The sub's own `turn.start` can come before the spawn answer, so a miss is normal.
 * - The main loop: the running turn. With none, the person's prompt row waits for the turn it starts (`pending`).
 */
export function targetOf(l: TurnLedger, who: TurnSource): TurnTarget | undefined {
  if (who.agentId !== undefined) {
    const known = mapped(l.agents, who.agentId)
    const ord = known !== undefined && recordOf(l, known) !== undefined ? known : (l.open?.ord ?? latestOrd(l))
    if (ord === undefined || recordOf(l, ord) === undefined) return undefined
    return l.open?.ord === ord ? { ord } : { ord, late: true }
  }
  if (l.open !== undefined) return { ord: l.open.ord }
  if (who.person === true) return { ord: l.pending?.ord ?? l.next, pending: true }
  return undefined
}

/** The turn that started the task a notice names: its tool call, then its id (an agent id), else the newest turn. */
function starterOf(l: TurnLedger, notice: Notice): number | undefined {
  const known = [mapped(l.calls, notice.toolUseId), mapped(l.agents, notice.taskId)].find(
    ord => ord !== undefined && recordOf(l, ord) !== undefined,
  )
  return known ?? latestOrd(l)
}

// ---------------------------------------------------------------- rows

/**
 * The person's prompt row. With no turn running, its items wait for the turn it starts: `pending` holds the ordinal that
 * turn will get and the first 60 characters of the prompt. A prompt that no turn followed (a hook dropped it) leaves its
 * entries for the next turn: they carry that ordinal already. A prompt row clears a task notice that no turn followed.
 */
export function personPrompt(l: TurnLedger, text: string): TurnLedger {
  if (l.open !== undefined) return l
  const { wake: _stale, ...rest } = l
  const had = l.pending
  return {
    ...rest,
    pending: {
      ord: l.next,
      prompt: excerpt(text),
      new: had?.new ?? [],
      seen: had?.seen ?? [],
      ...(had?.moreNew ? { moreNew: had.moreNew } : {}),
      ...(had?.moreSeen ? { moreSeen: had.moreSeen } : {}),
    },
  }
}

/** A task notice on a prompt row: the `turn.start` that follows is a wake. Ignored while a turn runs (no start follows). */
export function taskNotice(l: TurnLedger, text: string): TurnLedger {
  return l.open === undefined ? { ...l, wake: noticeOf(text) } : l
}

// ---------------------------------------------------------------- a turn opens and commits

/**
 * A main-loop `turn.start`. A wake (a task notice before it, or a notice as its text, and no person's prompt waiting)
 * takes no ordinal: it opens the record of the turn that started the task and counts a wake there. With no such turn the
 * wake's work is not stamped. Any other turn gets the next ordinal and a record, adopts what the prompt row left in
 * `pending`, and keeps the first 60 characters of the person's prompt. A text that looks like a notice does not make a
 * wake when the person's own prompt row holds it: the person pasted it, and the turn is theirs.
 */
export function openTurn(l: TurnLedger, e: { turnId: string; text: string; session: string; at: number }): TurnLedger {
  const { wake, pending, open: _open, ...rest } = l
  const typed = pending !== undefined && pending.prompt !== '' && pending.prompt === excerpt(e.text)
  const byText = isTaskNotice(e.text) && !typed
  if (byText || (wake !== undefined && pending === undefined)) {
    const ord = starterOf(l, { ...wake, ...(byText ? noticeOf(e.text) : {}) })
    const kept = pending === undefined ? rest : { ...rest, pending }
    if (ord === undefined) return kept
    return {
      ...kept,
      open: { ord, turnId: e.turnId, wake: true },
      turns: l.turns.map(r => (r.ord === ord ? { ...r, wakes: (r.wakes ?? 0) + 1 } : r)),
    }
  }
  const ord = l.next
  const prompt = pending?.prompt ? pending.prompt : excerpt(e.text) // a bucket with no prompt row yet has an empty one
  const record: TurnRecord = {
    ord,
    turnId: e.turnId,
    session: e.session,
    startedAt: e.at,
    ...(prompt !== '' ? { prompt } : {}),
    new: pending?.new ?? [],
    seen: pending?.seen ?? [],
    ...(pending?.moreNew ? { moreNew: pending.moreNew } : {}),
    ...(pending?.moreSeen ? { moreSeen: pending.moreSeen } : {}),
  }
  return capped({ ...rest, next: ord + 1, open: { ord, turnId: e.turnId }, turns: [...l.turns, record] })
}

/**
 * A main-loop `turn.complete`. Commits the running turn with the engine's own word. The end of a wake closes it and
 * leaves the record as it was. A turn that is not the running one (its start was not heard) changes nothing. A word that
 * is not one of the four is not stored.
 */
export function commitTurn(l: TurnLedger, e: { turnId: string; reason: unknown; at: number }): TurnLedger {
  const { open, ...rest } = l
  if (open === undefined || open.turnId !== e.turnId) return l
  if (open.wake === true) return rest
  return {
    ...rest,
    turns: l.turns.map(r =>
      r.ord === open.ord ? { ...r, endedAt: e.at, ...(isEnd(e.reason) ? { end: e.reason } : {}) } : r,
    ),
  }
}

// ---------------------------------------------------------------- agents and tool calls

/**
 * A subagent or workflow agent spawned. The agent and the tool call that spawned it map to the turn that made the spawn:
 * the one its parent agent maps to, else the running turn, else the newest. The wake of its end finds the turn this way.
 */
export function spawned(
  l: TurnLedger,
  e: { agentId?: string; toolUseId?: string; parentAgentId?: string },
): TurnLedger {
  const ord = targetOf(l, e.parentAgentId === undefined ? {} : { agentId: e.parentAgentId })?.ord ?? latestOrd(l)
  if (ord === undefined) return l
  const agents = e.agentId === undefined ? l.agents : put(l.agents, e.agentId, ord)
  const calls = e.toolUseId === undefined ? l.calls : put(l.calls, e.toolUseId, ord)
  return agents === l.agents && calls === l.calls ? l : { ...l, agents, calls }
}

/**
 * The answer of a tool call says that the call started a task. The engine gives `{ ref, result, text }`, and the task is
 * named in `result`: a Bash call that went to the background has `backgroundTaskId`, a Monitor has `taskId` (the processes
 * tracker reads the same two). Only the notice of such a call can name the call's id.
 */
export function startsTask(ran: unknown): boolean {
  const result = isRecord(ran) && isRecord(ran.result) ? ran.result : undefined
  return [result?.backgroundTaskId, result?.taskId].some(id => typeof id === 'string' && id !== '')
}

/**
 * A finished tool call that started a task: its id maps to the turn it ran in, for the notice of that task. The caller
 * maps only such calls (`startsTask`), so a Read or an Edit leaves the ledger as it was. A notice whose call is not mapped
 * finds the newest turn instead.
 */
export function called(l: TurnLedger, e: { toolUseId?: string; agentId?: string }): TurnLedger {
  if (e.toolUseId === undefined) return l
  const ord = targetOf(l, e.agentId === undefined ? {} : { agentId: e.agentId })?.ord
  if (ord === undefined || mapped(l.calls, e.toolUseId) === ord) return l
  return { ...l, calls: put(l.calls, e.toolUseId, ord) }
}

/**
 * What a capture found goes to the turn it belongs to. No target, no sighting, or a turn the cap dropped: no change. The
 * entries of a turn that has not opened wait in `pending`.
 */
export function noteSightings(l: TurnLedger, target: TurnTarget | undefined, s: Sightings): TurnLedger {
  if (target === undefined || isEmpty(s)) return l
  const late = target.late === true
  if (target.pending === true) {
    const had = l.pending ?? { ord: target.ord, prompt: '', new: [], seen: [] }
    const next = withSightings(had, s, late)
    if (next === had) return l
    const { moreNew: _n, moreSeen: _s, ...bare } = had
    return { ...l, pending: { ...bare, ...next } }
  }
  const rec = recordOf(l, target.ord)
  if (rec === undefined) return l
  const next = withSightings(rec, s, late)
  if (next === rec) return l
  const { moreNew: _n, moreSeen: _s, ...bare } = rec
  return { ...l, turns: l.turns.map(r => (r === rec ? { ...bare, ...next } : r)) }
}
