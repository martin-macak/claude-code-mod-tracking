// TreeDataTable.render: sections, rows, cells, selection, detail, the footer, the help swap. Pure: no tracker, no store.
// Caps, the budget guard and the handle helpers are in table-caps.test.ts. Plan: L6 Task 8.
import { expect, test } from 'claude-code/testing'
import { buttonKeyOf, CORE_KEYS, footerKeys, KeyRegistry, viewKeys } from '../core/infra/keys'
import type { Cell, RowRef } from '../core/interfaces/view'
import { KEYS as GITHUB_ROW_KEYS } from '../trackers/github/actions'
import { cellWidth } from '../ux/text/cell-width'
import { GAP, GLYPH_BOX, INDENT, resetWidths } from '../ux/tree-data-table/columns'
import { footerRows } from '../ux/tree-data-table/footer'
import { helpModel } from '../ux/tree-data-table/help'
import { DEFAULT_BODY_COLUMNS, GUTTER, NOTHING_MORE, TreeDataTable, UNAVAILABLE } from '../ux/tree-data-table/table'
import { EMPTY_TEXT } from '../ux/tree-data-table/text'
import {
  buttonOf,
  detailBoxes,
  footerOf,
  HELP_FOOTER,
  HELP_FOOTER_ROWS,
  handlesOf,
  helpFooterOf,
  isNode,
  leaves,
  NO_ROW_FOOTER,
  type Node,
  nodes,
  press,
  recorder,
  rowBoxes,
  texts,
  view,
  viewLineOf,
} from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { group, row, webRows } from './fixtures/sections'

// The first title of the help view: it names Tab, Shift+Tab and the arrows (issue #108).
const PANE_KEYS = 'Pane keys (Tab, Shift+Tab, Up, Down move between rows)'
/** The core keys that have a Button in the footer: all but the keys of the view line (issue #63, L3). */
const FOOTER_CORE = CORE_KEYS.filter(k => k.bar !== 'view')

const draw = (sections: Parameters<typeof TreeDataTable.render>[0], over: Parameters<typeof view>[0] = {}) => {
  resetWidths()
  const rec = recorder()
  return { ...rec, drawn: TreeDataTable.render(sections, view(over), EL, rec.actions) }
}

/** The header Boxes: the first child is a blank Text, and no Button sits inside. */
const headerBoxes = (tree: unknown): Node[] =>
  nodes(tree, 'Box').filter(b => {
    const first = b.children[0]
    return isNode(first) && first.type === 'Text' && first.children[0] === ' ' && nodes(b, 'Button').length === 0
  })

/** The Boxes of the cells of one row Box, after the gutter. */
const cellsOf = (r: Node): Node[] => r.children.slice(1) as Node[]

const only = <T>(list: readonly T[]): T => {
  expect(list).toHaveLength(1)
  return list[0] as T
}

test('a group draws one bold header row, its title and note, and one row per top-level row', () => {
  const { drawn } = draw([group('web', webRows(2), { title: 'Web links', note: { text: '2 links' } })])
  const bold = texts(drawn.tree)
    .filter(([p]) => p.weight === 'bold')
    .map(([, s]) => s)
  expect(bold).toEqual(['Name', 'Description', 'Web links'])
  expect(texts(drawn.tree).filter(([, s]) => s === '2 links')).toEqual([
    [{ wrap: 'truncate-end', dimColor: true }, '2 links'],
  ])
  expect(headerBoxes(drawn.tree)).toHaveLength(1)
  expect(rowBoxes(drawn.tree)).toHaveLength(2)
})

test('the note keeps its own color; a note longer than the room is clipped', () => {
  const warn: Cell = { text: 'gh · failed', fg: 'warning' }
  const { drawn } = draw([group('web', webRows(1), { title: 'Web links', note: warn })])
  expect(texts(drawn.tree).filter(([, s]) => s === 'gh · failed')).toEqual([
    [{ wrap: 'truncate-end', color: 'warning' }, 'gh · failed'],
  ])

  const long: Cell = { text: `tool\n${'n'.repeat(300)}` }
  const clipped = draw([group('web', webRows(1), { title: 'Web links', note: long })], { bodyColumns: 40 })
  const shown = texts(clipped.drawn.tree).filter(([p]) => p.dimColor === true)[0]?.[1] ?? ''
  expect(shown.startsWith('tool n')).toBe(true)
  expect(cellWidth(shown)).toBe(40 - cellWidth('Web links') - 1 - cellWidth('1') - 1)
  expect(shown.endsWith('…')).toBe(true)
})

test('handles are r0, r1, … across sections in pane order (U5)', () => {
  const a = group('a', webRows(2))
  const b = group('b', [row('only', { name: 'k', description: 't' })])
  const { drawn } = draw([a, b])
  expect([...drawn.handles.keys()]).toEqual(['r0', 'r1', 'r2'])
  expect([...drawn.handles.values()]).toEqual(['w0', 'w1', 'only'])
  expect(drawn.rows.map(r => r.handle)).toEqual(['r0', 'r1', 'r2'])
  expect(drawn.rows.map(r => r.group)).toEqual(['a', 'a', 'b'])
  expect(handlesOf(drawn.tree)).toEqual(['r0', 'r1', 'r2'])
})

test('every drawn row has exactly one Button; the header and detail lines have none', () => {
  const sections = [group('web', webRows(3))]
  const { drawn } = draw(sections, { expanded: new Set(['w1']) })
  const rows = rowBoxes(drawn.tree)
  expect(rows).toHaveLength(3)
  for (const r of rows) expect(nodes(r, 'Button')).toHaveLength(1)
  expect(detailBoxes(drawn.tree).length).toBeGreaterThan(0)
  for (const d of detailBoxes(drawn.tree)) expect(nodes(d, 'Button')).toHaveLength(0)
  for (const h of headerBoxes(drawn.tree)) expect(nodes(h, 'Button')).toHaveLength(0)
  expect(nodes(drawn.tree, 'Button')).toHaveLength(3 + FOOTER_CORE.length)
})

test('no Box and no Text carries a key', () => {
  const { drawn } = draw([group('web', webRows(2))], { expanded: new Set(['w0']) })
  for (const n of [...nodes(drawn.tree, 'Box'), ...nodes(drawn.tree, 'Text')]) expect('key' in n.props).toBe(false)
})

