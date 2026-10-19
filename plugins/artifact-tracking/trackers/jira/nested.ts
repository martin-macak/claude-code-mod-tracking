// Which Jira records the pane draws as roots. A record that another shown root already draws in its child tree (#48)
// gets no root row of its own. Pure. A row always holds its whole tree, so nothing is folded here.

import { childId } from './nodes'
import type { JiraNode, JiraRecord } from './types'

const lower = (s: string | undefined): string => (s ?? '').toLowerCase()

/** The identity of a Jira issue across records and nodes: lower-case site, upper-case key. */
export const jiraSiteKey = (site: string, key: string): string => `${lower(site)}/${key.toUpperCase()}`

/** The `site/KEY` of every node that the root's rows draw. */
function drawnKeys(root: JiraRecord): Set<string> {
  const out = new Set<string>()
  const walk = (parentId: string, nodes: readonly JiraNode[]): void => {
    for (const n of nodes) {
      out.add(jiraSiteKey(root.site, n.key))
      walk(childId(parentId, n.key), n.children)
    }
  }
  walk(root.key, root.children)
  return out
}

/**
 * The `site/KEY` of each Jira record that renders nested under another shown root, so it gets no root row (#48).
 * Roots are chosen top down: a record that no other open record draws above it becomes a root, and its drawn
 * keys close the records they show. A short snapshot draws less, so the record stays a root.
 * Records in a cycle (stale data) reach each other, so they all stay roots.
 */
export function nestedJira(records: readonly JiraRecord[]): Set<string> {
  const idOf = (r: JiraRecord): string => jiraSiteKey(r.site, r.issueKey)
  const drawn = new Map(records.map(r => [idOf(r), drawnKeys(r)]))
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set([from])
    const stack = [from]
    while (stack.length > 0) {
      for (const k of drawn.get(stack.pop()!) ?? []) {
        if (k === to) return true
        if (drawn.has(k) && !seen.has(k)) {
          seen.add(k)
          stack.push(k)
        }
      }
    }
    return false
  }
  const above = (p: JiraRecord, r: JiraRecord): boolean =>
    p !== r && drawn.get(idOf(p))!.has(idOf(r)) && !reaches(idOf(r), idOf(p))
  const shown = new Set<string>()
  const closed = new Set<string>()
  let left = [...records]
  for (;;) {
    const open = left.filter(r => !closed.has(idOf(r)))
    if (open.length === 0) break
    const tops = open.filter(r => !open.some(p => above(p, r)))
    for (const t of tops) {
      shown.add(idOf(t))
      for (const k of drawn.get(idOf(t))!) closed.add(k)
    }
    left = left.filter(r => !tops.includes(r))
  }
  return new Set(records.map(idOf).filter(id => !shown.has(id)))
}
