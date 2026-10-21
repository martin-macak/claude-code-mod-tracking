// The column solver: widths, drops, shrinks, the flex share and the grow-only memo. Pure.
import { expect, test } from 'claude-code/testing'
import type { ColumnDef, TreeRow } from '../core/interfaces/view'
import { GAP, GLYPH_BOX, resetWidths, type Solved, solveColumns } from '../ux/tree-data-table/columns'
import { row } from './fixtures/sections'

/** A small column set for the cases of the solver that name no tracker: a mark, a tree column and a flex one. */
const COLS: readonly ColumnDef[] = [
  { id: 'prio', header: '', width: { kind: 'fixed', cells: 1 } },
  { id: 'key', header: 'Label', width: { kind: 'content', min: 6, max: 24 }, role: 'tree' },
  { id: 'title', header: 'URL', width: { kind: 'flex', min: 10 } },
]

const content = (id: string, header: string, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  header,
  width: { kind: 'content' },
  ...extra,
})
const tree = (header = 'Key', extra: Partial<ColumnDef> = {}): ColumnDef => ({
  id: 'key',
  header,
  width: { kind: 'content' },
  role: 'tree',
  ...extra,
})
const flex = (id: string, min: number, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  header: id,
  width: { kind: 'flex', min },
  ...extra,
})
const fixed = (id: string, cells: number, extra: Partial<ColumnDef> = {}): ColumnDef => ({
  id,
  header: '',
  width: { kind: 'fixed', cells },
  ...extra,
})
const at = (depth: number, r: TreeRow) => ({ depth, row: r })
const widthOf = (s: Solved, id: string) => s.columns.find(c => c.id === id)?.width
const idsOf = (s: Solved) => s.columns.map(c => c.id)

test('a fixed column keeps its cells', () => {
  resetWidths()
  const s = solveColumns('s', [fixed('f', 4)], [at(0, row('a', { f: 'abcdefghij' }))], 100)
  expect(widthOf(s, 'f')).toBe(4)
  expect(s.dropped).toEqual([])
})

test('a content column takes the widest of its header and its cells, clamped', () => {
  const rows = [at(0, row('a', { type: 'PR' })), at(0, row('b', { type: 'Issue' }))]
  resetWidths()
  expect(widthOf(solveColumns('s', [content('type', 'Type')], rows, 100), 'type')).toBe(5)
  resetWidths()
  expect(
    widthOf(solveColumns('s', [content('type', 'Type', { width: { kind: 'content', max: 3 } })], rows, 100), 'type'),
  ).toBe(3)
  resetWidths()
  expect(
    widthOf(solveColumns('s', [content('type', 'Type', { width: { kind: 'content', min: 8 } })], rows, 100), 'type'),
  ).toBe(8)
})

test('the tree column adds 2 per level and 2 for the glyph', () => {
  resetWidths()
  const rows = [at(0, row('a', { key: 'ISS-1' })), at(1, row('b', { key: 'PROJ-201' }))]
  expect(widthOf(solveColumns('s', [tree()], rows, 100), 'key')).toBe(Math.max(5, 2 + 8) + GLYPH_BOX)
  expect(widthOf(solveColumns('s', [tree()], rows, 100), 'key')).toBe(12)
})

test('the tree column is at least as wide as its header and the glyph box', () => {
  resetWidths()
  expect(widthOf(solveColumns('s', [tree('Worktree')], [at(0, row('a', { key: 'a' }))], 100), 'key')).toBe(8)
  resetWidths()
  const empty = tree('', { width: { kind: 'content', min: 0, max: 0 } })
  expect(widthOf(solveColumns('s', [empty], [at(0, row('a', { key: 'long text' }))], 100), 'key')).toBe(GLYPH_BOX)
})

test('wide text measures by cellWidth', () => {
  resetWidths()
  const s = solveColumns('s', [content('t', 'T')], [at(0, row('a', { t: '日本語テキスト' }))], 100)
  expect(widthOf(s, 't')).toBe(14)
})

test('the flex column takes the rest', () => {
  resetWidths()
  const rows = [at(0, row('a', { key: 'ABCD' }))]
  const s = solveColumns('s', [tree('K'), flex('title', 10)], rows, 40)
  expect(widthOf(s, 'key')).toBe(6)
  expect(widthOf(s, 'title')).toBe(40 - 6 - GAP)
})

