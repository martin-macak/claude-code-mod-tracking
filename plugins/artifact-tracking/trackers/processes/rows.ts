// Process rows: how rows merge, and the writes the handlers make through the tracker's data slot.
// Moved out of hooks/register.tsx. The slot is one member of the `trackers` family, id `processes`.
// Plan: L3 Task 8.

import type { Json, JsonObject } from '../../core/interfaces/items'
import type { TrackerContext } from '../../core/interfaces/tracker'
import { ENDED_STATES } from './states'
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

/**
 * Folds `added` into `cur` by id. A known row keeps its `firstSeen` and gets a new `lastSeen`. Oldest first. `endedAt`
 * follows `endedBy`: a live copy clears it, and two ended copies keep the first. `now` is the time of the merge: the new
 * `lastSeen`, and the `endedAt` of an ended row that has none. A caller with the engine clock passes it.
 */
export function mergeProcessRows(cur: ProcessRecord[], added: ProcessRecord[], now = Date.now()): ProcessRecord[] {
  const byId = new Map(cur.map(r => [r.id, endedBy(r, [r], now)]))
  for (const row of added) {
    const old = byId.get(row.id)
    byId.set(
      row.id,
      old
        ? endedBy({ ...old, ...row, firstSeen: old.firstSeen, lastSeen: now }, [old, row], now)
        : endedBy(row, [row], now),
    )
  }
  return [...byId.values()].sort((a, b) => a.firstSeen - b.firstSeen || a.id.localeCompare(b.id))
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

export async function addProcessRows(ctx: RowsCtx, rows: ProcessRecord[]): Promise<void> {
  if (rows.length === 0) return
  await setProcesses(ctx, cur => mergeProcessRows(cur, rows))
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
