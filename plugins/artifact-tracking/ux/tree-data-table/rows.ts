// The pane as elements: the one header row of the table, the title row of each group, a row per laid row
// and the "N more" row. The columns are solved once for every row of every group (`solving`), so the cells of two
// groups stand under the same header. The row Box starts with the gutter that marks the selected row. Spec 5.10 "Rows".
// Decisions G10, G19 of plan L6. Design study of issue #63, section 5.
import type { RenderElement } from 'claude-code'
import type { Cell } from '../../core/interfaces/view'
import { cellWidth, clipMiddle, clipTo, normaliseCell } from '../text/cell-width'
import { COLOR, cellBox, cellText, GLYPH } from '../theme'
import { cellNode, headerRow, titleRow } from './cells'
import { cellOf, GAP, GLYPH_BOX, SHARED_COLUMNS, type Solved, type SolvedColumn, solveColumns } from './columns'
import { box, button, type TableElements, text } from './el'
import { glyphOf, hasStop, type LaidGroup, type LaidRow, solverRowsOf } from './layout'
import { DEFAULT_BODY_COLUMNS, GUTTER, indentOf, type TableActions, type TableView } from './shape'

const EMPTY: Cell = { text: '' }
/**
 * The id of the one table in the width memo of the solver. The tree view (issue #256) has its own: its group rows widen the
 * columns, and the by-list view keeps its widths.
 */
const TABLE = 'pane'
const TREE_TABLE = 'pane:tree'

/** What one drawing of the table needs besides its groups. */
export interface Draw {
  readonly el: TableElements
  readonly view: TableView
  readonly actions: TableActions
  /** The handle that gets `autoFocus`, if any. */
  readonly focus: string | undefined
}

/** How a cell is cut when it is too wide: the cell's own `clip` first, then the column's. Default: at the end. */
const clipFor = (cell: Cell, col: SolvedColumn) => ((cell.clip ?? col.clip) === 'middle' ? clipMiddle : clipTo)

/**
 * `bare` draws the glyph as text, with no Button and so no Tab stop: the copy of a group row above a window that starts inside its
 * section (issue #256), whose Button sits out of the window. A group row with no handle has no Button either.
 */
function treeCell(
  d: Draw,
  col: SolvedColumn,
  cell: Cell,
  r: LaidRow,
  dim: boolean,
  bare: boolean,
  after: RenderElement | null = null,
): RenderElement {
  const indent = indentOf(col.width, r.depth)
  const room = col.width - indent - GLYPH_BOX
  const label = clipFor(cell, col)(normaliseCell(cell.text), room)
  const handle =
    !hasStop(r) || bare
      ? text(d.el, {}, glyphOf(r))
      : button(d.el, {
          key: r.handle,
          plain: true,
          label: glyphOf(r),
          ...(r.handle === d.focus ? { autoFocus: true as const } : {}),
          onPress: () => d.actions.enter(r.row.id),
        })
  return box(
    d.el,
    { width: col.width, flexShrink: 0, paddingLeft: indent, ...cellBox(cell) },
    box(d.el, { width: GLYPH_BOX, flexShrink: 0 }, handle),
    label === '' ? null : cellNode(d.el, cell, label, dim),
    after,
  )
}

/**
 * The extras cell of a row: one Text for each badge, so each keeps the color of its token, with a space between. A badge
 * that fits is drawn whole. The first that does not fit is cut to the room that is left (two cells at least), and the
 * badges after it are left out. A badge is no Button, so it takes no Tab stop.
 */
function extrasCell(d: Draw, col: SolvedColumn, r: LaidRow, dim: boolean): RenderElement {
  const parts: RenderElement[] = []
  let room = col.width
  for (const badge of r.row.extras ?? []) {
    const full = normaliseCell(badge.text)
    if (full === '') continue
    const label = cellWidth(full) <= room ? full : room >= 2 ? clipTo(full, room) : ''
    if (label === '') break
    parts.push(cellNode(d.el, badge, label, dim))
    room -= cellWidth(label) + GAP
    if (room <= 0) break
  }
  return box(d.el, { width: col.width, flexShrink: 0, columnGap: GAP, justifyContent: col.justify }, ...parts)
}

/**
 * The control cell of a marked row (issue #138): `*` in the first cell, the level marker in the cell that is left. Both are
 * one glyph wide, so the column keeps its two cells. The marker keeps its color and its dim.
 */
