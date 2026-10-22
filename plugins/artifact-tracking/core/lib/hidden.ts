// The `/track clean --hide` rule, one place for every tracker that hides rows. Pure.
// Issue #122. Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.13 (`hidden`).

import type { HiddenState } from '../interfaces/view'

/**
 * True when `/track clean --hide` hides a row that is over and ended at `endedAt`: it ended at or before the time of the
 * command. A row with no end time was over before it, so it goes too. The caller checks that the row is over: a live row
 * never goes. `/track show-all` wins, so nothing goes while it is on. The TTL and `hideEnded` have no say here.
 */
export function sweptAway(hidden: HiddenState, endedAt: number | undefined): boolean {
  if (hidden.showAll || hidden.before === undefined) return false
  return endedAt === undefined || endedAt <= hidden.before
}
