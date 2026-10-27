// The cleanup contract of `/track clean` (issue #122, phase P2 of #49). A tracker plans what a cleanup would do from its view
// (pure), and applies the steps the person confirmed with `--yes <kind>`. Core runs both, prints the plan and keeps the
// audit log. Types only.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.12. Design study: issue #49, section 5.3.

import type { Json, JsonObject } from './items'
import type { TrackerContext } from './tracker'
import type { ViewContext } from './view'

/**
 * What `--yes` names. `tasks`: background tasks that still run. `containers`: Docker containers of this run that have exited
 * (switch `destroyContainers`, issue #123). `worktrees`: git records of worktrees that are gone from disk, and (switch
 * `destroyWorktrees`) clean, merged worktrees that are still there. A kind that joins the list is a compile error in the
 * places that switch over it.
 */
export type CleanKind = 'tasks' | 'containers' | 'worktrees'

/**
 * `stop`: stop a background task. `remove-record`: remove the git record of a worktree whose directory is gone.
 * `remove-worktree`: remove a live worktree that is clean and merged. `remove-container`: remove an exited container
 * (`docker rm`, issue #123).
 */
export type CleanAction = 'stop' | 'remove-record' | 'remove-worktree' | 'remove-container'

/** One thing a cleanup would do. */
export interface CleanStep {
  readonly kind: CleanKind
  /** The row id: the key of the log entry. Never a command line. */
  readonly id: string
  /** The words of the plan line. It may hold a command line, so it is shown and never logged. */
  readonly label: string
  readonly action: CleanAction
  /** Why the step is not taken. A step with a reason is listed in the plan and never applied. */
  readonly skip?: string
}

/** What one applied step gave. `outcome` is `done`, or `skipped: <reason>` when the step did not change anything. */
export interface CleanResult {
  readonly id: string
  readonly outcome: string
}

/**
 * The cleanup part of a tracker. `plan` is pure: it reads the view context and runs nothing. `apply` runs only after `--yes`,
 * with the steps of the named kinds that have no `skip`. It re-checks each step against the world, never stops at one
 * failure, and answers one result for each step.
 */
export interface Cleanup<C extends JsonObject = JsonObject, D extends Json = Json> {
  plan(ctx: ViewContext<C, D>): readonly CleanStep[]
  apply(ctx: TrackerContext<C, D>, steps: readonly CleanStep[]): Promise<readonly CleanResult[]>
}

/**
 * One entry of the audit log (a `v2:log:<run>` key): an attempt to change something outside the view. The row id, never the command
 * line. `by` is `manual` for `/track clean`; it names who asked, for a later automatic path.
 */
export type LogEntry = {
  /** Epoch ms. */
  at: number
  by: 'manual'
  kind: CleanKind
  id: string
  action: CleanAction
  /** `done`, or `skipped: <reason>`. */
  outcome: string
}

/**
 * What a line of the plan is, so a view can cut a plan without a parse of its words (issue #199).
 * - `title`: the first line.
 * - `blank`: a gap between blocks.
 * - `head`: a line that heads a block: a kind (`Tasks (apply with /track clean --yes tasks)`), `Problems:`, and the one
 *   sentence of a plan with no step. A cut keeps every head.
 * - `step`: what a cleanup does to one thing, under the head of its kind. A label with a newline is one line for each row.
 * - `more`: `and N more.`, the count of the steps of a kind that the plan leaves out.
 * - `problem`: a tracker whose plan failed, under `Problems:`. A message with a newline is one line for each row.
 * - `hint`: a line that names another mode of the command.
 */
export type PlanRole = 'title' | 'blank' | 'head' | 'step' | 'more' | 'problem' | 'hint'

/**
 * One line of a plan: its words, with no newline (one row), and its role. A text with a newline is more than one line (`rowsOf`).
 * The two optional fields let a view cut a plan by steps with no parse of the words (issue #199). Neither one is in the text.
 */
export interface PlanLine {
  readonly text: string
  readonly role: PlanRole
  /** A `more` line: how many steps of its kind the plan leaves out. */
  readonly count?: number
  /** Set on a row after the first of a step or a problem whose text held a newline: this line goes on with the line above it. */
  readonly cont?: true
}
