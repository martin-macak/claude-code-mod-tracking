// The status area of the pane (issue #138): with 18 body rows or more, a summary row above the table and two lines in the footer
// Box, the selected row and the health. Below 18 rows the bottom is the view line and the footer, as it was. Each line takes one
// row at every width: it is clipped cell by cell (as `extrasCell` clips the badges), so its row count is a constant and the window
// can count it. The quick view of the selected row (issue #276, L1 of #275) adds lines below the selected line; `statusOf` and
// `statusRows` are the one rule that says how many, for the drawing and for the window. Pure.
import type { RenderElement } from 'claude-code'
import type { Cell, CellId, StatusLine, TreeRow } from '../../core/interfaces/view'
import { cellWidth, clipMiddle, clipTo, normaliseCell } from '../text/cell-width'
import { cellNode } from './cells'
import { box, type TableElements, text } from './el'
import { footerRows } from './footer'
import { DEFAULT_BODY_COLUMNS, ROW_GAP, type StatusArea, type StatusForm, type TableView, textView } from './shape'
import { viewLineRows } from './viewline'
import { listFloor } from './window'

export type { StatusForm } from './shape'

/** The body rows (the engine's `bodyRows`) from which the pane draws the full status area. */
export const FULL_ROWS = 18

/** The rows of the summary row of the full status area: one, above the table, drawn by `withSummary`. */
export const SUMMARY_ROWS = 1

/**
 * The most rows the quick view takes, the selected-row line included, and the data rows the list keeps whatever it takes (issue #276,
 * owner decision Q3): the full form takes at most 6 rows and the list keeps 5 data rows, the compact form at most 3 and 2.
 */
export const QUICK_ROWS: Readonly<Record<StatusForm, number>> = { full: 6, compact: 3 }
export const LIST_ROWS: Readonly<Record<StatusForm, number>> = { full: 5, compact: 2 }

/** What the tail of a cut quick view says: how many lines it leaves out. */
const moreTail = (n: number): Cell => ({ text: `+${n} more`, dim: true })

/** The rows of the status area apart from the quick view, which the list needs to stay in view: see `quickRows`. */
type StatusInput = Pick<TableView, 'status' | 'help' | 'plan' | 'bodyRows' | 'bodyColumns' | 'footer' | 'viewLine'>

/**
 * The rows of the bottom of a body apart from the status area: the footer, the view line and the gap above them. The window takes
 * them off its budget (`windowOf`) and the quick view takes them off its room (`quickRows`), so the two read one count.
 */
export function bottomRows(view: Pick<TableView, 'bodyColumns' | 'footer' | 'viewLine'>): number {
  const columns = view.bodyColumns ?? DEFAULT_BODY_COLUMNS
  return footerRows(view.footer, columns, false) + viewLineRows(view.viewLine, columns) + ROW_GAP
}

/**
 * The rows the quick view may take, the selected-row line included (at least that one). The cap of the form, the lines the row has,
 * and the room the body leaves: the list must keep its data rows (`LIST_ROWS`) with what `listFloor` says they need (the header, the
 * title of one group and a hint on each side, as the selection in the middle of a list shows them), the detail lines of the selected
 * row when it is open (`quick.open`: the window shows that unit whatever its height, so it cannot give them back), the health line and
 * the bottom. The room is the same for any selection of a closed row, so the quick view holds still while the person moves between
 * rows of the same lines. With a second group in view the window spends a title and a gap more, which the room does not give back: at the first rows of a later
 * group the list keeps fewer data rows than the floor (3 at 96x18). No body height is known: no room limit.
 */
function quickRows(view: StatusInput, quick: NonNullable<StatusArea['quick']>): number {
  const wanted = Math.min(QUICK_ROWS[quick.form], quick.lines.length + 1)
  if (view.bodyRows === undefined) return wanted
  const around =
    bottomRows(view) +
    (view.status?.health === undefined ? 0 : 1) +
    listFloor(LIST_ROWS[quick.form]) +
    (quick.open ?? 0)
  return Math.max(1, Math.min(wanted, view.bodyRows - around))
}

/**
 * The first `rows` of `lines`. A cut list ends with a dim tail `+N more`, N the lines left out: the tail of the last line, which
 * keeps its room, so it shows at any width.
 */
