// The fact `github.branchPr` (issue #254, L3 of #57): the PR that the session branch has, for the preview of a file. The diff of a
// file starts at the merge-base with the base of this PR, so a PR that stacks on another branch diffs against that branch and not
// against the default one. The fact is the PR that rule R7 marks `top` (`isBranchPr` is the one test), with its base branch. The
// file tracker reads it by name and imports no other tracker, so the name and the shape are two copies that a parity test keeps
// together (`tests/github-branch-pr.test.ts`). Pure: no state, no I/O.

import type { Json, StoredItem } from '../../core/interfaces/items'
import type { RepoRef } from '../../core/interfaces/ports'
import type { FactsPort } from '../../core/interfaces/tracker'
import { currentBranch, isBranchPr, sessionRepo } from './rules'
import type { GitHubRecord } from './types'

/** The name of the fact. */
export const FACT_BRANCH_PR = 'github.branchPr'

/** What the fact holds: the PR by host, owner, repo and number, and its two branches. */
export type BranchPrFact = {
  host: string
  owner: string
  repo: string
  number: number
  /** The branch the PR merges into: where a diff of the session branch starts. */
  base: string
  /** The head of the PR: the session branch, as the fact was made. A reader checks it against its own branch. */
  head: string
}

/**
 * The PR of `branch` in the session repo `repo`, from the item list, or `undefined`. Open PRs only, a draft too, and a PR the lane
 * gave no base branch is no fact. With more than one PR on the branch the newest number wins. Nothing here says that the list is
 * current: a branch switch or a merge shows at the next step of the PR lane.
 */
export function branchPrOf(
  list: readonly StoredItem[],
  repo: RepoRef | undefined,
  branch: string | undefined,
): BranchPrFact | undefined {
  let best: BranchPrFact | undefined
  for (const item of list) {
    const rec = item as GitHubRecord
    if (rec.category !== 'github' || !isBranchPr(rec, repo, branch)) continue
    const { owner, repo: name, baseRefName, headRefName } = rec
    if (owner === undefined || name === undefined || baseRefName === undefined || baseRefName === '') continue
    if (headRefName === undefined) continue
    if (best === undefined || rec.number > best.number)
      best = { host: rec.host, owner, repo: name, number: rec.number, base: baseRefName, head: headRefName }
  }
  return best
}

/**
 * Publishes the fact for the list as it is now, or withdraws it. A value that did not change tells nobody (`FactsPort.publish`).
 * The two readers of the branch and the repo are the facts of R7, so the fact and the `top` level follow the same inputs.
 */
export function publishBranchPr(facts: FactsPort, list: readonly StoredItem[]): void {
  const fact = branchPrOf(list, sessionRepo(facts), currentBranch(facts))
  facts.publish(FACT_BRANCH_PR, fact as unknown as Json | undefined)
}
