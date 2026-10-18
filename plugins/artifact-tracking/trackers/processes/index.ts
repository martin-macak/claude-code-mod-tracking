// The processes tracker: background Bash tasks, Monitor runs, Docker, tmux, screen and detached processes.
// It reads the Bash, Monitor and TaskStop tool calls and the task notices, keeps its rows in its own slot, and probes
// them on the tick and on `/track`. It publishes the probe state as the fact `processes.ui`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.8. Plan: L3 Task 8.

import { CircuitBreaker } from '../../core/infra/circuit-breaker'
import type { CommandEvent, RowEvent, ToolCallEvent } from '../../core/interfaces/events'
import type { Json } from '../../core/interfaces/items'
import type { Handler, Tracker } from '../../core/interfaces/tracker'
import { isRecord } from '../../core/lib/json'
import { type ProcessesConfig, processesConfig } from './config'
import {
  monitorRow,
  parseBashProcesses,
  processUpdateFromNotification,
  processUpdateFromNotificationText,
  processUpdateFromTaskStop,
} from './parse'
import { addProcessRows, applyTaskUpdate, asRows, mergeProcessRows, setProcesses } from './rows'
import { type ProbeState, probeProcesses } from './watch'

export { type ProcessesConfig, processesConfig }

type H<E> = Handler<ProcessesConfig, Json, E>

/**
 * The tracker is built once per load, so its breaker lives as long as the load (plan decision D16). The breaker numbers
 * come from `global.tools.breaker`, read once, at `init`: the breaker is an object that holds them (decision C5).
 */
export function processesTracker(): Tracker<ProcessesConfig, Json> {
  let state: ProbeState | undefined
  const live = (b?: { threshold: number; openMs: number }): ProbeState => {
    state ??= { breaker: b ? new CircuitBreaker(b.threshold, b.openMs) : new CircuitBreaker() }
    return state
  }

  // A task notice completes the task-backed row. The person can type the same text, so only the origin counts.
  const onRow: H<RowEvent> = (ctx, ev) => {
    if (ev.origin !== 'task-notification') return
    return applyTaskUpdate(
      ctx,
      processUpdateFromNotification(ev.task) ?? processUpdateFromNotificationText(ev.text),
      ctx.clock.wall(),
    )
  }

  // The Bash input has no cwd. A compose project without -p is named after a folder, and a relative `cd` needs a base.
  const onBash: H<ToolCallEvent> = (ctx, ev) => {
    const command = String(isRecord(ev.input) ? (ev.input.command ?? '') : '')
    return addProcessRows(ctx, parseBashProcesses(command, ev.result, ev.toolUseId, ctx.clock.wall(), ev.cwdBefore))
  }

  const onMonitor: H<ToolCallEvent> = (ctx, ev) => {
    const result = isRecord(ev.result) && isRecord(ev.result.result) ? ev.result.result : undefined
    const taskId = result?.taskId
    if (typeof taskId !== 'string' || taskId === '') return
    return addProcessRows(ctx, [monitorRow(taskId, ctx.clock.wall(), ev.toolUseId)])
  }

  const onTaskStop: H<ToolCallEvent> = (ctx, ev) =>
    applyTaskUpdate(
      ctx,
      processUpdateFromTaskStop(isRecord(ev.result) ? ev.result.result : undefined),
      ctx.clock.wall(),
    )

  const onTick: H<unknown> = ctx => probeProcesses(ctx, live())

  // `/track` probes. `/track refresh` lets an open breaker try again first.
  const onCommand: H<CommandEvent> = (ctx, ev) => {
    if (ev.sub === 'refresh') live().breaker.reset()
    else if (ev.sub !== '') return
    return probeProcesses(ctx, live())
  }

  return {
    id: 'processes',
    order: 80,
    config: processesConfig,
    init: ctx => {
      live(ctx.config.global().tools.breaker) // builds the breaker once; a second init keeps it
    },
    store: ctx => ctx.config.slice(),
    data: {
      empty: v => !Array.isArray(v) || v.length === 0,
      settle: async (_ctx, liveRows, stored) => mergeProcessRows(asRows(stored), asRows(liveRows)) as unknown as Json,
      restore: async (ctx, value, how) => {
        const rows = asRows(value)
        if (rows.length > 0)
          await setProcesses(ctx, cur => (how === 'carry' ? mergeProcessRows(rows, cur) : mergeProcessRows(cur, rows)))
      },
      clear: ctx => setProcesses(ctx, () => []),
    },
    events: {
      row: { doors: ['prompt'], run: onRow },
      toolCall: { Bash: onBash, Monitor: onMonitor, TaskStop: onTaskStop },
      tick: { run: onTick },
      command: onCommand,
    },
  }
}
