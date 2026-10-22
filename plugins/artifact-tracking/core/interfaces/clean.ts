// The cleanup contract of `/track clean` (issue #122, phase P2 of #49). A tracker plans what a cleanup would do from its view
// (pure), and applies the steps the person confirmed with `--yes <kind>`. Core runs both, prints the plan and keeps the
// audit log. Types only.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.12. Design study: issue #49, section 5.3.

import type { Json, JsonObject } from './items'
import type { TrackerContext } from './tracker'
import type { ViewContext } from './view'

/**
 * What `--yes` names. `tasks`: background tasks that still run. `worktrees`: git records of worktrees that are gone from
 * disk. A kind that joins the list (containers, issue #49 P3) is a compile error in the places that switch over it.
 */
export type CleanKind = 'tasks' | 'worktrees'

/** `stop`: stop a background task. `remove-record`: remove the git record of a worktree whose directory is gone. */
export type CleanAction = 'stop' | 'remove-record'

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
 * One entry of the audit log (`v2:log`): an attempt to change something outside the view. The row id, never the command
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
