// The quick view of the selected row (issue #276, L1 of #275): the lines below the `Selected:` line that the row cannot show. They are
// the lines of the detail of the row (`quickDetailOf`) as status lines: one row each, cut cell by cell, indented under the first line.
// A link is plain text, cut in the middle. The pane builds them once for the selected row, and the status area decides how many of them
// the body has room for (status.ts). Pure.
import type { CellId, DetailLine, StatusLine, TreeRow } from '../../core/interfaces/view'
import { normaliseCell } from '../text/cell-width'
import { SHARED_COLUMNS, type Solved } from './columns'
import { quickDetailOf } from './detail'
import { wholeCellsOf } from './status'

/** The cells that the lines of the quick view sit in from the left: under the label of the first line. */
const INDENT = 2

/**
 * A line with no label and no words: a blank line of a plan or a response. The status line of it is an empty Box, which takes no row,
 * so it would count as one of the capped rows and show nothing.
 */
const isBlank = (line: DetailLine): boolean => line.label === undefined && normaliseCell(line.cell.text).trim() === ''

const lineOf = (line: DetailLine): StatusLine => ({
  label: line.label === undefined ? '' : `${normaliseCell(line.label).toLowerCase()}:`,
  indent: INDENT,
  // No `href`: a link is plain text here, so the line is a Text and takes no Tab stop. The link line says `clip: 'middle'` itself.
  cells: [{ ...line.cell, href: undefined }],
})

/**
 * The lines of the quick view of `row` below its first line, for the columns `solved` of a body `columns` wide. The name and the status
 * need no line when the first line draws them whole in `columns` cells (`wholeCellsOf`): else the text would show nowhere. A blank line
 * is none. Calls the `detail()` of the row once.
 */
export const quickLines = (row: TreeRow, solved: Solved, columns: number): readonly StatusLine[] =>
  quickDetailOf(row, SHARED_COLUMNS, solved, new Set<CellId>(['control', ...wholeCellsOf(row, columns)]))
    .filter(line => !isBlank(line))
    .map(lineOf)
