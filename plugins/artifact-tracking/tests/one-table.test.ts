// The pane as one table (issue #63, L1): one header for every group, a title line with the counts of its group, the badges
// of the extras column, and the budget of the window with a header that is not part of any group. Pure.
import { expect, test } from 'claude-code/testing'
import type { Cell } from '../core/interfaces/view'
import { cellWidth } from '../ux/text/cell-width'
import { resetWidths } from '../ux/tree-data-table/columns'
import { footerRows } from '../ux/tree-data-table/footer'
import { TreeDataTable } from '../ux/tree-data-table/table'
import { NO_ROW_FOOTER, type Node, nodes, recorder, rowBoxes, texts, view } from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { group, row, webRows } from './fixtures/sections'

const draw = (groups: Parameters<typeof TreeDataTable.render>[0], over: Parameters<typeof view>[0] = {}) => {
  resetWidths()
  const rec = recorder()
  return { ...rec, drawn: TreeDataTable.render(groups, view(over), EL, rec.actions) }
}

/** The header Boxes: the first child is a blank Text, and no Button sits inside. */
const headerBoxes = (tree: unknown): Node[] =>
  nodes(tree, 'Box').filter(b => {
    const first = b.children[0]
    return (
      typeof first === 'object' &&
      first !== null &&
      (first as Node).type === 'Text' &&
      (first as Node).children[0] === ' ' &&
      nodes(b, 'Button').length === 0
    )
  })

/** The bold texts, in drawing order. */
const bold = (tree: unknown): string[] =>
  texts(tree)
    .filter(([p]) => p.weight === 'bold')
    .map(([, s]) => s)

// ---------------------------------------------------------------- one header

test('three groups draw one header row, above the first title, and no group draws its own', () => {
  const { drawn } = draw([
    group('a', webRows(2), { title: 'Alpha' }),
    group('b', webRows(1), { title: 'Beta' }),
    group('c', webRows(3), { title: 'Gamma' }),
  ])
  expect(headerBoxes(drawn.tree)).toHaveLength(1)
  expect(bold(drawn.tree)).toEqual(['Name', 'Description', 'Alpha', 'Beta', 'Gamma'])
})

test('the header holds the words of the shared columns, and the columns no row fills have none', () => {
  const full = row('r', {
    control: '▲',
    name: 'n',
    description: 'd',
    type: 'T',
    status: 'S',
  })
  const { drawn } = draw([group('a', [{ ...full, extras: [{ text: 'x' }] }])])
  expect(bold(drawn.tree)).toEqual(['Name', 'Description', 'Type', 'Status', 'a'])
  const bare = draw([group('a', [row('r', { name: 'n', description: 'd' })])]).drawn
  expect(bold(bare.tree)).toEqual(['Name', 'Description', 'a'])
})

test('a pane with no row to draw has no header: only the titles and their texts', () => {
  const { drawn } = draw([group('a', [], { title: 'Alpha', empty: 'Nothing yet.' }), group('b', [], { title: 'Beta' })])
  expect(headerBoxes(drawn.tree)).toHaveLength(0)
  expect(bold(drawn.tree)).toEqual(['Alpha', 'Beta'])
})

test('the header columns are as wide as the columns of the rows, so the words stand over their cells', () => {
  const { drawn } = draw([group('a', webRows(1)), group('b', [row('x', { name: 'a-longer-name-than-the-web-rows' })])])
  const head = headerBoxes(drawn.tree)[0] as Node
  const [first] = rowBoxes(drawn.tree)
  const widths = (b: Node) => (b.children.slice(1) as Node[]).map(c => c.props.width)
  expect(widths(head)).toEqual(widths(first as Node))
})

// ---------------------------------------------------------------- the title of a group

test('a group title is the title, its count and, when some failed, the failing count in the error color', () => {
  const { drawn } = draw([
    group('prs', webRows(7), { title: 'Pull requests', failing: 2, note: { text: 'gh · ok' } }),
    group('web', webRows(1), { title: 'Web links' }),
  ])
  const shown = texts(drawn.tree).map(([, s]) => s)
  const at = shown.indexOf('Pull requests')
  expect(shown.slice(at, at + 4)).toEqual(['Pull requests', '7', '(2 failed)', 'gh · ok'])
  const web = shown.indexOf('Web links')
  expect(shown.slice(web, web + 2)).toEqual(['Web links', '1']) // no failing count, no note
  expect(texts(drawn.tree).find(([, s]) => s === '(2 failed)')?.[0]).toMatchObject({ color: 'error' })
  expect(shown.filter(s => s.includes('failed'))).toEqual(['(2 failed)'])
})

test('a group with no failing row says no failed count, and a group with no row says 0', () => {
  const { drawn } = draw([group('a', [], { title: 'Alpha', empty: 'gh not logged in' })])
  expect(bold(drawn.tree)).toEqual(['Alpha'])
  expect(texts(drawn.tree).map(([, s]) => s)).toContain('0')
  expect(texts(drawn.tree).map(([, s]) => s)).toContain('gh not logged in')
  expect(texts(drawn.tree).some(([, s]) => s.includes('failed'))).toBe(false)
})

