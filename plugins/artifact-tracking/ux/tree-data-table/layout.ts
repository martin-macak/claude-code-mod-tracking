// Which rows a drawing holds, and the handle of each. The one place that numbers handles: `render` and `handleOf`
// both use it, so a refocus finds the handle the next drawing gives a row. Pure.
// Decisions G3 (open state) and G4 (caps) of plan L6. Spec 5.10 "Rows".
import { canOpen, type GroupSpec, type RowRef, type TreeRow } from '../../core/interfaces/view'
import { GLYPH } from '../theme'
import { groupRefOf, groupRowOf } from './group-row'
import type { DrawnRow, TableView } from './shape'

export interface LaidRow {
  readonly row: TreeRow
  readonly depth: number
  readonly open: boolean
  /**
   * The key of the row's focus Button: `r0`, `r1`, … in drawing order. Empty on a group row that has no row to fold: it has no Button
   * (`hasStop` tells).
   */
  readonly handle: string
  /** The row of a foldable group (issue #256): `open` is "not folded", and the row has no detail lines. */
  readonly head?: true
}

export interface LaidGroup {
  readonly spec: GroupSpec
  readonly index: number
  /**
   * The group row of a foldable group (issue #256), drawn in place of the title line. It comes before the rows in drawing order and has
   * its handle before theirs, when the group has rows. Absent: the group draws a title line.
   */
  readonly head?: LaidRow
  readonly rows: readonly LaidRow[]
  /** Top-level rows the caps left out. */
  readonly more: number
}

export type LayoutView = Pick<TableView, 'expanded' | 'shown' | 'limits'>

/**
 * The glyph of the Button of a laid row (issue #277): `›` on a leaf, whose Button opens the detail view and has no fold to show, and
 * `▸` or `▾` on a row with children. The drawing and the stop of a row out of the window use this one rule.
 */
export function glyphOf(r: LaidRow): string {
  const fold = r.open ? GLYPH.open : GLYPH.closed
  if (r.head === true) return hasStop(r) ? fold : ''
  return canOpen(r.row) ? fold : GLYPH.leaf
}

/**
 * Whether a laid row takes a Button and a Tab stop. The one place that says so: a group row with no row to fold has an empty handle and
 * none. Any other row, and `undefined`, answer by the same test, so a caller never reads the empty handle itself (issue #256).
 */
export const hasStop = (r: LaidRow | undefined): r is LaidRow => r !== undefined && r.handle !== ''

/** Every row of the laid groups that takes a Button, in drawing order: a group row, then the rows of its group. */
export const stopRowsOf = (laid: readonly LaidGroup[]): LaidRow[] =>
  laid.flatMap(g => (hasStop(g.head) ? [g.head, ...g.rows] : g.rows))

/** Every row the solver measures: the group rows (with a Button or not) and the rows of their groups. */
export const solverRowsOf = (laid: readonly LaidGroup[]): LaidRow[] =>
  laid.flatMap(g => (g.head === undefined ? g.rows : [g.head, ...g.rows]))

/**
 * The caps count top-level rows. `maxRows` and every `shown` chunk make the total. In pane order each group takes
 * what is left of that total, up to `sectionRows` plus its own `shown` (keyed by the id of the group). Open children
 * count against the budget only. A foldable group (issue #256) has a group row first, at depth 0, and its rows at depth 1. Its id
 * in `expanded` means it is folded: it takes no row and no "N more" row, and its rows take nothing of the total. `halve` k cuts
 * every group's want to `max(1, floor(want / 2^k))`: a step of the budget guard.
 */
