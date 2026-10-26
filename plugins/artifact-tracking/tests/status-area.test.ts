// The adaptive status area (issue #138, PR 2). With 18 body rows or more the pane draws a summary row above the table, and the
// selected-row line and the health line in the footer Box, around the view line. Below 18 it draws today's bottom: the view line
// and the footer. This file pins the row budget for a short and a tall body: what each form leaves for the data rows, and that the
// tree is never taller than the body, so the footer keys stay in view (issue #109). Pure.
import { expect, test } from 'claude-code/testing'
import { KeyRegistry } from '../core/infra/keys'
import type { GroupSpec, StatusLine, TreeRow } from '../core/interfaces/view'
import { cellWidth } from '../ux/text/cell-width'
import { resetWidths } from '../ux/tree-data-table/columns'
import { helpModel } from '../ux/tree-data-table/help'
import {
  FULL_ROWS,
  STATUS_ROWS,
  type StatusForm,
  SUMMARY_ROWS,
  selectedLine,
  statusForm,
  statusLineBox,
  withSummary,
} from '../ux/tree-data-table/status'
import { TreeDataTable } from '../ux/tree-data-table/table'
import {
  footerOf,
  LIVE_VIEW_KEYS,
  leaves,
  NO_ROW_FOOTER,
  type Node,
  nodes,
  recorder,
  rowBoxes,
  texts,
  view,
  viewLineOf,
} from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { heightOf } from './fixtures/height'
import { group, row, webRows } from './fixtures/sections'

const SELECTED: StatusLine = {
  label: 'Selected:',
  cells: [{ text: '#142' }, { text: 'open', fg: 'success' }, { text: '✓ 3/3' }, { text: 'conflict', fg: 'error' }],
}
const HEALTH: StatusLine = {
  label: 'Health:',
  cells: [{ text: 'acli not installed' }, { text: 'gh ready' }, { text: '2 problems: h' }],
}
const STATUS = { selected: SELECTED, health: HEALTH }
const SUMMARY = 'Links 40 · Repos 1 (1 ✗)'

/** Three groups of ten one-line rows (ids `s0-w0` …), as the study of the issue drew them. */
const many = (count: number, rows: number): GroupSpec[] =>
  Array.from({ length: count }, (_, i) =>
    group(
      `s${i}`,
      webRows(rows).map(r => ({ ...r, id: `s${i}-${r.id}` })),
    ),
  )
/** The 16th row of three groups of ten: the selection sits in the middle of the list, so the hints show above and below. */
const MIDDLE = 's1-w5'

const LINE = { text: 'View: list', keys: LIVE_VIEW_KEYS }

/**
 * One drawing the way PaneSession makes it: the table takes the body less the summary row of the full form, and the summary
 * wraps it. `form` is the form the pane picks from the body; `body` is what the engine gives (`scroll.bodyRows`).
 */
function pane(
  body: {
    readonly columns: number
    readonly rows: number
    readonly placement: 'dock' | 'inline'
    /** The rows of the keys hint line above the table. */
    readonly hint?: number
    /** Draws the form that the body does not pick, to compare the two. */
    readonly form?: StatusForm
  },
  over: Parameters<typeof view>[0] = {},
  groups: readonly GroupSpec[] = many(3, 10),
) {
  resetWidths()
  const full = (body.form ?? statusForm(body.rows)) === 'full'
  const rec = recorder()
  const table = view({
    bodyColumns: body.columns,
    bodyRows: body.rows - (body.hint ?? 0) - (full ? SUMMARY_ROWS : 0),
    placement: body.placement,
    selected: MIDDLE,
    viewLine: LINE,
    ...(full ? { status: STATUS } : {}),
    ...over,
  })
  const drawn = TreeDataTable.render(groups, table, EL, rec.actions)
  const tree = full ? withSummary(EL, SUMMARY, body.columns, drawn.tree) : drawn.tree
  return { drawn, tree, full, height: heightOf(tree, body.columns) + (body.hint ?? 0), rows: rowBoxes(tree).length }
}

const INLINE_11 = { columns: 96, rows: 11, placement: 'inline' } as const
const INLINE_17 = { columns: 96, rows: 17, placement: 'inline' } as const
const INLINE_18 = { columns: 96, rows: 18, placement: 'inline' } as const
const DOCK_31 = { columns: 49, rows: 31, placement: 'dock' } as const
const DOCK_12 = { columns: 49, rows: 12, placement: 'dock' } as const

