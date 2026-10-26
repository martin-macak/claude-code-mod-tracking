// The slot record types of the processes tracker. Moved from the shared contract in plan L5, Task 1.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.13.

import type { BreakerState } from '../../core/interfaces/tracker'

export type ProcessKind =
  | 'background-task'
  | 'monitor'
  | 'docker-container'
  | 'docker-compose'
  | 'tmux'
  | 'screen'
  | 'detached-process'

/** `unknown`: a detached process whose command names a variable that the mod could not expand, and none was found. */
export type ProcessState = 'running' | 'up' | 'completed' | 'failed' | 'killed' | 'exited' | 'unhealthy' | 'unknown'

export type ProcessRecord = {
  /** Dedupe key. */
  id: string
  kind: ProcessKind
  /** Command, container, compose project or session name. */
  name: string
  state: ProcessState
  firstSeen: number
  lastSeen: number
  /**
   * When the row entered an end state (`ENDED_STATES`, trackers/processes/states.ts). Absent while it is live. The first time stays while it remains ended.
   * `lastSeen` cannot serve: every merge moves it.
   */
  endedAt?: number
  /** For task-backed rows. */
  taskId?: string
  toolUseId?: string
  /** The subagent or workflow agent whose Bash or Monitor call started a task-backed row. Absent for the main loop. */
  agentId?: string
  /**
   * The engine ends this task at the final response of its caller and sends no notice. For a Bash task the result says so
   * (`backgroundEndsWithFinalResponse`). For a Monitor, the caller is a workflow agent (issue #118): no result says so.
   * The row ends as `killed` when that agent ends.
   */
  endsWithAgent?: true
  /** Docker container id for docker rows. */
  containerId?: string
  /**
   * The `containerId` is the id that this row's own `docker run -d` printed (issue #231). The parser sets it only when the id
   * lines of the tool result pair one to one with the runs whose output reaches it, or every id line is one id and one such run
   * made it, and the run has no redirection of its output, no pipe after it and no substitution around it. Absent: the id is
   * not proven, or the row has none. A row from an older build has no mark. A new sighting of the row replaces the id and
   * the mark together, also with none (`mergeProcessRows`). Code that acts on the id, such as a `docker rm`, must trust a row with
   * this mark only.
   */
  containerIdExact?: true
  /** Docker compose project for compose rows. */
  project?: string
  /** Pid for detached process rows. */
  pid?: number
  /** Command fingerprint to defend against PID reuse. */
  fingerprint?: string
  /**
   * The first and the last turn whose Bash or Monitor call started or named the row (issue #133). Absent: no turn stamped it
   * (a row from before the lineage, or one started outside a turn). A state change stamps nothing.
   */
  firstTurn?: number
  lastTurn?: number
}

export type ProcessUiState = {
  breaker: BreakerState
  openUntil?: number
  dockerIssue?: string
}
