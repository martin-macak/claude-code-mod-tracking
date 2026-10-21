// TreeDataTable windows its rows when the body is shorter than the tree (issue #109): the title, the header and the footer
// stay in view, the rows that do not fit are bare focus stops, and the window follows the selected row. Pure.
import { expect, test } from 'claude-code/testing'
import type { GroupSpec } from '../core/interfaces/view'
import { BUDGET, fits, measure } from '../ux/tree-data-table/budget'
import { resetWidths } from '../ux/tree-data-table/columns'
import { footerRows } from '../ux/tree-data-table/footer'
import { ROW_GAP } from '../ux/tree-data-table/shape'
import { neighbourOf, TreeDataTable } from '../ux/tree-data-table/table'
import {
  buttonOf,
  footerOf,
  handlesOf,
  NO_ROW_FOOTER,
  type Node,
  nodes,
  press,
  recorder,
  rowBoxes,
  texts,
  view,
} from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { group, webRows } from './fixtures/sections'

// The inline pane at 100x40: a body of 11 rows, 96 cells wide. The docked pane at 120x37: 31 rows, drawn here 95 cells wide
// as in #109 (the live check of issue #63 measured 49 cells: tests/one-table.test.ts holds that width).
const INLINE = { bodyColumns: 96, bodyRows: 11 }
const DOCKED = { bodyColumns: 95, bodyRows: 31 }

const draw = (sections: readonly GroupSpec[], over: Parameters<typeof view>[0] = {}) => {
  resetWidths()
  const rec = recorder()
  return { ...rec, drawn: TreeDataTable.render(sections, view(over), EL, rec.actions) }
}

const web = (n: number) => [group('web', webRows(n))]
/** `count` groups `s0`, `s1`, … of `rows` rows each, with ids unique across the sections. */
const many = (count: number, rows: number): GroupSpec[] =>
  Array.from({ length: count }, (_, i) =>
    group(
      `s${i}`,
      webRows(rows).map(r => ({ ...r, id: `s${i}-${r.id}` })),
    ),
  )

/** The section Boxes: every child of the root but the footer. */
const sectionBoxes = (tree: unknown): Node[] => (tree as Node).children.slice(0, -1) as Node[]
/** The bare focus stops: a Box with no height that clips, holding one Button. */
const stops = (tree: unknown): Node[] => nodes(tree, 'Box').filter(b => b.props.height === 0)
const stopKeys = (tree: unknown): string[] => stops(tree).flatMap(b => nodes(b, 'Button').map(x => String(x.props.key)))
const hints = (tree: unknown): string[] =>
  texts(tree)
    .map(([, s]) => s)
    .filter(s => s.startsWith('▲') || s.startsWith('▼'))
const rowTexts = (tree: unknown): string[] =>
  rowBoxes(tree).map(b =>
    nodes(b, 'Text')
      .flatMap(t => t.children)
      .join(' '),
  )
const keyRange = (from: number, to: number): string[] => Array.from({ length: to - from }, (_, i) => `r${from + i}`)

test('the footer of the live pane takes one row at 96 cells, so the inline body keeps 9 rows for the table', () => {
  expect(footerRows(NO_ROW_FOOTER, INLINE.bodyColumns, false)).toBe(1)
})

test('inline 100x40, 12 rows: the title, the header and the footer show with the rows that fit, and a hint below', () => {
  const { drawn } = draw(web(12), INLINE)
  const tree = drawn.tree
  expect(rowBoxes(tree)).toHaveLength(6) // 11 rows: title, header, 6 rows, a hint, the gap, the footer
  expect(texts(tree).find(([p, s]) => s === 'web' && p.weight === 'bold')).toBeDefined() // the title
  expect(texts(tree).some(([, s]) => s === 'Name')).toBe(true) // the header
  expect(footerOf(tree)).toHaveLength(NO_ROW_FOOTER.length)
  expect(hints(tree)).toEqual(['▼ 6 more below'])
  expect(rowBoxes(tree).length + 2 + 1 + 1 + 1).toBe(INLINE.bodyRows) // the tree is as tall as the body, so the engine never scrolls
  expect(drawn.top).toBe(0)
  expect(drawn.page).toBe(6)
})

test('docked 120x37, 36 rows: the same, with the rows the body holds', () => {
  const { drawn } = draw(web(36), DOCKED)
  expect(rowBoxes(drawn.tree)).toHaveLength(26) // 31 rows: title, header, 26 rows, a hint, the gap, the footer
  expect(footerOf(drawn.tree)).toHaveLength(NO_ROW_FOOTER.length)
  expect(hints(drawn.tree)).toEqual(['▼ 10 more below'])
})

