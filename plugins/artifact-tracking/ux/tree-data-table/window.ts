// The window over the rows of the pane: which units are drawn in full when the tree is taller than the body. The engine
// owns one scroll window over the whole pane tree and gives the mod no sticky region, so a tall tree scrolls its title,
// header and footer away (issue #109). The mod keeps the tree as tall as the body instead: it draws the units that fit
// and every other row as a bare focus stop (windowed.ts). Pure.
import { ROW_GAP } from './shape'

/** One thing the window moves over: a row with its detail lines, the "N more" row of a section, or a section with no row. */
export interface Unit {
  /** The index of its section. Units run in section order. */
  readonly section: number
  /** Its height in lines. */
  readonly lines: number
  /** The rows it holds: 1 for a row, 0 for the others. The hints count these. */
  readonly rows: number
}

/** The lines of a hint ("N more above", "N more below"). */
export const HINT = 1

export interface Plan {
  /** The first unit drawn in full. */
  readonly from: number
  /** One past the last. */
  readonly to: number
}

export interface WindowInput {
  readonly units: readonly Unit[]
  /**
   * The lines the title line of a group takes. 0 for a group with no row: its unit holds them. The one header of the table
   * is not in it: `windowOf` takes it off the budget.
   */
  readonly chrome: readonly number[]
  /** The lines the units may take: the body less the footer and the gap above it. */
  readonly budget: number
  /** The first unit of the last window. Stale or out of range is fine. */
  readonly anchor: number
  /** The unit that must show: the selected row. */
  readonly focus: number | undefined
}

/**
 * The lines the units `a` to `b` take with what they need around them: the title line of each group that shows a unit,
 * one gap between two shown groups (the root Box has `rowGap`), and a hint on each side that has hidden units. The one
 * header of the table is not counted here: `windowOf` takes it off the budget.
 */
export function linesOf(units: readonly Unit[], chrome: readonly number[], a: number, b: number): number {
  let lines = 0
  let last = -1
  for (let i = a; i < b; i++) {
    const unit = units[i]
    if (unit === undefined) break
    if (unit.section !== last) {
      lines += (chrome[unit.section] ?? 0) + (last === -1 ? 0 : ROW_GAP)
      last = unit.section
    }
    lines += unit.lines
  }
  return lines + (a > 0 ? HINT : 0) + (b < units.length ? HINT : 0)
}

/**
 * The units to draw in full, or undefined when the whole tree fits `budget`. The window keeps its place (`anchor`) until
 * the focus leaves it: a focus above pulls it up, a focus below pushes it down by the least that shows it. At the end of
 * the list it fills the body upward. A leading run of units with no row (a note-only section) is not a row, so the window
 * starts at the top again whenever the focus still shows. At least one unit shows, whatever its height.
 */
export function planWindow(input: WindowInput): Plan | undefined {
  const { units, chrome, budget, anchor, focus } = input
  const n = units.length
  if (n === 0 || linesOf(units, chrome, 0, n) <= budget) return undefined
  // The room is a few units at most: each takes a line, so no window is longer than the budget.
  const reach = Math.max(1, budget + 1)
  /** The last unit (exclusive) that fits from `a`. */
  const extend = (a: number): number => {
    let best = a + 1
    for (let b = a + 1; b <= Math.min(n, a + reach); b++) if (linesOf(units, chrome, a, b) <= budget) best = b
    return best
  }
  /** The first unit that fits up to `b` (exclusive): the window filled upward from `b`. */
  const fill = (b: number): number => {
    let best = b - 1
    for (let a = b - 1; a >= Math.max(0, b - reach); a--) if (linesOf(units, chrome, a, b) <= budget) best = a
    return best
  }
  let from = Math.min(Math.max(anchor, 0), n - 1)
  if (focus !== undefined && focus < from) from = focus
  let to = extend(from)
  if (focus !== undefined && focus >= to) {
    to = focus + 1
    from = fill(to)
    // A hint below costs a line that a row may take: draw the window the way the next draw would.
    to = Math.max(to, extend(from))
  } else if (to === n) {
    from = fill(to)
  }
  // Units before the first row hold no row (a section with a note only). No hint counts them and Tab cannot reach them, so
  // they must not slide out for good: start at the top as long as the focus still shows.
  const firstRow = units.findIndex(u => u.rows > 0)
  if (from > 0 && from <= (firstRow < 0 ? n : firstRow)) {
    const top = extend(0)
    if (focus === undefined || focus < top) return { from: 0, to: top }
  }
  return { from, to }
}

/** The rows in the units from `a` to `b`. */
export function rowsIn(units: readonly Unit[], a: number, b: number): number {
  return units.slice(a, b).reduce((sum, u) => sum + u.rows, 0)
}
