// The status area of the pane (issue #138): with 18 body rows or more, a summary row above the table and two lines in the footer
// Box, the selected row and the health. Below 18 rows the bottom is the view line and the footer, as it was. Each line takes one
// row at every width: it is clipped cell by cell (as `extrasCell` clips the badges), so its row count is a constant and the window
// can count it. Pure.
import type { RenderElement } from 'claude-code'
import type { Cell, StatusLine, TreeRow } from '../../core/interfaces/view'
import { cellWidth, clipTo, normaliseCell } from '../text/cell-width'
import { cellNode } from './cells'
import { box, type TableElements, text } from './el'
import type { TableView } from './shape'

/** The body rows (the engine's `bodyRows`) from which the pane draws the full status area. */
export const FULL_ROWS = 18

/** The rows that the footer Box takes for the status area: the selected-row line and the health line. The summary row is the wrapper's. */
export const STATUS_ROWS = 2

/** The rows of the summary row of the full status area: one, above the table, drawn by `withSummary`. */
export const SUMMARY_ROWS = 1

/**
 * The status lines the table draws for a view: none in the help view, which has no status area. The footer draws them and the
 * window budgets them from this one rule, so the drawing and the budget cannot drift apart (the failure of issue #109).
 */
export const statusOf = (view: Pick<TableView, 'status' | 'help'>): TableView['status'] =>
  view.help === null ? view.status : undefined

/** The rows the status lines of a view take in the footer Box. */
export const statusRows = (view: Pick<TableView, 'status' | 'help'>): number =>
  statusOf(view) === undefined ? 0 : STATUS_ROWS

/** The cells between two items of a line. */
const GAP = 1
/** What the summary row says when no section has a count: the row stays, so the budget does not jump. */
const NO_COUNTS = 'No counts yet'
const NO_SELECTION = 'No row selected'
const SELECTED_LABEL = 'Selected:'
const DOT = '·'

export type StatusForm = 'compact' | 'full'

/**
 * The form of the bottom of the pane. It follows the engine's body (`scroll.bodyRows`), before the keys hint line takes its row:
 * a move of the keys to the prompt and back must not flip it. No body height is known: compact.
 */
export const statusForm = (bodyRows: number | undefined): StatusForm =>
  bodyRows !== undefined && bodyRows >= FULL_ROWS ? 'full' : 'compact'

/**
 * The selected-row line of a row: its name, its status in the color of its token, its badges and its strongest reason (dim). A
 * docked pane of 49 cells cuts the badges of the row (`✓ checks` shows as `✓…`); the line has the room to show them whole. With
 * no row: a dim `No row selected`, so the line always takes its row.
 */
export function selectedLine(row: TreeRow | undefined): StatusLine {
  if (row === undefined) return { label: '', cells: [{ text: NO_SELECTION, dim: true }] }
  const name = [row.cells.name, row.cells.description].find(c => c !== undefined && normaliseCell(c.text).trim() !== '')
  const status = row.cells.status
  const reason = row.reasons?.strongest
  return {
    label: SELECTED_LABEL,
    cells: [
      ...(name === undefined ? [] : [name]),
      ...(status === undefined || status.text === '' ? [] : [status]),
      ...(row.extras ?? []),
      ...(reason === undefined ? [] : [{ text: reason, dim: true }]),
    ],
  }
}

/**
 * The label and the cells of a line, as Texts in one row. A cell that fits is drawn whole; the first that does not is cut, the rest
 * are left out. The tail of the line keeps its room: the cells before it are cut to leave it, and it is drawn last, whole when it
 * fits.
 */
export function statusLineBox(el: TableElements, line: StatusLine, columns: number): RenderElement {
  const parts: RenderElement[] = []
  let used = 0
  const label = clipTo(normaliseCell(line.label), columns)
  if (label !== '') {
    parts.push(text(el, { dimColor: true, wrap: 'truncate-end' }, label))
    used = cellWidth(label)
  }
  let drawn = 0
  // Draws `cell` inside `limit` cells: whole, cut to the room that is left, or not at all. A dim dot goes between two cells, none
  // after the label. The gap before the dot and the gap after it count.
  const place = (cell: Cell, limit: number): 'whole' | 'cut' | 'none' => {
    const full = normaliseCell(cell.text)
    if (full === '') return 'whole'
    const lead = parts.length === 0 ? 0 : drawn === 0 ? GAP : GAP + cellWidth(DOT) + GAP
    const room = limit - used - lead
    const fit = cellWidth(full) <= room ? full : room >= 2 ? clipTo(full, room) : ''
    if (fit === '') return 'none'
    if (drawn > 0) parts.push(text(el, { dimColor: true }, DOT))
    parts.push(cellNode(el, cell, fit, false))
    used += lead + cellWidth(fit)
    drawn++
    return fit === full ? 'whole' : 'cut'
  }
  const tail = line.tail === undefined ? '' : normaliseCell(line.tail.text)
  // The room of the tail: its width, and the dot and the two gaps before it.
  const reserve = tail === '' ? 0 : GAP + cellWidth(DOT) + GAP + cellWidth(tail)
  for (const cell of line.cells) if (place(cell, columns - reserve) !== 'whole') break
  if (line.tail !== undefined) place(line.tail, columns)
  return box(el, { columnGap: GAP }, ...parts)
}

/** `tree` under the summary row: the words of the band, or a dim line when no section has a count. The row is clipped to one row. */
export function withSummary(
  el: TableElements,
  summary: string | null,
  columns: number,
  tree: RenderElement,
): RenderElement {
  const words = summary === null ? undefined : clipTo(normaliseCell(summary), columns)
  return box(
    el,
    { flexDirection: 'column' },
    words === undefined ? text(el, { dimColor: true }, NO_COUNTS) : text(el, { wrap: 'truncate-end' }, words),
    tree,
  )
}