test('the count is the top-level rows of the group, whatever the caps drew', () => {
  const rows = webRows(5)
  const { drawn } = draw([group('a', rows, { title: 'Alpha' })], { limits: { sectionRows: 2, maxRows: 300 } })
  expect(rowBoxes(drawn.tree)).toHaveLength(2)
  expect(texts(drawn.tree).map(([, s]) => s)).toContain('5')
})

test('the note is clipped to what the title, the count and the failing count leave of the width', () => {
  const note: Cell = { text: 'n'.repeat(200) }
  const { drawn } = draw([group('a', webRows(1), { title: 'Alpha', failing: 3, note })], { bodyColumns: 40 })
  const shown = texts(drawn.tree).filter(([p]) => p.dimColor === true)[0]?.[1] ?? ''
  // `Alpha 1 (3 failed) ` takes 19 cells.
  expect(cellWidth(shown)).toBe(40 - cellWidth('Alpha') - 1 - 1 - 1 - cellWidth('(3 failed)') - 1)
  expect(shown.endsWith('…')).toBe(true)
})

// ---------------------------------------------------------------- the badges of the extras column

const badged = (id: string, extras: readonly Cell[]) =>
  row(id, { control: '', name: id, description: `${id} title` }, { extras })

/** The Box of the extras cell of a row Box: the last cell, after the gutter and the other columns. */
const extrasBox = (r: Node): Node => r.children[r.children.length - 1] as Node

test('the badges of a row are one Text each, in the color of their token, in one cell with a space between', () => {
  const { drawn } = draw([
    group('a', [
      badged('one', [
        { text: '✗ ci', fg: 'error' },
        { text: '✓ ok', fg: 'success' },
        { text: 'dim', dim: true },
      ]),
    ]),
  ])
  const [r] = rowBoxes(drawn.tree)
  const cell = extrasBox(r as Node)
  expect(cell.props).toMatchObject({ flexShrink: 0, columnGap: 1 })
  expect(texts(cell)).toEqual([
    [{ wrap: 'truncate-end', color: 'error' }, '✗ ci'],
    [{ wrap: 'truncate-end', color: 'success' }, '✓ ok'],
    [{ wrap: 'truncate-end', dimColor: true }, 'dim'],
  ])
})

test('a badge is no Button: it takes no Tab stop', () => {
  const { drawn } = draw([group('a', [badged('one', [{ text: '✓ checks' }, { text: 'x' }])])])
  const [r] = rowBoxes(drawn.tree)
  expect(nodes(extrasBox(r as Node), 'Button')).toHaveLength(0)
  expect(nodes(r, 'Button')).toHaveLength(1) // the glyph of the tree column alone
})

test('the badges are clipped to the column: a whole badge while it fits, the first that does not is cut, the rest are left out', () => {
  const { drawn } = draw([
    group('a', [badged('one', [{ text: '✗ conflicts' }, { text: '✗ checks' }, { text: 'no worktree' }])]),
  ])
  const [r] = rowBoxes(drawn.tree)
  const cell = extrasBox(r as Node)
  expect(cell.props.width).toBe(14)
  expect(texts(cell).map(([, s]) => s)).toEqual(['✗ conflicts', '✗…'])
})

test('a row with no badge has an empty extras cell as wide as the column, and a badge with no text is left out', () => {
  const { drawn } = draw([
    group('a', [
      badged('one', [{ text: '✓ checks' }]),
      badged('two', []),
      badged('three', [{ text: '' }, { text: 'x' }]),
    ]),
  ])
  const [one, two, three] = rowBoxes(drawn.tree)
  expect(extrasBox(two as Node).props.width).toBe(extrasBox(one as Node).props.width)
  expect(texts(extrasBox(two as Node))).toEqual([])
  expect(texts(extrasBox(three as Node)).map(([, s]) => s)).toEqual(['x'])
})

test('the extras column drops in a narrow pane and the row keeps its name, description and status', () => {
  const rec = row('r', { name: 'n', description: 'd', type: 'T', status: 'S' }, { extras: [{ text: '✓ checks' }] })
  const wide = draw([group('a', [rec])], { bodyColumns: 96 }).drawn
  expect(texts(extrasBox(rowBoxes(wide.tree)[0] as Node)).map(([, s]) => s)).toEqual(['✓ checks'])
  const narrow = draw([group('a', [rec])], { bodyColumns: 30 }).drawn
  expect(texts(narrow.tree).map(([, s]) => s)).not.toContain('✓ checks')
  expect(texts(narrow.tree).map(([, s]) => s)).toEqual(expect.arrayContaining(['n', 'd', 'S']))
})