test('the tree cell holds the indent, the glyph Button and the text', () => {
  const kid = row('c', { name: 'child', description: 'ct' })
  const parent = row('p', { name: 'parent', description: 'pt' }, { expandedByDefault: true, children: [kid] })
  const { drawn } = draw([group('web', [parent])])
  const [first, second] = rowBoxes(drawn.tree)
  const treeCell = (r: Node) => cellsOf(r)[1] as Node
  expect(treeCell(first as Node).props.paddingLeft).toBe(0)
  const cell = treeCell(second as Node)
  expect(cell.props.paddingLeft).toBe(2)
  expect(cell.props.flexShrink).toBe(0)
  const glyph = only(nodes(cell, 'Button'))
  expect(glyph.props).toMatchObject({ key: 'r1', plain: true, label: '▸' })
  expect((cell.children[0] as Node).props).toEqual({ width: 2, flexShrink: 0 })
  expect(leaves(cell)).toEqual(['child'])
  expect(cell.props.width).toBe(((headerBoxes(drawn.tree)[0] as Node).children[2] as Node).props.width)
})

test('a cell with clip middle cuts a long cell as head…tail; a cell with none cuts as head…', () => {
  const long = 'feat/band-auto-tracking'
  const cells = { name: 'a', type: { text: long, clip: 'middle' as const }, status: long }
  const { drawn } = draw([group('s', [row('a', cells)])])
  const [, , , type, status] = cellsOf(only(rowBoxes(drawn.tree)))
  expect(leaves(type)).toEqual(['feat/band-…-tracking']) // the type column is 20 cells wide
  expect(leaves(status)).toEqual(['feat/band-aut…']) // the status column is 14
  const short = draw([group('s', [row('a', { name: 'a', type: { text: 'feat/x', clip: 'middle' } })])])
  expect(leaves(cellsOf(only(rowBoxes(short.drawn.tree)))[3])).toEqual(['feat/x'])
})

test('fg and bg map through the theme; bg sits on the cell Box (U4)', () => {
  const cell: Cell = { text: 'ok', fg: 'success', bg: 'accent' }
  const { drawn } = draw([group('web', [row('a', { name: 'k', description: cell })])])
  const titleBox = cellsOf(only(rowBoxes(drawn.tree)))[2] as Node
  expect(titleBox.props.backgroundColor).toBe('suggestion')
  expect((titleBox.children[0] as Node).props).toEqual({ wrap: 'truncate-end', color: 'success' })
})

test('a dim row draws every cell dim; a cell with href draws a Link inside its Text', () => {
  const key: Cell = { text: 'k', href: 'https://k.example/' }
  const { drawn } = draw([group('web', [row('a', { name: key, description: 't' }, { dim: true })])])
  const r = only(rowBoxes(drawn.tree))
  const cellTexts = nodes(r, 'Text').slice(1)
  expect(cellTexts.length).toBeGreaterThan(0)
  for (const t of cellTexts) expect(t.props.dimColor).toBe(true)
  const link = only(nodes(r, 'Link'))
  expect(link.props).toEqual({ href: 'https://k.example/' })
  expect(link.children).toEqual(['k'])
  const holder = nodes(r, 'Text').find(t => t.children.includes(link))
  expect(holder?.props.wrap).toBe('truncate-end')
})

test('an href that is blank or over 2048 characters draws plain text', () => {
  const sections = [
    group('web', [
      row('a', { name: { text: 'blank', href: '' } }),
      row('b', { name: { text: 'huge', href: `https://x.example/${'p'.repeat(2100)}` } }),
    ]),
  ]
  const { drawn } = draw(sections)
  expect(nodes(drawn.tree, 'Link')).toHaveLength(0)
  expect(leaves(drawn.tree)).toContain('huge')
})

test('a row with a missing cell draws an empty Text in a Box of the column width', () => {
  const { drawn } = draw([group('web', [row('a', { name: 'k' })])])
  const r = only(rowBoxes(drawn.tree))
  const titleBox = cellsOf(r)[2] as Node
  expect(titleBox.props.width).toBeGreaterThan(0)
  expect(titleBox.children).toEqual([{ type: 'Text', props: { wrap: 'truncate-end' }, children: [''] }])
})

test('the selected row draws > in the gutter and the selected background (G10)', () => {
  const rows = [row('a', { name: 'a' }), row('b', { name: 'b' })]
  const { drawn } = draw([group('web', rows)], { selected: 'b' })
  const [a, b] = rowBoxes(drawn.tree) as [Node, Node]
  expect(b.props.backgroundColor).toBe('blue')
  expect((b.children[0] as Node).children).toEqual(['>'])
  expect('backgroundColor' in a.props).toBe(false)
  expect((a.children[0] as Node).children).toEqual([' '])
  expect(a.props.columnGap).toBe(1)
})

test('autoFocus sits on the first handle while selected is null', () => {
  const { drawn } = draw([group('web', webRows(2))])
  expect(buttonOf(drawn.tree, 'r0').props.autoFocus).toBe(true)
  expect(buttonOf(drawn.tree, 'r1').props.autoFocus).toBeUndefined()
})

test('a selected id that no drawn row holds puts autoFocus on the first handle (Review Focus 4)', () => {
  const child = row('hidden', { name: 'h' })
  const parent = row('p', { name: 'p' }, { children: [child] })
  for (const selected of ['gone', 'hidden']) {
    const { drawn } = draw([group('web', [parent, row('q', { name: 'q' })])], { selected })
    expect(buttonOf(drawn.tree, 'r0').props.autoFocus).toBe(true)
    expect(nodes(drawn.tree, 'Button').filter(b => b.props.autoFocus === true)).toHaveLength(1)
  }
})

// Issue #108: a pane that takes the keys again (a second /track after the keys went to the prompt) starts its ring on the
// selected row, not on nothing. On nothing, the first Down walks from the first row and the selection jumps there.
test('autoFocus sits on the handle of the selected row once a drawn row is selected', () => {
  const { drawn } = draw([group('web', webRows(3))], { selected: 'w1' })
  expect(nodes(drawn.tree, 'Button').filter(b => b.props.autoFocus !== undefined)).toHaveLength(1)
  expect(buttonOf(drawn.tree, 'r1').props.autoFocus).toBe(true)
})

test('autoFocus follows the selected row into a later section', () => {
  const { drawn } = draw([group('a', webRows(2)), group('b', [row('late', { name: 'late' })])], {
    selected: 'late',
  })
  expect(nodes(drawn.tree, 'Button').filter(b => b.props.autoFocus === true)).toHaveLength(1)
  expect(buttonOf(drawn.tree, 'r2').props.autoFocus).toBe(true)
})

