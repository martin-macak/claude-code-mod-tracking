// The groups of the by-list view (issue #63, L1): today's sections as the groups the one table draws. Pure.
import { expect, test } from 'claude-code/testing'
import type { SectionSpec, TreeRow } from '../core/interfaces/view'
import { groupId, LIST_VIEW, listGroups } from '../core/lib/grouping'

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

test('the failing count is the failing count of the band of the section, 0 when it has none', () => {
  const band = (failing: number) => ({ label: 'PRs', count: 5, failing, rank: 1 })
  expect(listGroups([section('prs', [row('a')], { band: band(2) })])[0]?.failing).toBe(2)
  expect(listGroups([section('web', [row('a')])])[0]?.failing).toBe(0)
})

test('a group has the rows of its section, as the same array', () => {
  const rows = [row('a'), row('b')]
  expect(listGroups([section('web', rows)])[0]?.rows).toBe(rows)
})

test('no section gives no group', () => {
  expect(listGroups([])).toEqual([])
})
