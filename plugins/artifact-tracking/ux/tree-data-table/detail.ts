// The detail lines of a row, from one builder. `detailOf` gives the lines under an open row: a tracker's `detail()` wins. A leaf
// with none gets the default: the full text of every cell the row had to clip or drop, a line for each badge, then the links, else
// one dim line. A row with reasons ends with one line that lists them all, and a row an item of which a turn tracked adds one line
// with its first and last turn. `quickDetailOf` gives the lines of the quick view (issue #276): the same cut cells and links, for a
// row with children too and for a row with its own `detail()`, then the lines of that `detail()`, the reasons and the turns, with no
// badge line (the first line of the quick view has the badges) and with the count of the children. Pure.
// Decision G13 of plan L6. Spec 5.10 "Rows".
import type { CellId, ColumnDef, DetailLine, TreeRow } from '../../core/interfaces/view'
import { cellWidth, normaliseCell } from '../text/cell-width'
import { cellOf, GLYPH_BOX, type Solved } from './columns'
import { indentOf, NOTHING_MORE } from './shape'

/** The one line that says why the row is tracked: every reason, strongest first (issue #62). None for a row with no reasons. */
const whyOf = (row: TreeRow): readonly DetailLine[] =>
  row.reasons === undefined ? [] : [{ label: 'reasons', cell: { text: row.reasons.all.join(', ') } }]

/** The one line that names the first and the last turn that tracked the row's item (issue #69). None for a row no turn tracked. */
const turnsOf = (row: TreeRow): readonly DetailLine[] =>
  row.turns === undefined
    ? []
    : [{ label: 'turns', cell: { text: `first ${row.turns.first} · last ${row.turns.last}` } }]

/** What the cut-cell lines leave out. */
interface Cuts {
  /** Draw a line for each badge of the extras column. The quick view leaves them out: its first line has them. */
  readonly badges: boolean
  /** The columns whose cells need no line. The first line of the quick view draws them whole. */
  readonly skip?: ReadonlySet<string>
}

/**
 * The lines for the cells the row had to clip or drop, then the links. A cell that fits its column, or that the row lacks, has no
 * line. The cells of the columns still drawn have the room of their column; a dropped column has none.
 */
function cutLines(
  row: TreeRow,
  columns: readonly ColumnDef[],
  solved: Solved,
  depth: number,
  cuts: Cuts,
): readonly DetailLine[] {
  const room = new Map(
    solved.columns.map(c => [c.id, c.tree ? c.width - indentOf(c.width, depth) - GLYPH_BOX : c.width] as const),
  )
  const lines: DetailLine[] = []
  for (const def of columns) {
    if (cuts.skip?.has(def.id) === true) continue
    const cell = cellOf(row, def.id)
    const text = normaliseCell(cell?.text ?? '')
    if (cell === undefined || text.trim() === '') continue
    const have = room.get(def.id)
    if (have !== undefined && cellWidth(text) <= have) continue
    // The links follow below, so a clipped cell leaves its own href out. The badges of the extras column keep their own
    // color, so each is a line of its own. A badge line has no label: the column has no header word, and its id is not
    // for the person.
    if (def.id === 'extras') {
      if (!cuts.badges) continue
      for (const badge of row.extras ?? []) {
        if (normaliseCell(badge.text).trim() !== '') lines.push({ cell: { ...badge, href: undefined } })
      }
    } else lines.push({ label: def.header || def.id, cell: { ...cell, href: undefined } })
  }
  const links = new Set(
    columns.map(def => cellOf(row, def.id)?.href).filter((h): h is string => h !== undefined && h !== ''),
  )
  // A link is cut in the middle, as a path is: the head names the host, the tail the page. The lines under an open row ignore `clip`.
  for (const href of links) lines.push({ label: 'link', cell: { text: href, clip: 'middle' } })
  return lines
}

export function detailOf(
  row: TreeRow,
  columns: readonly ColumnDef[],
  solved: Solved,
  depth: number,
): readonly DetailLine[] {
  const why = [...whyOf(row), ...turnsOf(row)]
  if (row.detail !== undefined) return [...row.detail(), ...why]
  if ((row.children?.length ?? 0) > 0) return why
  const lines = [...cutLines(row, columns, solved, depth, { badges: true }), ...why]
  return lines.length > 0 ? lines : [{ cell: { text: NOTHING_MORE, dim: true } }]
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
    ...cutLines(row, columns, solved, 0, { badges: false, skip: inFirstLine }),
    ...(row.detail?.() ?? []),
    ...whyOf(row),
    ...turnsOf(row),
    ...(kids > 0 ? [{ label: 'children', cell: { text: String(kids) } }] : []),
  ]
}