test('two flex columns split the rest evenly, the remainder to the left', () => {
  resetWidths()
  const rows = [at(0, row('a', { key: 'ABCD' }))]
  const cols = [tree('K'), flex('x', 10), flex('y', 10)]
  const even = solveColumns('s', cols, rows, 40)
  expect([widthOf(even, 'x'), widthOf(even, 'y')]).toEqual([16, 16])
  const odd = solveColumns('s', cols, rows, 41)
  expect([widthOf(odd, 'x'), widthOf(odd, 'y')]).toEqual([17, 16])
})

test('over the width the highest priority number drops first, ties the rightmost', () => {
  const cols = [
    tree('K'),
    flex('title', 10),
    content('type', 'T', { priority: 2 }),
    content('status', 'S', { priority: 2 }),
    content('extra', 'E', { priority: 1 }),
  ]
  const rows = [at(0, row('a', { key: 'AB-1', type: 'x'.repeat(8), status: 'y'.repeat(8), extra: 'z'.repeat(8) }))]
  // tree 6 + flex 10 + three content columns of 8 + 4 gaps = 44
  const droppedAt = (avail: number) => {
    resetWidths()
    return solveColumns('s', cols, rows, avail).dropped
  }
  expect(droppedAt(44)).toEqual([])
  expect(droppedAt(43)).toEqual(['status'])
  expect(droppedAt(35)).toEqual(['status'])
  expect(droppedAt(34)).toEqual(['status', 'type'])
  expect(droppedAt(26)).toEqual(['status', 'type'])
  expect(droppedAt(25)).toEqual(['status', 'type', 'extra'])
  resetWidths()
  expect(idsOf(solveColumns('s', cols, rows, 25))).toEqual(['key', 'title'])
})

test('tree and flex columns and columns without priority never drop', () => {
  resetWidths()
  const cols = [
    tree('K', { priority: 3 }),
    flex('title', 10, { priority: 2 }),
    content('plain', 'P'),
    content('last', 'L', { priority: 1 }),
  ]
  const rows = [at(0, row('a', { key: 'AB-1', plain: 'p'.repeat(8), last: 'l'.repeat(8) }))]
  const s = solveColumns('s', cols, rows, 1)
  expect(s.dropped).toEqual(['last'])
  expect(idsOf(s)).toEqual(['key', 'title', 'plain'])
})

test('after the drops content columns shrink toward their min, widest first', () => {
  const cols = [
    tree('K'),
    content('a', 'A', { width: { kind: 'content', min: 4 } }),
    content('b', 'B', { width: { kind: 'content', min: 2 } }),
  ]
  const rows = [at(0, row('r', { key: 'AB-1', a: 'a'.repeat(12), b: 'b'.repeat(9) }))]
  // tree 6 + a 12 + b 9 + 2 gaps = 29
  const solve = (avail: number) => {
    resetWidths()
    return solveColumns('s', cols, rows, avail)
  }
  const wide = solve(29)
  expect([widthOf(wide, 'key'), widthOf(wide, 'a'), widthOf(wide, 'b')]).toEqual([6, 12, 9])
  const some = solve(22)
  expect([widthOf(some, 'key'), widthOf(some, 'a'), widthOf(some, 'b')]).toEqual([6, 5, 9])
  const more = solve(14)
  expect([widthOf(more, 'key'), widthOf(more, 'a'), widthOf(more, 'b')]).toEqual([6, 4, 2])
  expect(more.dropped).toEqual([])
})

test('content columns of equal width: the leftmost gives the cells first', () => {
  const cols = [content('a', 'A'), content('b', 'B'), content('c', 'C')]
  const rows = [at(0, row('r', { a: 'a'.repeat(10), b: 'b'.repeat(10), c: 'c'.repeat(10) }))]
  const solve = (avail: number) => {
    resetWidths()
    return solveColumns('s', cols, rows, avail)
  }
  const widths = (s: Solved) => [widthOf(s, 'a'), widthOf(s, 'b'), widthOf(s, 'c')]
  expect(widths(solve(32))).toEqual([10, 10, 10]) // 10 + 10 + 10 + 2 gaps
  expect(widths(solve(31))).toEqual([9, 10, 10]) // a tie: the leftmost gives the cell
  expect(widths(solve(30))).toEqual([8, 10, 10]) // it keeps giving while it is the widest, down to its min
  expect(widths(solve(21))).toEqual([1, 8, 10]) // at its min, b and c tie: b gives
})

test('the tree column shrinks toward its min plus the glyph box, and no further', () => {
  const cols = [tree('K', { width: { kind: 'content', min: 4, max: 30 } })]
  const rows = [at(0, row('r', { key: 'x'.repeat(20) }))]
  resetWidths()
  expect(widthOf(solveColumns('s', cols, rows, 100), 'key')).toBe(22)
  resetWidths()
  expect(widthOf(solveColumns('s', cols, rows, 12), 'key')).toBe(12)
  resetWidths()
  expect(widthOf(solveColumns('s', cols, rows, 3), 'key')).toBe(4 + GLYPH_BOX)
})

