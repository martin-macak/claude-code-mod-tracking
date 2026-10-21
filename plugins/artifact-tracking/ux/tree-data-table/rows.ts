// The pane as elements: the one header row of the table, the title row of each group, a row per laid row with its detail
// lines and the "N more" row. The columns are solved once for every row of every group (`solving`), so the cells of two
// groups stand under the same header. The row Box starts with the gutter that marks the selected row. Spec 5.10 "Rows".
// Decisions G10, G19 of plan L6. Design study of issue #63, section 5.
import type { RenderElement } from 'claude-code'
import type { Cell, DetailLine } from '../../core/interfaces/view'
import { cellWidth, clipMiddle, clipTo, normaliseCell } from '../text/cell-width'
import { wrapRows } from '../text/wrap'
import { COLOR, cellBox, cellText, GLYPH } from '../theme'
import { cellNode, headerRow, shown, titleRow } from './cells'
import { cellOf, GAP, GLYPH_BOX, INDENT, SHARED_COLUMNS, type Solved, type SolvedColumn, solveColumns } from './columns'
import { detailOf } from './detail'
import { box, button, type TableElements, text } from './el'
import type { LaidGroup, LaidRow } from './layout'
import { DEFAULT_BODY_COLUMNS, DETAIL_CELLS, GUTTER, indentOf, type TableActions, type TableView } from './shape'

/** A detail line keeps at least this many cells for its text. */
const MIN_DETAIL = 20
const EMPTY: Cell = { text: '' }
/** The id of the one table in the width memo of the solver. */
const TABLE = 'pane'

/** What one drawing of the table needs besides its groups. */
export interface Draw {
  readonly el: TableElements
  readonly view: TableView
  readonly actions: TableActions
  /** Draw the detail lines of open rows. The budget guard turns this off first. */
  readonly detail: boolean
  /** The handle that gets `autoFocus`, if any. */
  readonly focus: string | undefined
}

function treeCell(d: Draw, col: SolvedColumn, cell: Cell, r: LaidRow, dim: boolean): RenderElement {
  const indent = indentOf(col.width, r.depth)
  const label = clipTo(normaliseCell(cell.text), col.width - indent - GLYPH_BOX)
  const handle = button(d.el, {
    key: r.handle,
    plain: true,
    label: r.open ? GLYPH.open : GLYPH.closed,
    ...(r.handle === d.focus ? { autoFocus: true as const } : {}),
    onPress: () => d.actions.toggle(r.row.id),
  })
  return box(
    d.el,
    { width: col.width, flexShrink: 0, paddingLeft: indent, ...cellBox(cell) },
    box(d.el, { width: GLYPH_BOX, flexShrink: 0 }, handle),
    label === '' ? null : cellNode(d.el, cell, label, dim),
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

function rowLine(d: Draw, solved: Solved, r: LaidRow): RenderElement {
  const selected = r.row.id === d.view.selected
  // A pane that has no keys keeps the marker, dim, and drops the background: nothing here answers a key (issue #108).
  const live = d.view.focused !== false
  const dim = r.row.dim === true
  const cells = solved.columns.map(col => {
    if (col.id === 'extras') return extrasCell(d, col, r, dim)
    const cell = cellOf(r.row, col.id) ?? EMPTY
    if (col.tree) return treeCell(d, col, cell, r, dim)
    return box(
      d.el,
      { width: col.width, flexShrink: 0, justifyContent: col.justify, ...cellBox(cell) },
      cellNode(
        d.el,
        cell,
        ((cell.clip ?? col.clip) === 'middle' ? clipMiddle : clipTo)(normaliseCell(cell.text), col.width),
        dim,
      ),
    )
  })
  return box(
    d.el,
    { columnGap: 1, ...(selected && live ? { backgroundColor: COLOR.selected } : {}) },
    text(d.el, selected && !live ? { dimColor: true } : {}, selected ? GLYPH.selected : GLYPH.unselected),
    ...cells,
  )
}

function detailLine(d: Draw, line: DetailLine, pad: number, dim: boolean): RenderElement {
  const label = line.label === undefined ? null : text(d.el, { dimColor: true }, `${normaliseCell(line.label)}:`)
  const body = clipTo(normaliseCell(line.cell.text), DETAIL_CELLS)
  return box(
    d.el,
    { columnGap: 1, paddingLeft: pad },
    label,
    text(d.el, { ...cellText(line.cell, dim), wrap: 'wrap' }, shown(d.el, line.cell, body)),
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

/** The solved columns of the table and where its rows start: what a row and its detail lines need. */
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
  const solved = solveColumns(
    TABLE,
    SHARED_COLUMNS,
    laid.flatMap(g => g.rows),
    width - GUTTER,
  )
  return { solved, offset: GUTTER + treeOffset(solved), width }
}

/** The detail lines of a row and their indent. None when the budget guard turned detail off or the row is closed. */
export function detailsOf(
  d: Draw,
  g: Solving,
  r: LaidRow,
): { readonly lines: readonly DetailLine[]; readonly pad: number } {
  if (!d.detail || !r.open) return { lines: [], pad: 0 }
  const pad = Math.min(g.offset + INDENT * r.depth + GLYPH_BOX, Math.max(0, g.width - MIN_DETAIL))
  return { lines: detailOf(r.row, SHARED_COLUMNS, g.solved, r.depth), pad }
}

/**
 * The rows a detail line takes: its text wraps in what the indent and the label leave of the body. The window counts
 * them before it draws, so it must wrap as the engine does.
 */
export function detailRows(line: DetailLine, pad: number, width: number): number {
  const label = line.label === undefined ? 0 : cellWidth(`${normaliseCell(line.label)}:`) + 1
  return wrapRows(clipTo(normaliseCell(line.cell.text), DETAIL_CELLS), width - pad - label)
}

/** The rows a laid row takes: its own line and its detail lines. */
export function rowLines(d: Draw, g: Solving, r: LaidRow): number {
  const { lines, pad } = detailsOf(d, g, r)
  return 1 + lines.reduce((sum, line) => sum + detailRows(line, pad, g.width), 0)
}

/** A row and its detail lines. */
export function rowParts(d: Draw, g: Solving, r: LaidRow): RenderElement[] {
  const { lines, pad } = detailsOf(d, g, r)
  return [rowLine(d, g.solved, r), ...lines.map(line => detailLine(d, line, pad, r.row.dim === true))]
}

/** The one header row of the table, over the columns of the rows. */
export const tableHeader = (d: Draw, g: Solving): RenderElement => headerRow(d.el, SHARED_COLUMNS, g.solved)

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
  const headed = laid.some(s => s.rows.length > 0)
  return laid.map((s, i) => {
    const lead = i === 0 && headed ? [tableHeader(d, g)] : []
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
