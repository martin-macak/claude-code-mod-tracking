// The facts that the file tracker reads or publishes, spelled once for this folder (a tracker imports no other: the github tracker and
// the auto tracker own the first two names, and `tests/github-branch-pr.test.ts` keeps the copy of the shape of the PR fact whole).
// Issue #254, L3 of #57. Pure: no state, no I/O.

import type { Json } from '../../core/interfaces/items'
import type { FactsPort } from '../../core/interfaces/tracker'
import { isRecord } from '../../core/lib/json'

/** The fact of the auto tracker: the folder of the session (`cwd`) and the top of its repo (`top`, `null` when it is in none). */
export const FACT_ROOT = 'auto.root'
/** The fact of the github tracker: the PR of the session branch. */
export const FACT_BRANCH_PR = 'github.branchPr'
/** The fact of this tracker: the folders whose diff mode is off, each with the reason and the time git said so (`diff-off.ts`). */
export const FACT_DIFF_OFF = 'file.diffOff'

/** The root of the session as the auto tracker pins it. A part that is not a plain non-empty string is left out. */
export function rootOf(facts: Pick<FactsPort, 'read'>): { cwd?: string; top?: string } {
  const v = facts.read<Json>(FACT_ROOT)
  if (!isRecord(v)) return {}
  return {
    ...(typeof v.cwd === 'string' && v.cwd !== '' ? { cwd: v.cwd } : {}),
    ...(typeof v.top === 'string' && v.top !== '' ? { top: v.top } : {}),
  }
}

/**
 * The branches of the fact `github.branchPr`: the base that the PR merges into, and its head (the session branch as the fact was made).
 * A value of another shape (no fact, a word, a list, an empty or a non-string branch) is not the fact: `undefined`.
 */
export function branchesOfFact(v: Json | undefined): { base: string; head: string } | undefined {
  if (!isRecord(v)) return undefined
  const { base, head } = v
  return typeof base === 'string' && base !== '' && typeof head === 'string' && head !== '' ? { base, head } : undefined
}
