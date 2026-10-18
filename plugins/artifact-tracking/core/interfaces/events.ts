// Domain events the bus carries. Plain data: the hooks in register.tsx build them from engine events. Types only.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.5.
// Engine payloads (tool input, tool result, agent answer) travel as `Json`. The handler of a tracker parses them with guards.

import type { Json } from './items'

/** One conversation row. Capture reads it first. Then the trackers that declared its door see it. */
export interface RowEvent {
  /** The engine door: `prompt`, `command`, `response`, `tool-result`, ... */
  readonly door: string
  /** The engine's origin kind, e.g. `composer` or `task-notification`. `replay` for a row read back from the transcript. */
  readonly origin: string
  /** The loop that wrote the row. Absent for the main loop. */
  readonly agentId?: string
  /** The row is meta (the engine wrote it for the model, not the person). */
  readonly isMeta: boolean
  /** The row carries a message. A row without one has no text. */
  readonly hasMessage: boolean
  readonly text: string
  /** The task-notification payload of the row, when it has one. Untrusted: parse it with guards. */
  readonly task?: Json
}

/** One finished tool call. Dispatched by tool name. */
export interface ToolCallEvent {
  readonly tool: string
  /** The tool input. Untrusted: parse it with guards. */
  readonly input: Json
  /** The answer of `next(e)`, or the stored result on a replay. Untrusted: parse it with guards. */
  readonly result: Json
  readonly agentId?: string
  readonly toolUseId?: string
  /** The session cwd read before the tool ran. A persisted `cd` moves it during the run. */
  readonly cwdBefore?: string
}

/** A subagent or workflow agent started. */
export interface AgentSpawnEvent {
  /** The spawn input of `agent.spawn`. Untrusted. */
  readonly input: Json
  /** The answer of `next(e)`: the new agent id. Untrusted. */
  readonly answer: Json
  /** The session cwd read before the spawn. */
  readonly sessionCwd?: string
}

/** A turn ended. */
export interface TurnCompleteEvent {
  /** The `turn.complete` input: the reason and the loop. Untrusted. */
  readonly input: Json
}

/** The Scheduler beat. */
export interface TickEvent {
  /** Engine time, epoch ms. */
  readonly now: number
}

/** The start sequence reached the trackers. */
export interface StartEvent {
  readonly cwd?: string
  /** True when the plugin state held nothing: the first start of a session, not a reload. */
  readonly cold: boolean
}

/** SessionWatch saw a new session id. */
export interface SessionChangedEvent {
  readonly from: string
  readonly to: string
  /** `clear`: the items carry over. `resume`: the stored session loads. */
  readonly kind: 'clear' | 'resume'
}

/** A `/track <sub>` command that no core sub-command claimed. */
export interface CommandEvent {
  readonly sub: string
  readonly args: string
  /** True when the handler must await its work before the command answers (today `/track refresh` waits for the runs to end). */
  readonly wait: boolean
}

/** Row ids and item keys the person dismissed. */
export interface DismissedEvent {
  readonly ids: readonly string[]
}

/** One item of a transcript replay: a row or a tool call, in transcript order. */
export type ReplayItem = { kind: 'row'; ev: RowEvent } | { kind: 'toolCall'; ev: ToolCallEvent }
