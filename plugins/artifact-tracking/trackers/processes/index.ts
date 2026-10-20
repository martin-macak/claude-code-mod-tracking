// The processes tracker: background Bash tasks, Monitor runs, Docker, tmux, screen and detached processes.
// It reads the Bash, Monitor and TaskStop tool calls and the task notices, keeps its rows in its own slot, and probes
// them on the tick and on `/track`. It publishes the probe state as the fact `processes.ui`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.8. Plan: L3 Task 8.

import type { CommandEvent, RowEvent, ToolCallEvent, TurnCompleteEvent } from '../../core/interfaces/events'
import type { Json } from '../../core/interfaces/items'
import type { Traceable } from '../../core/interfaces/reasons'
import type { Handler, Tracker } from '../../core/interfaces/tracker'
import { CircuitBreaker } from '../../core/lib/circuit-breaker'
import { isRecord } from '../../core/lib/json'
import { type LoadKey, LoadState } from '../../core/lib/load-state'
import { type ProcessesConfig, processesConfig } from './config'
import {
  monitorRow,
  parseBashProcesses,
  processUpdateFromNotification,
  processUpdateFromNotificationText,
  processUpdateFromTaskStop,
} from './parse'
import { processReasonsOf } from './reasons'
import { addProcessRows, applyAgentEnd, applyTaskUpdate, asRows, mergeProcessRows, setProcesses } from './rows'
import { sections } from './sections'
import { type ProbeState, probeProcesses } from './watch'

export { type ProcessesConfig, processesConfig }

type H<E> = Handler<ProcessesConfig, Json, E>

/**
 * The breaker lives as long as the load (plan decision D16), so it is kept per load: the tracker is a module constant
 * (`TRACKERS`). The breaker numbers come from `global.tools.breaker`, read once, at `init`: the breaker is an object that
 * holds them (decision C5).
 */
const probes = new LoadState<ProbeState>()
const probeOf = (ctx: LoadKey, b?: { threshold: number; openMs: number }): ProbeState =>
  probes.of(ctx, () => ({ breaker: b ? new CircuitBreaker(b.threshold, b.openMs) : new CircuitBreaker() }))

export function processesTracker(): Tracker<ProcessesConfig, Json> & Traceable<Json> {
  // A task notice completes the task-backed row. The person can type the same text, so only the origin counts.
  // The engine gives the notice by one of two doors. `prompt`: the session was idle. `delivery`: a turn was running, so
  // the engine folded the notice into it, as an attachment row (Claude Code 2.1.304, issue #56). The queue repeats the text
  // with the origin `engine`; it is not read. A subagent's notice comes the same way, with its agent id.
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
    return addProcessRows(
      ctx,
      parseBashProcesses(command, ev.result, {
        toolUseId: ev.toolUseId,
        at: ctx.clock.wall(),
        cwd: ev.cwdBefore,
        agentId: ev.agentId,
      }),
    )
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

  // A loop ended: its tasks that end with it get no notice. `agentId` is absent for the main loop. An id that is not a
  // string is a shape this build does not give: the handler leaves the rows alone then.
  const onTurnComplete: H<TurnCompleteEvent> = (ctx, ev) => {
    if (!isRecord(ev.input)) return
    const id = ev.input.agentId
    if (id !== undefined && (typeof id !== 'string' || id === '')) return
    return applyAgentEnd(ctx, id, ctx.clock.wall())
  }

  const onTick: H<unknown> = ctx => probeProcesses(ctx, probeOf(ctx))

  // `/track` probes. `/track refresh` lets an open breaker try again first.
  const onCommand: H<CommandEvent> = (ctx, ev) => {
    if (ev.sub === 'refresh') probeOf(ctx).breaker.reset()
    else if (ev.sub !== '') return
    return probeProcesses(ctx, probeOf(ctx))
  }

  return {
    id: 'processes',
    order: 80,
    config: processesConfig,
    init: ctx => {
      probeOf(ctx, ctx.config.global().tools.breaker) // builds the breaker once; a second init keeps it
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
    sections,
    reasonsOf: processReasonsOf,
    events: {
      row: { doors: ['prompt', 'delivery'], run: onRow },
      toolCall: { Bash: onBash, Monitor: onMonitor, TaskStop: onTaskStop },
      turnComplete: onTurnComplete,
      tick: { run: onTick },
      command: onCommand,
    },
  }
}