export function layout(groups: readonly GroupSpec[], view: LayoutView, halve = 0): readonly LaidGroup[] {
  let left = view.limits.maxRows + groups.reduce((sum, g) => sum + view.shown(g.id), 0)
  let next = 0
  return groups.map((spec, index) => {
    const want = view.limits.sectionRows + view.shown(spec.id)
    const cap = halve > 0 ? Math.max(1, Math.floor(want / 2 ** halve)) : want
    const foldable = spec.foldable === true
    const folded = foldable && view.expanded.has(spec.id)
    const take = folded ? 0 : Math.max(0, Math.min(spec.rows.length, cap, left))
    left -= take
    const head: LaidRow | undefined = foldable
      ? { row: groupRowOf(spec), depth: 0, open: !folded, handle: spec.rows.length > 0 ? `r${next++}` : '', head: true }
      : undefined
    const rows: LaidRow[] = []
    const visit = (row: TreeRow, depth: number): void => {
      // A leaf has no open state (issue #278): its id in `expanded`, or `expandedByDefault`, changes nothing.
      const open = canOpen(row) && (row.expandedByDefault === true) !== view.expanded.has(row.id)
      rows.push({ row, depth, open, handle: `r${next++}` })
      if (open) for (const child of row.children ?? []) visit(child, depth + 1)
    }
    for (const row of spec.rows.slice(0, take)) visit(row, foldable ? 1 : 0)
    return { spec, index, ...(head === undefined ? {} : { head }), rows, more: folded ? 0 : spec.rows.length - take }
  })
}

/** The handle `rowId` gets in the next full drawing, or undefined when no drawn row holds it. */
export function handleOf(groups: readonly GroupSpec[], view: LayoutView, rowId: string): string | undefined {
  for (const g of layout(groups, view)) {
    if (hasStop(g.head) && g.head.row.id === rowId) return g.head.handle
    const hit = g.rows.find(r => r.row.id === rowId)
    if (hit !== undefined) return hit.handle
  }
  return undefined
}

/**
 * A row as the key routing sees it. The one place that builds a `RowRef`: `findRow`, `laidRefs` and the drawing use it. `can.open` is
 * set here, from the children of the row (issue #277): `o` is live where the row has children, so the footer and `route` know it.
 */
export const refOf = (row: TreeRow, group: string): RowRef => ({
  id: row.id,
  owner: row.owner,
  group,
  can: { ...row.can, open: canOpen(row) },
})

/** The rows of laid groups as the key routing sees them, in drawing order. */
export const refsOf = (laid: readonly LaidGroup[]): readonly RowRef[] =>
  laid.flatMap(g => g.rows.map(r => refOf(r.row, g.spec.id)))

/**
 * Every row that a full drawing holds (`layout` with no halving), as the key routing sees it, in drawing order. A row that a cap,
 * a filter or a closed parent leaves out is not here. The footer, the labels, the question and the press all read the marked
 * rows from this one list, so a label never counts rows that the press does not act on (issue #138).
 */
export function laidRefs(groups: readonly GroupSpec[], view: LayoutView): readonly RowRef[] {
  return refsOf(layout(groups, view))
}

