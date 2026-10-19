// Which rows a drawing holds, and the handle of each. The one place that numbers handles: `render` and `handleOf`
// both use it, so a refocus finds the handle the next drawing gives a row. Pure.
// Decisions G3 (open state) and G4 (caps) of plan L6. Spec 5.10 "Rows".
import type { RowRef, SectionSpec, TreeRow } from '../../core/interfaces/view'
import type { DrawnRow, TableView } from './shape'

export interface LaidRow {
  readonly row: TreeRow
  readonly depth: number
  readonly open: boolean
  /** The key of the row's focus Button: `r0`, `r1`, … in drawing order. */
  readonly handle: string
}

export interface LaidSection {
  readonly spec: SectionSpec
  readonly index: number
  readonly rows: readonly LaidRow[]
  /** Top-level rows the caps left out. */
  readonly more: number
}

export type LayoutView = Pick<TableView, 'expanded' | 'shown' | 'limits'>

/**
 * The caps count top-level rows. `maxRows` and every `shown` chunk make the total. In pane order each section takes
 * what is left of that total, up to `sectionRows` plus its own `shown`. Open children count against the budget only.
 * `halve` k cuts every section's want to `max(1, floor(want / 2^k))`: a step of the budget guard.
 */
export function layout(sections: readonly SectionSpec[], view: LayoutView, halve = 0): readonly LaidSection[] {
  let left = view.limits.maxRows + sections.reduce((sum, s) => sum + view.shown(s.id), 0)
  let next = 0
  return sections.map((spec, index) => {
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
export function handleOf(sections: readonly SectionSpec[], view: LayoutView, rowId: string): string | undefined {
  for (const s of layout(sections, view)) {
    const hit = s.rows.find(r => r.row.id === rowId)
    if (hit !== undefined) return hit.handle
  }
  return undefined
}

/** The row with this id, drawn or not: a child of a closed row counts. */
export function findRow(sections: readonly SectionSpec[], rowId: string | null): RowRef | undefined {
  if (rowId === null) return undefined
  const search = (rows: readonly TreeRow[], section: string): RowRef | undefined => {
    for (const row of rows) {
      if (row.id === rowId) return { id: row.id, owner: row.owner, section, can: row.can }
      const hit = search(row.children ?? [], section)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  for (const s of sections) {
    const hit = search(s.rows, s.id)
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
