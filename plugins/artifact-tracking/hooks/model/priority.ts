// Priority of a tracked item (issue #30): the order of the levels, their markers and the merge of manual marks.
// Pure: no `$`. A record's `priority` is the person's manual mark only. Absent means no mark.

import { type Level, type Priority, rankOf, withPriority } from '../../core/lib/levels'
import { mergeNodePriorities } from '../../trackers/jira/nodes'
import type { GitHubRecord, ItemRecord, JiraNode, RepoRef } from '../contracts'
import { JIRA_KEY } from '../contracts'
import { extractRefs } from '../scan/refs'
import { childId, keyOf } from './keys'

export type { Level } from '../../core/lib/levels'
// The level helpers moved to core/lib/levels.ts in plan L5, Task 2. The old callers import them from here until Task 15.
export { byLevel, markerOf, mergePriority, rankOf, withPriority } from '../../core/lib/levels'
export { mergeNodePriorities }

/** `nodes` with the mark of child row `id` set, or undefined when no node of the tree is `id` or nothing changes. */
function setNode(
  nodes: readonly JiraNode[],
  parentId: string,
  id: string,
  level: Priority | undefined,
): JiraNode[] | undefined {
  for (const [i, n] of nodes.entries()) {
    const nid = childId(parentId, n.key)
    if (nid !== id && !id.startsWith(`${nid}/`)) continue
    let next: JiraNode | undefined
    if (nid === id) next = n.priority === level ? undefined : withPriority(n, level)
    else {
      const children = setNode(n.children, nid, id, level)
      if (children) next = { ...n, children }
    }
    return next ? nodes.map((x, j) => (j === i ? next : x)) : undefined
  }
  return undefined
}

/**
 * The list with the person's mark on row `id` set to `level`, or removed when `level` is undefined. `id` is an item
 * key, or the `childId` path of a Jira child. An unknown id, or a mark that does not change, gives the input list.
 */
export function setPriority(list: readonly ItemRecord[], id: string, level: Priority | undefined): ItemRecord[] {
  const i = list.findIndex(r => r.key === id || (r.category === 'jira' && id.startsWith(`${r.key}/`)))
  const rec = list[i]
  if (!rec) return list as ItemRecord[]
  let next: ItemRecord | undefined
  if (rec.key === id) next = rec.priority === level ? undefined : withPriority(rec, level)
  else if (rec.category === 'jira') {
    const children = setNode(rec.children, rec.key, id, level)
    if (children) next = { ...rec, children }
  }
  return next ? list.map((r, j) => (j === i ? next : r)) : (list as ItemRecord[])
}

// ---------------------------------------------------------------- auto levels (study section 5)

/** The level an item shows: its manual mark, else what a rule gives (`auto`), else none. */
export type Effective = { level?: Level; auto?: true }

/** What the rules read besides the records. `currentBranch` absent: detached HEAD or not known yet. */
export type LevelContext = { sessionRepo?: RepoRef | null; currentBranch?: string }

export type ItemClass = 'github-pr' | 'github-issue' | 'jira' | 'artifact' | 'web' | 'file'

/** What a rule may read: the context, the levels found so far, and the tracked PRs that close an issue. */
export type RuleEnv = {
  ctx: LevelContext
  levelOf(key: string): Level | undefined
  closers(issueKey: string): readonly GitHubRecord[]
}

/** A rule of one item class. It gives an auto level or none. A manual mark always wins over it. */
export type Rule = (rec: ItemRecord, env: RuleEnv) => Level | undefined

/** A GitHub item of unknown type has no class, so no rule. */
export function classOf(rec: ItemRecord): ItemClass | undefined {
  if (rec.category !== 'github') return rec.category
  return rec.type === 'pr' ? 'github-pr' : rec.type === 'issue' ? 'github-issue' : undefined
}

const lower = (s: string | undefined): string => (s ?? '').toLowerCase()
const inRepo = (rec: GitHubRecord, repo: RepoRef): boolean =>
  lower(rec.host) === lower(repo.host) && lower(rec.owner) === lower(repo.owner) && lower(rec.repo) === lower(repo.repo)

