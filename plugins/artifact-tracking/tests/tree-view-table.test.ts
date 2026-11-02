// The tree view (issue #256): each section is a group row of the one table, at depth 0, that folds. Layout, drawing, window, selection,
// keys and text of the group row, on the pure table. The kit tests of the fold, the band press and the view switch are at the end
// of tests/pane-session.test.ts and tests/pane-turn.test.ts. Pure.
import { expect, test } from 'claude-code/testing'
import { footerKeys, KeyRegistry, route } from '../core/infra/keys'
import type { GroupSpec, SectionSpec } from '../core/interfaces/view'
import { isListLike, listGroups, viewGroups, viewSummary } from '../core/lib/grouping'
import { resetWidths } from '../ux/tree-data-table/columns'
import {
  findRow,
  findTreeRow,
  handleOf,
  laidRefs,
  layout,
  shownSelection,
  survivorOf,
  TreeDataTable,
} from '../ux/tree-data-table/table'
import { groupsText } from '../ux/tree-data-table/text'
import { buttonOf, handlesOf, leaves, nodes, press, recorder, rowBoxes, texts, view } from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { heightOf } from './fixtures/height'
import { row, section, webRows } from './fixtures/sections'

const OFF = { touchedOnly: false }
const INLINE = { bodyColumns: 96, bodyRows: 11 }
const DOCKED_49 = { bodyColumns: 49, bodyRows: 31 }
const DOCKED_40 = { bodyColumns: 40, bodyRows: 31 }

const failed = (id: string) =>
  row(
    id,
    { name: id, description: id, status: { text: 'failed', fg: 'error' } },
    {
      facets: { status: { label: 'failed', token: 'failed' } },
    },
  )

/** The groups of the tree view over these sections. */
const tree = (sections: readonly SectionSpec[]): readonly GroupSpec[] => viewGroups(sections, 'tree', OFF).groups
const list = (sections: readonly SectionSpec[]): readonly GroupSpec[] => viewGroups(sections, 'list', OFF).groups

const two = (): readonly SectionSpec[] => [
  section('prs', [row('p1', { name: '#1', description: 'one' }), failed('p2')], {
    title: 'Pull requests',
    note: { text: 'gh · ok' },
  }),
  section('files', [row('f1', { name: 'README.md', description: 'edit' })], { title: 'Files' }),
]

const folded = (...ids: string[]) => view({ expanded: new Set(ids) })
const draw = (groups: readonly GroupSpec[], over: Parameters<typeof view>[0] = {}) => {
  resetWidths()
  const rec = recorder()
  return { ...rec, drawn: TreeDataTable.render(groups, view(over), EL, rec.actions) }
}

// ---------------------------------------------------------------- the view and its groups

test('the tree view has the groups of the list view: same sections, order, rows and counts; ids tree:<section>, foldable, with a key', () => {
  const sections = two()
  const a = list(sections)
  const b = tree(sections)
  expect(b.map(g => g.id)).toEqual(['tree:prs', 'tree:files'])
  expect(b.map(g => g.key)).toEqual(['prs', 'files'])
  expect(b.every(g => g.foldable === true)).toBe(true)
  expect(a.every(g => g.foldable === undefined)).toBe(true)
  expect(b.map(({ id: _i, foldable: _f, ...rest }) => rest)).toEqual(a.map(({ id: _i, ...rest }) => rest))
})

test('the Pinned group comes first in the tree view and folds like any group: tree:pinned', () => {
  const pinned = row('p', { name: 'p' }, { facets: { level: { level: 'top' } } })
  const groups = tree([section('prs', [pinned, row('q', { name: 'q' })])])
  expect(groups.map(g => g.id)).toEqual(['tree:pinned', 'tree:prs'])
  expect(groups[0]?.foldable).toBe(true)
  expect(groups[0]?.key).toBe('pinned')
})

