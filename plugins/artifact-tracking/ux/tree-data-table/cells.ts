// The cells of the pane: a cell's text (a Link when it has a usable href), the title row of a group and the one header row
// of the table. Every cell is `Box width` + `Text`, with the data clipped to its column first (`clipTo`, or `clipMiddle`
// for a column or a cell with `clip: 'middle'`), so the engine never cuts.
// Spec 5.10 "Columns", "Header". Decision G19 of plan L6. Design study of issue #63, sections 5.2 and 5.3.
import type { RenderChildren, RenderElement } from 'claude-code'
import type { Cell, ColumnDef, GroupSpec } from '../../core/interfaces/view'
import { cellWidth, clipTo, normaliseCell } from '../text/cell-width'
import { cellText, GLYPH } from '../theme'
import type { Solved } from './columns'
import { box, link, type TableElements, text } from './el'

/** A link longer than this is refused by the engine, and one bad prop refuses the whole pane: draw it plain. */
const LINK_MAX = 2048

/** The label of a cell, as a Link when the cell has a usable href. */
export function shown(el: TableElements, cell: Cell, label: string): RenderChildren {
  const href = cell.href
  return href !== undefined && href !== '' && href.length <= LINK_MAX ? link(el, { href }, label) : label
}

export const cellNode = (el: TableElements, cell: Cell, label: string, dim: boolean): RenderElement =>
  text(el, cellText(cell, dim), shown(el, cell, label))

/**
 * The title line of a group: the title, the number of its rows and, when some failed, `(n failed)` in the error color,
 * then the note. The note is clipped to the width that the rest leaves.
 */
export function titleRow(el: TableElements, spec: GroupSpec, width: number): RenderElement {
  const title = normaliseCell(spec.title)
  const count = String(spec.count)
  const failed = spec.failing > 0 ? `(${spec.failing} failed)` : undefined
  const note = spec.note
  const used = cellWidth(title) + 1 + cellWidth(count) + (failed === undefined ? 0 : 1 + cellWidth(failed))
  const room = Math.max(1, width - used - 1)
  return box(
    el,
    { columnGap: 1 },
    text(el, { weight: 'bold' }, title),
    text(el, {}, count),
    failed === undefined ? null : text(el, cellText({ text: failed, fg: 'error' }, false), failed),
    note === undefined
      ? null
      : text(
          el,
          { ...cellText(note, false), ...(note.fg === undefined ? { dimColor: true } : {}) },
          shown(el, note, clipTo(normaliseCell(note.text), room)),
        ),
  )
}

/** The one header row of the table: the words of the columns that are drawn, over their cells. */
export function headerRow(el: TableElements, columns: readonly ColumnDef[], solved: Solved): RenderElement {
  const headers = new Map(columns.map(c => [c.id, c.header] as const))
  return box(
    el,
    { columnGap: 1 },
    text(el, {}, GLYPH.unselected),
    ...solved.columns.map(col => {
      const head = clipTo(normaliseCell(headers.get(col.id) ?? ''), col.width)
      return box(
        el,
        { width: col.width, flexShrink: 0, justifyContent: col.justify },
        head === '' ? null : text(el, { weight: 'bold', wrap: 'truncate-end' }, head),
      )
    }),
  )
}