function markedControl(d: Draw, col: SolvedColumn, cell: Cell, dim: boolean): RenderElement {
  const rest = clipTo(normaliseCell(cell.text), Math.max(0, col.width - cellWidth(GLYPH.marked)))
  return box(
    d.el,
    { width: col.width, flexShrink: 0, justifyContent: col.justify, ...cellBox(cell) },
    text(d.el, cellText({ text: GLYPH.marked, fg: 'accent' }, dim), GLYPH.marked),
    rest === '' ? null : cellNode(d.el, cell, rest, dim),
  )
}

/**
 * The title of a group row that the name column cuts (issue #256, R14): it spans the name and the description columns, so a
 * narrow pane keeps the whole title and the count. The note follows the title in the room that is left, and is left out when
 * none is. Undefined when the title fits in the name column (the note then stands in the description column) or the row has no
 * description column after the name.
 */
function spanOf(
  solved: Solved,
  r: LaidRow,
): { readonly col: SolvedColumn; readonly note: Cell | undefined } | undefined {
  const at = solved.columns.findIndex(c => c.tree)
  const name = solved.columns[at]
  const next = solved.columns[at + 1]
  if (r.head !== true || name === undefined || next?.id !== 'description') return undefined
  const title = normaliseCell(cellOf(r.row, name.id)?.text ?? '')
  if (cellWidth(title) <= name.width - indentOf(name.width, r.depth) - GLYPH_BOX) return undefined
  return { col: { ...name, width: name.width + GAP + next.width }, note: cellOf(r.row, next.id) }
}

/** The note of a spanned group row, clipped to the room the title leaves in the cell (three cells at least), or none. */
function noteAfter(
  d: Draw,
  span: { readonly col: SolvedColumn; readonly note: Cell | undefined },
  r: LaidRow,
): RenderElement | null {
  const { col, note } = span
  if (note === undefined) return null
  const title = cellOf(r.row, col.id)?.text ?? ''
  const used =
    GLYPH_BOX + Math.min(cellWidth(normaliseCell(title)), col.width - indentOf(col.width, r.depth) - GLYPH_BOX)
  const room = col.width - indentOf(col.width, r.depth) - used - GAP
  if (room < 3) return null
  return box(
    d.el,
    { paddingLeft: GAP },
    cellNode(d.el, note, clipTo(normaliseCell(note.text), room), r.row.dim === true),
  )
}

function rowLine(d: Draw, solved: Solved, r: LaidRow, bare = false): RenderElement {
  const selected = r.row.id === d.view.selected
  // A pane that has no keys keeps the marker, dim, and drops the background: nothing here answers a key (issue #108).
  const live = d.view.focused !== false
  const dim = r.row.dim === true
  const span = spanOf(solved, r)
  const cells = solved.columns.flatMap(col => {
    if (span !== undefined && col.id === 'description') return []
    if (span !== undefined && col.tree)
      return [treeCell(d, span.col, cellOf(r.row, col.id) ?? EMPTY, r, dim, bare, noteAfter(d, span, r))]
    return [cellFor(d, col, r, dim, bare)]
  })
  return box(
    d.el,
    { columnGap: 1, ...(selected && live ? { backgroundColor: COLOR.selected } : {}) },
    text(d.el, selected && !live ? { dimColor: true } : {}, selected ? GLYPH.selected : GLYPH.unselected),
    ...cells,
  )
}

function cellFor(d: Draw, col: SolvedColumn, r: LaidRow, dim: boolean, bare: boolean): RenderElement {
  if (col.id === 'extras') return extrasCell(d, col, r, dim)
  const cell = cellOf(r.row, col.id) ?? EMPTY
  if (col.tree) return treeCell(d, col, cell, r, dim, bare)
  if (col.id === 'control' && d.view.marked?.has(r.row.id) === true) return markedControl(d, col, cell, dim)
  return box(
    d.el,
    { width: col.width, flexShrink: 0, justifyContent: col.justify, ...cellBox(cell) },
    cellNode(d.el, cell, clipFor(cell, col)(normaliseCell(cell.text), col.width), dim),
  )
}

/** The cells between the gutter and the tree column: their widths and the gaps after them. */
function treeOffset(solved: Solved): number {
  const before = solved.columns.slice(
    0,
    Math.max(
      0,
      solved.columns.findIndex(c => c.tree),
    ),
  )
  return before.reduce((sum, c) => sum + c.width + GAP, 0)
}

function moreRow(d: Draw, g: LaidGroup, pad: number): RenderElement {
  const press = () => d.actions.more(g.spec.id)
  return box(
    d.el,
    { paddingLeft: pad },
    button(d.el, { key: `m${g.index}`, plain: true, label: `${g.more} more`, onPress: press }),
  )
}

