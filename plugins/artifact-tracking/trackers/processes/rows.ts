// Process rows: how rows merge, and the writes the handlers make through the tracker's data slot.
// Moved out of hooks/register.tsx. The slot is one member of the `trackers` family, id `processes`.
// Plan: L3 Task 8.

import type { Json, JsonObject } from '../../core/interfaces/items'
import type { TrackerContext } from '../../core/interfaces/tracker'
import type { TurnPort } from '../../core/interfaces/turns'
import { stampedTurn, withSpan } from '../../core/lib/turn-span'
import type { ProcessesConfig } from './config'
import { ENDED_STATES, FAILED_STATES } from './states'
import { processSightings } from './turns'
import type { ProcessRecord, ProcessState } from './types'

/** What the writes need of a context: the data slot only. */
export type RowsCtx = Pick<TrackerContext<JsonObject, Json>, 'data'>

/** The update a task notice, a Monitor stop or a TaskStop gives: which row, and its new state. */
export type TaskUpdate = { taskId?: string; toolUseId?: string; state: ProcessRecord['state'] }

/**
 * The row in `state` as of `at`. An end state sets `endedAt` the first time the row is ended and keeps it after that. A
 * live state drops it. `more` sets other fields of the same write (the pid the probe found).
 */
export function withState(
  r: ProcessRecord,
  state: ProcessState,
  at: number,
  more: Partial<ProcessRecord> = {},
): ProcessRecord {
  const next: ProcessRecord = { ...r, ...more, state, lastSeen: at }
  if (!ENDED_STATES.has(state)) delete next.endedAt
  else next.endedAt = ENDED_STATES.has(r.state) ? (r.endedAt ?? at) : at
  return next
}

/**
 * A merged row with its `endedAt` set by the rule: a live row has none, and an ended row keeps the first time of its
 * ended copies (a copy that is live says nothing about the end). A row that is ended and has no time gets `now`, so a row
 * stored before `endedAt` existed can expire too.
 */
function endedBy(merged: ProcessRecord, copies: readonly (ProcessRecord | undefined)[], now: number): ProcessRecord {
  const next: ProcessRecord = { ...merged }
  if (!ENDED_STATES.has(merged.state)) {
    delete next.endedAt
    return next
  }
  const times = copies.flatMap(c =>
    c !== undefined && ENDED_STATES.has(c.state) && c.endedAt !== undefined ? [c.endedAt] : [],
  )
  next.endedAt = times.length > 0 ? Math.min(...times) : now
  return next
}

/** What the cap reads of the config: the row limit and the two TTLs. */
export type ProcessCap = Pick<ProcessesConfig, 'maxRows' | 'endedTtlMs' | 'failedTtlMs'>

/**
 * True for a row that is over and ended longer ago than its TTL: `failedTtlMs` for a failure, else `endedTtlMs`. A row
 * with no `endedAt` is never expired: the mod cannot date it. Rule: issue #49. `ENDED_STATES` names the end states.
 */
export function expired(r: ProcessRecord, cap: ProcessCap, now: number): boolean {
  if (!ENDED_STATES.has(r.state) || r.endedAt === undefined) return false
  return now - r.endedAt >= (FAILED_STATES.has(r.state) ? cap.failedTtlMs : cap.endedTtlMs)
}

/**
 * The ids of the rows over `cap.maxRows`. Only ended rows go, and a live row never does, so live rows alone may pass
 * `maxRows`. A row past its TTL (`expired`) goes before a row inside it, even before an older one. Within each group the
 * oldest end goes first, by `endedAt` (a row with none, by its first sighting). Two rows with the same time go by first
 * sighting, then by id, so the answer does not depend on the order of `rows`. The cap drops no more than the rows over
 * `maxRows`: the TTL orders the cut, it does not start one. Rule: issues #49 and #134. The merge and the view share it.
 */
export function overCap(rows: readonly ProcessRecord[], cap: ProcessCap, now: number): ReadonlySet<string> {
  const extra = rows.length - cap.maxRows
  if (extra <= 0) return new Set()
  const ended = rows.filter(r => ENDED_STATES.has(r.state))
  const endOf = (r: ProcessRecord) => r.endedAt ?? r.firstSeen
  const staleFirst = (r: ProcessRecord) => (expired(r, cap, now) ? 0 : 1)
  ended.sort(
    (a, b) =>
      staleFirst(a) - staleFirst(b) || endOf(a) - endOf(b) || a.firstSeen - b.firstSeen || a.id.localeCompare(b.id),
  )
  return new Set(ended.slice(0, extra).map(r => r.id))
}

/**
 * The old row as a new sighting of it leaves it. The new sighting wins field by field, except that the container id and its
 * mark go together and come from the new row alone (issue #231): a sighting with no id, or with an id that no run proved,
 * must not keep the old row's proof. `{ ...old, ...row }` alone would keep the old id when the new row has none.
 */
