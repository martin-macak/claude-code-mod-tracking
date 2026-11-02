// The lines of the quick view of a row (issue #276), from one builder: `quickDetailOf`. The cut cells and the links first, for a
// row with children too and for a row with its own `detail()`, then the lines of that `detail()`, the reasons and the turns, with no
// badge line (the first line of the quick view has the badges) and with the count of the children. The table draws no detail lines
// under a row any more (issue #278): the quick view and the detail view show them. Pure.
// Decision G13 of plan L6. Spec 5.10 "Rows".
import type { CellId, ColumnDef, DetailLine, TreeRow } from '../../core/interfaces/view'
import { cellWidth, normaliseCell } from '../text/cell-width'
import { cellOf, GLYPH_BOX, type Solved } from './columns'
import { indentOf } from './shape'

/** The one line that says why the row is tracked: every reason, strongest first (issue #62). None for a row with no reasons. */
const whyOf = (row: TreeRow): readonly DetailLine[] =>
  row.reasons === undefined ? [] : [{ label: 'reasons', cell: { text: row.reasons.all.join(', ') } }]

/** The one line that names the first and the last turn that tracked the row's item (issue #69). None for a row no turn tracked. */
const turnsOf = (row: TreeRow): readonly DetailLine[] =>
  row.turns === undefined
    ? []
    : [{ label: 'turns', cell: { text: `first ${row.turns.first} · last ${row.turns.last}` } }]

/**
 * The lines for the cells the row had to clip or drop, then the links. A cell that fits its column, or that the row lacks, has no
 * line. The columns in `skip` need no line: the first line of the quick view draws them whole. The cells of the columns still drawn have the room of their column; a dropped column has none.
 */
function cutLines(
  row: TreeRow,
  columns: readonly ColumnDef[],
  solved: Solved,
  skip: ReadonlySet<string>,
): readonly DetailLine[] {
  const room = new Map(
    solved.columns.map(c => [c.id, c.tree ? c.width - indentOf(c.width, 0) - GLYPH_BOX : c.width] as const),
  )
  const lines: DetailLine[] = []
  for (const def of columns) {
    if (skip.has(def.id)) continue
    const cell = cellOf(row, def.id)
    const text = normaliseCell(cell?.text ?? '')
    if (cell === undefined || text.trim() === '') continue
    const have = room.get(def.id)
    if (have !== undefined && cellWidth(text) <= have) continue
    // The links follow below, so a clipped cell leaves its own href out. The badges of the extras column have no line: the
    // first line of the quick view has them.
    if (def.id !== 'extras') lines.push({ label: def.header || def.id, cell: { ...cell, href: undefined } })
  }
  const links = new Set(
    columns.map(def => cellOf(row, def.id)?.href).filter((h): h is string => h !== undefined && h !== ''),
  )
  // A link is cut in the middle, as a path is: the head names the host, the tail the page. The quick view ignores `clip`.
  for (const href of links) lines.push({ label: 'link', cell: { text: href, clip: 'middle' } })
  return lines
}

/**
 * The lines of the quick view of a row, below its `Selected:` line (issue #276): the cut cells and the links first, whether the row
 * has its own `detail()` or not (a summary that the table cuts is a line the person needs before the detail of the call). Then a
 * tracker's `detail()` lines, the reasons, the turns and, for a row with children, how many it has. A row with nothing more to say
 * has none: the quick view is its first line alone, with no `(nothing more to show)` filler. `inFirstLine` names the columns whose
 * cells the first line draws whole (the name and the status), so they need no line.
 */
export function quickDetailOf(
  row: TreeRow,
  columns: readonly ColumnDef[],
  solved: Solved,
  inFirstLine: ReadonlySet<CellId>,
): readonly DetailLine[] {
  const kids = row.children?.length ?? 0
  return [
    ...cutLines(row, columns, solved, inFirstLine),
    ...(row.detail?.() ?? []),
    ...whyOf(row),
    ...turnsOf(row),
    ...(kids > 0 ? [{ label: 'children', cell: { text: String(kids) } }] : []),
  ]
}