// Issue #108, option 4: a pane that has no keys draws no live-looking highlight. The marker stays, dim, so the person
// sees where the selection will be when the keys come back.
test('a pane without the keys draws the selected row with a dim > and no background', () => {
  const rows = [row('a', { name: 'a' }), row('b', { name: 'b' })]
  const { drawn } = draw([group('web', rows)], { selected: 'b', focused: false })
  const [a, b] = rowBoxes(drawn.tree) as [Node, Node]
  expect('backgroundColor' in b.props).toBe(false)
  expect(b.children[0]).toEqual({ type: 'Text', props: { dimColor: true }, children: ['>'] })
  expect(a.children[0]).toEqual({ type: 'Text', props: {}, children: [' '] })
})

test('a pane with the keys, or one that does not say, draws the selected row as before', () => {
  const rows = [row('a', { name: 'a' }), row('b', { name: 'b' })]
  for (const focused of [true, undefined]) {
    const { drawn } = draw([group('web', rows)], { selected: 'b', focused })
    const b = rowBoxes(drawn.tree)[1] as Node
    expect(b.props.backgroundColor).toBe('blue')
    expect(b.children[0]).toEqual({ type: 'Text', props: {}, children: ['>'] })
  }
})

test('a closed row draws ▸ and hides its children; an open row draws ▾ and its children one level deeper', () => {
  const kid = row('c', { name: 'child' })
  const sections = [group('web', [row('p', { name: 'parent' }, { children: [kid] })])]
  const closed = draw(sections)
  expect(rowBoxes(closed.drawn.tree)).toHaveLength(1)
  expect(buttonOf(closed.drawn.tree, 'r0').props.label).toBe('▸')

  const open = draw(sections, { expanded: new Set(['p']) })
  expect(rowBoxes(open.drawn.tree)).toHaveLength(2)
  expect(buttonOf(open.drawn.tree, 'r0').props.label).toBe('▾')
  expect(open.drawn.rows.map(r => r.depth)).toEqual([0, 1])
  expect(open.drawn.handles.get('r1')).toBe('c')
  expect(detailBoxes(open.drawn.tree)).toHaveLength(0)
})

test('expandedByDefault rows are open unless their id is in expanded (G3)', () => {
  const kids = [row('c1', { name: 'one' }), row('c2', { name: 'two' })]
  const sections = [group('web', [row('p', { name: 'p' }, { expandedByDefault: true, children: kids })])]
  expect(rowBoxes(draw(sections).drawn.tree)).toHaveLength(3)
  expect(rowBoxes(draw(sections, { expanded: new Set(['p']) }).drawn.tree)).toHaveLength(1)
})

test('Enter on a handle calls toggle with the row id', () => {
  const { drawn, calls } = draw([group('web', webRows(2))])
  press(buttonOf(drawn.tree, 'r1'))
  expect(calls).toEqual(['toggle:w1'])
})

test('an open leaf with detail() draws its lines; without detail it draws the default detail (U1)', () => {
  const withDetail = row(
    'a',
    { name: 'k' },
    { detail: () => [{ label: 'Body', cell: { text: 'Hello', fg: 'error' } }] },
  )
  const lines = draw([group('web', [withDetail])], { expanded: new Set(['a']) })
  const box = only(detailBoxes(lines.drawn.tree))
  expect(box.props).toMatchObject({ columnGap: 1 })
  expect(texts(box)).toEqual([
    [{ dimColor: true }, 'Body:'],
    [{ wrap: 'wrap', color: 'error' }, 'Hello'],
  ])

  const plain = draw([group('web', [row('b', { name: 'k', description: 't' })])], { expanded: new Set(['b']) })
  expect(leaves(only(detailBoxes(plain.drawn.tree)))).toEqual([NOTHING_MORE])
})

test('a detail line is indented under the tree text of its row', () => {
  const kid = row('c', { name: 'child' }, { detail: () => [{ cell: { text: 'info' } }] })
  const parent = row('p', { name: 'parent' }, { expandedByDefault: true, children: [kid] })
  const { drawn } = draw([group('web', [parent])], { expanded: new Set(['c']) })
  const box = only(detailBoxes(drawn.tree))
  // The gutter, the control column and its gap, one tree level, then the glyph box.
  expect(box.props.paddingLeft).toBe(GUTTER + (2 + GAP) + INDENT + GLYPH_BOX)
  expect(box.children).toHaveLength(1)
})

test('a detail line keeps room for its text in a narrow pane', () => {
  let node = row('d4', { name: 'deepest' }, { detail: () => [{ cell: { text: 'info' } }] })
  for (let i = 3; i >= 0; i--) node = row(`d${i}`, { name: `k${i}` }, { expandedByDefault: true, children: [node] })
  const { drawn } = draw([group('web', [node])], { bodyColumns: 30, expanded: new Set(['d4']) })
  expect(only(detailBoxes(drawn.tree)).props.paddingLeft).toBe(30 - 20)
})

test('the default detail lists clipped and dropped cells and the link; else (nothing more to show) (G13)', () => {
  const key: Cell = { text: 'one.example/a', href: 'https://one.example/a' }
  const long = row('w', { control: '', name: key, description: 'x'.repeat(60) })
  const { drawn } = draw([group('web', [long])], { bodyColumns: 40, expanded: new Set(['w']) })
  expect(detailBoxes(drawn.tree).flatMap(leaves)).toEqual([
    'Description:',
    'x'.repeat(60),
    'link:',
    'https://one.example/a',
  ])

  const short = row('s', { control: '', name: 'k', description: 't' })
  const none = draw([group('web', [short])], { expanded: new Set(['s']) })
  const dim = texts(only(detailBoxes(none.drawn.tree)))
  expect(dim).toEqual([[{ wrap: 'wrap', dimColor: true }, '(nothing more to show)']])
})

