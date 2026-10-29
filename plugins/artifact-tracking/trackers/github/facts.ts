// The facts that the github tracker reads: their names and their readers. The publishers own the names (the auto tracker:
// `auto.branches` and `auto.prs`; the repos tracker: `repos.branches`, issue #195). A tracker imports no other, so this folder
// spells what it reads, once, for the tracker, the sections and the lane. A value of another shape is not the fact.

import type { Json } from '../../core/interfaces/items'
import { isRecord } from '../../core/lib/json'
import type { BranchesFact, ForeignRepo, PrRef } from './types'

/** The branches after each round of the auto tracker. */
export const FACT_BRANCHES = 'auto.branches'
/** The PRs that the run created. */
export const FACT_PRS = 'auto.prs'
/** The branches that the session proved in other repos. */
export const FACT_REPO_BRANCHES = 'repos.branches'
/** The repo of the session, as this tracker finds it (`repo.ts`). The fact of the PR of the session branch follows it (issue #254). */
export const FACT_SESSION_REPO = 'session.repo'

const isStrings = (v: unknown): v is readonly string[] => Array.isArray(v) && v.every(x => typeof x === 'string')

/** The fact `auto.branches` as the lane reads it. A value of another shape is not the fact: undefined. */
export function branchesOf(v: Json | undefined): BranchesFact | undefined {
  if (!isRecord(v)) return undefined
  const { seq, reasons, branches, overflow } = v
  if (typeof seq !== 'number' || typeof overflow !== 'number' || !isStrings(reasons) || !isStrings(branches))
    return undefined
  return { seq, reasons, branches, overflow }
}

/**
 * The fact `auto.prs` as the lane reads it: the PRs the session created, each as host, owner, repo and number (issue
 * #158). An entry that is not whole is left out. A value of another shape is not the fact: no PRs.
 */
export function createdOf(v: Json | undefined): PrRef[] {
  if (!Array.isArray(v)) return []
  const out: PrRef[] = []
  for (const e of v) {
    if (!isRecord(e)) continue
    const { host, owner, repo, number } = e
    if (typeof host !== 'string' || typeof owner !== 'string' || typeof repo !== 'string') continue
    if (
      host === '' ||
      owner === '' ||
      repo === '' ||
      typeof number !== 'number' ||
      !Number.isSafeInteger(number) ||
      number < 1
    )
      continue
    out.push({ host, owner, repo, number })
  }
  return out
}

/**
 * The fact `repos.branches` as the lane reads it (issue #195): the repos other than the session repo, each with the branches
 * the session proved in it, and how many repos were left out over the cap. An entry that is not whole is left out. A value
 * of another shape is not the fact: no repos.
 */
export function foreignOf(v: Json | undefined): { repos: ForeignRepo[]; overflow: number } {
  if (!isRecord(v)) return { repos: [], overflow: 0 }
  const repos: ForeignRepo[] = []
  for (const e of Array.isArray(v.repos) ? v.repos : []) {
    if (!isRecord(e)) continue
    const { host, owner, repo, branches } = e
    if (typeof host !== 'string' || typeof owner !== 'string' || typeof repo !== 'string') continue
    if (host === '' || owner === '' || repo === '') continue
    if (!isStrings(branches) || branches.length === 0 || branches.some(b => b === '')) continue
    repos.push({ host, owner, repo, branches })
  }
  const overflow = typeof v.overflow === 'number' && v.overflow > 0 ? v.overflow : 0
  return { repos, overflow }
}