test('the tree view is list-like: no ended count on its view line, and the list groups keep their ids', () => {
  expect(isListLike('tree')).toBe(true)
  expect(isListLike('list')).toBe(true)
  expect(isListLike('flat')).toBe(false)
  expect(viewSummary({ view: 'tree', touchedOnly: false, showAll: false, hidden: 0, ended: 3 })).toBe('View: tree')
  expect(viewSummary({ view: 'flat', touchedOnly: false, showAll: false, hidden: 0, ended: 3 })).toBe(
    'View: flat · 3 ended hidden',
  )
  expect(listGroups(two().slice(0, 1))[0]?.id).toBe('list:prs')
  expect(listGroups(two().slice(0, 1), 'tree')[0]?.id).toBe('tree:prs')
})

test('the /track text of the tree view is the text of the list view', () => {
  const sections = two()
  expect(groupsText(tree(sections))).toBe(groupsText(list(sections)))
})

// ---------------------------------------------------------------- the layout

test('a group row gets its handle before the handles of its rows, at depth 0; its rows are at depth 1', () => {
  const laid = layout(tree(two()), view())
  expect(laid.map(g => [g.head?.handle, g.head?.depth, g.rows.map(r => [r.handle, r.depth])])).toEqual([
    [
      'r0',
      0,
      [
        ['r1', 1],
        ['r2', 1],
      ],
    ],
    ['r3', 0, [['r4', 1]]],
  ])
  expect(laid[0]?.head?.open).toBe(true)
  // The list view has no group row, and its rows stay at depth 0.
  expect(layout(list(two()), view()).map(g => [g.head, g.rows.map(r => r.depth)])).toEqual([
    [undefined, [0, 0]],
    [undefined, [0]],
  ])
})

test('a folded group keeps its group row and takes no row, no "N more" row and nothing of maxRows', () => {
  const groups = tree([
    section('a', webRows(5)),
    section(
      'b',
      webRows(5).map(r => ({ ...r, id: `b${r.id}` })),
    ),
  ])
  const v = view({ expanded: new Set(['tree:a']), limits: { sectionRows: 3, maxRows: 4 } })
  const laid = layout(groups, v)
  expect(laid[0]?.rows).toEqual([])
  expect(laid[0]?.more).toBe(0)
  expect(laid[0]?.head?.open).toBe(false)
  expect(laid[1]?.rows).toHaveLength(3) // the fold left the whole total to the next group
  expect(laid[1]?.more).toBe(2)
})

test('a group with no row has a group row with no handle: nothing to fold', () => {
  const [g] = layout(tree([section('none', [], { empty: 'nothing here' })]), view())
  expect(g?.head?.handle).toBe('')
  expect(handleOf(tree([section('none', [])]), view(), 'tree:none')).toBeUndefined()
})

test('handleOf finds the handle of a group row, and a fold does not move it', () => {
  const groups = tree(two())
  expect(handleOf(groups, view(), 'tree:files')).toBe('r3')
  expect(handleOf(groups, folded('tree:prs'), 'tree:files')).toBe('r1')
  expect(handleOf(groups, folded('tree:prs'), 'p1')).toBeUndefined() // a row of a folded group has no handle
})

test('a row of a folded group is laid nowhere, so a mark on it counts nowhere and stays', () => {
  const groups = tree(two())
  expect(laidRefs(groups, view()).map(r => r.id)).toEqual(['p1', 'p2', 'f1'])
  expect(laidRefs(groups, folded('tree:prs')).map(r => r.id)).toEqual(['f1'])
})

// ---------------------------------------------------------------- the drawing