test('statusForm: the engine body of 18 rows or more is the full form, below it or with no height the compact form', () => {
  expect(FULL_ROWS).toBe(18)
  expect(STATUS_ROWS).toBe(2)
  expect(SUMMARY_ROWS).toBe(1)
  expect(statusForm(undefined)).toBe('compact')
  expect(statusForm(0)).toBe('compact')
  expect(statusForm(12)).toBe('compact')
  expect(statusForm(17)).toBe('compact')
  expect(statusForm(18)).toBe('full')
  expect(statusForm(31)).toBe('full')
  expect(statusForm(60)).toBe('full')
})

test('selectedLine with no row says No row selected, dim, with no label: the line always takes its row', () => {
  expect(selectedLine(undefined)).toEqual({ label: '', cells: [{ text: 'No row selected', dim: true }] })
})

test('selectedLine names the row: the name cell, the status in its color, the badges and the strongest reason, last and dim', () => {
  const pr: TreeRow = row(
    'pr',
    { name: '#142', description: 'Fix the login', status: { text: 'open', fg: 'success' }, type: 'PR' },
    {
      extras: [
        { text: '✓ 3/3', fg: 'success' },
        { text: 'conflict', fg: 'error' },
      ],
      reasons: { first: 'created', all: ['created', 'discovered'], strongest: 'created' },
    },
  )
  expect(selectedLine(pr)).toEqual({
    label: 'Selected:',
    cells: [
      { text: '#142' },
      { text: 'open', fg: 'success' },
      { text: '✓ 3/3', fg: 'success' },
      { text: 'conflict', fg: 'error' },
      { text: 'created', dim: true },
    ],
  })
})

test('selectedLine leaves out what a row lacks: no status, no badge, no reason; a row with no name falls to its title', () => {
  expect(selectedLine(row('a', { name: 'one.example' })).cells).toEqual([{ text: 'one.example' }])
  expect(selectedLine(row('a', { name: '', description: 'https://one.example/' })).cells).toEqual([
    { text: 'https://one.example/' },
  ])
  expect(selectedLine(row('a', { name: 'x', status: { text: '' } })).cells).toEqual([{ text: 'x' }])
})

test('statusLineBox takes one row at every width, however long the cells and however many: it cuts cell by cell', () => {
  const long: StatusLine = {
    label: 'Selected:',
    cells: [
      { text: 'a-very-long-branch-name/that-goes-on-and-on-and-on-and-on' },
      { text: 'open', fg: 'success' },
      ...Array.from({ length: 8 }, (_, i) => ({ text: `badge-${i}` })),
      { text: 'created', dim: true },
    ],
  }
  for (const columns of [96, 49, 40, 24, 12]) {
    const node = statusLineBox(EL, long, columns)
    expect(heightOf(node, columns), String(columns)).toBe(1)
    const total = nodes(node, 'Text').reduce((sum, t) => sum + cellWidth(t.children.map(String).join('')), 0)
    // The Texts and the one cell between two of them (`columnGap: 1`) stay inside the width.
    expect(total + nodes(node, 'Text').length - 1, String(columns)).toBeLessThanOrEqual(columns)
  }
})

test('statusLineBox draws every cell that fits whole, with a dim dot between two cells and none after the label', () => {
  const node = statusLineBox(EL, SELECTED, 96)
  expect(texts(node).map(([, s]) => s)).toEqual(['Selected:', '#142', '·', 'open', '·', '✓ 3/3', '·', 'conflict'])
  const [labelProps, , dotProps, openProps] = texts(node).map(([p]) => p)
  expect(labelProps?.dimColor).toBe(true)
  expect(dotProps?.dimColor).toBe(true)
  expect(openProps?.color).toBeDefined() // the success color of the cell
})

test('statusLineBox leaves out the cells that do not fit, with no dot left dangling', () => {
  // At 22 cells the label takes 9, `#142` brings it to 14, `open` to 21, and `✓ 3/3` needs 3 more than the room: no cut, no cell.
  const node = statusLineBox(EL, SELECTED, 22)
  const words = texts(node).map(([, s]) => s)
  expect(words).toEqual(['Selected:', '#142', '·', 'open'])
  expect(heightOf(node, 22)).toBe(1)
})

test('statusLineBox cuts the first cell that does not fit to the room that is left, and draws nothing after it', () => {
  // At 27 cells the room for `✓ 3/3` is 3: it is cut to `✓ …`, and `conflict` is left out.
  const words = texts(statusLineBox(EL, SELECTED, 27)).map(([, s]) => s)
  expect(words).toEqual(['Selected:', '#142', '·', 'open', '·', '✓ …'])
})