/** R7: an open PR (a draft too) of the session repo whose head is the current branch is `top`. */
const branchPr: Rule = (rec, { ctx }) =>
  rec.category === 'github' &&
  rec.state === 'open' &&
  ctx.currentBranch !== undefined &&
  rec.headRefName === ctx.currentBranch &&
  ctx.sessionRepo &&
  inRepo(rec, ctx.sessionRepo)
    ? 'top'
    : undefined

/** R8: an issue takes the highest level of the tracked PRs that close it, `low` included. Normal is no level. */
const closedByPr: Rule = (rec, env) => {
  let best: Level | undefined
  for (const pr of env.closers(rec.key)) {
    const level = env.levelOf(pr.key) ?? 'normal'
    if (best === undefined || rankOf(level) < rankOf(best)) best = level
  }
  return best === 'normal' ? undefined : best
}

/** R9: the rules per item class. Jira, artifacts, web links and files have none yet. */
export const RULES: Readonly<Partial<Record<ItemClass, Rule>>> = { 'github-pr': branchPr, 'github-issue': closedByPr }

/**
 * The level of every record, by key: the manual mark, else the rule of its class, else none. Issues go last, so they
 * read the final level of each PR, manual or auto. One pass over the records and one map: O(n), no I/O.
 */
export function effectiveLevels(
  records: readonly ItemRecord[],
  ctx: LevelContext,
  rules: Readonly<Partial<Record<ItemClass, Rule>>> = RULES,
): Map<string, Effective> {
  const out = new Map<string, Effective>()
  const closing = new Map<string, GitHubRecord[]>()
  for (const r of records)
    if (r.category === 'github' && r.type === 'pr')
      for (const k of r.closes ?? []) closing.set(k, [...(closing.get(k) ?? []), r])
  const env: RuleEnv = { ctx, levelOf: key => out.get(key)?.level, closers: key => closing.get(key) ?? [] }
  const resolve = (rec: ItemRecord): void => {
    if (rec.priority !== undefined) {
      out.set(rec.key, { level: rec.priority })
      return
    }
    const cls = classOf(rec)
    const level = cls === undefined ? undefined : rules[cls]?.(rec, env)
    out.set(rec.key, level === undefined ? {} : { level, auto: true })
  }
  for (const rec of records) if (classOf(rec) !== 'github-issue') resolve(rec)
  for (const rec of records) if (classOf(rec) === 'github-issue') resolve(rec)
  return out
}

// ---------------------------------------------------------------- /track prio (R11)

/** The row id of the first node in a Jira tree whose key is `key`, depth first. */
function childRow(nodes: readonly JiraNode[], parentId: string, key: string): string | undefined {
  for (const n of nodes) {
    const id = childId(parentId, n.key)
    if (n.key === key) return id
    const deeper = childRow(n.children, id, key)
    if (deeper !== undefined) return deeper
  }
  return undefined
}

/**
 * The row id a `/track prio` ref names, or undefined when it names no tracked row. A Jira key, in any case, names a
 * root or a child; anything else is read as the capture reads text: a URL, `o/r#N`, or `#N` in the session repo.
 */
export function rowIdOf(
  list: readonly ItemRecord[],
  ref: string,
  opts: { defaultRepo: RepoRef | null; githubHosts: readonly string[] },
): string | undefined {
  const upper = ref.toUpperCase()
  if (JIRA_KEY.test(upper)) {
    for (const rec of list) {
      if (rec.category !== 'jira') continue
      if (rec.issueKey === upper) return rec.key
      const child = childRow(rec.children, rec.key, upper)
      if (child !== undefined) return child
    }
    return undefined
  }
  const [first] = extractRefs(ref, {
    mode: 'full',
    strictShortRefs: false,
    ...opts,
    githubHosts: [...opts.githubHosts],
  })
  const key = first === undefined ? undefined : keyOf(first)
  return key !== undefined && list.some(r => r.key === key) ? key : undefined
}
