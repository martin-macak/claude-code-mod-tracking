// The groups of the by-list view (issue #63, L1): today's sections as the groups the one table draws. Pure.
import { expect, test } from 'claude-code/testing'
import type { SectionSpec, TreeRow } from '../core/interfaces/view'
import { groupId, LIST_VIEW, listGroups, VIEW_IDS, viewGroups } from '../core/lib/grouping'
import { groupsText } from '../ux/tree-data-table/text'

const row = (id: string, children?: TreeRow[]): TreeRow => ({
  id,
  owner: 't',
  cells: { name: { text: id } },
  ...(children ? { children } : {}),
})
const section = (id: string, rows: TreeRow[], over: Partial<SectionSpec> = {}): SectionSpec => ({
  id,
  title: id.toUpperCase(),
  rows,
  ...over,
})

test('a group id is the view and the group key: list:prs', () => {
  expect(LIST_VIEW).toBe('list')
  expect(groupId('list', 'prs')).toBe('list:prs')
  expect(groupId('status', 'failed')).toBe('status:failed')
})

test('each section is one group, in the order it came, keyed by the list view', () => {
  const note = { text: 'gh · ok' }
  const groups = listGroups([
    section('prs', [row('a')], { note, empty: 'none yet' }),
    section('web', [row('b'), row('c')]),
  ])
  expect(groups.map(g => [g.id, g.title])).toEqual([
    ['list:prs', 'PRS'],
    ['list:web', 'WEB'],
  ])
  expect(groups[0]).toEqual({
    id: 'list:prs',
    title: 'PRS',
    note,
    rows: [row('a')],
    count: 1,
    failing: 0,
    empty: 'none yet',
  })
  expect(groups[1]?.note).toBeUndefined()
  expect(groups[1]?.empty).toBeUndefined()
})

test('the count is the top-level rows: children and the caps of the table do not change it', () => {
  const tree = row('p', [row('c1', [row('g1')]), row('c2')])
  const [group] = listGroups([section('jira', [tree, row('q')])])
  expect(group?.count).toBe(2)
  expect(listGroups([section('none', [])])[0]?.count).toBe(0)
})

test('the count of a section wins over its top-level rows: a tree section that hangs every row under one root says so', () => {
  const tree = row('root', [row('a'), row('b', [row('c')])])
  expect(listGroups([section('wt', [tree], { count: 4 })])[0]?.count).toBe(4)
  expect(listGroups([section('wt', [tree])])[0]?.count).toBe(1)
  expect(listGroups([section('wt', [], { count: 0 })])[0]?.count).toBe(0)
})

test('the failing count is the rows with the token failed, at every depth; the band of the section does not count', () => {
  const failed = (id: string, children?: TreeRow[]): TreeRow => ({
    ...row(id, children),
    facets: { status: { label: 'x', token: 'failed' } },
  })
  const active = (id: string, children?: TreeRow[]): TreeRow => ({
    ...row(id, children),
    facets: { status: { label: 'x', token: 'active' } },
  })
  const band = (failing: number) => ({ label: 'PRs', count: 5, failing, rank: 1 })
  // Two failed rows and a band that says 0: the group says 2. A band that says 5 and no failed row: 0.
  expect(listGroups([section('prs', [failed('a'), active('b'), failed('c')], { band: band(0) })])[0]?.failing).toBe(2)
  expect(listGroups([section('prs', [active('a'), row('b')], { band: band(5) })])[0]?.failing).toBe(0)
  expect(listGroups([section('web', [row('a')])])[0]?.failing).toBe(0)
  // A failed row below a row that did not fail counts: the agents hang under one root row.
  expect(listGroups([section('agents', [active('m', [failed('a'), active('b', [failed('c')])])])])[0]?.failing).toBe(2)
})

test('a group has the rows of its section, as the same array', () => {
  const rows = [row('a'), row('b')]
  expect(listGroups([section('web', rows)])[0]?.rows).toBe(rows)
})