test('statusLineBox measures wide characters in cells: a long CJK name keeps the line inside 24 cells', () => {
  const name = '日本語のとても長い名前'.repeat(2)
  const node = statusLineBox(EL, { label: 'Selected:', cells: [{ text: name }, { text: 'open' }] }, 24)
  const total = nodes(node, 'Text').reduce((sum, t) => sum + cellWidth(t.children.map(String).join('')), 0)
  expect(total + nodes(node, 'Text').length - 1).toBeLessThanOrEqual(24)
  const words = texts(node).map(([, s]) => s)
  expect(words[1]?.endsWith('…')).toBe(true) // the name is cut, in cells, not in characters
  expect(words).not.toContain('open') // nothing is drawn after the cut cell
})

// The tail of a line keeps its room (issue #138, review m4): the health line puts the problem count there, and a narrow pane must
// cut a tool note and never the count.
const TAILED: StatusLine = {
  label: 'Health:',
  cells: [{ text: 'acli not installed' }, { text: 'gh not logged in' }],
  tail: { text: '2 problems: h', fg: 'warning' },
}

test('statusLineBox keeps the room of the tail: at 49 cells the tool notes are cut and the problem count is drawn whole', () => {
  const node = statusLineBox(EL, TAILED, 49)
  expect(texts(node).map(([, s]) => s)).toEqual(['Health:', 'acli not installed', '·', 'gh …', '·', '2 problems: h'])
  const total = nodes(node, 'Text').reduce((sum, t) => sum + cellWidth(t.children.map(String).join('')), 0)
  expect(total + nodes(node, 'Text').length - 1).toBe(49) // the line fills the row and goes no further
  expect(heightOf(node, 49)).toBe(1)
})

test('statusLineBox draws the tail after the cells with a dim dot, and alone after the label when no cell fits', () => {
  expect(texts(statusLineBox(EL, TAILED, 96)).map(([, s]) => s)).toEqual([
    'Health:',
    'acli not installed',
    '·',
    'gh not logged in',
    '·',
    '2 problems: h',
  ])
  // At 24 cells the tail needs 16 with its dot, so no tool note has room: label, one gap, the count.
  expect(texts(statusLineBox(EL, TAILED, 24)).map(([, s]) => s)).toEqual(['Health:', '2 problems: h'])
})

test('statusLineBox cuts the tail itself only when it does not fit even alone', () => {
  const words = texts(statusLineBox(EL, TAILED, 12)).map(([, s]) => s)
  expect(words[0]).toBe('Health:')
  expect(words.at(-1)?.endsWith('…')).toBe(true)
  expect(words).not.toContain('acli not installed')
  expect(heightOf(statusLineBox(EL, TAILED, 12), 12)).toBe(1)
})

test('statusLineBox with a tail and no label or cells draws the tail alone', () => {
  const words = texts(statusLineBox(EL, { label: '', cells: [], tail: { text: 'no problems', dim: true } }, 40))
  expect(words.map(([, s]) => s)).toEqual(['no problems'])
})

test('statusLineBox of a line with no label starts at the first cell, and a cell with an empty text is skipped', () => {
  const node = statusLineBox(EL, { label: '', cells: [{ text: 'No row selected', dim: true }, { text: '' }] }, 40)
  expect(texts(node)).toEqual([[expect.objectContaining({ dimColor: true }), 'No row selected']])
})

test('statusLineBox draws a cell with a link as a Link, so a click on the name still opens it', () => {
  const node = statusLineBox(
    EL,
    { label: 'Selected:', cells: [{ text: '#142', href: 'https://example.test/142' }] },
    60,
  )
  expect(nodes(node, 'Link')).toHaveLength(1)
})

test('withSummary puts one dim row above the tree and clips a long summary to the width', () => {
  const tree = withSummary(EL, 'x'.repeat(200), 40, {
    type: 'Box',
    props: {},
    children: [],
  } as never) as unknown as Node
  expect(tree.props.flexDirection).toBe('column')
  expect(heightOf(tree, 40)).toBe(1) // the empty tree has no row of its own
  const [props, line] = texts(tree)[0] as [Node['props'], string]
  expect(props.dimColor).not.toBe(true) // the summary is the band's words: plain, as the band draws them
  expect(cellWidth(line)).toBeLessThanOrEqual(40)
})

