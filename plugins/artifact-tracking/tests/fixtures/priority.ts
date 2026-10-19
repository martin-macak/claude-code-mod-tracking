// Priority of a tracked item (issue #30): the order of the levels, their markers and the merge of manual marks.
// Pure: no `$`. A record's `priority` is the person's manual mark only. Absent means no mark.
// A test binding over `core/infra/priority.ts` and the rules of the shipped kinds (plan L5, Tasks 6 and 15): each function
// keeps its old signature.

import { effectiveLevels as levelsOf, rowIdOf as rowOf, setLevel } from '../../core/infra/priority'
import type { Effective, Json, PriorityRule } from '../../core/interfaces/items'
import { scanContext } from '../../core/lib/kind-context'
import type { Priority } from '../../core/lib/levels'
import type { KindTable } from '../../core/lib/records'
import { GITHUB_DEFAULTS } from '../../trackers/github/config'
import { BRANCH_PR, CLOSED_BY_PR } from '../../trackers/github/rules'
import { mergeNodePriorities } from '../../trackers/jira/nodes'
import type { ItemRecord, RepoRef } from './contracts'
import { REF_KINDS } from './refs'
import { KINDS } from './registry'

export type { Level } from '../../core/lib/levels'
// The level helpers moved to core/lib/levels.ts in plan L5, Task 2. The tests import them from here.
export { byLevel, markerOf, mergePriority, rankOf, withPriority } from '../../core/lib/levels'
export type { Effective }
export { mergeNodePriorities }

const table: KindTable = category => KINDS.find(kind => kind.category === category)

/**
 * The list with the person's mark on row `id` set to `level`, or removed when `level` is undefined. `id` is an item
 * key, or the `childId` path of a Jira child. An unknown id, or a mark that does not change, gives the input list.
 */
export function setPriority(list: readonly ItemRecord[], id: string, level: Priority | undefined): ItemRecord[] {
  return setLevel(list, id, level, table) as unknown as ItemRecord[]
}

// ---------------------------------------------------------------- auto levels (study section 5)

/** What the auto rules read: the session repo, and the branch of this session's cwd. `currentBranch` absent: detached HEAD or not known yet. */
export type LevelContext = { sessionRepo?: RepoRef | null; currentBranch?: string }

/** R9: the rules of the github kind by id. The other kinds have none yet. */
export const RULES: Readonly<Record<string, PriorityRule>> = {
  [BRANCH_PR.id]: BRANCH_PR,
  [CLOSED_BY_PR.id]: CLOSED_BY_PR,
}

/** The shipped kinds, each with the rules of `extra` whose id is its category. */
function withRules(extra: readonly PriorityRule[]): KindTable {
  return category => {
    const kind = table(category)
    const own = extra.filter(rule => rule.id === category)
    return kind && own.length > 0 ? { ...kind, rules: [...(kind.rules ?? []), ...own] } : kind
  }
}

/**
 * The level of every record, by key: the manual mark, else the rules of its kind in stages, else none. `extra` rules
 * join the kind whose category is the rule's id. The facts the rules read come from `ctx`.
 */
export function effectiveLevels(
  records: readonly ItemRecord[],
  ctx: LevelContext,
  extra: readonly PriorityRule[] = [],
): Map<string, Effective> {
  const facts: Record<string, Json | undefined> = {
    'session.repo': (ctx.sessionRepo ?? undefined) as unknown as Json | undefined,
    'auto.branches': ctx.currentBranch === undefined ? undefined : { current: ctx.currentBranch },
  }
  return levelsOf(records, extra.length === 0 ? table : withRules(extra), {
    read: <T extends Json>(name: string) => facts[name] as T | undefined,
  })
}

// ---------------------------------------------------------------- /track prio (R11)

/**
 * The row id a `/track prio` ref names, or undefined when it names no tracked row. A Jira key, in any case, names a
 * root or a child; anything else is read as the capture reads text: a URL, `o/r#N`, or `#N` in the session repo.
 */
export function rowIdOf(
  list: readonly ItemRecord[],
  ref: string,
  opts: { defaultRepo: RepoRef | null; githubHosts: readonly string[] },
): string | undefined {
  const ctx = scanContext({
    mode: 'full',
    purpose: 'lookup',
    facts: { 'session.repo': opts.defaultRepo as unknown as Json, 'github.hosts': [...opts.githubHosts] },
    slice: { shortRefKeywords: [...GITHUB_DEFAULTS.shortRefKeywords] },
  })
  return rowOf(list, ref, REF_KINDS, ctx)
}
