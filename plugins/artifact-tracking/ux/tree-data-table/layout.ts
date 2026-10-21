// Which rows a drawing holds, and the handle of each. The one place that numbers handles: `render` and `handleOf`
// both use it, so a refocus finds the handle the next drawing gives a row. Pure.
// Decisions G3 (open state) and G4 (caps) of plan L6. Spec 5.10 "Rows".
import type { GroupSpec, RowRef, TreeRow } from '../../core/interfaces/view'
import type { DrawnRow, TableView } from './shape'

export interface LaidRow {
  readonly row: TreeRow
  readonly depth: number
  readonly open: boolean
  /** The key of the row's focus Button: `r0`, `r1`, … in drawing order. */
  readonly handle: string
}

export interface LaidGroup {
  readonly spec: GroupSpec
  readonly index: number
  readonly rows: readonly LaidRow[]
  /** Top-level rows the caps left out. */
  readonly more: number
}

export type LayoutView = Pick<TableView, 'expanded' | 'shown' | 'limits'>

/**
 * The caps count top-level rows. `maxRows` and every `shown` chunk make the total. In pane order each group takes
 * what is left of that total, up to `sectionRows` plus its own `shown` (keyed by the id of the group). Open children
 * count against the budget only. `halve` k cuts every group's want to `max(1, floor(want / 2^k))`: a step of the budget
 * guard.
 */
export function layout(groups: readonly GroupSpec[], view: LayoutView, halve = 0): readonly LaidGroup[] {
  let left = view.limits.maxRows + groups.reduce((sum, g) => sum + view.shown(g.id), 0)
  let next = 0
  return groups.map((spec, index) => {
    const want = view.limits.sectionRows + view.shown(spec.id)
    const cap = halve > 0 ? Math.max(1, Math.floor(want / 2 ** halve)) : want
    const take = Math.max(0, Math.min(spec.rows.length, cap, left))
    left -= take
    const rows: LaidRow[] = []
    const visit = (row: TreeRow, depth: number): void => {
      const open = (row.expandedByDefault === true) !== view.expanded.has(row.id)
      rows.push({ row, depth, open, handle: `r${next++}` })
      if (open) for (const child of row.children ?? []) visit(child, depth + 1)
    }
    for (const row of spec.rows.slice(0, take)) visit(row, 0)
    return { spec, index, rows, more: spec.rows.length - take }
  })
}

/** The handle `rowId` gets in the next full drawing, or undefined when no drawn row holds it. */
export function handleOf(groups: readonly GroupSpec[], view: LayoutView, rowId: string): string | undefined {
  for (const g of layout(groups, view)) {
    const hit = g.rows.find(r => r.row.id === rowId)
    if (hit !== undefined) return hit.handle
  }
  return undefined
}

/** The row with this id, drawn or not: a child of a closed row counts. */
export function findRow(groups: readonly GroupSpec[], rowId: string | null): RowRef | undefined {
  if (rowId === null) return undefined
  const search = (rows: readonly TreeRow[], group: string): RowRef | undefined => {
    for (const row of rows) {
      if (row.id === rowId) return { id: row.id, owner: row.owner, group, can: row.can }
      const hit = search(row.children ?? [], group)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  for (const g of groups) {
    const hit = search(g.rows, g.id)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** The row to select once `id` is gone: the next drawn row at the same or a lower depth, else the one before. */
export function neighbourOf(rows: readonly DrawnRow[], id: string): string | null {
  const at = rows.findIndex(r => r.id === id)
  if (at < 0) return null
  const depth = rows[at]?.depth ?? 0
  return (rows.slice(at + 1).find(r => r.depth <= depth) ?? rows[at - 1])?.id ?? null
}

/**
 * The row the pane treats as selected. A row can leave the pane with no key from the person: its TTL passes, a cap takes
 * it, or its run folds. The `selected` atom then names a row that no drawing holds, and a render must not write it (E9),
 * so the drawing and the keys fall back to a row instead (issue #49).
 *
 * - A selected row that a full drawing holds stays selected, and no selection stays none.
 * - The row the last drawing fell to for this same selection, while it is still drawn: so a redraw does not move it.
 * - A row that sits below a closed row, or past the cap of its group: the closest row above it that is drawn.
 * - A row that is gone (or the row the last drawing fell to): the row after it in the last drawing that is still drawn,
 *   else the row before it.
 * - Every row of the last drawing gone too: the first drawn row, or none when the pane has no row.
 * - A selection that no drawing ever held and no row holds stays as it is, so its keys stay off. It is no row that hid.
 */
export function shownSelection(
  groups: readonly GroupSpec[],
  view: LayoutView,
  selected: string | null,
  before: readonly DrawnRow[],
  fellTo: string | null = null,
): string | null {
  if (selected === null) return null
  const laid = layout(groups, view).flatMap(g => g.rows.map(r => r.row.id))
  const drawn = new Set(laid)
  if (drawn.has(selected)) return selected
  if (fellTo !== null && drawn.has(fellTo)) return fellTo
  const above = ancestorsOf(groups, selected)
    .reverse()
    .find(id => drawn.has(id))
  if (above !== undefined) return above
  // The row the last drawing fell to may have gone too: then the search starts where that row was.
  const at = [fellTo, selected].map(id => before.findIndex(r => r.id === id)).find(i => i >= 0) ?? -1
  if (at >= 0) {
    const after = before.slice(at + 1).find(r => drawn.has(r.id))
    const prior = before
      .slice(0, at)
      .reverse()
      .find(r => drawn.has(r.id))
    return (after ?? prior)?.id ?? laid[0] ?? null
  }
  return selected
}

/** The ids of the rows above `rowId` in its tree, the top row first. Empty for a top row and for an id no row holds. */
function ancestorsOf(groups: readonly GroupSpec[], rowId: string): string[] {
  const walk = (rows: readonly TreeRow[], path: readonly string[]): string[] | undefined => {
    for (const row of rows) {
      if (row.id === rowId) return [...path]
      const hit = walk(row.children ?? [], [...path, row.id])
      if (hit !== undefined) return hit
    }
    return undefined
  }
  for (const g of groups) {
    const hit = walk(g.rows, [])
    if (hit !== undefined) return hit
  }
  return []
}