test('a fixed tree column keeps its cells, whatever its text, its depth and its header', () => {
  const cols = (cells: number) => [tree('A long header', { width: { kind: 'fixed', cells } })]
  const deep = [at(0, row('a', { key: 'x'.repeat(30) })), at(3, row('b', { key: 'y'.repeat(30) }))]
  resetWidths()
  expect(widthOf(solveColumns('s', cols(12), deep, 100), 'key')).toBe(12)
  expect(widthOf(solveColumns('s', cols(12), [at(0, row('a', { key: 'x' }))], 100), 'key')).toBe(12)
  expect(widthOf(solveColumns('s', cols(1), deep, 100), 'key')).toBe(GLYPH_BOX)
})

test('a fixed tree column neither drops nor shrinks, even with a priority', () => {
  const cols = [tree('K', { width: { kind: 'fixed', cells: 12 }, priority: 1 }), content('type', 'Type')]
  resetWidths()
  const s = solveColumns('s', cols, [at(0, row('a', { key: 'x'.repeat(30), type: 'PR' }))], 10)
  expect(widthOf(s, 'key')).toBe(12)
  expect(s.dropped).toEqual([])
})

test('a flex tree column starts at its min and takes the rest, whatever its text', () => {
  const cols = [tree('K', { width: { kind: 'flex', min: 6 } }), content('type', 'Type')]
  const rows = [at(0, row('a', { key: 'x'.repeat(30), type: 'PR' }))]
  resetWidths()
  const s = solveColumns('s', cols, rows, 20)
  expect([widthOf(s, 'key'), widthOf(s, 'type')]).toEqual([15, 4]) // 20 less one gap and the 4 of the type column
  expect(widthOf(solveColumns('s', [tree('K', { width: { kind: 'flex', min: 1 } })], rows, 1), 'key')).toBe(GLYPH_BOX)
})

test('at 24 columns only the tree and flex columns stay, each at least 1 wide', () => {
  resetWidths()
  const prs: ColumnDef[] = [
    fixed('prio', 1),
    { id: 'key', header: 'PR', width: { kind: 'content', min: 4, max: 10 }, role: 'tree' },
    { id: 'title', header: 'Title', width: { kind: 'flex', min: 10 } },
    { id: 'type', header: 'Branch', width: { kind: 'content', max: 26 }, priority: 2 },
    { id: 'status', header: 'State', width: { kind: 'content', max: 8 } },
    { id: 'extra', header: 'Checks', width: { kind: 'content', max: 10 }, priority: 1 },
  ]
  const cells = {
    prio: '★',
    key: '#7',
    title: 'Opened here',
    type: 'worktree-probe-wt',
    status: 'open',
    extra: '✓ checks',
  }
  const s = solveColumns('prs', prs, [at(0, row('r', cells))], 24)
  expect(s.columns.every(c => c.width >= 1)).toBe(true)
  expect((widthOf(s, 'key') ?? 0) >= 2).toBe(true)
  expect(idsOf(s).every(id => ['prio', 'key', 'title', 'status'].includes(id))).toBe(true)
  expect(s.dropped).toEqual(['type', 'extra'])
  const sum = s.columns.reduce((n, c) => n + c.width, 0) + GAP * (s.columns.length - 1)
  expect(sum).toBe(24)
})

test('a width of zero or below never throws and keeps every width at least 1', () => {
  resetWidths()
  const rows = [at(0, row('r', { prio: '★', key: 'AB-1', title: 'T', type: 'x', status: 'y' }))]
  for (const avail of [0, -5]) {
    const s = solveColumns(
      's',
      [...COLS, content('type', 'Type', { priority: 1 }), content('status', 'St')],
      rows,
      avail,
    )
    expect(s.columns.every(c => c.width >= 1)).toBe(true)
    expect((widthOf(s, 'key') ?? 0) >= GLYPH_BOX).toBe(true)
  }
})

test('a content column whose cells are all empty is left out', () => {
  resetWidths()
  const cols = [fixed('prio', 1), tree('K'), flex('title', 10), content('type', 'Type')]
  const rows = [at(0, row('a', { prio: '', key: 'AB-1', title: 't', type: '' })), at(0, row('b', { key: 'AB-2' }))]
  const s = solveColumns('s', cols, rows, 100)
  expect(idsOf(s)).toEqual(['prio', 'key', 'title'])
  expect(s.dropped).toEqual([])
  // a fixed and a tree column stay even when empty; the header alone does not keep a content column
  const lone = solveColumns('s', [tree('K'), content('type', 'Type')], [at(0, row('c', { key: '' }))], 100)
  expect(idsOf(lone)).toEqual(['key'])
})

