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
// Spec: issue #69, the design study "Show what each turn tracked", sections 4 and 5, and the owner decisions of 2026-10-21.

import type { CoreReason } from '../interfaces/items'
import type { Sightings, TurnEnd, TurnEntry, TurnLedger, TurnRecord, TurnSource, TurnTarget } from '../interfaces/turns'
import { isRecord } from './json'
import { isCoreReason, strongerReason } from './reasons'

/** The turns the ledger keeps. The oldest go first. */
export const MAX_TURNS = 50
/** The entries of one list of one turn. More count as `moreNew` or `moreSeen`. */
export const MAX_ENTRIES = 50
/** The agent ids, and the tool call ids, the ledger maps to a turn. The oldest go first. */
export const MAX_MAPPED = 200
/** How much of the person's prompt a record keeps (owner decision of 2026-10-21). */
export const PROMPT_CHARS = 60

export const emptyLedger = (): TurnLedger => ({ next: 1, turns: [], agents: [], calls: [] })

/** The engine's words for how a turn ended. */
const TURN_ENDS: readonly TurnEnd[] = ['answer', 'aborted', 'refusal', 'error']
const isEnd = (v: unknown): v is TurnEnd => TURN_ENDS.includes(v as TurnEnd)

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

type Pairs = readonly (readonly [string, number])[]

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
function capped(l: TurnLedger): TurnLedger {
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

// ---------------------------------------------------------------- entries

type Lists = {
  readonly new: readonly TurnEntry[]
  readonly seen: readonly TurnEntry[]
  readonly moreNew?: number
  readonly moreSeen?: number
}

/** The entry with the stronger reason of the two. The first entry's `late` stays: it was told when it came. */
const stronger = (a: TurnEntry, b: TurnEntry): TurnEntry => (strongerReason(a.r, b.r) === a.r ? a : { ...a, r: b.r })

/** One entry into a list: a known key keeps its place and takes the stronger reason, else it goes last, up to the cap. */
function listed(list: readonly TurnEntry[], more: number, e: TurnEntry): { list: readonly TurnEntry[]; more: number } {
  const at = list.findIndex(x => x.k === e.k)
  if (at >= 0) {
    const next = stronger(list[at]!, e)
    return next === list[at] ? { list, more } : { list: list.map((x, i) => (i === at ? next : x)), more }
  }
  if (list.length >= MAX_ENTRIES) return { list, more: more + 1 }
  return { list: [...list, e], more }
}

/**
 * The sightings into the lists of one turn. An item that the turn added stays in `new` when a later claim of the turn
 * names it, with the stronger reason; it never moves to `seen`. An item the turn saw again counts once. A repeat (the
 * turn stamped the item before) only strengthens an entry that is listed, in `new` or in `seen`: an item that did not fit
 * a list was counted at its first sighting, and a repeat counts nothing more.
 */
export function withSightings(lists: Lists, s: Sightings, late: boolean): Lists {
  const mark = (e: TurnEntry): TurnEntry => (late ? { ...e, late: true } : e)
  const st = { fresh: lists.new, again: lists.seen, moreNew: lists.moreNew ?? 0, moreSeen: lists.moreSeen ?? 0 }
  for (const e of s.added.map(mark)) {
    const was = st.again.find(x => x.k === e.k)
    if (was !== undefined) st.again = st.again.filter(x => x.k !== e.k)
    const into = listed(st.fresh, st.moreNew, was === undefined ? e : stronger(was, e))
    st.fresh = into.list
    st.moreNew = into.more
  }
  for (const e of s.seen.map(mark)) {
    if (st.fresh.some(x => x.k === e.k)) {
      const into = listed(st.fresh, st.moreNew, e)
      st.fresh = into.list
      st.moreNew = into.more
    } else {
      const into = listed(st.again, st.moreSeen, e)
      st.again = into.list
      st.moreSeen = into.more
    }
  }
  for (const e of (s.repeat ?? []).map(mark)) {
    if (st.fresh.some(x => x.k === e.k)) st.fresh = listed(st.fresh, st.moreNew, e).list
    else if (st.again.some(x => x.k === e.k)) st.again = listed(st.again, st.moreSeen, e).list
  }
  const same =
    st.fresh === lists.new &&
    st.again === lists.seen &&
    st.moreNew === (lists.moreNew ?? 0) &&
    st.moreSeen === (lists.moreSeen ?? 0)
  if (same) return lists
  return {
    new: st.fresh,
    seen: st.again,
    ...(st.moreNew > 0 ? { moreNew: st.moreNew } : {}),
    ...(st.moreSeen > 0 ? { moreSeen: st.moreSeen } : {}),
  }
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

/** A capture that made no claim. */
export const NO_SIGHTINGS: Sightings = { added: [], seen: [] }

/** The capture named no item at all. */
export const isEmpty = (s: Sightings): boolean => s.added.length + s.seen.length + (s.repeat?.length ?? 0) === 0

/** The sightings of two captures: the entries of `a`, then those of `b`. */
export function joinSightings(a: Sightings, b: Sightings): Sightings {
  if (isEmpty(b)) return a
  const repeat = [...(a.repeat ?? []), ...(b.repeat ?? [])]
  return {
    added: [...a.added, ...b.added],
    seen: [...a.seen, ...b.seen],
    ...(repeat.length > 0 ? { repeat } : {}),
  }
}

/**
 * The sightings of one merge. Each key of `added`, `touched` and `repeated` becomes an entry: its category from the claim
 * that named it first, its reason the strongest of the claims that named it. Order: the order of the keys. `claims` are the
 * claims the merge took (dismissed keys and kinds that are off are out).
 */
export function sightingsOf(
  claims: readonly { readonly key: string; readonly category: string; readonly reason: CoreReason }[],
  added: readonly string[],
  touched: readonly string[],
  repeated: readonly string[] = [],
): Sightings {
  const entry = (k: string): TurnEntry[] => {
    const hits = claims.filter(c => c.key === k)
    const first = hits[0]
    if (first === undefined) return []
    return [{ k, c: first.category, r: hits.reduce<CoreReason>((r, c) => strongerReason(r, c.reason), first.reason) }]
  }
  const repeat = repeated.flatMap(entry)
  return { added: added.flatMap(entry), seen: touched.flatMap(entry), ...(repeat.length > 0 ? { repeat } : {}) }
}

// ---------------------------------------------------------------- reading

/** How many items a turn listed, with the ones that did not fit. */
export const countOf = (
  r: Pick<TurnRecord, 'new' | 'seen' | 'moreNew' | 'moreSeen'>,
): { added: number; seen: number } => ({
  added: r.new.length + (r.moreNew ?? 0),
  seen: r.seen.length + (r.moreSeen ?? 0),
})

/** The newest turn that tracked anything, the running one included. The band shows it. */
export function latestWithEntries(l: TurnLedger): TurnRecord | undefined {
  return [...l.turns].reverse().find(r => r.new.length + r.seen.length > 0)
}

/** The keys of a turn in the order it lists them: what it added, then what it saw again. */
export const keysOf = (r: Pick<TurnRecord, 'new' | 'seen'>): readonly string[] => [...r.new, ...r.seen].map(e => e.k)

// ---------------------------------------------------------------- the stored copy

/** What a session copy keeps: the records and the counters. A running turn, the pending prompt and a notice are not kept. */
export function persisted(l: TurnLedger): TurnLedger {
  return { next: l.next, turns: l.turns, agents: l.agents, calls: l.calls }
}

/**
 * The change from `a` to `b` touches a stored part, so the session copy is out of date. The pure rules return the same
 * list when they change none of it, so identity tells. A change of the running turn, the pending prompt or a notice
 * alone writes nothing worth a copy.
 */
export const persistedChanged = (a: TurnLedger, b: TurnLedger): boolean =>
  a.next !== b.next || a.turns !== b.turns || a.agents !== b.agents || a.calls !== b.calls

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const str = (v: unknown): v is string => typeof v === 'string'

function entryOf(v: unknown): TurnEntry | undefined {
  if (!isRecord(v) || !str(v.k) || !str(v.c) || !isCoreReason(v.r)) return undefined
  return { k: v.k, c: v.c, r: v.r as CoreReason, ...(v.late === true ? { late: true as const } : {}) }
}

const entriesOf = (v: unknown): TurnEntry[] =>
  (Array.isArray(v) ? v : []).flatMap(x => entryOf(x) ?? []).slice(0, MAX_ENTRIES)

/** A count that is more than 0, whole; else undefined. */
const some = (v: unknown): number | undefined => (num(v) && v >= 1 ? Math.floor(v) : undefined)

function recordFrom(v: unknown): TurnRecord | undefined {
  if (!isRecord(v) || !num(v.ord) || !str(v.turnId) || !str(v.session) || !num(v.startedAt)) return undefined
  const [moreNew, moreSeen, wakes] = [some(v.moreNew), some(v.moreSeen), some(v.wakes)]
  return {
    ord: v.ord,
    turnId: v.turnId,
    session: v.session,
    startedAt: v.startedAt,
    ...(num(v.endedAt) ? { endedAt: v.endedAt } : {}),
    ...(isEnd(v.end) ? { end: v.end } : {}),
    ...(str(v.prompt) && v.prompt !== '' ? { prompt: excerpt(v.prompt) } : {}),
    new: entriesOf(v.new),
    seen: entriesOf(v.seen),
    ...(moreNew !== undefined ? { moreNew } : {}),
    ...(moreSeen !== undefined ? { moreSeen } : {}),
    ...(wakes !== undefined ? { wakes } : {}),
  }
}

const pairsFrom = (v: unknown): Pairs =>
  (Array.isArray(v) ? v : [])
    .flatMap(p => (Array.isArray(p) && str(p[0]) && num(p[1]) ? [[p[0], p[1]] as const] : []))
    .slice(-MAX_MAPPED)

/**
 * A ledger from a stored value. The store holds JSON of a build, so the value is checked: a record or an entry that is
 * not well formed is dropped, the caps are applied again. undefined: not a ledger at all.
 */
export function ledgerFrom(v: unknown): TurnLedger | undefined {
  if (!isRecord(v) || !Array.isArray(v.turns)) return undefined
  const turns = v.turns.flatMap(r => recordFrom(r) ?? []).slice(-MAX_TURNS)
  const last = turns.at(-1)?.ord ?? 0
  return {
    next: Math.max(num(v.next) ? Math.floor(v.next) : 1, last + 1),
    turns,
    agents: pairsFrom(v.agents),
    calls: pairsFrom(v.calls),
  }
}

/**
 * Two ledgers of one lineage in one: `a` is the newer (the live one), so its record of a turn wins. The counters go on
 * from the larger. Used for `session.end`, for a carry over `/clear` and for a load. A running turn of `a` stays.
 */
export function joinLedgers(a: TurnLedger, b: TurnLedger): TurnLedger {
  const known = new Set(a.turns.map(r => r.turnId))
  const turns = [...a.turns, ...b.turns.filter(r => !known.has(r.turnId))].sort((x, y) => x.ord - y.ord)
  const out: TurnLedger = {
    ...a,
    next: Math.max(a.next, b.next),
    turns,
    agents: [...b.agents.filter(([k]) => !a.agents.some(([x]) => x === k)), ...a.agents],
    calls: [...b.calls.filter(([k]) => !a.calls.some(([x]) => x === k)), ...a.calls],
  }
  return capped(out)
}

/** A ledger that holds no turn. */
export const isBare = (l: TurnLedger): boolean => l.turns.length === 0
