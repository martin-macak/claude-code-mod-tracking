// The end states of a process row: one place that names them. The view hides a row in one of them once it ended longer
// ago than its TTL (issue #49). `KIND` must name every `ProcessState`, so a state that joins the union (#118) is a
// compile error here until it says whether it is live, ended or a failure. `rows`, `watch` and `sections` follow.
// Runtime values, so they live apart from the type modules, which export none.

import type { ProcessState } from './types'

/** `live`: still going. `ended`: over, hides after `endedTtlMs`. `failed`: over, hides after `failedTtlMs`. */
type StateKind = 'live' | 'ended' | 'failed'

const KIND: Readonly<Record<ProcessState, StateKind>> = {
  running: 'live',
  up: 'live',
  unhealthy: 'live',
  completed: 'ended',
  exited: 'ended',
  unknown: 'ended',
  failed: 'failed',
  killed: 'failed',
}

const statesOf = (keep: (k: StateKind) => boolean): ReadonlySet<ProcessState> =>
  new Set((Object.keys(KIND) as ProcessState[]).filter(s => keep(KIND[s])))

/** The states in which a row is over. */
export const ENDED_STATES: ReadonlySet<ProcessState> = statesOf(k => k !== 'live')
/** The ended states that are failures: they hide after `failedTtlMs`, the others after `endedTtlMs`. */
export const FAILED_STATES: ReadonlySet<ProcessState> = statesOf(k => k === 'failed')