test('the default detail names a dropped column by its header, gives each badge a line with no label, and lists a link once', () => {
  const href = 'https://a.example/'
  const r = row(
    'a',
    { name: { text: 'key', href }, description: { text: 'title', href }, type: 'kind-text' },
    { extras: [{ text: '✓ checks' }, { text: 'by me', fg: 'error' }] },
  )
  const { drawn } = draw([group('s', [r])], { bodyColumns: 20, expanded: new Set(['a']) })
  expect(cellsOf(only(headerBoxes(drawn.tree)))).toHaveLength(3) // control, name, description: the type and the extras dropped
  // The extras column has no header word and its id is not for the person: each badge is a line of its own, with no
  // label, in its own color.
  expect(detailBoxes(drawn.tree).flatMap(leaves)).toEqual(['Type:', 'kind-text', '✓ checks', 'by me', 'link:', href])
  expect(
    detailBoxes(drawn.tree)
      .flatMap(b => texts(b))
      .filter(([p]) => p.color === 'error'),
  ).toHaveLength(1)
})

test('the default detail lists the badges that the column clipped, and none when they all show', () => {
  const badges = [{ text: '✗ conflicts' }, { text: '✗ checks' }, { text: 'no worktree' }]
  const r = row('a', { name: 'k', description: 'd' }, { extras: badges })
  const clipped = draw([group('s', [r])], { bodyColumns: 96, expanded: new Set(['a']) })
  // A badge line has no label: the extras column has no header word, and its id is not for the person.
  expect(detailBoxes(clipped.drawn.tree).flatMap(leaves)).toEqual(['✗ conflicts', '✗ checks', 'no worktree'])
  const fits = row('b', { name: 'k', description: 'd' }, { extras: [{ text: '✓ ok' }, { text: 'two' }] })
  const whole = draw([group('s', [fits])], { bodyColumns: 96, expanded: new Set(['b']) })
  expect(leaves(only(detailBoxes(whole.drawn.tree)))).toEqual(['(nothing more to show)'])
})

test('a 5000-character title costs at most its column in the row and 500 cells in the detail (Review Focus 2)', () => {
  const big = 'x'.repeat(5000)
  const sections = [group('web', [row('a', { name: 'k', description: big })])]
  const closed = draw(sections)
  const head = headerBoxes(closed.drawn.tree)[0] as Node
  const titleWidth = (head.children[3] as Node).props.width as number
  const titleText = leaves(cellsOf(only(rowBoxes(closed.drawn.tree)))[2])[0] ?? ''
  expect(cellWidth(titleText)).toBeLessThanOrEqual(titleWidth)
  expect(titleText.endsWith('…')).toBe(true)

  const open = draw(sections, { expanded: new Set(['a']) })
  const detail = leaves(only(detailBoxes(open.drawn.tree)))
  expect(detail[0]).toBe('Description:')
  expect(cellWidth(detail[1] ?? '')).toBe(500)
  expect((detail[1] ?? '').endsWith('…')).toBe(true)
  expect(leaves(open.drawn.tree).join('').length).toBeLessThan(1200)
})

test('a title with a newline and an ANSI code draws on one line (Review Focus 1)', () => {
  const { drawn } = draw([group('web', [row('a', { name: 'k', description: 'a\nb\u001b[31mc' })])])
  const titleBox = cellsOf(only(rowBoxes(drawn.tree)))[2] as Node
  expect(leaves(titleBox)).toEqual(['a b c'])
})

test('an unknown width reads as 80 (Review Focus 3)', () => {
  const { drawn } = draw([group('web', webRows(2))], { bodyColumns: undefined })
  const widths = cellsOf(only(headerBoxes(drawn.tree))).map(b => b.props.width as number)
  const total = GUTTER + widths.reduce((a, b) => a + b, 0) + (widths.length - 1)
  expect(total).toBe(DEFAULT_BODY_COLUMNS)
  expect(DEFAULT_BODY_COLUMNS).toBe(80)
})

test('a narrow pane drops columns by priority and still draws every row (Review Focus 3)', () => {
  const r = row('a', { name: 'KEY-1', description: 'a title', type: 'a type text' }, { extras: [{ text: '✓ ok' }] })
  const wide = draw([group('s', [r])], { bodyColumns: 80 })
  expect(cellsOf(only(headerBoxes(wide.drawn.tree)))).toHaveLength(5) // control, name, description, type, extras
  const narrow = draw([group('s', [r])], { bodyColumns: 24 })
  expect(cellsOf(only(headerBoxes(narrow.drawn.tree)))).toHaveLength(3) // control, name, description
  expect(rowBoxes(narrow.drawn.tree)).toHaveLength(1)
})

test('a deeply nested row whose indent fills its column draws the glyph only, inside the column', () => {
  let node = row('d14', { name: 'deepest' })
  for (let i = 13; i >= 0; i--) node = row(`d${i}`, { name: `k${i}` }, { expandedByDefault: true, children: [node] })
  const { drawn } = draw([group('s', [node])])
  const last = rowBoxes(drawn.tree).at(-1) as Node
  const treeBox = cellsOf(last)[1] as Node
  // The name column holds 24 cells and the glyph box: 15 levels of 2 cells do not fit, so the indent stops at 24.
  expect(treeBox.props.paddingLeft).toBe(24)
  expect(nodes(treeBox, 'Button')).toHaveLength(1)
  expect(leaves(treeBox)).toEqual([])
})

test('every core key has one footer Button in every state; disabled ones are dim, do no work and ask for the keys (G16, issue #129)', () => {
  const reg = new KeyRegistry()
  const sections = [group('web', webRows(1))]
  const process: RowRef = { id: 'w0', owner: 'p', group: 'processes', can: {} }
  const item: RowRef = { id: 'w0', owner: 'items', group: 'web', can: { dismiss: true, priority: true } }
  const pane = ['r', 'h', 'x', '1', '2', '3', '0']
  const cases = [
    { footer: footerKeys(reg, undefined, () => false, false), help: null, on: ['refresh', 'help'], hotkeys: pane },
    { footer: footerKeys(reg, process, () => false, false), help: null, on: ['refresh', 'help'], hotkeys: pane },
    {
      footer: footerKeys(reg, item, o => o === 'items', false),
      help: null,
      on: FOOTER_CORE.map(k => k.id),
      hotkeys: pane,
    },
    {
      footer: footerKeys(reg, item, o => o === 'items', true),
      help: helpModel(reg.all(), sections, undefined, []),
      on: ['refresh', 'help'],
      hotkeys: [...pane, 'g', 'a', 't', 'm'], // the help view has no view line (issue #200): its footer draws those keys too
    },
  ]
  for (const c of cases) {
    const { drawn, calls, asks } = draw(sections, { footer: c.footer, help: c.help })
    const buttons = c.help === null ? footerOf(drawn.tree) : helpFooterOf(drawn.tree)
    expect(buttons.map(b => b.props.hotkey)).toEqual(c.hotkeys)
    expect(buttons.map(b => b.props.key)).toEqual(c.footer.map(buttonKeyOf))
    for (const b of buttons) {
      const live = c.on.includes(String(b.props.key))
      expect(b.props.dimColor).toBe(live ? undefined : true)
      expect(b.props.plain).toBe(true)
      press(b)
    }
    expect(calls).toEqual(c.on.map(k => `press:${k}`)) // a dim key does no work
    expect(asks.count).toBe(buttons.length - c.on.length) // and each dim key asks for the keys, once
    const footer = (drawn.tree as unknown as Node).children.at(-1) as Node
    expect(footer.props).toEqual({ columnGap: 2, flexWrap: 'wrap' })
    expect(footer.children.at(-1)).toEqual({ type: 'Text', props: { dimColor: true }, children: ['Esc close'] })
  }
})

