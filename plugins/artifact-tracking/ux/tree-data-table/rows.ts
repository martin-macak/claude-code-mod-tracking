// One section of the pane as elements: a row per laid row with its detail lines and the "N more" row, under the title
// and header rows of `cells.ts`. The row Box starts with the gutter that marks the selected row. Spec 5.10 "Rows".
// Decisions G10, G19 of plan L6.
import type { RenderElement } from 'claude-code'
import type { Cell, DetailLine } from '../../core/interfaces/view'
import { clipMiddle, clipTo, normaliseCell } from '../text/cell-width'
import { COLOR, cellBox, cellText, GLYPH } from '../theme'
import { cellNode, headerRow, shown, titleRow } from './cells'
import { GAP, GLYPH_BOX, INDENT, type Solved, type SolvedColumn, solveColumns } from './columns'
import { detailOf } from './detail'
import { box, button, type TableElements, text } from './el'
import type { LaidRow, LaidSection } from './layout'
import { DEFAULT_BODY_COLUMNS, DETAIL_CELLS, GUTTER, indentOf, type TableActions, type TableView } from './shape'

/** A detail line keeps at least this many cells for its text. */
const MIN_DETAIL = 20
const EMPTY: Cell = { text: '' }

/** What one drawing of a section needs besides the section. */
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

function rowLine(d: Draw, solved: Solved, r: LaidRow): RenderElement {
  const selected = r.row.id === d.view.selected
  const dim = r.row.dim === true
  const cells = solved.columns.map(col => {
    const cell = r.row.cells[col.id] ?? EMPTY
    if (col.tree) return treeCell(d, col, cell, r, dim)
    return box(
      d.el,
      { width: col.width, flexShrink: 0, justifyContent: col.justify, ...cellBox(cell) },
      cellNode(d.el, cell, (col.clip === 'middle' ? clipMiddle : clipTo)(normaliseCell(cell.text), col.width), dim),
    )
  })
  return box(
    d.el,
    { columnGap: 1, ...(selected ? { backgroundColor: COLOR.selected } : {}) },
    text(d.el, {}, selected ? GLYPH.selected : GLYPH.unselected),
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

function moreRow(d: Draw, s: LaidSection, pad: number): RenderElement {
  const press = () => d.actions.more(s.spec.id)
  return box(
    d.el,
    { paddingLeft: pad },
    button(d.el, { key: `m${s.index}`, plain: true, label: `${s.more} more`, onPress: press }),
  )
}

/** One laid section. With no row drawn there is nothing to solve: no header, and the "N more" row sits at the gutter. */
export function drawSection(d: Draw, s: LaidSection): RenderElement {
  const { el, view } = d
  const width = view.bodyColumns ?? DEFAULT_BODY_COLUMNS
  const parts: RenderElement[] = [titleRow(el, s.spec, width)]
  if (s.rows.length === 0) {
    if (s.spec.rows.length === 0 && s.spec.empty !== undefined) {
      parts.push(text(el, { dimColor: true }, normaliseCell(s.spec.empty)))
    }
    if (s.more > 0) parts.push(moreRow(d, s, GUTTER))
    return box(el, { flexDirection: 'column' }, ...parts)
  }
  const solved = solveColumns(s.spec.id, s.spec.columns, s.rows, width - GUTTER)
  const offset = GUTTER + treeOffset(solved)
  parts.push(headerRow(el, s.spec.columns, solved))
  for (const r of s.rows) {
    parts.push(rowLine(d, solved, r))
    if (!d.detail || !r.open) continue
    const pad = Math.min(offset + INDENT * r.depth + GLYPH_BOX, Math.max(0, width - MIN_DETAIL))
    for (const line of detailOf(r.row, s.spec.columns, solved, r.depth)) {
      parts.push(detailLine(d, line, pad, r.row.dim === true))
    }
  }
  if (s.more > 0) parts.push(moreRow(d, s, offset))
  return box(el, { flexDirection: 'column' }, ...parts)
}
