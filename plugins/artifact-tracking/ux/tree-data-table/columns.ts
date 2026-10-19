// The column solver: the width of each column of one section, from the rows it draws. Pure.
// The engine's Box has no maxWidth, so the mod clamps widths itself. Decision G5 of plan L6; spec 5.10 "Columns".
//
// Order, as the tests pin it:
//   1. leave out a content column whose visible cells are all empty (the header alone does not count);
//   2. natural widths: fixed as given, flex as its min (the tree column too, at least the glyph box), content as its
//      widest header or cell clamped to min and max (grow-only memo), a content tree column as its widest indent plus
//      text (grow-only memo), clamped, plus the glyph box;
//   3. over `avail`: drop whole columns by `priority` (highest number first, ties the rightmost), until it fits;
//   4. still over: shrink content columns toward their min, the widest first (a tie: the leftmost). A content tree
//      column is one of them: its min counts the text only, so its floor is min plus the glyph box;
//   5. under `avail`: the flex columns share the rest evenly, the remainder to the leftmost.
// A tree or flex column never drops, and a column without `priority` never drops. When nothing is left to drop or
// shrink, the columns stay wider than `avail`: only a pane of about 20 cells or less gets there.
import type { ColumnDef, TreeRow } from '../../core/interfaces/view'
import { cellWidth, normaliseCell } from '../text/cell-width'

/** Cells between two columns. */
export const GAP = 1
/** Cells per tree level. */
export const INDENT = 2
/** The expand glyph and one space. */
export const GLYPH_BOX = 2

export interface SolvedColumn {
  readonly id: string
  readonly width: number
  readonly justify: 'flex-start' | 'center' | 'flex-end'
  readonly tree: boolean
  /** Where a cell too long for the column is cut. */
  readonly clip: 'end' | 'middle'
}

export interface Solved {
  readonly columns: readonly SolvedColumn[]
  /** The ids of the columns left out for width, in the order they dropped. */
  readonly dropped: readonly string[]
}

type Laid = readonly { readonly depth: number; readonly row: TreeRow }[]
interface Slot {
  readonly def: ColumnDef
  width: number
}

/** The widest width a content or tree column had, by `section/column`. It only grows, so a column holds still when a row
 * opens or closes. */
const memo = new Map<string, number>()

/** Forget the memo. `r` (refresh) calls it. */
export function resetWidths(): void {
  memo.clear()
}

const clamp = (value: number, min = 0, max = Number.POSITIVE_INFINITY): number => Math.min(max, Math.max(min, value))
const isTree = (def: ColumnDef): boolean => def.role === 'tree'
const textOf = (rows: Laid, id: string): string[] => rows.map(r => normaliseCell(r.row.cells[id]?.text ?? ''))
const widest = (widths: number[]): number => widths.reduce((a, b) => Math.max(a, b), 0)

function naturalWidth(sectionId: string, def: ColumnDef, rows: Laid): number {
  const w = def.width
  // Fixed and flex come first, also for the tree column: it never measures its text then. Its floor is the glyph box.
  const floor = isTree(def) ? GLYPH_BOX : 1
  if (w.kind === 'fixed') return Math.max(floor, w.cells)
  if (w.kind === 'flex') return Math.max(floor, w.min)
  const head = cellWidth(def.header)
  const key = `${sectionId}/${def.id}`
  if (isTree(def)) {
    const depths = rows.map(r => r.depth)
    const body = widest(textOf(rows, def.id).map((t, i) => INDENT * (depths[i] ?? 0) + cellWidth(t)))
    const tall = Math.max(memo.get(key) ?? 0, body)
    memo.set(key, tall)
    return Math.max(GLYPH_BOX, head, clamp(tall, w.min, w.max) + GLYPH_BOX)
  }
  const grown = Math.max(memo.get(key) ?? 0, head, widest(textOf(rows, def.id).map(cellWidth)))
  memo.set(key, grown)
  return Math.max(1, clamp(grown, w.min, w.max))
}

/** The narrowest a content column shrinks to. */
function floorOf(slot: Slot): number {
  const w = slot.def.width
  return Math.max(w.kind === 'content' ? (w.min ?? 1) : 1, 1) + (isTree(slot.def) ? GLYPH_BOX : 0)
}

const JUSTIFY = { left: 'flex-start', center: 'center', right: 'flex-end' } as const

export function solveColumns(sectionId: string, columns: readonly ColumnDef[], rows: Laid, avail: number): Solved {
  const hidden = (def: ColumnDef): boolean =>
    def.width.kind === 'content' && !isTree(def) && textOf(rows, def.id).every(t => t.trim() === '')
  const slots: Slot[] = columns
    .filter(def => !hidden(def))
    .map(def => ({ def, width: naturalWidth(sectionId, def, rows) }))
  const total = (): number => slots.reduce((sum, s) => sum + s.width, 0) + GAP * Math.max(0, slots.length - 1)

  const dropped: string[] = []
  while (total() > avail) {
    let pick = -1
    slots.forEach((s, i) => {
      const priority = s.def.priority
      if (priority === undefined || isTree(s.def) || s.def.width.kind === 'flex') return
      if (pick < 0 || priority >= (slots[pick]?.def.priority ?? 0)) pick = i
    })
    if (pick < 0) break
    dropped.push(slots[pick]?.def.id ?? '')
    slots.splice(pick, 1)
  }

  while (total() > avail) {
    const room = slots.filter(s => s.def.width.kind === 'content' && s.width > floorOf(s))
    const fattest = room.reduce<Slot | undefined>(
      (best, s) => (best === undefined || s.width > best.width ? s : best),
      undefined,
    )
    if (fattest === undefined) break
    fattest.width -= Math.min(total() - avail, fattest.width - floorOf(fattest))
  }

  const flexes = slots.filter(s => s.def.width.kind === 'flex')
  const rest = avail - total()
  const first = flexes[0]
  if (rest > 0 && first !== undefined) {
    const each = Math.floor(rest / flexes.length)
    for (const s of flexes) s.width += each
    first.width += rest - each * flexes.length
  }

  return {
    columns: slots.map(s => ({
      id: s.def.id,
      width: s.width,
      justify: JUSTIFY[s.def.align ?? 'left'],
      tree: isTree(s.def),
      clip: s.def.clip ?? 'end',
    })),
    dropped,
  }
}