export function capLines(lines: readonly StatusLine[], rows: number): readonly StatusLine[] {
  if (rows >= lines.length) return lines
  const kept = lines.slice(0, Math.max(1, rows))
  const last = kept.at(-1) as StatusLine
  return [...kept.slice(0, -1), { ...last, tail: moreTail(lines.length - kept.length) }]
}

/**
 * The status lines the table draws for a view: none in a text view (the help view and the plan view), which has no status area. The
 * selected-row lines (the first line, then as many lines of the quick view as the body has room for) and the health line. The footer draws them and the window
 * budgets them from this one rule, so the drawing and the budget cannot drift apart (the failure of issue #109).
 */
export function statusOf(
  view: StatusInput,
): { readonly selected: readonly StatusLine[]; readonly health: StatusLine | undefined } | undefined {
  const area = textView(view) ? undefined : view.status
  if (area === undefined) return undefined
  const lines =
    area.quick === undefined
      ? [area.selected]
      : capLines([area.selected, ...area.quick.lines], quickRows(view, area.quick))
  return { selected: lines, health: area.health }
}

/** The rows the status lines of a view take in the footer Box. */
export function statusRows(view: StatusInput): number {
  const lines = statusOf(view)
  return lines === undefined ? 0 : lines.selected.length + (lines.health === undefined ? 0 : 1)
}

/** The cells between two items of a line. */
const GAP = 1
/** What the summary row says when no section has a count: the row stays, so the budget does not jump. */
const NO_COUNTS = 'No counts yet'
const NO_SELECTION = 'No row selected'
const SELECTED_LABEL = 'Selected:'
const DOT = '·'

/**
 * The form of the bottom of the pane. It follows the engine's body (`scroll.bodyRows`), before the keys hint line takes its row:
 * a move of the keys to the prompt and back must not flip it. No body height is known: compact.
 */
export const statusForm = (bodyRows: number | undefined): StatusForm =>
  bodyRows !== undefined && bodyRows >= FULL_ROWS ? 'full' : 'compact'

/** The cell that names a row in the selected-row line: its name, else its description when the name is empty. None when both are. */
export const nameCellOf = (row: TreeRow): Extract<CellId, 'name' | 'description'> | undefined =>
  (['name', 'description'] as const).find(id => {
    const cell = row.cells[id]
    return cell !== undefined && normaliseCell(cell.text).trim() !== ''
  })

/** A cell of the selected-row line and the table cell it shows. The badges and the reason are no cell of the table: no id. */
interface SelectedCell {
  readonly id: CellId | undefined
  readonly cell: Cell
}

const selectedCells = (row: TreeRow): readonly SelectedCell[] => {
  const nameId = nameCellOf(row)
  const name = nameId === undefined ? undefined : row.cells[nameId]
  const status = row.cells.status
  const reason = row.reasons?.strongest
  return [
    ...(nameId === undefined || name === undefined ? [] : [{ id: nameId, cell: name }]),
    ...(status === undefined || status.text === '' ? [] : [{ id: 'status' as const, cell: status }]),
    ...(row.extras ?? []).map(cell => ({ id: undefined, cell })),
    ...(reason === undefined ? [] : [{ id: undefined, cell: { text: reason, dim: true } }]),
  ]
}

/**
 * The selected-row line of a row: its name, its status in the color of its token, its badges and its strongest reason (dim). A
 * docked pane of 49 cells cuts the badges of the row (`✓ checks` shows as `✓…`); the line has the room to show them whole. With
 * no row: a dim `No row selected`, so the line always takes its row.
 */
export function selectedLine(row: TreeRow | undefined): StatusLine {
  if (row === undefined) return { label: '', cells: [{ text: NO_SELECTION, dim: true }] }
  return { label: SELECTED_LABEL, cells: selectedCells(row).map(c => c.cell) }
}

/**
 * The status area of a drawing: the selected-row line of `row`, the health line of the full form and the quick view when its flag
 * says so. None when the drawing has neither: the compact form with no quick view draws the bottom it had before issue #138.
 */
export function statusAreaOf(parts: {
  readonly row: TreeRow | undefined
  readonly health: StatusLine | undefined
  readonly quick: StatusArea['quick']
}): StatusArea | undefined {
  const { row, health, quick } = parts
  if (health === undefined && quick === undefined) return undefined
  return {
    selected: selectedLine(row),
    ...(health === undefined ? {} : { health }),
    ...(quick === undefined ? {} : { quick }),
  }
}