test('a tall body shows every row, with no hint and no stop', () => {
  const { drawn } = draw(web(12), { ...INLINE, bodyRows: 60 })
  expect(rowBoxes(drawn.tree)).toHaveLength(12)
  expect(hints(drawn.tree)).toEqual([])
  expect(stops(drawn.tree)).toEqual([])
  expect(drawn.top).toBe(0)
})

test('a body that gives no height draws every row, as before', () => {
  const { drawn } = draw(web(12), { bodyRows: undefined })
  expect(rowBoxes(drawn.tree)).toHaveLength(12)
  expect(stops(drawn.tree)).toEqual([])
})

test('every row keeps its focus stop in the same order, whatever the window: the ring sits on a position', () => {
  for (const selected of [null, 'w0', 'w6', 'w11']) {
    const { drawn } = draw(web(12), { ...INLINE, selected })
    expect(handlesOf(drawn.tree), String(selected)).toEqual(keyRange(0, 12))
    expect(drawn.handles.size).toBe(12)
    expect(drawn.rows).toHaveLength(12)
  }
})

test('the rows out of the window are bare stops: no height, clipped, one Button each that acts as the row Button does', () => {
  const { drawn, calls } = draw(web(12), INLINE)
  expect(stopKeys(drawn.tree)).toEqual(keyRange(6, 12))
  for (const stop of stops(drawn.tree)) {
    expect(stop.props).toMatchObject({ height: 0, overflow: 'hidden', flexShrink: 0 })
    expect(stop.children).toHaveLength(1)
    const button = nodes(stop, 'Button')[0] as Node
    expect(button.props.plain).toBe(true)
    press(button)
  }
  expect(calls).toEqual(keyRange(6, 12).map(k => `toggle:w${k.slice(1)}`)) // an Enter that lands before the next drawing still opens the row
})

test('the window follows the selected row: it shows it and gives its place back to the next draw', () => {
  const first = draw(web(12), { ...INLINE, selected: 'w10' })
  expect(rowTexts(first.drawn.tree).map(t => t.includes('s10.example'))).toEqual([
    false,
    false,
    false,
    false,
    true,
    false,
  ])
  expect(first.drawn.top).toBe(6) // the row after it takes the place of the hint below
  expect(hints(first.drawn.tree)).toEqual(['▲ 6 more above'])
  // The next draw reads the place back: a selection inside the window does not move it.
  for (const [selected, top] of [
    ['w8', 6],
    ['w6', 6],
    ['w5', 5],
    ['w11', 6],
  ] as const) {
    const next = draw(web(12), { ...INLINE, selected, top: first.drawn.top })
    expect(next.drawn.top, selected).toBe(top)
    const shown = rowTexts(next.drawn.tree).join('|')
    expect(shown, selected).toContain(`s${selected.slice(1)}.example`)
  }
})

test('at the end of the list the window fills the body upward and has no hint below', () => {
  const { drawn } = draw(web(12), { ...INLINE, selected: 'w11' })
  expect(rowBoxes(drawn.tree)).toHaveLength(6)
  expect(rowTexts(drawn.tree).at(-1)).toContain('s11.example')
  expect(hints(drawn.tree)).toEqual(['▲ 6 more above'])
})

test('the selected row draws the gutter mark inside the window', () => {
  const { drawn } = draw(web(12), { ...INLINE, selected: 'w3' })
  const selected = rowBoxes(drawn.tree).filter(b => (b.children[0] as Node).children[0] === '>')
  expect(selected).toHaveLength(1)
  expect(rowTexts(drawn.tree)[3]).toContain('s3.example')
})

test('windowing works across groups: a group with no row in view draws no title, only its stops', () => {
  // 3 groups of 5 rows in a body of 14: the footer, the gap and the one header take 3, so 11 lines. Group 0 takes 6 (its
  // title and 5 rows); two rows of group 1 add a gap and its title: 10, and the hint below makes 11.
  const { drawn } = draw(many(3, 5), { ...INLINE, bodyRows: 14 })
  const boxes = sectionBoxes(drawn.tree)
  expect(boxes).toHaveLength(2) // the root keeps only the groups that show a row, then the footer
  expect(rowBoxes(boxes[0]).length).toBe(5)
  expect(rowBoxes(boxes[1]).length).toBe(2)
  const titles = texts(drawn.tree)
    .filter(([p]) => p.weight === 'bold')
    .map(([, s]) => s)
  expect(titles).toContain('s0')
  expect(titles).toContain('s1')
  expect(titles).not.toContain('s2')
  expect(handlesOf(drawn.tree)).toEqual(keyRange(0, 15)) // s2's stops follow in the last section Box, in order
  expect(stopKeys(boxes[1])).toEqual(keyRange(7, 15))
  expect(hints(drawn.tree)).toEqual(['▼ 8 more below'])
})

