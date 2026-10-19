// Domain events the bus carries. Plain data: the hooks in register.tsx build them from engine events. Types only.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.5.
// `tick` has no payload. A tracker declares it as `events.tick` in `Tracker`.

/** One conversation row. Capture reads it first. Then the trackers that declared its door see it. */
export interface RowEvent {
  /** The engine door: `prompt`, `command`, `response`, `tool-result`, ... */
  readonly door: string
  readonly text: string
  /** The engine's origin kind, e.g. `composer` or `task-notification`. `replay` for a row read back from the transcript. */
  readonly origin: string
  /** The loop that wrote the row. Absent for the main loop. */
  readonly agentId?: string
}

/** One finished tool call. Dispatched by tool name. */
export interface ToolCallEvent {
  readonly tool: string
  /** The tool input. Untrusted: parse it with guards. */
  readonly input: Readonly<Record<string, unknown>>
  /** The answer of `next(e)`, or the stored result on a replay. Untrusted: parse it with guards. */
  readonly result: unknown
  readonly agentId?: string
  /** The session cwd read before the tool ran. A persisted `cd` moves it during the run. */
  readonly cwdBefore?: string
}

/** A subagent or workflow agent started. */
export interface AgentSpawnEvent {
  /** The id `next(e)` answered. */
  readonly agentId: string
  readonly description: string
  readonly subagentType: string
  readonly name?: string
  /** The loop that spawned it. Absent: the main loop. */
  readonly parentAgentId?: string
  readonly workflow?: { readonly runId: string; readonly agentIndex: number }
  readonly cwd?: string
  /** The session cwd read before the spawn. */
  readonly cwdBefore?: string
  /** True for a resumed agent, not a new one. */
  readonly resume?: boolean
}

/** A turn ended. */
export interface TurnCompleteEvent {
  readonly reason: 'answer' | 'aborted' | 'refusal' | 'error'
  /** The loop that ended the turn. Absent for the main loop. */
  readonly agentId?: string
}

/** SessionWatch saw a new session id. */
export interface SessionChangedEvent {
  readonly oldId: string
  readonly newId: string
  /** `clear`: the items carry over. `resume`: the stored session loads. */
  readonly kind: 'clear' | 'resume'
}

/** A `/track <sub>` command that no core sub-command claimed. */
export interface CommandEvent {
  readonly sub: string
  readonly args: string
}