// ---------------------------------------------------------------- the window: the header counts once

const lines = (n: number) => webRows(n)

/** The rows of the body the tree takes at `bodyRows`: the header, the titles and the rows drawn in full, and the footer. */
const bodyOf = (groupsCount: number, bodyRows: number) => {
  const groups = Array.from({ length: groupsCount }, (_, i) => group(`g${i}`, lines(40), { title: `G${i}` }))
  const { drawn } = draw(groups, { bodyRows, bodyColumns: 96 })
  return drawn
}

test('a body of 11 rows keeps the header, one title, the rows that fit, a hint and the footer', () => {
  const drawn = bodyOf(1, 11)
  const footer = footerRows(NO_ROW_FOOTER, 96, false)
  // header 1 + title 1 + rows + hint below 1 + gap 1 + footer
  const rows = 11 - 1 - 1 - 1 - 1 - footer
  expect(rowBoxes(drawn.tree)).toHaveLength(rows)
  expect(headerBoxes(drawn.tree)).toHaveLength(1)
  expect(bold(drawn.tree)).toEqual(['Name', 'Description', 'G0'])
  expect(drawn.page).toBe(rows)
})

// The live check of issue #63, L1 measured the docked pane of a 120-column terminal at 49 cells. The window tests of
// #109 (`DOCKED` in table-window, table-pin and pane) use 95 cells, so this test holds the real width with several groups.
test('docked at 49 cells with a worktree, many conflicted PRs and a process: one header with no Type, no badge, the footer in view', () => {
  const DOCKED_49 = { bodyColumns: 49, bodyRows: 31, placement: 'dock' } as const
  const worktrees = group(
    'list:worktrees',
    [
      row(
        'wt:root',
        { name: 'claude-code-mod-tracking', description: 'feat/one-table' },
        { expandedByDefault: true, children: [row('wt:demo', { name: 'demo-wt', description: 'worktree-demo-wt' })] },
      ),
    ],
    { title: 'Worktrees', count: 2 },
  )
  const prs = Array.from({ length: 40 }, (_, i) =>
    row(
      `pr${i}`,
      { control: '', name: `#${i}`, description: 'Draw the fake PR', type: 'kind-of-pr', status: 'open' },
      {
        extras: [
          { text: '✗ conflicts', fg: 'error' },
          { text: '✓ checks', fg: 'success' },
        ],
      },
    ),
  )
  const processes = group('list:processes', [
    row('bg', { name: 'bg', description: 'sleep 900', type: 'background task', status: 'running' }),
  ])
  const { drawn } = draw(
    [worktrees, group('list:prs', prs, { title: 'Pull requests', failing: 40 }), processes],
    DOCKED_49,
  )
  const shown = texts(drawn.tree).map(([, s]) => s)
  // One header, and the type and the extras are gone: the row has no type cell, no badge, and the header no `Type`.
  expect(headerBoxes(drawn.tree)).toHaveLength(1)
  // The long worktree name takes the room, so the description is at its minimum of 10 cells: its header reads `Descripti…`.
  expect(bold(drawn.tree).slice(0, 3)).toEqual(['Name', 'Descripti…', 'Status'])
  expect(shown).not.toContain('Type')
  expect(shown).not.toContain('kind-of-pr')
  expect(shown.some(s => s.includes('conflicts') || s.includes('checks'))).toBe(false)
  expect(shown).toContain('open')
  // The footer sits on the last rows and the tree is as tall as the body: header 1, Worktrees (title 1, 2 rows), a gap,
  // Pull requests (title 1, the rows that fit), the hint below, the gap above the footer and the footer.
  const footer = footerRows(NO_ROW_FOOTER, DOCKED_49.bodyColumns, false)
  const prRows = DOCKED_49.bodyRows - (1 + 1 + 2 + 1 + 1 + 1 + 1 + footer)
  expect(rowBoxes(drawn.tree)).toHaveLength(2 + prRows)
  expect((drawn.tree as Node).props.minHeight).toBe(DOCKED_49.bodyRows)
  expect(((drawn.tree as Node).children.at(-1) as Node).props).toMatchObject({
    flexGrow: 1,
    justifyContent: 'flex-end',
  })
  expect(shown).toContain(`▼ ${40 - prRows + 1} more below`) // the rows of the PRs and the process out of view
})

test('with two groups the header costs one row in all, each title one row and the gap between them one', () => {
  const groups = [group('a', lines(3), { title: 'A' }), group('b', lines(3), { title: 'B' })]
  const { drawn } = draw(groups, { bodyRows: 9, bodyColumns: 96 })
  // budget: 9 less the footer, the gap above it and the header = 6. Group A takes a title, 3 rows and a hint below.
  expect(drawn.page).toBe(3)
  expect(rowBoxes(drawn.tree)).toHaveLength(3)
  expect(bold(drawn.tree)).toEqual(['Name', 'Description', 'A'])
})