test('the selected row in a later section brings that section into view and drops the first one', () => {
  const { drawn } = draw(many(3, 5), { ...INLINE, bodyRows: 14, selected: 's2-w4' })
  const titles = texts(drawn.tree)
    .filter(([p]) => p.weight === 'bold')
    .map(([, s]) => s)
  expect(titles).toContain('s2')
  expect(titles).not.toContain('s0')
  expect(rowTexts(drawn.tree).at(-1)).toContain('s4.example')
  expect(handlesOf(drawn.tree)).toEqual(keyRange(0, 15))
})

test('the N more Button of a section stays a stop when it is out of the window, and shows when the ring is on it', () => {
  const sections = [group('web', webRows(60))]
  const hidden = draw(sections, INLINE)
  expect(stopKeys(hidden.drawn.tree)).toContain('m0')
  expect(buttonOf(hidden.drawn.tree, 'm0').props.label).toBe('10 more')
  const shown = draw(sections, { ...INLINE, selected: 'w49', onMore: 'm0' })
  expect(stopKeys(shown.drawn.tree)).not.toContain('m0')
  expect(buttonOf(shown.drawn.tree, 'm0').props.label).toBe('10 more')
  expect(rowBoxes(shown.drawn.tree)).toHaveLength(5)
  expect(rowTexts(shown.drawn.tree).at(-1)).toContain('s49.example')
  // Pressing it still asks for the next chunk, shown or not.
  press(buttonOf(shown.drawn.tree, 'm0'))
  expect(shown.calls).toEqual(['more:web'])
  press(buttonOf(hidden.drawn.tree, 'm0'))
  expect(hidden.calls).toEqual(['more:web'])
})

test('a stale onMore, with its Button gone, lets the window follow the selected row', () => {
  // Enter on the last "N more" showed the rest of the rows: the Button is gone and the ring kept its position, so no
  // ui.focus cleared onMore. No unit matches it any more, and the window must plan from the selected row (issue #109).
  const { drawn } = draw(web(12), { ...INLINE, selected: 'w11', top: 0, onMore: 'm0' })
  expect(drawn.top).toBe(6)
  expect(rowTexts(drawn.tree).at(-1)).toContain('s11.example')
})

test('the detail lines of an open row count against the body', () => {
  const rows = webRows(12).map((r, i) =>
    i === 0
      ? { ...r, detail: () => [{ cell: { text: 'one' } }, { cell: { text: 'two' } }, { cell: { text: 'three' } }] }
      : r,
  )
  const { drawn } = draw([group('web', rows)], { ...INLINE, expanded: new Set(['w0']) })
  // 3 detail lines and the row take 4, two more rows 2, the title and header 2 and the hint 1: 9 lines for the budget of 9.
  expect(rowBoxes(drawn.tree)).toHaveLength(3)
  expect(texts(drawn.tree).filter(([, s]) => ['one', 'two', 'three'].includes(s))).toHaveLength(3)
})

test('a footer of two rows leaves the table one row less', () => {
  const columns = 40
  const footer = footerRows(NO_ROW_FOOTER, columns, false)
  expect(footer).toBeGreaterThan(1)
  const bodyRows = 16
  const { drawn } = draw(web(30), { bodyColumns: columns, bodyRows })
  expect(rowBoxes(drawn.tree)).toHaveLength(bodyRows - footer - 1 - 2 - 1) // the gap, the title and header, the hint
})

test('the floor of the window: 7 body rows hold the title, the header, a row, both hints, the gap and the footer; 6 do not', () => {
  // The window always shows one unit, so a body that cannot hold even that is a known limit (README "Known limits"): the
  // tree is then taller than the body, and the engine scrolls the title or the footer out of view. This pins the floor.
  const footer = footerRows(NO_ROW_FOOTER, INLINE.bodyColumns, false)
  const linesOfTree = (tree: unknown): number => 2 + rowBoxes(tree).length + hints(tree).length + ROW_GAP + footer
  const fit = draw(web(12), { ...INLINE, bodyRows: 7, selected: 'w5' })
  expect(rowBoxes(fit.drawn.tree)).toHaveLength(1)
  expect(hints(fit.drawn.tree)).toHaveLength(2)
  expect(linesOfTree(fit.drawn.tree)).toBe(7) // a body of 7 rows is full
  const tight = draw(web(12), { ...INLINE, bodyRows: 6, selected: 'w5' })
  expect(rowBoxes(tight.drawn.tree)).toHaveLength(1) // the window cannot drop below one unit
  expect(linesOfTree(tight.drawn.tree)).toBe(7) // one line over a body of 6
  expect(handlesOf(tight.drawn.tree)).toEqual(keyRange(0, 12)) // every row keeps its stop: Tab still walks them all
})