// Issue #200: in the help view a press of g, a, t or m must not type the letter into the prompt. A Button with that hotkey takes
// the press and does nothing, as x and the digits do, and asks for the keys, so the keyboard stays in the pane.
test('the help view draws g, a, t and m as dim footer Buttons, one Button per hotkey, and a press only asks for the keys', () => {
  const reg = new KeyRegistry()
  const sections = [group('web', webRows(2))]
  const { drawn, calls, asks } = draw(sections, {
    footer: footerKeys(reg, undefined, () => false, true),
    help: helpModel(reg.all(), sections, '/c/config.json', []),
  })
  const hotkeys = helpFooterOf(drawn.tree).map(b => String(b.props.hotkey))
  expect(hotkeys).toEqual(['r', 'h', 'x', '1', '2', '3', '0', 'g', 'a', 't', 'm'])
  expect(hotkeys).toEqual([...new Set(hotkeys)]) // the engine lets the later of two equal hotkeys win in silence
  expect(viewLineOf(drawn.tree)).toHaveLength(4) // the same Buttons: the help view has no view line, so these are its footer
  expect(footerOf(drawn.tree)).toHaveLength(7)
  for (const key of ['view', 'show-all', 'touched', 'mark']) {
    const b = buttonOf(drawn.tree, key)
    expect(b.props.dimColor, key).toBe(true)
    expect(b.props.plain, key).toBe(true)
    press(b)
  }
  expect(calls).toEqual([]) // no work
  expect(asks.count).toBe(4) // each press asks for the keys, once
  const footer = (drawn.tree as unknown as Node).children.at(-1) as Node
  expect(nodes(footer, 'Button').map(b => b.props.hotkey)).toEqual(hotkeys) // all in the footer Box
})

test('the pane draws g, a, t and m once, on the view line, and the help view draws them once, in the footer', () => {
  const reg = new KeyRegistry()
  const sections = [group('web', webRows(2))]
  const row: RowRef = { id: 'w0', owner: 'items', group: 'web', can: { dismiss: true, priority: true } }
  const pane = draw(sections, {
    footer: footerKeys(reg, row, o => o === 'items', false),
    viewLine: { text: '', keys: viewKeys(reg, row, o => o === 'items', false) },
  })
  const paneKeys = nodes(pane.drawn.tree, 'Button')
    .map(b => b.props.hotkey)
    .filter(k => k !== undefined)
  expect(paneKeys).toEqual([...new Set(paneKeys)])
  expect(paneKeys.filter(k => ['g', 'a', 't', 'm'].includes(String(k)))).toHaveLength(4)
  expect(viewLineOf(pane.drawn.tree)).toHaveLength(4)
  expect(footerOf(pane.drawn.tree).map(b => b.props.hotkey)).toEqual(['r', 'h', 'x', '1', '2', '3', '0'])
  // The help view takes no view line, whatever the view carries: the keys are in the footer, not twice.
  const help = draw(sections, {
    footer: footerKeys(reg, undefined, () => false, true),
    help: helpModel(reg.all(), sections, undefined, []),
    viewLine: { text: '', keys: viewKeys(reg, undefined, () => false, false) },
  })
  const helpKeys = helpFooterOf(help.drawn.tree).map(b => b.props.hotkey)
  expect(helpKeys).toEqual([...new Set(helpKeys)])
  expect(helpKeys).toHaveLength(11)
})

// Issue #108, option 1: the footer says how to move, where that costs no row. The core footer is 79 cells, 92 with the hint.
// A body of 79 to 91 cells draws it on one row without the hint and on two with it, so the hint stays out there: the help
// view names the keys at every width. Where the footer wraps anyway and the hint fits on the second row, it stays.
const MOVE = 'Tab ↑↓ move'
const footerAt = (bodyColumns: number) => draw([], { bodyColumns }).drawn.tree as unknown as Node

test('the footer names Tab and the arrows before Esc close in a body where that adds no row', () => {
  for (const bodyColumns of [92, 95, 96]) {
    const footer = (footerAt(bodyColumns).children.at(-1) ?? {}) as Node
    expect(footer.children.slice(-2)).toEqual([
      { type: 'Text', props: { dimColor: true }, children: [MOVE] },
      { type: 'Text', props: { dimColor: true }, children: ['Esc close'] },
    ])
    expect(footerRows(NO_ROW_FOOTER, bodyColumns, true)).toBe(1)
  }
})

test('the footer leaves the move hint out of a body where it would add a row', () => {
  for (const bodyColumns of [91, 80, 79]) {
    const footer = footerAt(bodyColumns).children.at(-1) as Node
    expect(leaves(footer)).not.toContain(MOVE)
    expect(footer.children.at(-1)).toEqual({ type: 'Text', props: { dimColor: true }, children: ['Esc close'] })
    expect(footerRows(NO_ROW_FOOTER, bodyColumns, false)).toBe(1) // it takes the one row it took before the hint
    expect(footerRows(NO_ROW_FOOTER, bodyColumns, true)).toBe(2) // the hint would have cost this body a row
  }
})

test('the footer keeps the move hint where it wraps anyway and the hint fits on the second row', () => {
  // 78 cells: the keys fill the first row, and the second holds `Tab ↑↓ move  Esc close` with or without the hint.
  expect(footerRows(NO_ROW_FOOTER, 78, false)).toBe(2)
  expect(footerRows(NO_ROW_FOOTER, 78, true)).toBe(2)
  expect(leaves(footerAt(78).children.at(-1))).toContain(MOVE)
})

