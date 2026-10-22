// The answer of the engine's TaskStop as one `StopResult` (issue #122). Pure. The shapes are the ones the design study of
// #49 saw live (S2): a record `{ message, task_id, ... }` on success; a string `Error: ...` with `isError` when the task is
// unknown or not running; `{ deny }` when a hook refuses the call.

import type { StopResult } from '../interfaces/ports'
import { isRecord } from './json'
import { firstLine } from './text'

/** What of a `tool.call` answer the rule reads. */
export interface StopAnswer {
  readonly deny?: string
  readonly result?: unknown
  readonly text?: string
  readonly isError?: boolean
}

/** The longest reason the plan and the log keep. */
const MAX_REASON = 200

/** `Error: x` and `<tool_use_error>x</tool_use_error>` as `x`, on one line, at most `MAX_REASON` characters. */
function reasonOf(raw: string): string {
  const bare = firstLine(raw.replace(/<\/?tool_use_error>/g, '')).replace(/^Error:\s*/, '')
  if (bare === '') return 'TaskStop failed'
  return bare.length > MAX_REASON ? `${bare.slice(0, MAX_REASON - 1)}…` : bare
}

/**
 * A stop needs the proof that the processes tracker's own TaskStop hook needs (`processUpdateFromTaskStop`): a record with a
 * `task_id`, and the id must be the one the call asked for (`taskId`). An answer with no `deny`, no `isError` and no such
 * record is not a stop, so the row never reads `killed` for a task that may still run. A record that names another task (a
 * hook of another plugin can answer a call with a record of its own) is no stop of this one. The reason names no id: the
 * text is from another party.
 */
export function stopResultOf(a: StopAnswer | undefined, taskId: string): StopResult {
  if (a == null) return { stopped: false, reason: 'TaskStop gave no answer' }
  if (a.deny !== undefined) return { stopped: false, reason: reasonOf(a.deny) }
  if (a.isError === true)
    return { stopped: false, reason: reasonOf(typeof a.result === 'string' ? a.result : (a.text ?? '')) }
  const id = isRecord(a.result) ? a.result.task_id : undefined
  if (typeof id !== 'string' || id === '') return { stopped: false, reason: 'TaskStop did not confirm the stop' }
  return id === taskId ? { stopped: true } : { stopped: false, reason: 'TaskStop named another task' }
}
