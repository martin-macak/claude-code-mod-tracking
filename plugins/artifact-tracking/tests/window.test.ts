// The window planner of the pane (issue #109): which units of the pane are drawn in full when the body is shorter
// than the tree. Pure: units, a line budget, the last first unit and the unit that must show in, a plan out.
import { expect, test } from 'claude-code/testing'
import { HINT, linesOf, planWindow, type Unit } from '../ux/tree-data-table/window'

/** `n` one-line row units in one section whose title and header take 2 lines. */
const rows = (n: number, section = 0): Unit[] => Array.from({ length: n }, () => ({ section, lines: 1, rows: 1 }))
const plan = (units: readonly Unit[], budget: number, anchor = 0, focus?: number, chrome: readonly number[] = [2]) =>
  planWindow({ units, chrome, budget, anchor, focus })

test('linesOf: the units, the title and header of each section, a gap between sections and a line per hidden side', () => {
  const units = [...rows(3, 0), ...rows(2, 1)]
  const chrome = [2, 2]
  expect(linesOf(units, chrome, 0, 5)).toBe(3 + 2 + 1 + 2 + 2) // 3 rows, 2 rows, two title+header, one gap
  expect(linesOf(units, chrome, 1, 3)).toBe(2 + 2 + HINT + HINT) // two rows of section 0, its chrome, a hint on each side
  expect(linesOf(units, chrome, 3, 5)).toBe(2 + 2 + HINT) // the end of the list: no hint below
})

test('a tree that fits is not windowed', () => {
  expect(plan(rows(5), 7)).toBeUndefined() // 5 rows and a title and header take 7
  expect(plan([], 3)).toBeUndefined()
})

test('a tree that does not fit shows the rows the budget holds, with a hint below', () => {
  // budget 9: title and header 2, hint below 1, so 6 rows
  expect(plan(rows(12), 9)).toEqual({ from: 0, to: 6 })
})

test('the window keeps its place while the focus stays in it', () => {
  expect(plan(rows(12), 9, 3, 5)).toEqual({ from: 3, to: 8 }) // hints above and below: 2 + 2 + 5 rows
  expect(plan(rows(12), 9, 3, 3)).toEqual({ from: 3, to: 8 })
})

test('a focus above the window pulls it up, a focus below pushes it down by the least', () => {
  expect(plan(rows(12), 9, 5, 2)).toEqual({ from: 2, to: 7 })
  expect(plan(rows(12), 9, 0, 6)).toEqual({ from: 2, to: 7 }) // row 6 is the last shown, with a hint above and below
})

test('a row that takes the place of a hint shows: the focus one before the end shows the last row', () => {
  expect(plan(rows(12), 9, 0, 10)).toEqual({ from: 6, to: 12 }) // 6 rows and a hint above cost the same as 5, a hint below and one above
})

test('at the end of the list the window fills the body upward and drops the hint below', () => {
  expect(plan(rows(12), 9, 0, 11)).toEqual({ from: 6, to: 12 }) // 6 rows, a hint above, none below
  expect(plan(rows(12), 9, 9, 9)).toEqual({ from: 6, to: 12 }) // an anchor too far down is pulled back to fill
})

test('a stale anchor is clamped to the list', () => {
  expect(plan(rows(12), 9, 99)).toEqual({ from: 6, to: 12 })
  expect(plan(rows(12), 9, -4)).toEqual({ from: 0, to: 6 })
})

test('the plan is stable: planning again from its own result gives it back', () => {
  for (const focus of [0, 4, 6, 7, 10, 11]) {
    const first = plan(rows(12), 9, 0, focus)
    expect(first).toBeDefined()
    expect(plan(rows(12), 9, first?.from, focus)).toEqual(first)
  }
})

test('a unit taller than one line counts its lines: an open row with detail shows fewer rows', () => {
  const units: Unit[] = rows(12)
  units[1] = { section: 0, lines: 4, rows: 1 } // row 1 is open with three detail lines
  // rows 0..2 take 1 + 4 + 1 = 6, with the title and header 2 and the hint below 1: 9. A fourth row makes 10.
  expect(plan(units, 9)).toEqual({ from: 0, to: 3 })
})

test('a section header is paid only by a section that shows a unit; a gap between two shown sections', () => {
  const units = [...rows(4, 0), ...rows(4, 1)]
  const chrome = [2, 2]
  // budget 9: section 0 alone takes 4 rows + 2 + a hint below = 7. One row of section 1 adds a gap and its title and header: 11.
  expect(plan(units, 9, 0, undefined, chrome)).toEqual({ from: 0, to: 4 })
  // budget 12: 6 rows (4 + 2) + 2 + 2 + 1 gap + 1 hint = 12
  expect(plan(units, 12, 0, undefined, chrome)).toEqual({ from: 0, to: 6 })
})

test('a budget under one unit still shows one', () => {
  expect(plan(rows(12), 0)).toEqual({ from: 0, to: 1 })
  expect(plan(rows(12), 1, 5, 7)).toEqual({ from: 7, to: 8 })
})

test('a unit with no rows (a section with nothing in it) takes its lines and counts no row', () => {
  const units: Unit[] = [{ section: 0, lines: 2, rows: 0 }, ...rows(12, 1)]
  // the empty section 2, a gap 1, the title and header of section 1 2, three rows 3 and the hint 1: 9
  expect(plan(units, 9, 0, undefined, [0, 2])).toEqual({ from: 0, to: 4 })
})

test('a leading section with no row does not slide out: the focus back on the first row starts the window at the top', () => {
  // The GitHub tracker draws such a section (a title and a note) before its rows when it is paused or not logged in.
  const units: Unit[] = [{ section: 0, lines: 2, rows: 0 }, ...rows(12, 1)]
  const chrome = [0, 2]
  // The window from unit 1 holds the first row. Nothing counts the note (no hint, no Tab), so it must come back.
  expect(plan(units, 9, 1, 1, chrome)).toEqual({ from: 0, to: 4 })
  // The walk down the list and back up with the place carried: the focus is always in the window, the walk ends at the top.
  let anchor = 0
  for (const focus of [12, 11, 9, 6, 3, 2, 1]) {
    const next = plan(units, 9, anchor, focus, chrome)
    expect(next).toBeDefined()
    expect(next?.from).toBeLessThanOrEqual(focus)
    expect(next?.to).toBeGreaterThan(focus)
    anchor = next?.from ?? 0
  }
  expect(anchor).toBe(0)
})

test('a leading section with no row stays out of the window while the focus needs the room', () => {
  const units: Unit[] = [{ section: 0, lines: 2, rows: 0 }, ...rows(12, 1)]
  // Focus on the last row: the window fills upward, and the note is not forced back in when it would hide the focus.
  expect(plan(units, 9, 0, 12, [0, 2])).toEqual({ from: 7, to: 13 })
  // Focus on the fourth row from a window at the top: the top window holds it, nothing moves.
  expect(plan(units, 9, 0, 3, [0, 2])).toEqual({ from: 0, to: 4 })
})
