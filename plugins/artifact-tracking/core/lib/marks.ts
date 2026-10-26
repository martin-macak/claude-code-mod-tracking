// The rules of the row marks (issue #138): which ids a mark write keeps, and the words that marks and the question put on
// the pane. Pure. The marks are a session atom of row ids; `hooks/pane-marks.ts` writes it.

import type { FooterKey, SectionSpec, TreeRow } from '../interfaces/view'

/** `cur` with `id` marked, or unmarked when it was marked. A new list. */
export const toggled = (cur: readonly string[], id: string): string[] =>
  cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]

/**
 * The marks of rows that the trackers still hold, hidden or not: `known` is the inventory (`Views.inventory`), so a row that a
 * rule of time or of a cap only leaves out keeps its mark. A render never prunes (E9): the next mark write does.
 */
export const pruned = (cur: readonly string[], known: ReadonlySet<string>): string[] => cur.filter(id => known.has(id))

/** The id of every row of every section, a child included, drawn or not. */
export function rowIdsOf(sections: readonly SectionSpec[]): Set<string> {
  const ids = new Set<string>()
  const visit = (rows: readonly TreeRow[]): void => {
    for (const row of rows) {
      ids.add(row.id)
      visit(row.children ?? [])
    }
  }
  for (const s of sections) visit(s.rows)
  return ids
}

/** Two lists name the same ids, whatever their order and whatever a list repeats. */
export const sameIds = (a: readonly string[], b: readonly string[]): boolean => {
  const left = new Set(a)
  const right = new Set(b)
  return left.size === right.size && [...left].every(id => right.has(id))
}

/** The words of the view line with the count of the marked rows. The `/track` text never calls it: marks are pane state. */
export const markedSummary = (summary: string, marked: number): string =>
  marked === 0 ? summary : `${summary} · ${marked} marked`

/** The question of a bulk dismiss. It replaces the words of the view line: only an `x` answers it, so it names no other key. */
export const dismissQuestion = (rows: number): string =>
  `Dismiss ${rows} marked ${rows === 1 ? 'row' : 'rows'}? x again: yes`

/**
 * The footer with the count on the key that asks (`confirm`, which is `x`) while marked rows are its targets: `dismiss 3`, and
 * `confirm 3` while the question stands. The registry keeps the static label. With no target the list stays as it is.
 */
export function relabelDismiss(keys: readonly FooterKey[], targets: number, asking: boolean): readonly FooterKey[] {
  if (targets === 0) return keys
  return keys.map(k => (k.confirm === true ? { ...k, label: `${asking ? 'confirm' : k.label} ${targets}` } : k))
}
