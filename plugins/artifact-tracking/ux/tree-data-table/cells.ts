// The cells of the pane: a cell's text (a Link when it has a usable href), a section's title row and its header row.
// Every cell is `Box width` + `Text`, with the data clipped to its column first (`clipTo`, or `clipMiddle` for a column
// or a cell with `clip: 'middle'`), so the engine never cuts.
// Spec 5.10 "Columns", "Header". Decision G19 of plan L6.
import type { RenderChildren, RenderElement } from 'claude-code'
import type { Cell, ColumnDef, SectionSpec } from '../../core/interfaces/view'
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

export function titleRow(el: TableElements, spec: SectionSpec, width: number): RenderElement {
  const title = normaliseCell(spec.title)
  const note = spec.note
  const room = Math.max(1, width - cellWidth(title) - 1)
  return box(
    el,
    { columnGap: 1 },
    text(el, { weight: 'bold' }, title),
    note === undefined
      ? null
      : text(
          el,
          { ...cellText(note, false), ...(note.fg === undefined ? { dimColor: true } : {}) },
          shown(el, note, clipTo(normaliseCell(note.text), room)),
        ),
  )
}

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