test('withSummary with no counts draws a dim placeholder, so the form takes its row all the same', () => {
  const tree = withSummary(EL, null, 96, { type: 'Box', props: {}, children: [] } as never)
  const [props, line] = texts(tree)[0] as [Node['props'], string]
  expect(props.dimColor).toBe(true)
  expect(line).toBe('No counts yet')
  expect(heightOf(tree, 96)).toBe(1)
})

// ---- the row budget ---------------------------------------------------------------------------------------------------------

test('compact, inline 96x11: the bottom of today, 4 data rows, and the footer is the last child', () => {
  const p = pane(INLINE_11)
  expect(p.full).toBe(false)
  expect(p.rows).toBe(4)
  expect(p.height).toBe(11)
  expect(footerOf((p.drawn.tree as unknown as Node).children.at(-1)).length).toBe(NO_ROW_FOOTER.length)
})

test('compact, inline 96x10 with the keys hint above the table: 3 data rows, the tree and the hint fill the body', () => {
  const p = pane({ ...INLINE_11, rows: 10 })
  expect(p.rows).toBe(3)
  expect(p.height).toBe(10)
})

test('compact, inline 96x17: 8 data rows, and no status line is drawn', () => {
  const p = pane(INLINE_17)
  expect(p.full).toBe(false)
  expect(p.rows).toBe(8)
  expect(p.height).toBe(17)
  expect(texts(p.tree).some(([, s]) => s === 'Selected:' || s === 'Health:')).toBe(false)
})

test('full, inline 96x18: the summary, the selected-row line and the health line take 3 rows, 8 data rows are left', () => {
  const p = pane(INLINE_18)
  expect(p.full).toBe(true)
  expect(p.rows).toBe(8)
  expect(p.height).toBe(18) // the tree is as tall as the body: the engine has nothing to scroll
  const words = texts(p.tree).map(([, s]) => s)
  expect(words).toContain(SUMMARY)
  expect(words).toContain('Selected:')
  expect(words).toContain('Health:')
})

test('the two status lines come off the window budget: a body of 17 rows with them draws what a body of 15 draws without', () => {
  resetWidths()
  const table = view({ bodyColumns: 96, bodyRows: 17, placement: 'inline', selected: MIDDLE, viewLine: LINE })
  const lined = TreeDataTable.render(many(3, 10), { ...table, status: STATUS }, EL, recorder().actions)
  resetWidths()
  const bare = TreeDataTable.render(many(3, 10), { ...table, bodyRows: 17 - STATUS_ROWS }, EL, recorder().actions)
  expect(rowBoxes(lined.tree).length).toBe(rowBoxes(bare.tree).length)
  expect(lined.top).toBe(bare.top)
  expect(lined.page).toBe(bare.page)
  expect(heightOf(lined.tree, 96)).toBe(17)
})

test('full, inline 96x18 with the keys hint: 7 data rows, and the hint, the summary and the table fill the body', () => {
  const p = pane({ ...INLINE_18, hint: 1 })
  expect(p.full).toBe(true) // the form follows the engine body, before the hint line takes its row
  expect(p.rows).toBe(7)
  expect(p.height).toBe(18)
})

test('full, docked 49x31 (the 120x37 terminal): 18 data rows where the compact form left 20, and the tree is the body', () => {
  const p = pane(DOCK_31)
  expect(p.full).toBe(true)
  expect(p.rows).toBe(18)
  expect(p.height).toBe(31)
  const compact = pane({ ...DOCK_31, form: 'compact' })
  expect(compact.rows).toBe(20)
  expect(compact.height).toBe(31)
})

test('full, docked 49x31 with the keys hint (two rows at 49 cells): 16 data rows, and the hint, the summary and the table fill the body', () => {
  const p = pane({ ...DOCK_31, hint: 2 })
  expect(p.full).toBe(true)
  expect(p.rows).toBe(16)
  expect(p.height).toBe(31)
})

test('full, docked 49x31: the footer Box holds the selected-row line, the view line, the health line and the keys, in that order', () => {
  const p = pane(DOCK_31)
  const root = p.drawn.tree as unknown as Node
  const pin = root.children.at(-1) as Node
  expect(pin.props).toMatchObject({ flexGrow: 1, flexShrink: 0, justifyContent: 'flex-end' })
  const footer = pin.children[0] as Node
  expect(footer.props.flexDirection).toBe('column')
  const kinds = footer.children.map(c => {
    const node = c as Node
    if (nodes(node, 'Button').some(b => b.props.key === 'view')) return 'view'
    if (nodes(node, 'Button').length > 0) return 'keys'
    return texts(node)[0]?.[1]
  })
  expect(kinds).toEqual(['Selected:', 'view', 'Health:', 'keys'])
  expect(viewLineOf(p.tree).length).toBe(LIVE_VIEW_KEYS.length)
  expect(footerOf(p.tree)).toHaveLength(NO_ROW_FOOTER.length) // one footer, not a copy
})

