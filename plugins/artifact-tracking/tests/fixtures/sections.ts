// Synthetic SectionSpec and GroupSpec builders for the pane tests. No tracker, no store: the table draws what it is given.
import type { Cell, GroupSpec, SectionSpec, TreeRow } from '../../core/interfaces/view'

/** A section of the tracker: id, rows and what `extra` adds. The title is the id. */
export function section(id: string, rows: readonly TreeRow[], extra: Partial<SectionSpec> = {}): SectionSpec {
  return { id, title: id, rows, ...extra }
}

/** A group of the table: the id is the one given (no view prefix), the title is the id, and the counts follow the rows. */
export function group(id: string, rows: readonly TreeRow[], extra: Partial<GroupSpec> = {}): GroupSpec {
  return { id, title: id, rows, count: rows.length, failing: 0, ...extra }
}

/**
 * A row of owner `t` that can be dismissed and given a priority. A string cell is `{ text }`. The ids are the column ids
 * of the table (`control`, `name`, `description`, `type`, `status`); the solver cases that name no tracker use others.
 */
export function row(id: string, cells: Readonly<Record<string, string | Cell>>, extra: Partial<TreeRow> = {}): TreeRow {
  const made: Record<string, Cell> = {}
  for (const [column, cell] of Object.entries(cells)) made[column] = typeof cell === 'string' ? { text: cell } : cell
  return { id, owner: 't', cells: made as TreeRow['cells'], can: { dismiss: true, priority: true }, ...extra }
}

/** `n` rows: ids `w0`, `w1`, ..., names `s<i>.example`, descriptions from `title` (default a short URL). */
export function webRows(n: number, title: (i: number) => string = i => `https://s${i}.example/`): TreeRow[] {
  return Array.from({ length: n }, (_, i) =>
    row(`w${i}`, { control: '', name: `s${i}.example`, description: title(i) }),
  )
}
