// Process rows: how rows merge, and the writes the handlers make through the tracker's data slot.
// Moved out of hooks/register.tsx. The slot is one member of the `trackers` family, id `processes`.
// Plan: L3 Task 8.

import type { Json, JsonObject } from '../../core/interfaces/items'
import type { TrackerContext } from '../../core/interfaces/tracker'
import type { ProcessRecord } from './types'

/** What the writes need of a context: the data slot only. */
export type RowsCtx = Pick<TrackerContext<JsonObject, Json>, 'data'>

/** The update a task notice, a Monitor stop or a TaskStop gives: which row, and its new state. */
export type TaskUpdate = { taskId?: string; toolUseId?: string; state: ProcessRecord['state'] }

/** Folds `added` into `cur` by id. A known row keeps its `firstSeen` and gets a new `lastSeen`. Oldest first. */
export function mergeProcessRows(cur: ProcessRecord[], added: ProcessRecord[]): ProcessRecord[] {
  if (added.length === 0) return cur
  const now = Date.now()
  const byId = new Map(cur.map(r => [r.id, r]))
  for (const row of added) {
    const old = byId.get(row.id)
    byId.set(
      row.id,
      old
        ? {
            ...old,
            ...row,
            firstSeen: old.firstSeen,
            lastSeen: now,
          }
        : row,
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
  await setProcesses(ctx, rows => rows.map(r => (ends(r) ? { ...r, state: 'killed', lastSeen: at } : r)))
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
      return { ...r, state: u.state, lastSeen: at }
    })
    return changed ? next : rows
  })
}