test('a body of one row still shows a row and the footer', () => {
  const { drawn } = draw(web(12), { ...INLINE, bodyRows: 1 })
  expect(rowBoxes(drawn.tree)).toHaveLength(1)
  expect(footerOf(drawn.tree)).toHaveLength(NO_ROW_FOOTER.length)
  expect(handlesOf(drawn.tree)).toEqual(keyRange(0, 12))
})

test('the rows of a drawing list every row, so a dismissed last row finds its neighbour below the window', () => {
  const { drawn } = draw(web(12), INLINE)
  expect(drawn.rows.map(r => r.id)).toEqual(Array.from({ length: 12 }, (_, i) => `w${i}`))
  expect(neighbourOf(drawn.rows, 'w5')).toBe('w6') // w6 is out of the window
})

test('no row in the window at open: the first visible row gets autoFocus', () => {
  const { drawn } = draw(web(12), INLINE)
  const focused = nodes(drawn.tree, 'Button').filter(b => b.props.autoFocus === true)
  expect(focused.map(b => b.props.key)).toEqual(['r0'])
})

test('the largest list the caps allow, windowed, stays inside the budget guard', () => {
  const { drawn } = draw([group('web', webRows(300))], {
    ...DOCKED,
    limits: { sectionRows: 300, maxRows: 300 },
  })
  expect(rowBoxes(drawn.tree)).toHaveLength(26)
  expect(handlesOf(drawn.tree)).toHaveLength(300)
  expect(fits(measure(drawn.tree), BUDGET)).toBe(true)
})

test('a hint is plain dim text, not a Button: the hidden rows are reached by the ring', () => {
  const { drawn } = draw(web(12), { ...INLINE, selected: 'w6' })
  const hint = nodes(drawn.tree, 'Text').filter(t => t.children.some(c => typeof c === 'string' && /^[▲▼]/.test(c)))
  expect(hint).toHaveLength(2)
  for (const h of hint) expect(h.props.dimColor).toBe(true)
  expect(nodes(drawn.tree, 'Button').some(b => String(b.props.label).includes('more above'))).toBe(false)
})

test('an empty section next to a long one costs its lines and is not a row', () => {
  const sections = [group('none', [], { empty: 'Nothing here' }), group('web', webRows(30))]
  const { drawn } = draw(sections, INLINE)
  const boxes = sectionBoxes(drawn.tree)
  expect(boxes).toHaveLength(2)
  // The header of the table leads the first Box: a blank for the gutter, then the words of the columns.
  expect(texts(boxes[0]).map(([, s]) => s)).toEqual([' ', 'Name', 'Description', 'none', '0', 'Nothing here'])
  expect(rowBoxes(drawn.tree).length).toBeGreaterThan(0)
  expect(rowBoxes(drawn.tree).length).toBeLessThan(6)
})

test('a leading section with no row comes back into view when the selection returns to the first row', () => {
  // The GitHub tracker draws a note-only section before its rows when it is paused or not logged in. The note holds the only
  // hint that PRs are not tracked, and no hint counts it, so the window must not leave it behind for good.
  const sections = [group('gh', [], { empty: 'gh not logged in' }), group('web', webRows(12))]
  const open = draw(sections, { ...INLINE, selected: 'w0' })
  expect(texts(open.drawn.tree).map(([, s]) => s)).toContain('gh not logged in')
  let top = open.drawn.top
  for (const selected of ['w11', 'w10', 'w8', 'w5', 'w2', 'w1', 'w0']) {
    const { drawn } = draw(sections, { ...INLINE, selected, top })
    expect(rowTexts(drawn.tree).join('|'), selected).toContain(`s${selected.slice(1)}.example`)
    top = drawn.top
  }
  const { drawn } = draw(sections, { ...INLINE, selected: 'w0', top })
  expect(drawn.top).toBe(0)
  expect(texts(drawn.tree).map(([, s]) => s)).toContain('gh not logged in')
  expect(hints(drawn.tree).some(h => h.startsWith('▲'))).toBe(false)
  expect(handlesOf(drawn.tree)).toEqual(keyRange(0, 12))
})
