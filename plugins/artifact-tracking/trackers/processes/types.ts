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
   * made it, and the run has no redirection of its output (also after a bare `exec`), no pipe after it and no substitution
   * around it. Absent: the id is not proven, or the row has none. A row from an older build has no mark. A new sighting of the
   * row replaces the id and the mark together, also with none (`mergeProcessRows`). Code that acts on the id, such as a
   * `docker rm`, must trust a row with this mark only.
   *
   * The mark means "paired by the rules", not "checked with Docker". The parser has known limits where a row gets an id that
   * another command printed: a run that failed or never ran, a trailing `&`, and a function called with a redirection (KB page
   * process-tracking-signals, "The id of a container"). Code that removes a container must also check it, for example with
   * `docker inspect <id>` and a name or label that equals the row's. A row with no `--name` has no name to check, so `/track
   * clean --yes containers` never removes it. A row whose run was not the whole Bash call (`containerRunAlone`) is never removed either.
   */
  containerIdExact?: true
  /**
   * The whole Bash call was this one `docker run -d` and nothing else (issue #123, review of PR 285). The parser sets it only for
   * a lone command: the call has one simple command at the top level, which is a detached `docker run` with `docker` as its head (no
   * wrapper such as `env`, `command`, `sudo` or `time` before it, and no leading assignment); no `;`, `&&`, `||`, `|` or `&`; no line
   * break that a backslash does not continue outside single quotes (in single quotes `\<newline>` keeps both characters); no
   * redirection of any kind; and no `$(`, backtick, `${` or `$'` anywhere in the raw text, in quotes or not. Anything else
   * withholds it. Bash can put any text, an id too, on a bare line of the tool result (a trace,
   * the message of a builtin that failed on an operand, of a failed redirection or of a failed expansion), and no list of commands
   * that print nothing can be proven, so the rule does not try. Then the one id line can only be the run's own, so the known limits
   * of `containerIdExact` (a run that failed or never ran, while another command printed an id) cannot give the row an id that is
   * not its run's. The parser sets it beside `containerIdExact` and never without it. It goes with the id: a new sighting replaces
   * both, also with none (`mergeProcessRows`). Absent: the call was more than that one command, or the row is from an older build.
   * A row with a `--name` is not enough for `/track clean --yes containers`, because Docker keeps names unique: the run that failed
   * on a taken name pairs with the id of the old container that holds it, and that container has the name of the row. So the apply
   * needs this mark.
   */
  containerRunAlone?: true
  /**
   * The container of `containerId` no longer exists (issue #123). The probe sets it when no line of `docker ps -a --no-trunc` has
   * the id of the row (a `--rm` container, or one that was removed by hand), and drops it when a line has it again. A listing
   * that the runner cut proves no absence: it sets no mark and leaves each mark as it was. `/track
   * clean --yes containers` sets it after its own `docker rm` and when Docker says `No such container`. The plan has no step for
   * such a row, so a gone container is not tried on each `--yes`. A new sighting that is live drops it (`mergeProcessRows`): a
   * `docker run -d` of the same row id makes a new container. The row keeps its state until its TTL.
   */
  containerGone?: true
  /** Docker compose project for compose rows. */
  project?: string
  /** Pid for detached process rows. */
  pid?: number
  /** Command fingerprint to defend against PID reuse. */
  fingerprint?: string
  /**
   * The first and the last turn whose Bash or Monitor call started or named the row, or whose TaskStop stopped it (issues
   * #133, #204). Absent: no turn stamped it (a row from before the lineage, or one started outside a turn). A state change
   * that no action of the turn made (a task notice, the probe, a TaskStop that a plugin raised) stamps nothing.
   */
  firstTurn?: number
  lastTurn?: number
}

export type ProcessUiState = {
  breaker: BreakerState
  openUntil?: number
  dockerIssue?: string
}
