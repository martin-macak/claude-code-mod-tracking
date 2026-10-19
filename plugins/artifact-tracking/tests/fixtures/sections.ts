// Synthetic SectionSpec builders for the pane tests. No tracker, no store: the table draws what it is given.
import type { Cell, ColumnDef, SectionSpec, TreeRow } from '../../core/interfaces/view'

/** The `web` columns of the L5 contract (A1), written out so the fixture needs no tracker. */
export const COLS: readonly ColumnDef[] = [
  { id: 'prio', header: '', width: { kind: 'fixed', cells: 1 } },
  { id: 'key', header: 'Label', width: { kind: 'content', min: 6, max: 24 }, role: 'tree' },
  { id: 'title', header: 'URL', width: { kind: 'flex', min: 10 } },
]

export function section(
  id: string,
  columns: readonly ColumnDef[],
  rows: readonly TreeRow[],
  extra: Partial<SectionSpec> = {},
): SectionSpec {
  return { id, title: id, columns, rows, ...extra }
}

/** A row of owner `t` that can be dismissed and given a priority. A string cell is `{ text }`. */
export function row(id: string, cells: Record<string, string | Cell>, extra: Partial<TreeRow> = {}): TreeRow {
  const made: Record<string, Cell> = {}
  for (const [column, cell] of Object.entries(cells)) made[column] = typeof cell === 'string' ? { text: cell } : cell
  return { id, owner: 't', cells: made, can: { dismiss: true, priority: true }, ...extra }
}

/** `n` rows for `COLS`: ids `w0`, `w1`, ..., keys `s<i>.example`, titles from `title` (default a short URL). */
export function webRows(n: number, title: (i: number) => string = i => `https://s${i}.example/`): TreeRow[] {
  return Array.from({ length: n }, (_, i) => row(`w${i}`, { prio: '', key: `s${i}.example`, title: title(i) }))
}
