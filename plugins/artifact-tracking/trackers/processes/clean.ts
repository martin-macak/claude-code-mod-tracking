// `/track clean` for background tasks (issue #122): the cleanup of the processes tracker. The plan lists each running
// background Bash task for a TaskStop. `--yes tasks` stops them one by one through the narrow `tasks.stop` port and marks
// the row `killed` itself: the mod's own TaskStop hook may see the call too, but nothing proves it from inside a `/track` run, and the two writes are the same (the first end time stays). A Monitor task is
// listed and skipped: its stop is not tested (design study of #49, R11b). Docker, tmux, screen and detached processes are not
// touched: the study found no proof of who owns them.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.12. Design study: issue #49, R11a.

import type { CleanResult, CleanStep, Cleanup } from '../../core/interfaces/clean'
import type { Json } from '../../core/interfaces/items'
import type { StopResult } from '../../core/interfaces/ports'
import type { ProcessesConfig } from './config'
import { applyTaskUpdate, asRows, readRows } from './rows'
import type { ProcessRecord } from './types'

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The step of a running task row. A row with no task id or a Monitor row is listed with the reason it is not stopped. */
function stepOf(r: ProcessRecord): CleanStep | undefined {
  if (r.state !== 'running' || (r.kind !== 'background-task' && r.kind !== 'monitor')) return undefined
  const base = { kind: 'tasks', id: r.id, label: r.name, action: 'stop' } as const
  if (r.kind === 'monitor') return { ...base, skip: 'a Monitor task is not stopped yet' }
  return r.taskId === undefined || r.taskId === '' ? { ...base, skip: 'no task id' } : base
}

export const processesCleanup: Cleanup<ProcessesConfig, Json> = {
  plan: ctx => asRows(ctx.data).flatMap(r => stepOf(r) ?? []),

  async apply(ctx, steps) {
    const rows = await readRows(ctx)
    const out: CleanResult[] = []
    for (const step of steps) {
      // The row is read again: a step is judged on the row of now, and only its own task id goes to the port.
      const taskId = rows.find(r => r.id === step.id)?.taskId
      if (taskId === undefined || taskId === '') {
        out.push({ id: step.id, outcome: 'skipped: the row is gone' })
        continue
      }
      if (ctx.tasks === undefined) {
        out.push({ id: step.id, outcome: 'skipped: no task port' })
        continue
      }
      let stopped: StopResult
      try {
        stopped = await ctx.tasks.stop(taskId)
      } catch (e) {
        out.push({ id: step.id, outcome: `skipped: ${reason(e)}` })
        continue
      }
      if (!stopped.stopped) {
        out.push({ id: step.id, outcome: `skipped: ${stopped.reason}` })
        continue
      }
      // The task is stopped. A refused row write does not undo that: the task notice, or the next TaskStop answer, fixes the row.
      try {
        await applyTaskUpdate(ctx, { taskId, state: 'killed' }, ctx.clock.wall())
      } catch (e) {
        ctx.log(`processes: row of ${step.id} not marked killed: ${reason(e)}`)
      }
      out.push({ id: step.id, outcome: 'done' })
    }
    return out
  },
}