test('full, docked 49x31: the summary row is the first line of the tree, above the header of the table', () => {
  const p = pane(DOCK_31)
  const first = texts(p.tree)[0]
  expect(first?.[1]).toBe(SUMMARY)
})

test('a 12-row docked body stays compact: the full form would leave it 1 data row, and a tree taller than the body', () => {
  const p = pane(DOCK_12)
  expect(p.full).toBe(false)
  expect(p.rows).toBe(3)
  expect(p.height).toBe(12)
  const forced = pane({ ...DOCK_12, form: 'full' })
  expect(forced.rows).toBe(1)
  expect(forced.height).toBeGreaterThan(12)
})

test('a tall inline body (100x60: 18 body rows) draws the full form and is exactly as tall as the body', () => {
  const p = pane({ columns: 96, rows: 18, placement: 'inline' }, {}, many(1, 12))
  expect(p.full).toBe(true)
  expect(p.height).toBe(18)
})

test('at 40 cells the full form keeps every line to its rows: 18 data rows docked, and the tree is the body', () => {
  const dock = pane({ columns: 40, rows: 31, placement: 'dock' })
  expect(dock.full).toBe(true)
  expect(dock.rows).toBe(18)
  expect(dock.height).toBe(31)
  const inline = pane({ columns: 40, rows: 31, placement: 'inline' })
  expect(inline.height).toBeLessThanOrEqual(31)
  expect(inline.rows).toBeGreaterThan(0)
})

test('the window follows the selected row with the status lines in the budget: the body is full whatever the selection', () => {
  // The first and the last row show one hint, a row in the middle shows two: the hint takes the row of a data row.
  const rows = { 's0-w0': 9, 's1-w5': 8, 's2-w9': 9 }
  for (const [selected, count] of Object.entries(rows)) {
    const p = pane(INLINE_18, { selected })
    expect(p.rows, selected).toBe(count)
    expect(p.height, selected).toBe(18)
    // The selected row is drawn in the window: its row Box starts with the `>` gutter.
    expect(
      rowBoxes(p.tree).some(b => leaves(b.children[0]).includes('>')),
      selected,
    ).toBe(true)
  }
})

test('a docked pane with fewer rows than the body holds still pins the footer to the last row, with the status lines above it', () => {
  const p = pane(DOCK_31, {}, many(1, 3))
  expect(p.height).toBe(31)
  const root = p.drawn.tree as unknown as Node
  expect(root.props.minHeight).toBe(DOCK_31.rows - SUMMARY_ROWS) // the body less the summary row
})

test('the help view draws no status area, whatever the view carries', () => {
  resetWidths()
  const help = helpModel(new KeyRegistry().all(), [], undefined, [])
  const drawn = TreeDataTable.render(
    [],
    view({ bodyColumns: 96, bodyRows: 31, placement: 'dock', help, status: STATUS }),
    EL,
    recorder().actions,
  )
  expect(texts(drawn.tree).some(([, s]) => s === 'Selected:' || s === 'Health:')).toBe(false)
})

test('a view with a status area and no view line still draws the two status lines above and below the keys', () => {
  resetWidths()
  const drawn = TreeDataTable.render(
    many(1, 3),
    view({ bodyColumns: 96, bodyRows: 30, placement: 'dock', selected: 's0-w0', status: STATUS }),
    EL,
    recorder().actions,
  )
  const words = texts(drawn.tree).map(([, s]) => s)
  expect(words).toContain('Selected:')
  expect(words).toContain('Health:')
  expect(heightOf(drawn.tree, 96)).toBe(30)
})

test('two empty status lines never make the tree taller than the body', () => {
  const empty: StatusLine = { label: '', cells: [] }
  resetWidths()
  const withLines = TreeDataTable.render(
    many(3, 10),
    view({
      bodyColumns: 96,
      bodyRows: 17,
      placement: 'inline',
      selected: MIDDLE,
      viewLine: LINE,
      status: { selected: empty, health: empty },
    }),
    EL,
    recorder().actions,
  )
  // An empty line is an empty Box: it takes no row, though the window left two for it. The tree is never taller than the body.
  expect(heightOf(withLines.tree, 96)).toBeLessThanOrEqual(17)
})