function sighted(old: ProcessRecord, row: ProcessRecord, now: number): ProcessRecord {
  const next: ProcessRecord = { ...old, ...row, firstSeen: old.firstSeen, lastSeen: now }
  if (row.containerId === undefined) delete next.containerId
  if (row.containerIdExact === undefined) delete next.containerIdExact
  return next
}

/**
 * Folds `added` into `cur` by id. A known row keeps its `firstSeen` and gets a new `lastSeen`. Oldest first. `endedAt`
 * follows `endedBy`: a live copy clears it, and two ended copies keep the first. `now` is the time of the merge: the new
 * `lastSeen`, and the `endedAt` of an ended row that has none. A caller with the engine clock passes it. The container id
 * and its mark (`containerIdExact`) are the new row's: a sighting that has none removes the old ones.
 *
 * `cap` caps the rows the merge keeps (issue #134): the rows over `maxRows` leave, by `overCap`. A live row never leaves.
 * A caller that stores the result passes the config of the tracker. No `cap`: no cap.
 */
export function mergeProcessRows(
  cur: ProcessRecord[],
  added: ProcessRecord[],
  now = Date.now(),
  cap?: ProcessCap,
): ProcessRecord[] {
  const byId = new Map(cur.map(r => [r.id, endedBy(r, [r], now)]))
  for (const row of added) {
    const old = byId.get(row.id)
    byId.set(
      row.id,
      old ? withSpan(endedBy(sighted(old, row, now), [old, row], now), old, row) : endedBy(row, [row], now),
    )
  }
  const rows = [...byId.values()].sort((a, b) => a.firstSeen - b.firstSeen || a.id.localeCompare(b.id))
  const over = cap === undefined ? undefined : overCap(rows, cap, now)
  return over !== undefined && over.size > 0 ? rows.filter(r => !over.has(r.id)) : rows
}

/** The slot value as rows. The family stores Json, so a value that is not a list reads as none. */
export const asRows = (v: Json | undefined): ProcessRecord[] =>
  Array.isArray(v) ? (v as unknown as ProcessRecord[]) : []

export async function readRows(ctx: RowsCtx): Promise<ProcessRecord[]> {
  return asRows(await ctx.data.get())
}

/** Changes the rows in the slot. The context's `persisted` signal arms the store write. */
export async function setProcesses(ctx: RowsCtx, change: (rows: ProcessRecord[]) => ProcessRecord[]): Promise<void> {
  await ctx.data.update(cur => change(asRows(cur)) as unknown as Json)
}

/**
 * Adds rows a Bash or Monitor call found. `cap` is the config of the tracker: the slot keeps no more rows than `maxRows` (see
 * `mergeProcessRows`). With `turn` (issue #133) the rows are stamped with its ordinal, and the ledger hears which rows the
 * call added and which it named again.
 */
export async function addProcessRows(
  ctx: RowsCtx,
  rows: ProcessRecord[],
  cap: ProcessCap,
  turn?: TurnPort,
): Promise<void> {
  if (rows.length === 0) return
  if (turn === undefined) return setProcesses(ctx, cur => mergeProcessRows(cur, rows, undefined, cap))
  const marked = rows.map(r => stampedTurn(r, turn.ord))
  let held: ProcessRecord[] = []
  await setProcesses(ctx, cur => {
    held = cur // the last run is the one that wrote: a write that missed its version runs again
    return mergeProcessRows(cur, marked, undefined, cap)
  })
  await turn.note(processSightings(turn.ord, marked, held))
}

/**
 * A loop ended. Its running tasks that the engine ends with the loop's final response (`endsWithAgent`) end as `killed`:
 * no notice follows them. `agentId` is undefined for the main loop (a headless session). A task of a background
 * subagent has no flag: it survives, and its notice comes later. Writes nothing when no row matches.
 */
export async function applyAgentEnd(ctx: RowsCtx, agentId: string | undefined, at: number): Promise<void> {
  const ends = (r: ProcessRecord) => r.state === 'running' && r.endsWithAgent === true && r.agentId === agentId
  if (!(await readRows(ctx)).some(ends)) return // a main turn ends often: no write for nothing
  await setProcesses(ctx, rows => rows.map(r => (ends(r) ? withState(r, 'killed', at) : r)))
}

/** Sets the state of the rows a task id or a tool use id names. Writes nothing when no row matches. */
export async function applyTaskUpdate(ctx: RowsCtx, u: TaskUpdate | null, at: number): Promise<void> {
  if (!u) return
  await setProcesses(ctx, rows => {
    let changed = false
    const next = rows.map(r => {
      const byTask = u.taskId !== undefined && r.taskId === u.taskId
      const byToolUse = u.toolUseId !== undefined && r.toolUseId === u.toolUseId
      if (!byTask && !byToolUse) return r
      changed = true
      return withState(r, u.state, at)
    })
    return changed ? next : rows
  })
}
