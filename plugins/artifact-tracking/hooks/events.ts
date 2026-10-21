// Engine inputs to domain events. Pure: no `$`, no I/O. register.tsx builds the event and hands it to the manager,
// so no tracker ever sees an engine shape. The engine payloads travel as Json and each handler parses them with guards.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.3 and 5.5. Plan: L3 Task 8.

import type {
  AgentSpawnEvent,
  RowEvent,
  ToolCallEvent,
  TurnCompleteEvent,
  TurnStartEvent,
} from '../core/interfaces/events'
import type { Json } from '../core/interfaces/items'
import { textOfContent } from '../core/lib/links'

/** The parts of a `session.append` input that the row event reads. */
type AppendIn = { door: string; origin: { kind: string }; agentId?: string }
/** The parts of its stored result: `message` is absent when a hook refused the row. */
type AppendOut = { message?: { isMeta?: boolean; content: unknown } }

/**
 * One appended row. `stored` is the answer of `next(e)`: the text and the meta flag are the row as it was kept.
 * `task` is the task-notification payload some engine builds put on the input.
 */
export function rowEvent(e: AppendIn, stored: AppendOut): RowEvent {
  const message = stored.message
  const task = (e as { task?: Json }).task
  return {
    door: e.door,
    origin: e.origin.kind,
    ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
    isMeta: message?.isMeta === true,
    hasMessage: message !== undefined,
    text: message ? textOfContent(message.content) : '',
    ...(task !== undefined ? { task } : {}),
  }
}

/**
 * One finished tool call. `e` is the whole input (the tool's own arguments sit beside `tool`), `ran` the answer of
 * `next(e)`. `cwdBefore` is the session cwd read before the call ran: a persisted `cd` moves it during the run.
 */
export function toolCallEvent(
  e: { tool: string; agentId?: string; tool_use_id?: string },
  ran: unknown,
  cwdBefore: string | undefined,
): ToolCallEvent {
  return {
    tool: e.tool,
    input: e as unknown as Json,
    result: (ran ?? null) as Json,
    ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
    ...(e.tool_use_id !== undefined ? { toolUseId: e.tool_use_id } : {}),
    ...(cwdBefore !== undefined ? { cwdBefore } : {}),
  }
}

/** A subagent or workflow agent started. `out` is the answer of `next(e)`: it names the new agent. */
export function spawnEvent(e: unknown, out: unknown, sessionCwd: string | undefined): AgentSpawnEvent {
  return {
    input: e as Json,
    answer: (out ?? null) as Json,
    ...(sessionCwd !== undefined ? { sessionCwd } : {}),
  }
}

/** A main-loop turn began. The hook passes the main loop only: `e.agentId` is absent. */
export function turnStartEvent(e: { turnId: string; text: string }): TurnStartEvent {
  return { turnId: e.turnId, text: typeof e.text === 'string' ? e.text : '' }
}

/** A turn ended. `durationRow` is the uuid of its `turn_duration` row, when the row hook noted one. */
export function turnEvent(e: unknown, durationRow?: string): TurnCompleteEvent {
  return { input: e as Json, ...(durationRow !== undefined ? { durationRow } : {}) }
}