// The help footer (issue #200) is 127 cells wide with its 11 Buttons and `Esc close` (116 cells for the Buttons alone, 140 with
// the hint), so the hint fits it only where it adds no row: not at 66 to 69 cells (2 rows without the hint, 3 with it), and not
// at 127 to 139 cells (1 row without, 2 with). It fits from 70 to 126 cells, where the footer wraps anyway, and from 140.
test('the help footer of 11 Buttons draws the move hint only where it adds no row', () => {
  const draws = (bodyColumns: number) => {
    const help = helpModel([], [], undefined, [])
    const tree = draw([], { footer: HELP_FOOTER, help, bodyColumns }).drawn.tree as unknown as Node
    return leaves(tree.children.at(-1)).includes(MOVE)
  }
  for (const bodyColumns of [70, 96, 126, 140]) {
    expect(draws(bodyColumns), `${bodyColumns} cells`).toBe(true)
    expect(footerRows(HELP_FOOTER, bodyColumns, true), `${bodyColumns} cells`).toBe(
      footerRows(HELP_FOOTER, bodyColumns, false),
    )
  }
  for (const bodyColumns of [127, 139, 69, 66]) {
    expect(draws(bodyColumns), `${bodyColumns} cells`).toBe(false)
    expect(footerRows(HELP_FOOTER, bodyColumns, true), `${bodyColumns} cells`).toBeGreaterThan(
      footerRows(HELP_FOOTER, bodyColumns, false),
    )
  }
})

test('the footer Button key is the key the registry finds the key by, for a tracker key too', () => {
  const reg = new KeyRegistry()
  reg.add('a', [{ id: 'open', key: 'o', label: 'open', scope: 'row' }])
  const mine: RowRef = { id: 'w0', owner: 'a', group: 'web', can: {} }
  const footer = footerKeys(reg, mine, () => false, false)
  const { drawn, calls } = draw([group('web', webRows(1))], { footer })
  const keys = footerOf(drawn.tree).map(b => String(b.props.key))
  expect(keys).toEqual(footer.map(buttonKeyOf))
  expect(keys.at(-1)).toBe('a.open')
  expect(reg.get('a.open')?.owner).toBe('a')
  press(buttonOf(drawn.tree, 'a.open'))
  expect(calls).toEqual(['press:a.open'])
  expect(buttonOf(drawn.tree, 'help').props.label).toBe('help')
})

test('with help the footer labels h as back', () => {
  const reg = new KeyRegistry()
  const footer = footerKeys(reg, undefined, () => false, true)
  const { drawn } = draw([], { footer, help: helpModel(reg.all(), [], undefined, []) })
  expect(buttonOf(drawn.tree, 'help').props.label).toBe('back')
})

test('an empty pane draws No tracked items yet. and the footer', () => {
  const { drawn } = draw([])
  expect(texts(drawn.tree).filter(([p, s]) => s === EMPTY_TEXT && p.dimColor === true)).toHaveLength(1)
  expect(footerOf(drawn.tree)).toHaveLength(7)
  expect(drawn.handles.size).toBe(0)
  expect(drawn.rows).toEqual([])
})

test('a section with no rows draws its title and its empty text, and no header', () => {
  const { drawn } = draw([group('web', [], { title: 'Web links', empty: 'No links yet.' })])
  expect(headerBoxes(drawn.tree)).toHaveLength(0)
  expect(rowBoxes(drawn.tree)).toHaveLength(0)
  expect(texts(drawn.tree).filter(([, s]) => s === 'No links yet.')).toEqual([[{ dimColor: true }, 'No links yet.']])
  expect(leaves(drawn.tree)).toContain('Web links')
  const silent = draw([group('web', [], { title: 'Web links' })])
  expect(leaves(silent.drawn.tree)).not.toContain('No links yet.')
})

test('with help the pane draws the help view and the footer, and no row', () => {
  const reg = new KeyRegistry()
  const sections = [group('web', webRows(2))]
  const footer = footerKeys(reg, undefined, () => false, true)
  const { drawn } = draw(sections, { footer, help: helpModel(reg.all(), sections, '/c/config.json', ['Bad.']) })
  const all = leaves(drawn.tree)
  expect(all).toContain(PANE_KEYS)
  expect(all).toContain('Config file: /c/config.json')
  expect(all).toContain('Bad.')
  expect(rowBoxes(drawn.tree)).toHaveLength(0)
  expect(handlesOf(drawn.tree)).toEqual([])
  expect(drawn.handles.size).toBe(0)
  expect(helpFooterOf(drawn.tree)).toHaveLength(11) // the 7 footer keys and the dim g, a, t and m (issue #200)
})

// The help view in a short body (issue #92). The engine gives the body height as `scroll.bodyRows`. The full help view
// takes 11 lines (2 titles, 7 keys, the config line and the version line of issue #65), the gap and the footer: 13
// rows. A body of fewer rows draws the compact form. The model has a version, as the pane has once the start ran.
const VERSION = '1.2.3'
const FULL_ROWS = 13
const COMPACT_LINES = 7 // 2 titles, 3 lines of keys (three keys to a line), the config line, the version line
// A body too short for any form takes the fewest rows (issue #105): the widest line of keys the width holds, so the
// pane keys and the row keys take a line each.
const TIGHTEST_LINES = 6 // 2 titles, 2 lines of keys, the config line, the version line
const FULL_LINES = 11

/**
 * The help view over `bodyRows` rows: its Box, the footer Box and the gap between them. On purpose it takes a registry of the
 * footer keys only (`FOOTER_CORE`), so its footer is the 7 Buttons of 79 cells that took one row before issue #200, and the
 * tests on it are about the mechanics of the guard (a footer that wraps, the hint, the compact form), not about the pane. The
 * 11 Buttons that the pane draws now (`HELP_FOOTER`, 2 rows at 96 cells) are pinned in `problemsIn` below, in `help.test.ts`
 * and in `pane.test.tsx`.
 */
function helpIn(bodyRows: number | undefined, bodyColumns = 96) {
  const reg = new KeyRegistry(FOOTER_CORE)
  const footer = footerKeys(reg, undefined, () => false, true)
  const { drawn } = draw([], {
    footer,
    help: helpModel(reg.all(), [], '/c/config.json', [], VERSION),
    bodyColumns,
    bodyRows,
  })
  const tree = drawn.tree as unknown as Node
  const [help, foot] = tree.children as Node[]
  return { tree, help: help as Node, foot: foot as Node, lines: (help as Node).children.length }
}