/** The row with this id and the id of its group, drawn or not: a child of a closed row counts. */
function locate(
  groups: readonly GroupSpec[],
  rowId: string | null,
): { row: TreeRow; group: string; title: string } | undefined {
  if (rowId === null) return undefined
  const search = (
    rows: readonly TreeRow[],
    g: GroupSpec,
  ): { row: TreeRow; group: string; title: string } | undefined => {
    for (const row of rows) {
      if (row.id === rowId) return { row, group: g.id, title: g.title }
      const hit = search(row.children ?? [], g)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  for (const g of groups) {
    const hit = search(g.rows, g)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** The foldable group with this id (issue #256), or undefined: a row id is no group id. */
export const foldableOf = (groups: readonly GroupSpec[], id: string | null): GroupSpec | undefined =>
  id === null ? undefined : groups.find(g => g.foldable === true && g.id === id)

/**
 * The row with this id, drawn or not, as the key routing sees it. A group row of the tree view (issue #256) is one: only `o` is live
 * on it (`can.open`), as no key of a tracker, no `x` and no digit has a target there.
 */
export function findRow(groups: readonly GroupSpec[], rowId: string | null): RowRef | undefined {
  const group = foldableOf(groups, rowId)
  if (group !== undefined) return groupRefOf(group)
  const hit = locate(groups, rowId)
  return hit === undefined ? undefined : refOf(hit.row, hit.group)
}

/** The row with this id, drawn or not, whole: the selected-row line of the status area reads its cells (issue #138). */
export const findTreeRow = (groups: readonly GroupSpec[], rowId: string | null): TreeRow | undefined => {
  const group = foldableOf(groups, rowId)
  return group === undefined ? locate(groups, rowId)?.row : groupRowOf(group)
}

/** The row with this id and the title of its group, drawn or not: the detail view of the row reads both (issue #277). */
export function findDetailRow(
  groups: readonly GroupSpec[],
  rowId: string | null,
): { readonly row: TreeRow; readonly title: string } | undefined {
  const hit = locate(groups, rowId)
  return hit === undefined ? undefined : { row: hit.row, title: hit.title }
}

/**
 * The row to select once `id` is gone: the next drawn row at the same or a lower depth, else the one before. It is `survivorOf`
 * for one dismissed row, so the single and the bulk dismiss follow one rule. An `id` that no drawing holds gives none.
 */
export function neighbourOf(rows: readonly DrawnRow[], id: string): string | null {
  return rows.some(r => r.id === id) ? survivorOf(rows, id, new Set([id])) : null
}

/**
 * The row to select once the rows in `gone` are dismissed (issue #138): `from` itself when it stays, else the next drawn row
 * that stays, else the one before. A dismissed row takes its children with it, so they never stay. A `from` that no drawing
 * holds, and no selection, stay as they are. A group row (issue #256) is never the answer in place of a row that stays: when `from`
 * is dismissed, a data row comes first. A group row that is `from` and stays is kept.
 */
export function survivorOf(rows: readonly DrawnRow[], from: string | null, gone: ReadonlySet<string>): string | null {
  const at = rows.findIndex(r => r.id === from)
  if (at < 0) return from
  let under = -1 // the depth of the dismissed row whose subtree the loop is in
  const stays = rows.map(r => {
    if (under >= 0 && r.depth > under) return false
    under = gone.has(r.id) ? r.depth : -1
    return under < 0
  })
  if (stays[at] === true) return from // a group row that stays is the answer too: a bulk dismiss leaves the ring on it
  const data = (i: number): boolean => stays[i] === true && rows[i]?.head !== true
  const after = rows.findIndex((_, i) => i >= at && data(i))
  if (after >= 0) return rows[after]?.id ?? null
  const before = rows.findLastIndex((_, i) => i <= at && data(i))
  if (before >= 0) return rows[before]?.id ?? null
  // No data row stays: the closest group row that stays.
  const anyAfter = rows.findIndex((_, i) => i >= at && stays[i] === true)
  if (anyAfter >= 0) return rows[anyAfter]?.id ?? null
  const anyBefore = stays.lastIndexOf(true, at)
  return anyBefore >= 0 ? (rows[anyBefore]?.id ?? null) : null
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
  const laid = stopRowsOf(layout(groups, view)).map(r => r.row.id)
  const drawn = new Set(laid)
  if (drawn.has(selected)) return selected
  if (fellTo !== null && drawn.has(fellTo)) return fellTo
  const section = sectionOf(groups, selected, before, drawn)
  if (section !== undefined) return section
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

/**
 * The first drawn row of the section of a group row that this view lacks (issue #256): the person left the tree view with a group row
 * selected, and the next view has no such row. The last drawing says which section the group row stood for (`DrawnRow.section`), and
 * the group of the same key in the next view holds the rows. Undefined for any other id, and for a section with no drawn row (the
 * search then goes on by the last drawing).
 */
function sectionOf(
  groups: readonly GroupSpec[],
  selected: string,
  before: readonly DrawnRow[],
  drawn: ReadonlySet<string>,
): string | undefined {
  const key = before.find(r => r.id === selected && r.head === true)?.section
  if (key === undefined || groups.some(g => g.id === selected)) return undefined
  return groups
    .find(g => g.key === key)
    ?.rows.map(r => r.id)
    .find(id => drawn.has(id))
}

/**
 * The ids of the rows above `rowId` in its tree, the top row first, led by the id of its group when the group is foldable
 * (issue #256). Empty for a top row of a plain group and for an id no row holds.
 */
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
    if (hit !== undefined) return g.foldable === true ? [g.id, ...hit] : hit
  }
  return []
}
