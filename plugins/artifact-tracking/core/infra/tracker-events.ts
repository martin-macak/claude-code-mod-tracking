// The handlers a tracker declares in `events`, as a flat list of bus entries: one per event kind, per tool of a
// `toolCall` map, per door of a `row` and per name of a `facts` map. TrackerHost adds them to the bus in this order. A new
// event kind is one line here and one in `bus.ts`. It names no tracker and holds no `$`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.5. Plan: L3 Task 8, D11. L5 Task 11, K14.

import type { TickEvent } from '../interfaces/events'
import type { Json, JsonObject } from '../interfaces/items'
import type { Handler, TrackerEvents } from '../interfaces/tracker'
import type { BusKind } from './bus'

/** What the bus filters by: the tools of a `toolCall`, the doors of a `row`, the names of a `fact`. */
export type DeclaredFilter = { tools?: string[]; doors?: string[]; names?: string[] }

/** One handler for one bus kind. `run` takes the tracker's context and the event of that kind. */
export type Declared = { kind: BusKind; run: Handler<JsonObject, Json, unknown>; filter?: DeclaredFilter }

/** `due(everyMs, now)` answers for one tracker whether its period is over (the Scheduler). */
export type Due = (everyMs: number, now: number) => boolean

export function declaredHandlers(ev: TrackerEvents, due: Due): Declared[] {
  const out: Declared[] = []
  const add = <E>(kind: BusKind, run: Handler<JsonObject, Json, E>, filter?: DeclaredFilter) =>
    void out.push({ kind, run: run as Handler<JsonObject, Json, unknown>, filter })
  if (ev.start) add('start', ev.start)
  if (ev.row) add('row', ev.row.run, { doors: [...ev.row.doors] })
  for (const [tool, run] of Object.entries(ev.toolCall ?? {})) add('toolCall', run, { tools: [tool] })
  if (ev.agentSpawn) add('agentSpawn', ev.agentSpawn)
  if (ev.turnComplete) add('turnComplete', ev.turnComplete)
  if (ev.sessionChanged) add('sessionChanged', ev.sessionChanged)
  if (ev.command) add('command', ev.command)
  if (ev.dismissed) add('dismissed', ev.dismissed)
  if (ev.replay) add('replay', ev.replay)
  for (const [name, run] of Object.entries(ev.facts ?? {})) add('fact', run, { names: [name] })
  const tick = ev.tick
  if (tick)
    add<TickEvent>('tick', async (ctx, e) => {
      const everyMs = tick.everyMs?.(ctx.config.slice()) ?? ctx.config.global().refresh.tickMs
      if (due(everyMs, e.now)) await tick.run(ctx, e)
    })
  return out
}