test('with help and room for it the pane draws the full help view, a gap and the footer, with a 7-key footer', () => {
  for (const rows of [undefined, FULL_ROWS, 28]) {
    const { tree, lines } = helpIn(rows)
    expect(lines).toBe(FULL_LINES)
    expect(tree.props.rowGap).toBe(1)
  }
})

test('with help and a body one row short the pane draws the compact help view and no gap, with a 7-key footer', () => {
  const { tree, help, foot, lines } = helpIn(FULL_ROWS - 1)
  expect(lines).toBe(COMPACT_LINES)
  expect(leaves(help)[0]).toBe(PANE_KEYS)
  expect(tree.props.rowGap).toBe(0)
  expect(tree.children).toHaveLength(2)
  expect(footerOf(foot)).toHaveLength(7)
  expect(lines + 1).toBeLessThanOrEqual(FULL_ROWS - 1) // the help lines and the footer fit the short body
})

test('a 7-key footer that wraps at a narrow body takes a row, so help that fits at 80 columns turns compact at 78', () => {
  expect(helpIn(FULL_ROWS, 80).lines).toBe(FULL_LINES) // the footer is 79 cells: one row
  expect(helpIn(FULL_ROWS, 78).lines).toBe(COMPACT_LINES) // two rows
  expect(helpIn(FULL_ROWS, undefined).lines).toBe(FULL_LINES) // no width: 80 columns
})

// The move hint is counted only where it is drawn (issue #108): at 91 cells it would cost the footer a row and turn the
// help view compact, so it is left out and the help view stays full.
test('the move hint never turns the help view compact: full at 91 and 92 columns with a 7-key footer, with and without the hint', () => {
  expect(helpIn(FULL_ROWS, 91).lines).toBe(FULL_LINES) // 79 cells of footer, no hint: one row
  expect(helpIn(FULL_ROWS, 92).lines).toBe(FULL_LINES) // 92 cells with the hint: one row
})

test('a body shorter than the footer plus one line still draws the compact help view and the 7-key footer', () => {
  for (const rows of [2, 1, 0]) {
    const { tree, help, foot, lines } = helpIn(rows)
    expect(lines).toBe(TIGHTEST_LINES)
    expect(lines).toBeLessThan(COMPACT_LINES) // nothing fits: the fewest rows, so the least of the top scrolls out
    expect(leaves(help)[0]).toBe(PANE_KEYS)
    expect(footerOf(foot)).toHaveLength(7)
    expect(tree.children).toHaveLength(2)
  }
})

// Issue #105: the problems of the config. The full form lists every one. A body too short for them draws the compact form,
// which names the first problems the body has rows for and counts the rest.
const LIVE_PATH = '/var/folders/sn/0_q8tr7x4vv44d69rbtyckwr0000gn/T/cc-tracker-config-SAq3DF/config.json' // 86 cells
const problemsOf = (n: number): string[] => Array.from({ length: n }, (_, i) => `Problem ${i + 1}.`)

/** The help view of every real key (the core keys and the github keys) and `n` problems over a body of `bodyRows` rows. */
function problemsIn(n: number, bodyRows: number | undefined, path = LIVE_PATH) {
  const reg = new KeyRegistry()
  reg.add('github', GITHUB_ROW_KEYS)
  const footer = footerKeys(reg, undefined, () => false, true)
  const help = helpModel(reg.all(), [], path, problemsOf(n), VERSION)
  const { drawn } = draw([], { footer, help, bodyColumns: 96, bodyRows })
  const tree = drawn.tree as unknown as Node
  const [body, foot] = tree.children as Node[]
  return { tree, body: body as Node, foot: foot as Node, lines: leaves(body) }
}

test('at 100x40 inline with 3 or more problems the help view shows Pane keys, the count and the footer in the 11-row body', () => {
  expect(HELP_FOOTER_ROWS).toBe(2) // the 11 Buttons wrap at 96 cells (issue #200)
  for (const n of [3, 4, 30]) {
    const { tree, body, foot, lines } = problemsIn(n, 11)
    expect(lines[0], `${n} problems`).toBe(PANE_KEYS)
    expect(lines.at(-1), `${n} problems`).toBe(`${n} problems: /track help`)
    // 2 titles, 2 lines of keys, the row of the github keys, the config line, the version line and the count: the github group
    // takes one row of its own (issue #265), and the 2-row footer leaves the body one row fewer than the 1-row footer did.
    expect(body.children).toHaveLength(8)
    expect(tree.props.rowGap).toBe(0)
    expect(helpFooterOf(foot)).toHaveLength(11)
    // The 86-cell path wraps to a second row: 8 lines, 1 wrapped row and the 2-row footer fill the body.
    expect(body.children.length + 1 + HELP_FOOTER_ROWS).toBe(11)
  }
})

test('the help view lists every problem of its model when the body has the rows, and caps them when it has not', () => {
  const tall = problemsIn(30, 100)
  expect(tall.lines.filter(l => /^Problem \d+\.$/.test(l))).toEqual(problemsOf(30)) // the full form: no cap, no count
  expect(tall.lines.join('\n')).not.toContain('/track help')
  expect(tall.tree.props.rowGap).toBe(1)
  // The compact form: the footer and a body of 16 rows. The pane keys take two lines (g, a and t, issue #63, L3) and the footer takes
  // two rows (the dim Buttons of g, a, t and m, issue #200), so 2 of 12 problems fit.
  const room = problemsIn(12, 16, '/c/config.json')
  expect(room.lines.filter(l => /^Problem \d+\.$/.test(l))).toHaveLength(2)
  expect(room.lines.at(-1)).toBe('10 more problems: /track help')
})

test('the table view never turns compact: the root keeps its gap, and a body that holds the tree changes nothing', () => {
  const sections = [group('web', webRows(2))]
  const tall = draw(sections, { bodyRows: 28 }).drawn
  const exact = draw(sections, { bodyRows: 6 }).drawn // the title, the header, 2 rows, the gap and the footer
  expect(JSON.stringify(exact.tree)).toBe(JSON.stringify(tall.tree)) // closures differ, the shape does not
  const short = draw(sections, { bodyRows: 3 }).drawn // a window over the rows (table-window.test.ts), still with the gap
  expect((short.tree as unknown as Node).props.rowGap).toBe(1)
  expect((tall.tree as unknown as Node).props.rowGap).toBe(1)
})

