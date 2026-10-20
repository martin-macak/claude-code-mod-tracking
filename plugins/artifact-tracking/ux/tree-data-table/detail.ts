// The detail lines of an open row. A tracker's `detail()` wins. A leaf with none gets the default: the full text of
// every cell the row had to clip or drop, then the links, else one dim line. A row with reasons ends with one line that
// lists them all. Pure.
// Decision G13 of plan L6. Spec 5.10 "Rows".
import type { ColumnDef, DetailLine, TreeRow } from '../../core/interfaces/view'
import { cellWidth, normaliseCell } from '../text/cell-width'
import { GLYPH_BOX, type Solved } from './columns'
import { indentOf, NOTHING_MORE } from './shape'

/** The one line that says why the row is tracked: every reason, strongest first (issue #62). None for a row with no reasons. */
const whyOf = (row: TreeRow): readonly DetailLine[] =>
  row.reasons === undefined ? [] : [{ label: 'reasons', cell: { text: row.reasons.all.join(', ') } }]

export function detailOf(
  row: TreeRow,
  columns: readonly ColumnDef[],
  solved: Solved,
  depth: number,
): readonly DetailLine[] {
  const why = whyOf(row)
  if (row.detail !== undefined) return [...row.detail(), ...why]
  if ((row.children?.length ?? 0) > 0) return why
  // The cells of the columns still drawn have this much room; a dropped column has none.
  const room = new Map(
    solved.columns.map(c => [c.id, c.tree ? c.width - indentOf(c.width, depth) - GLYPH_BOX : c.width] as const),
  )
  const lines: DetailLine[] = []
  for (const def of columns) {
    const cell = row.cells[def.id]
    const text = normaliseCell(cell?.text ?? '')
    if (cell === undefined || text.trim() === '') continue
    const have = room.get(def.id)
    // The links follow below, so a clipped cell leaves its own href out.
    if (have === undefined || cellWidth(text) > have)
      lines.push({ label: def.header || def.id, cell: { ...cell, href: undefined } })
  }
  const links = new Set(
    columns.map(def => row.cells[def.id]?.href).filter((h): h is string => h !== undefined && h !== ''),
  )
  for (const href of links) lines.push({ label: 'link', cell: { text: href } })
  lines.push(...why)
  return lines.length > 0 ? lines : [{ cell: { text: NOTHING_MORE, dim: true } }]
}
