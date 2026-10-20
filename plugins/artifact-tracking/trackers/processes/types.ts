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
  /** For task-backed rows. */
  taskId?: string
  toolUseId?: string
  /** The subagent or workflow agent whose Bash call started a task-backed row. Absent for the main loop. */
  agentId?: string
  /**
   * The engine ends this task at the final response of its caller and sends no notice
   * (`backgroundEndsWithFinalResponse` in the Bash result). The row ends as `killed` when that agent ends.
   */
  endsWithAgent?: true
  /** Docker container id for docker rows. */
  containerId?: string
  /** Docker compose project for compose rows. */
  project?: string
  /** Pid for detached process rows. */
  pid?: number
  /** Command fingerprint to defend against PID reuse. */
  fingerprint?: string
}

export type ProcessUiState = {
  breaker: BreakerState
  openUntil?: number
  dockerIssue?: string
}