/**
 * The cells of the table that the `Selected:` line of `row` draws whole in `columns` cells: the name (else the description) and the
 * status, as far as `fitLine` leaves them room. A cell that the line cuts, or leaves out because a cell before it filled the line,
 * is not here, so the quick view gives it a line of its own (issue #276). The level marker has no words for the person.
 */
export function wholeCellsOf(row: TreeRow, columns: number): ReadonlySet<CellId> {
  const fitted = fitLine(selectedLine(row), columns).cells
  const whole = new Set<CellId>()
  selectedCells(row).forEach(({ id }, i) => {
    if (id !== undefined && fitted[i]?.whole === true) whole.add(id)
  })
  return whole
}

/** A cell of a line as `statusLineBox` draws it: the `words` it has room for ('' for none) and whether they are the whole text. */
export interface Fitted {
  readonly cell: Cell
  readonly words: string
  readonly whole: boolean
}

/**
 * How the cells of `line` fit in `columns` cells: the label (cut to the width), then each cell after a gap, and after a dot and a
 * gap from the second one. A cell that fits is whole; the first that does not is cut to the room that is left, and the cells after
 * it are left out of the result. The tail keeps its room: the cells before it are cut to leave it, and it is placed last. The one
 * place that says what a line shows, for `statusLineBox`, which draws it, and for `wholeCellsOf`, which must know what it draws whole.
 */
export function fitLine(
  line: StatusLine,
  columns: number,
): { readonly label: string; readonly cells: readonly Fitted[]; readonly tail: Fitted | undefined } {
  const label = clipTo(normaliseCell(line.label), columns)
  let used = label === '' ? 0 : cellWidth(label)
  let drawn = 0
  // Fits `cell` inside `limit` cells: whole, cut to the room that is left, or not at all. A dim dot goes between two cells, none
  // after the label. The gap before the dot and the gap after it count.
  const place = (cell: Cell, limit: number): Fitted => {
    const full = normaliseCell(cell.text)
    if (full === '') return { cell, words: '', whole: true }
    const lead = drawn > 0 ? GAP + cellWidth(DOT) + GAP : label === '' ? 0 : GAP
    const room = limit - used - lead
    const clip = cell.clip === 'middle' ? clipMiddle : clipTo
    const fit = cellWidth(full) <= room ? full : room >= 2 ? clip(full, room) : ''
    if (fit === '') return { cell, words: '', whole: false }
    used += lead + cellWidth(fit)
    drawn++
    return { cell, words: fit, whole: fit === full }
  }
  const tail = line.tail === undefined ? '' : normaliseCell(line.tail.text)
  // The room of the tail: its width, and the dot and the two gaps before it.
  const reserve = tail === '' ? 0 : GAP + cellWidth(DOT) + GAP + cellWidth(tail)
  const cells: Fitted[] = []
  for (const cell of line.cells) {
    const fitted = place(cell, columns - reserve)
    cells.push(fitted)
    if (!fitted.whole) break
  }
  return { label, cells, tail: line.tail === undefined ? undefined : place(line.tail, columns) }
}

/**
 * The label and the cells of a line, as Texts in one row (`fitLine` says what fits). The tail of the line keeps its room: the cells
 * before it are cut to leave it, and it is drawn last, whole when it fits. A line with an `indent` sits that many cells in from the
 * left (the lines of the quick view), and the cells have the width that is left. A cell with `clip: 'middle'` is cut in the middle,
 * as a link is.
 */
export function statusLineBox(el: TableElements, line: StatusLine, width: number): RenderElement {
  const indent = Math.min(line.indent ?? 0, Math.max(0, width - 1))
  const fitted = fitLine(line, width - indent)
  const parts: RenderElement[] = []
  if (fitted.label !== '') parts.push(text(el, { dimColor: true, wrap: 'truncate-end' }, fitted.label))
  let drawn = 0
  for (const f of [...fitted.cells, ...(fitted.tail === undefined ? [] : [fitted.tail])]) {
    if (f.words === '') continue
    if (drawn > 0) parts.push(text(el, { dimColor: true }, DOT))
    parts.push(cellNode(el, f.cell, f.words, false))
    drawn++
  }
  return box(el, { columnGap: GAP, ...(indent > 0 ? { paddingLeft: indent } : {}) }, ...parts)
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