test('no section gives no group', () => {
  expect(listGroups([])).toEqual([])
})

test('the text mode of a section rides on its group; a section with none leaves the group without it', () => {
  const [quiet, loud] = listGroups([section('q', [row('a')], { text: 'title' }), section('p', [row('b')])])
  expect(quiet?.text).toBe('title')
  expect(loud).not.toHaveProperty('text')
})

// A view other than by list puts the rows of several sections in one group, so the text mode of a section cannot ride on a
// group. `viewGroups` marks each row of such a section `quiet` instead, in every view (issue #71, the Questions section).
test('viewGroups marks the rows of a section with text title quiet, in every view, and no other row', () => {
  const qa = section('qa', [row('q1', [row('q1:0')]), row('q2')], { text: 'title', note: { text: '2 calls' } })
  const plain = section('web', [row('w1'), row('w2', [row('w2:0')])])
  const loud = section('prs', [row('p1')], { text: 'rows' })
  for (const view of VIEW_IDS) {
    const rows = viewGroups([qa, plain, loud], view, { touchedOnly: false }).groups.flatMap(g => g.rows)
    expect(
      rows
        .filter(r => r.quiet === true)
        .map(r => r.id)
        .sort(),
      view,
    ).toEqual(['q1', 'q2'])
    expect(
      rows
        .filter(r => r.quiet === undefined)
        .map(r => r.id)
        .sort(),
      view,
    ).toEqual(['p1', 'w1', 'w2'])
    // The whole tree is marked: a `lift` makes a child a row of its own in the groups of a view, and the text must skip it too.
    expect(rows.find(r => r.id === 'q1')?.children?.[0]?.quiet, view).toBe(true)
    expect(rows.find(r => r.id === 'w2')?.children?.[0]).not.toHaveProperty('quiet')
  }
})

test('a lifted child of a quiet row stays quiet in every view: no row of a text-title section prints', () => {
  const lifted = { ...row('q1', [row('q1:0', [row('q1:0:0')])]), lift: true as const }
  const qa = section('qa', [lifted, row('q2')], { text: 'title', note: { text: '2 calls' } })
  for (const view of VIEW_IDS) {
    const { groups } = viewGroups([qa], view, { touchedOnly: false })
    const rows = groups.flatMap(g => g.rows)
    expect(
      rows.every(r => r.quiet === true),
      view,
    ).toBe(true)
    // In a view other than by list the lift makes `q1:0` a row of its own (its child stays below it): it is there, and quiet.
    if (view !== LIST_VIEW) expect(rows.map(r => r.id).sort(), view).toEqual(['q1', 'q1:0', 'q2'])
    expect(rows.find(r => r.id === 'q1:0')?.children?.[0]?.quiet ?? true, view).toBe(true)
    // groupsText prints none of them: no title for a group of quiet rows either.
    expect(groupsText(groups), view).toBe(view === LIST_VIEW ? 'QA  2 calls' : '')
  }
})

test('viewGroups leaves the rows of the section as they were: the mark is on a copy', () => {
  const rows = [row('q1'), row('q2')]
  const qa = section('qa', rows, { text: 'title' })
  const { groups } = viewGroups([qa], 'flat', { touchedOnly: false })
  expect(groups[0]?.rows.every(r => r.quiet === true)).toBe(true)
  expect(rows.some(r => 'quiet' in r)).toBe(false)
  expect(qa.rows).toBe(rows)
})

test('a section with no text mode, or with text rows, gets no mark, and a view keeps its rows and counts as before', () => {
  const rows = [row('a'), row('b')]
  const { groups } = viewGroups([section('web', rows), section('prs', [row('c')], { text: 'rows' })], 'flat', {
    touchedOnly: false,
  })
  expect(groups.flatMap(g => g.rows).some(r => 'quiet' in r)).toBe(false)
  expect(groups[0]?.count).toBe(3)
})
