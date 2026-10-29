// The priority rules of the github kind (study section 5): R7 lifts the open PR on the session branch, R8 lets an issue
// take the level of the PRs that close it. A rule reads facts and the list through `RuleEnv`; it names no other tracker.
// Plan: L5 Task 6, K6, K20.

import type { Json, Level, PriorityRule, StoredItem } from '../../core/interfaces/items'
import type { RepoRef } from '../../core/interfaces/ports'
import type { FactsPort } from '../../core/interfaces/tracker'
import { isRecord } from '../../core/lib/json'
import { rankOf } from '../../core/lib/levels'
import type { GitHubRecord } from './types'

const lower = (s: string | undefined): string => (s ?? '').toLowerCase()

/** The session repo fact, when it holds a host, an owner and a repo. */
export function sessionRepo(facts: Pick<FactsPort, 'read'>): RepoRef | undefined {
  const v = facts.read<Json>('session.repo')
  return isRecord(v) && typeof v.host === 'string' && typeof v.owner === 'string' && typeof v.repo === 'string'
    ? { host: v.host, owner: v.owner, repo: v.repo }
    : undefined
}

/** The branch of the master agent, as the auto tracker publishes it. Absent: a detached HEAD, or not known yet. */
export function currentBranch(facts: Pick<FactsPort, 'read'>): string | undefined {
  const v = facts.read<Json>('auto.branches')
  return isRecord(v) && typeof v.current === 'string' ? v.current : undefined
}

/**
 * Whether `rec` is an open PR (a draft too) of the session repo whose head is `branch`. The one test of R7 below and of the fact
 * `github.branchPr` (issue #254), so the PR that is `top` and the PR whose base a diff takes are the same PR.
 */
export function isBranchPr(rec: GitHubRecord, repo: RepoRef | undefined, branch: string | undefined): boolean {
  return (
    rec.type === 'pr' &&
    rec.state === 'open' &&
    rec.headRefName !== undefined &&
    repo !== undefined &&
    rec.headRefName === branch &&
    lower(rec.host) === lower(repo.host) &&
    lower(rec.owner) === lower(repo.owner) &&
    lower(rec.repo) === lower(repo.repo)
  )
}

/** R7: an open PR (a draft too) of the session repo whose head is the current branch is `top`. */
export const BRANCH_PR: PriorityRule = {
  id: 'github-pr',
  stage: 0,
  level(item, env) {
    return isBranchPr(item as GitHubRecord, sessionRepo(env.facts), currentBranch(env.facts)) ? 'top' : undefined
  },
}

/** The keys of the PRs that close each issue, built once for a list. A list is never changed in place. */
const CLOSING = new WeakMap<readonly StoredItem[], ReadonlyMap<string, readonly string[]>>()

function closingIndex(items: readonly StoredItem[]): ReadonlyMap<string, readonly string[]> {
  const cached = CLOSING.get(items)
  if (cached) return cached
  const index = new Map<string, string[]>()
  for (const item of items) {
    const pr = item as GitHubRecord
    if (pr.type !== 'pr') continue
    for (const issue of pr.closes ?? []) index.set(issue, [...(index.get(issue) ?? []), pr.key])
  }
  CLOSING.set(items, index)
  return index
}

/** R8: an issue takes the highest level of the tracked PRs that close it, `low` included. Normal is no level. */
export const CLOSED_BY_PR: PriorityRule = {
  id: 'github-issue',
  stage: 1,
  level(item, env) {
    if ((item as GitHubRecord).type !== 'issue') return undefined
    let best: Level | undefined
    for (const pr of closingIndex(env.items).get(item.key) ?? []) {
      const level = env.levelOf(pr) ?? 'normal'
      if (best === undefined || rankOf(level) < rankOf(best)) best = level
    }
    return best === 'normal' ? undefined : best
  },
}
