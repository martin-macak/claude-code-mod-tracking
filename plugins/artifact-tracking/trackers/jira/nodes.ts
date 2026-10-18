// The child tree of a Jira item: the marks a person sets on its nodes and how they survive a refresh and a fold.
// Pure. Moved from `hooks/contracts.ts` and `hooks/model/priority.ts` in plan L5, Task 4; the Jira kind needs them.

import { mergePriority, withPriority } from '../../core/lib/levels'
import type { JiraNode } from './types'

/** The row id of a Jira child: its parent's row id, a slash, its own key. The fold, the mark and the pane use it. */
export const childId = (parentId: string, nodeKey: string): string => `${parentId}/${nodeKey}`

/**
 * A fetched child tree with the marks the person set. A node matches by key, level by level.
 * A refresh carries no mark of its own, so `old` decides for each node it holds, also when that node has no mark:
 * the person may have reset it while the fetch ran. A node `old` lacks keeps what `fresh` has.
 */
export function carryPriorities(fresh: readonly JiraNode[], old: readonly JiraNode[]): JiraNode[] {
  const byKey = new Map(old.map(n => [n.key, n]))
  return fresh.map(n => {
    const prev = byKey.get(n.key)
    const out = { ...n, children: carryPriorities(n.children, prev?.children ?? []) }
    const priority = prev ? prev.priority : n.priority
    if (priority === undefined) delete out.priority
    else out.priority = priority
    return out
  })
}

/** Child trees of one Jira item: `a` gives the shape; each node merges the mark of the same key in `b`, level by level. */
export function mergeNodePriorities(a: readonly JiraNode[], b: readonly JiraNode[]): JiraNode[] {
  const byKey = new Map(b.map(n => [n.key, n]))
  return a.map(n => {
    const other = byKey.get(n.key)
    const children = mergeNodePriorities(n.children, other?.children ?? [])
    return withPriority({ ...n, children }, mergePriority(n.priority, other?.priority))
  })
}