test('a cell of tabs and newlines counts as empty', () => {
  resetWidths()
  const s = solveColumns('s', [tree('K'), content('type', 'Type')], [at(0, row('a', { key: 'x', type: '\t\n' }))], 100)
  expect(idsOf(s)).toEqual(['key'])
})

test('the width memo grows only, per table and column; resetWidths forgets it', () => {
  const col = [content('t', 'T')]
  const solve = (table: string, text: string) =>
    widthOf(solveColumns(table, col, [at(0, row('a', { t: text }))], 100), 't')
  resetWidths()
  expect(solve('s', 'abcdefgh')).toBe(8)
  expect(solve('s', 'ab')).toBe(8)
  expect(solve('other', 'ab')).toBe(2)
  resetWidths()
  expect(solve('s', 'ab')).toBe(2)
})

test('the tree column keeps its width when a deeper row closes; resetWidths forgets it', () => {
  const open = [at(0, row('a', { key: 'ISS-1' })), at(1, row('b', { key: 'PROJ-201' }))]
  const shut = [at(0, row('a', { key: 'ISS-1' }))]
  resetWidths()
  expect(widthOf(solveColumns('s', [tree()], open, 100), 'key')).toBe(2 + 8 + GLYPH_BOX)
  expect(widthOf(solveColumns('s', [tree()], shut, 100), 'key')).toBe(2 + 8 + GLYPH_BOX)
  expect(widthOf(solveColumns('other', [tree()], shut, 100), 'key')).toBe(5 + GLYPH_BOX)
  resetWidths()
  expect(widthOf(solveColumns('s', [tree()], shut, 100), 'key')).toBe(5 + GLYPH_BOX)
  const capped = [tree('K', { width: { kind: 'content', max: 6 } })]
  expect(widthOf(solveColumns('c', capped, [at(0, row('a', { key: 'x'.repeat(20) }))], 100), 'key')).toBe(6 + GLYPH_BOX)
  expect(widthOf(solveColumns('c', capped, [at(0, row('a', { key: 'ab' }))], 100), 'key')).toBe(6 + GLYPH_BOX)
})

test('the memo holds the unclamped width, so a clamped column stays at its max', () => {
  resetWidths()
  const wide = [content('t', 'T', { width: { kind: 'content', max: 5 } })]
  expect(widthOf(solveColumns('s', wide, [at(0, row('a', { t: 'abcdefgh' }))], 100), 't')).toBe(5)
  expect(widthOf(solveColumns('s', wide, [at(0, row('a', { t: 'ab' }))], 100), 't')).toBe(5)
})

test('n columns take n - 1 gaps, and a fixed column with a priority can drop', () => {
  resetWidths()
  const cols = [fixed('a', 5), fixed('b', 5), fixed('c', 5, { priority: 1 })]
  const rows = [at(0, row('r', {}))]
  expect(solveColumns('s', cols, rows, 17).dropped).toEqual([])
  expect(solveColumns('s', cols, rows, 16).dropped).toEqual(['c'])
})

test('align maps to justify', () => {
  resetWidths()
  const cols = [
    content('l', 'L', { align: 'left' }),
    content('c', 'C', { align: 'center' }),
    content('r', 'R', { align: 'right' }),
    content('n', 'N'),
  ]
  const rows = [at(0, row('a', { l: 'a', c: 'b', r: 'c', n: 'd' }))]
  const s = solveColumns('s', cols, rows, 100)
  expect(s.columns.map(c => c.justify)).toEqual(['flex-start', 'center', 'flex-end', 'flex-start'])
  expect(s.columns.map(c => c.tree)).toEqual([false, false, false, false])
})

test('clip maps to the solved column: end by default, middle when the column says so', () => {
  resetWidths()
  const cols = [content('a', 'A'), content('b', 'B', { clip: 'middle' }), content('c', 'C', { clip: 'end' })]
  const s = solveColumns('s', cols, [at(0, row('r', { a: 'x', b: 'y', c: 'z' }))], 100)
  expect(s.columns.map(c => c.clip)).toEqual(['end', 'middle', 'end'])
})

test('a tree column is flagged', () => {
  resetWidths()
  expect(solveColumns('s', [tree('K')], [at(0, row('a', { key: 'x' }))], 100).columns[0]?.tree).toBe(true)
})