/** The solved columns of the table and where its rows start: what a row needs. */
export interface Solving {
  readonly solved: Solved
  /** The cells before the tree column, the gutter included. */
  readonly offset: number
  readonly width: number
}

/**
 * The columns come from every row of every group, drawn or not, so they hold still while a window moves over them and
 * the cells of two groups stand under the same header.
 */
export function solving(d: Draw, laid: readonly LaidGroup[]): Solving {
  const width = d.view.bodyColumns ?? DEFAULT_BODY_COLUMNS
  const solved = solvedOf(laid, width)
  return { solved, offset: GUTTER + treeOffset(solved), width }
}

/**
 * The columns of the table for these laid rows in a body `width` wide. The quick view (issue #276) reads the same columns to know
 * which cells the table cut, so it asks here and the two cannot solve the columns two ways.
 */
export const solvedOf = (laid: readonly LaidGroup[], width: number): Solved =>
  solveColumns(
    laid.some(g => g.spec.foldable === true) ? TREE_TABLE : TABLE,
    SHARED_COLUMNS,
    solverRowsOf(laid),
    width - GUTTER,
  )

/** A row: its own line. A row has no detail lines under it (issue #278): the quick view and the detail view show its detail. */
export const rowParts = (d: Draw, g: Solving, r: LaidRow): RenderElement[] => [rowLine(d, g.solved, r)]

/** The one header row of the table, over the columns of the rows. */
export const tableHeader = (d: Draw, g: Solving): RenderElement => headerRow(d.el, SHARED_COLUMNS, g.solved)

/**
 * The group row of a foldable group (issue #256): a row of the table, with the Button of its glyph. `bare` draws a copy with no
 * Button, for a window that starts inside the section: the Button keeps its place among the stops (windowed.ts).
 */
export const groupRowLine = (g: Solving, d: Draw, head: LaidRow, bare = false): RenderElement =>
  rowLine(d, g.solved, head, bare)

/** The text of a group with no row, under its group row (issue #256): what the title line path draws after the title. */
export const emptyOf = (d: Draw, s: LaidGroup): RenderElement | null =>
  s.spec.rows.length === 0 && s.spec.empty !== undefined
    ? text(d.el, { dimColor: true }, normaliseCell(s.spec.empty))
    : null

/** The title row of a group that has a row to draw. */
export const groupTitle = (d: Draw, s: LaidGroup, g: Solving): RenderElement => titleRow(d.el, s.spec, g.width)

/** The "N more" row of a group that has rows, indented under the tree column. */
export const moreRowOf = (d: Draw, s: LaidGroup, g: Solving): RenderElement => moreRow(d, s, g.offset)

/** A group with no row to draw: its title, its empty text and the "N more" row at the gutter. Nothing to solve. */
export function bareParts(d: Draw, s: LaidGroup): RenderElement[] {
  const { el } = d
  const parts: RenderElement[] = [titleRow(el, s.spec, d.view.bodyColumns ?? DEFAULT_BODY_COLUMNS)]
  if (s.spec.rows.length === 0 && s.spec.empty !== undefined) {
    parts.push(text(el, { dimColor: true }, normaliseCell(s.spec.empty)))
  }
  if (s.more > 0) parts.push(moreRow(d, s, GUTTER))
  return parts
}

/**
 * The laid groups, one Box each. The first Box starts with the header of the table, when any group has a row to draw: the
 * root Box puts a gap between its children, and the header stands right over the first title.
 */
export function drawGroups(d: Draw, laid: readonly LaidGroup[]): RenderElement[] {
  const g = solving(d, laid)
  // A group row is a row of the table: a pane of folded groups keeps its header and draws every group row in the columns.
  const headed = laid.some(s => s.rows.length > 0 || s.head !== undefined)
  return laid.map((s, i) => {
    const lead = i === 0 && headed ? [tableHeader(d, g)] : []
    if (s.head !== undefined) {
      return box(
        d.el,
        { flexDirection: 'column' },
        ...lead,
        groupRowLine(g, d, s.head),
        emptyOf(d, s),
        ...s.rows.flatMap(r => rowParts(d, g, r)),
        ...(s.more > 0 ? [moreRowOf(d, s, g)] : []),
      )
    }
    if (s.rows.length === 0) return box(d.el, { flexDirection: 'column' }, ...lead, ...bareParts(d, s))
    return box(
      d.el,
      { flexDirection: 'column' },
      ...lead,
      groupTitle(d, s, g),
      ...s.rows.flatMap(r => rowParts(d, g, r)),
      ...(s.more > 0 ? [moreRowOf(d, s, g)] : []),
    )
  })
}