test('a group row is a row of the table: glyph Button, bold title, note, count and (n failed) in the status cell, header unchanged', () => {
  const { drawn } = draw(tree(two()))
  expect(handlesOf(drawn.tree)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4'])
  const open = buttonOf(drawn.tree, 'r0')
  expect(open.props.label).toBe('▾')
  const head = rowBoxes(drawn.tree)[0]
  const words = texts(head)
  expect(words.find(([p, s]) => s === 'Pull requests' && p.weight === 'bold')).toBeDefined()
  expect(words.find(([p, s]) => s === 'gh · ok' && p.dimColor === true)).toBeDefined()
  expect(words.find(([p, s]) => s === '2 (1 failed)' && p.color !== undefined)).toBeDefined()
  expect(texts(rowBoxes(drawn.tree)[3]).some(([, s]) => s === '1')).toBe(true) // the count of Files is plain
  expect(texts(drawn.tree).filter(([, s]) => s === 'Name')).toHaveLength(1) // one header
  expect(texts(drawn.tree).some(([, s]) => s === 'Pull requests')).toBe(true)
})

test('Enter on a group row and a click on its glyph are the press of its handle: enter:<group id>', () => {
  const { drawn, calls } = draw(tree(two()))
  press(buttonOf(drawn.tree, 'r3'))
  expect(calls).toEqual(['enter:tree:files'])
  expect(drawn.handles.get('r3')).toBe('tree:files')
})

test('a folded group draws its row with the closed glyph and nothing else; its rows take no stop', () => {
  const { drawn } = draw(tree(two()), { expanded: new Set(['tree:prs']) })
  expect(handlesOf(drawn.tree)).toEqual(['r0', 'r1', 'r2']) // the two group rows, then the row of Files
  expect(buttonOf(drawn.tree, 'r0').props.label).toBe('▸')
  expect(leaves(drawn.tree)).not.toContain('one')
  expect(drawn.stops).toEqual(['r0', 'r1', 'r2'])
  expect(drawn.rows.map(r => [r.id, r.head === true])).toEqual([
    ['tree:prs', true],
    ['tree:files', true],
    ['f1', false],
  ])
  // The count and the failed count are the numbers of the group, folded or not.
  expect(leaves(drawn.tree)).toContain('2 (1 failed)')
})

test('a pane of folded groups keeps its header and draws every group row in the columns', () => {
  const { drawn } = draw(tree(two()), { expanded: new Set(['tree:prs', 'tree:files']) })
  expect(handlesOf(drawn.tree)).toEqual(['r0', 'r1']) // only the two group rows
  expect(texts(drawn.tree).filter(([, s]) => s === 'Name')).toHaveLength(1)
  expect(texts(drawn.tree).some(([, s]) => s === 'Status')).toBe(true)
})

test('a group with no row is a group row with no glyph and no Tab stop, and its empty text follows', () => {
  const { drawn } = draw(tree([section('none', [], { title: 'Processes', empty: 'no processes' })]))
  expect(handlesOf(drawn.tree)).toEqual([])
  expect(drawn.stops).toEqual([])
  expect(drawn.rows).toEqual([])
  expect(leaves(drawn.tree)).toContain('Processes')
  expect(leaves(drawn.tree)).toContain('no processes')
  expect(texts(drawn.tree).some(([, s]) => s === 'Name')).toBe(true)
})

test('a capped group keeps its group row and its "N more" row', () => {
  const { drawn } = draw(tree([section('web', webRows(8))]), { limits: { sectionRows: 3, maxRows: 300 } })
  expect(handlesOf(drawn.tree)).toEqual(['r0', 'r1', 'r2', 'r3'])
  expect(buttonOf(drawn.tree, 'm0').props.label).toBe('5 more')
  expect(drawn.stops).toEqual(['r0', 'r1', 'r2', 'r3', 'm0'])
})

test('the rows of a group sit one level right of its group row', () => {
  const { drawn } = draw(tree([section('web', webRows(2))]))
  const pad = (b: unknown): unknown => nodes(b, 'Box').find(x => x.props.paddingLeft !== undefined)?.props.paddingLeft
  const boxes = rowBoxes(drawn.tree)
  expect(pad(boxes[0])).toBe(0)
  expect(pad(boxes[1])).toBe(2)
})

test('the by-list view still draws a title line and no group row', () => {
  const { drawn } = draw(list(two()))
  expect(handlesOf(drawn.tree)).toEqual(['r0', 'r1', 'r2'])
  expect(drawn.rows.every(r => r.head === undefined)).toBe(true)
})

test('every view but the tree draws as before: no foldable group, no group row, no depth (R17)', () => {
  const child = row('c', { name: 'c' })
  const sections = [
    section(
      'prs',
      [
        row('p1', { name: '#1' }, { facets: { level: { level: 'top' } } }),
        failed('p2'),
        row('p3', { name: 'p' }, { children: [child] }),
      ],
      {
        title: 'Pull requests',
      },
    ),
    section('files', [row('f1', { name: 'README.md' })], { title: 'Files' }),
  ]
  for (const v of ['list', 'tracker', 'status', 'reason', 'kind', 'flat'] as const) {
    const groups = viewGroups(sections, v, OFF).groups
    expect(
      groups.some(g => g.foldable === true),
      v,
    ).toBe(false)
    expect(
      layout(groups, view()).some(g => g.head !== undefined || g.rows.some(r => r.head === true || r.depth > 0)),
      v,
    ).toBe(false)
    const { drawn } = draw(groups)
    expect(
      drawn.rows.some(r => r.head === true),
      v,
    ).toBe(false)
    const data = groups.flatMap(g => g.rows).length
    expect(handlesOf(drawn.tree), v).toEqual(
      Array.from({ length: data }, (_, i) => `r${i}`).slice(0, handlesOf(drawn.tree).length),
    )
    const win = draw(groups, { bodyRows: 3 })
    expect(
      win.drawn.rows.some(r => r.head === true),
      `${v} windowed`,
    ).toBe(false)
  }
})

test('the tree view keeps its own column widths: the list view after it is as wide as before', () => {
  const sections = [section('web', webRows(2), { title: 'A very long group title here' })]
  const widthOf = (tr: unknown): unknown =>
    nodes(rowBoxes(tr)[0], 'Box').find(b => typeof b.props.width === 'number')?.props.width
  resetWidths()
  const before = TreeDataTable.render(list(sections), view({ bodyColumns: 60 }), EL, recorder().actions)
  resetWidths()
  TreeDataTable.render(tree(sections), view({ bodyColumns: 60 }), EL, recorder().actions)
  const after = TreeDataTable.render(list(sections), view({ bodyColumns: 60 }), EL, recorder().actions)
  expect(widthOf(after.tree)).toBe(widthOf(before.tree))
})

test('docked at 49 cells a group row keeps its glyph, its title and its count', () => {
  const { drawn } = draw(tree(two()), DOCKED_49)
  const head = rowBoxes(drawn.tree)[0]
  expect(buttonOf(drawn.tree, 'r0').props.label).toBe('▾')
  expect(leaves(head).join(' ')).toContain('Pull requests')
  expect(leaves(head).join(' ')).toContain('2 (1 failed)')
  expect(texts(drawn.tree).some(([, s]) => s === 'Type')).toBe(false) // the type column went first
})

test('docked at 40 cells a group row keeps its glyph, its whole title and its count (R14)', () => {
  const head = (groups: readonly GroupSpec[]) => {
    const { drawn } = draw(groups, DOCKED_40)
    return { drawn, line: leaves(rowBoxes(drawn.tree)[0]).join(' ') }
  }
  const a = head(tree(two()))
  expect(buttonOf(a.drawn.tree, 'r0').props.label).toBe('▾')
  expect(a.line).toContain('Pull requests')
  expect(a.line).toContain('2 (1 failed)')
  const rows = ['a', 'b', 'c'].map(failed)
  const b = head(tree([section('jira', rows, { title: 'Jira work items' })]))
  expect(b.line).toContain('Jira work items')
  expect(b.line).toContain('3 failed')
})

// ---------------------------------------------------------------- the keys

test('a group row takes no row key: x, the digits, m and the tracker keys have no target; o folds it', () => {
  const groups = tree(two())
  const reg = new KeyRegistry()
  const ref = findRow(groups, 'tree:prs')
  expect(ref).toEqual({ id: 'tree:prs', owner: 'core', group: 'tree:prs', can: { open: true } })
  const k = (id: string) => reg.all().find(x => x.id === id) as NonNullable<ReturnType<KeyRegistry['get']>>
  const web = (owner: string) => owner === 'core' || owner === 't'
  for (const id of [
    'dismiss',
    'mark',
    ...reg
      .all()
      .filter(x => x.id.startsWith('prio'))
      .map(x => x.id),
  ]) {
    expect(route(k(id), ref, web).to, id).toBe('none')
  }
  expect(route(k('open'), ref, web)).toEqual({ to: 'open', rowId: 'tree:prs' })
  expect(route(k('refresh'), ref, web).to).toBe('refresh')
  expect(route(k('view'), ref, web).to).toBe('view')
  const keys = footerKeys(reg, ref, web, false)
  expect(
    keys
      .filter(x => x.enabled)
      .map(x => x.id)
      .sort(),
  ).toEqual(['help', 'open', 'refresh'])
  // A group with no row has nothing to open.
  expect(findRow(tree([section('none', [])]), 'tree:none')?.can).toEqual({ open: false })
  // A row id is no group id, and the list view has no group row.
  expect(findRow(groups, 'p1')?.owner).toBe('t')
  expect(findRow(list(two()), 'list:prs')).toBeUndefined()
})

test('the selected-row line names the group: findTreeRow gives the row of the group with its title, note and count', () => {
  const r = findTreeRow(tree(two()), 'tree:prs')
  expect(r?.cells.name?.text).toBe('Pull requests')
  expect(r?.cells.description?.text).toBe('gh · ok')
  expect(r?.cells.status).toEqual({ text: '2 (1 failed)', fg: 'error' })
  expect(findTreeRow(tree(two()), 'p1')?.id).toBe('p1')
})

// ---------------------------------------------------------------- the selection

test('a row of a folded group falls to the group row; a group row stays selected', () => {
  const groups = tree(two())
  const v = folded('tree:prs')
  expect(shownSelection(groups, v, 'p2', [])).toBe('tree:prs')
  expect(shownSelection(groups, v, 'tree:prs', [])).toBe('tree:prs')
  expect(shownSelection(groups, view(), 'p2', [])).toBe('p2')
})

test('a row of an open group in a closed parent falls to the parent first', () => {
  const child = row('c', { name: 'c' })
  const parent = row('par', { name: 'par' }, { children: [child] })
  const groups = tree([section('s', [parent])])
  expect(shownSelection(groups, view(), 'c', [])).toBe('par')
  expect(shownSelection(groups, folded('tree:s'), 'c', [])).toBe('tree:s')
})

test('leaving the tree view with a group row selected selects the first row of that section, else the row before', () => {
  const sections = two()
  const before = draw(tree(sections), { expanded: new Set(['tree:files']) }).drawn.rows
  // Folded or open, the section is found by its key.
  expect(shownSelection(list(sections), view(), 'tree:files', before)).toBe('f1')
  expect(shownSelection(list(sections), view(), 'tree:prs', before)).toBe('p1')
  // A section with no row in the list view: the row before it.
  const other = [sections[0] as SectionSpec, section('files', [])]
  expect(shownSelection(list(other), view(), 'tree:files', before)).toBe('p2')
})

test('a dismiss never falls to a group row while a data row stays', () => {
  const { drawn } = draw(tree(two()))
  // p2 is the last row of its group: the next data row is the first of Files, not the group row between them.
  expect(survivorOf(drawn.rows, 'p2', new Set(['p2']))).toBe('f1')
  // f1 is the last row of the pane: the row before it.
  expect(survivorOf(drawn.rows, 'f1', new Set(['f1']))).toBe('p2')
  // No data row stays: the closest group row.
  const solo = draw(tree([section('only', [row('x', { name: 'x' })])])).drawn.rows
  expect(survivorOf(solo, 'x', new Set(['x']))).toBe('tree:only')
})

test('a bulk dismiss with a group row selected leaves the selection on it: it stays (R6, marked rows)', () => {
  const { drawn } = draw(tree(two()))
  expect(survivorOf(drawn.rows, 'tree:files', new Set(['f1']))).toBe('tree:files')
  expect(survivorOf(drawn.rows, 'tree:prs', new Set(['p1']))).toBe('tree:prs')
})

test('a pane that opens with no selection puts the ring on its first group row', () => {
  const { drawn } = draw(tree(two()))
  expect(buttonOf(drawn.tree, 'r0').props.autoFocus).toBe(true)
})

// ---------------------------------------------------------------- the window

const many = (count: number, rows: number): SectionSpec[] =>
  Array.from({ length: count }, (_, i) =>
    section(
      `s${i}`,
      webRows(rows).map(r => ({ ...r, id: `s${i}-${r.id}` })),
    ),
  )
/** The keys of the bare focus stops: a Box with no height that clips, around one Button. */
const stopKeys = (t: unknown): string[] =>
  nodes(t, 'Box')
    .filter(b => b.props.height === 0)
    .flatMap(b => nodes(b, 'Button').map(x => String(x.props.key)))
/** The row handles that the window draws in full, with a Button in the body: the stops are left out. */
const shownHandles = (t: unknown): string[] => handlesOf(t).filter(k => !stopKeys(t).includes(k))
const hints = (t: unknown): string[] =>
  texts(t)
    .map(([, s]) => s)
    .filter(s => s.startsWith('▲') || s.startsWith('▼'))

test('a long group shows as many rows in the tree view as in the list view at 100x40 inline', () => {
  const sections = [section('web', webRows(30))]
  const inList = draw(list(sections), INLINE).drawn
  const inTree = draw(tree(sections), INLINE).drawn
  // The group row takes the line of the title: the tree view draws the same lines, so the same data rows.
  // The page counts what the ring stops on: the group row at the top of the window is one more than the list's title line (review of PR 315).
  expect(inTree.page).toBe((inList.page ?? 0) + 1)
  expect(hints(inTree.tree)).toEqual(hints(inList.tree))
})

test('a window that starts inside a section draws the group row of that section above its first row, as a copy with no Button', () => {
  const groups = tree(many(2, 12))
  const { drawn } = draw(groups, { ...INLINE, selected: 's1-w5' })
  expect(shownHandles(drawn.tree)).not.toContain('r13') // the Button of the group row of s1 is a stop out of the window
  expect(leaves(drawn.tree)).toContain('s1') // its copy: the title above the rows
  expect(stopKeys(drawn.tree)).toContain('r13')
  // Every row keeps its stop in order: the stops of the drawing are all the handles.
  expect(drawn.stops).toEqual(Array.from({ length: 26 }, (_, i) => `r${i}`))
  expect(drawn.rows.map(r => r.handle)).toEqual(drawn.stops)
})

test('the window follows a selected group row, also from far below', () => {
  const groups = tree(many(3, 12))
  const { drawn } = draw(groups, { ...INLINE, selected: 'tree:s2' })
  expect(shownHandles(drawn.tree)).toContain('r26')
  expect(buttonOf(drawn.tree, 'r26').props.label).toBe('▾')
  expect(buttonOf(drawn.tree, 'r26').props.autoFocus).toBe(true)
})

test('a folded group frees its lines: a pane that needed a window fits whole once two groups are folded, and the hints count data rows only', () => {
  const groups = tree(many(3, 5))
  const open = draw(groups, INLINE).drawn
  expect(open.page).toBeDefined() // 3 group rows, 15 rows and a header do not fit 11 lines
  expect(hints(open.tree).length).toBeGreaterThan(0)
  expect(hints(open.tree).every(h => /^[▲▼] \d+ more (above|below)$/.test(h))).toBe(true)
  const total = 15
  const below = Number(
    hints(open.tree)
      .find(h => h.startsWith('▼'))
      ?.match(/\d+/)?.[0],
  )
  expect(below).toBeLessThan(total) // the hint counts data rows: never the three group rows
  const shut = draw(groups, { ...INLINE, expanded: new Set(['tree:s0', 'tree:s1']) }).drawn
  expect(shut.page).toBeDefined() // s2 still has 5 rows: group rows 3 + rows 5 + header 1 + gaps 2 = 11 lines, over a body of 9
  expect(shownHandles(shut.tree)).toEqual(
    ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'].slice(0, shownHandles(shut.tree).length),
  )
  const all = draw(groups, { ...INLINE, expanded: new Set(['tree:s0', 'tree:s1', 'tree:s2']) }).drawn
  expect(all.page).toBeUndefined() // three group rows fit whole
  expect(hints(all.tree)).toEqual([])
  expect(shownHandles(all.tree)).toEqual(['r0', 'r1', 'r2'])
})

test('the window keeps the footer, the view line and the header in view with group rows', () => {
  const { drawn } = draw(tree(many(4, 20)), { ...INLINE, selected: 's3-w10' })
  const root = drawn.tree as unknown as { children: unknown[] }
  expect(texts(drawn.tree).some(([, s]) => s === 'Name')).toBe(true)
  expect(root.children.length).toBeGreaterThan(1)
  expect(nodes(drawn.tree, 'Button').some(b => b.props.hotkey === 'r')).toBe(true)
})

test('the window counts the lines it draws: the tree is as tall as the body for any selection, fold and size, group rows included', () => {
  const groups = tree(many(4, 9))
  const ids = groups.flatMap(g => [g.id, ...g.rows.filter((_, i) => i % 4 === 0).map(r => r.id)])
  for (const [columns, bodyRows] of [
    [96, 11],
    [96, 17],
    [49, 31],
    [40, 14],
  ] as const) {
    for (const folds of [[], ['tree:s1'], ['tree:s0', 'tree:s2'], ['tree:s0', 'tree:s1', 'tree:s2']]) {
      for (const id of ids) {
        const { drawn } = draw(groups, {
          bodyColumns: columns,
          bodyRows,
          placement: 'dock',
          selected: id,
          expanded: new Set(folds),
        })
        const at = `${columns}x${bodyRows} folds ${folds.join()} selected ${id}`
        expect(heightOf(drawn.tree, columns), at).toBeLessThanOrEqual(bodyRows)
        // Every focus stop keeps its place: the handles of the drawing are the stops, in order.
        expect(
          drawn.rows.map(r => r.handle),
          at,
        ).toEqual(drawn.stops.filter(s => !s.startsWith('m')))
      }
    }
  }
})

test('a window of folded groups pages by the group rows it shows, and its hints still count data rows only', () => {
  // Review of PR 315: eight folded groups in 11 lines drew four group rows and returned page 0, so a page key moved one row.
  const groups = tree(many(8, 5))
  const all = new Set(groups.map(g => g.id))
  const { drawn } = draw(groups, { ...INLINE, expanded: all })
  expect(drawn.page).toBe(shownHandles(drawn.tree).length)
  expect(drawn.page).toBeGreaterThan(1)
  expect(hints(drawn.tree).filter(h => /rows? (above|below)$/.test(h))).toEqual([])
})

test('the ring on the "N more" Button of a capped tree section keeps the window on that Button, not on the group row', () => {
  // Review of PR 315: `head` matched the `onMore` lookup before the `more` unit, so the window jumped back to the group row.
  const groups = tree([section('web', webRows(60), { title: 'Web' })])
  const { drawn } = draw(groups, { ...INLINE, selected: 'w49', top: 40, onMore: 'm0' })
  expect(drawn.top).toBeGreaterThan(0)
  expect(stopKeys(drawn.tree)).not.toContain('m0')
  expect(buttonOf(drawn.tree, 'm0').props.label).toMatch(/more$/)
})