test('unavailable draws one dim line', () => {
  expect(TreeDataTable.unavailable(EL)).toEqual({ type: 'Text', props: { dimColor: true }, children: [UNAVAILABLE] })
  expect(UNAVAILABLE).toBe('Tracking is unavailable. Run /track to try again.')
})

// ---------------------------------------------------------------- reasons in the detail (issue #62)

const REASONS = { first: 'mentioned', all: ['updated', 'read', 'mentioned'], strongest: 'updated' } as const

test('the detail of an open row lists all its reasons, strongest first (#62)', () => {
  const r = row('a', { control: '', name: 'k', description: 't' }, { reasons: REASONS })
  const { drawn } = draw([group('web', [r])], { expanded: new Set(['a']) })
  // The row has nothing else to say, so the reasons are the whole detail: no "nothing more" line.
  expect(detailBoxes(drawn.tree).flatMap(leaves)).toEqual(['reasons:', 'updated, read, mentioned'])
})

test('the reasons line follows the default detail and the detail() of a tracker', () => {
  const key: Cell = { text: 'one.example/a', href: 'https://one.example/a' }
  const long = row('w', { control: '', name: key, description: 'x'.repeat(60) }, { reasons: REASONS })
  const dflt = draw([group('web', [long])], { bodyColumns: 40, expanded: new Set(['w']) })
  expect(detailBoxes(dflt.drawn.tree).flatMap(leaves)).toEqual([
    'Description:',
    'x'.repeat(60),
    'link:',
    'https://one.example/a',
    'reasons:',
    'updated, read, mentioned',
  ])
  const own = row('b', { name: 'k' }, { reasons: REASONS, detail: () => [{ label: 'Body', cell: { text: 'Hello' } }] })
  const custom = draw([group('web', [own])], { expanded: new Set(['b']) })
  expect(detailBoxes(custom.drawn.tree).flatMap(leaves)).toEqual([
    'Body:',
    'Hello',
    'reasons:',
    'updated, read, mentioned',
  ])
})

test('a row with children lists its reasons when open; a row with no reasons gets no such line', () => {
  const kid = row('c', { name: 'child' })
  const parent = row('p', { name: 'parent' }, { reasons: REASONS, children: [kid] })
  const open = draw([group('web', [parent])], { expanded: new Set(['p']) })
  expect(detailBoxes(open.drawn.tree).flatMap(leaves)).toEqual(['reasons:', 'updated, read, mentioned'])
  const bare = row('q', { name: 'bare' }, { children: [kid] })
  expect(detailBoxes(draw([group('web', [bare])], { expanded: new Set(['q']) }).drawn.tree)).toHaveLength(0)
  const plain = draw([group('web', [row('b', { name: 'k', description: 't' })])], { expanded: new Set(['b']) })
  expect(leaves(only(detailBoxes(plain.drawn.tree)))).toEqual([NOTHING_MORE])
})

// ---------------------------------------------------------------- turns in the detail (issue #69)

test('R6: the detail lists the first and the last turn of an item, one line after the reasons line', () => {
  const r = row('a', { control: '', name: 'k', description: 't' }, { reasons: REASONS, turns: { first: 3, last: 7 } })
  const { drawn } = draw([group('web', [r])], { expanded: new Set(['a']) })
  expect(detailBoxes(drawn.tree).flatMap(leaves)).toEqual([
    'reasons:',
    'updated, read, mentioned',
    'turns:',
    'first 3 · last 7',
  ])
})

test('R6: an item that one turn tracked says so with the same turn twice; a row with no turns has no such line', () => {
  const once = row('a', { name: 'k' }, { reasons: REASONS, turns: { first: 2, last: 2 } })
  const { drawn } = draw([group('web', [once])], { expanded: new Set(['a']) })
  expect(detailBoxes(drawn.tree).flatMap(leaves).slice(-2)).toEqual(['turns:', 'first 2 · last 2'])
  const none = row('b', { name: 'k' }, { reasons: REASONS })
  const plain = draw([group('web', [none])], { expanded: new Set(['b']) })
  expect(detailBoxes(plain.drawn.tree).flatMap(leaves)).not.toContain('turns:')
})

test('R6: the turns line follows the detail() of a tracker and the default detail, and a row with children lists it too', () => {
  const key: Cell = { text: 'one.example/a', href: 'https://one.example/a' }
  const turns = { first: 1, last: 4 }
  const long = row('w', { control: '', name: key, description: 'x'.repeat(60) }, { reasons: REASONS, turns })
  const dflt = draw([group('web', [long])], { bodyColumns: 40, expanded: new Set(['w']) })
  expect(detailBoxes(dflt.drawn.tree).flatMap(leaves).slice(-4)).toEqual([
    'reasons:',
    'updated, read, mentioned',
    'turns:',
    'first 1 · last 4',
  ])
  const own = row(
    'b',
    { name: 'k' },
    { reasons: REASONS, turns, detail: () => [{ label: 'Body', cell: { text: 'Hello' } }] },
  )
  const custom = draw([group('web', [own])], { expanded: new Set(['b']) })
  expect(detailBoxes(custom.drawn.tree).flatMap(leaves)).toEqual([
    'Body:',
    'Hello',
    'reasons:',
    'updated, read, mentioned',
    'turns:',
    'first 1 · last 4',
  ])
  const parent = row('p', { name: 'parent' }, { reasons: REASONS, turns, children: [row('c', { name: 'child' })] })
  const open = draw([group('web', [parent])], { expanded: new Set(['p']) })
  expect(detailBoxes(open.drawn.tree).flatMap(leaves).slice(-2)).toEqual(['turns:', 'first 1 · last 4'])
})

test('a footer key passes the surface of its press to the action; a press with no event names none', () => {
  const reg = new KeyRegistry()
  reg.add('a', [{ id: 'open', key: 'o', label: 'open', scope: 'row' }])
  const mine: RowRef = { id: 'w0', owner: 'a', group: 'web', can: {} }
  const { drawn, calls, surfaces } = draw([group('web', webRows(1))], {
    footer: footerKeys(reg, mine, () => false, false),
  })
  const key = buttonOf(drawn.tree, 'a.open')
  press(key, 'desktop')
  press(key)
  expect(calls).toEqual(['press:a.open', 'press:a.open'])
  expect(surfaces).toEqual(['desktop', undefined])
})
