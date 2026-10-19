// The /track text of a list of sections (plan L6 Task 9, decision G2). Pure.
import { expect, test } from 'claude-code/testing'
import type { ColumnDef } from '../core/interfaces/view'
import { EMPTY_TEXT, sectionsText } from '../ux/tree-data-table/text'
import { COLS, row, section, webRows } from './fixtures/sections'

const col = (id: string, tree = false): ColumnDef => ({
  id,
  header: id,
  width: { kind: 'content' },
  ...(tree ? { role: 'tree' as const } : {}),
})
const FILES = [col('prio'), col('key', true), col('title'), col('type'), col('status'), col('extra'), col('mark')]
const PRS = [col('prio'), col('key', true), col('title'), col('type'), col('status'), col('extra')]

test('no sections gives No tracked items yet.', () => {
  expect(sectionsText([])).toBe(EMPTY_TEXT)
  expect(EMPTY_TEXT).toBe('No tracked items yet.')
})

test('the title line is the title, two spaces and the note', () => {
  const web = section('web', COLS, [], { title: 'Web links', note: { text: '2 links' } })
  expect(sectionsText([web])).toBe('Web links  2 links')
  expect(sectionsText([section('agents', COLS, [], { title: 'Agents' })])).toBe('Agents  ')
})

test('the marker and the tree cell join with one space, the rest with two, empty cells are left out', () => {
  const marked = section('web', COLS, [row('a', { prio: '▲', key: 'two.example', title: 'two.example' })])
  expect(sectionsText([marked]).split('\n')[1]).toBe('  ▲ two.example  two.example')
  const plain = section('web', COLS, [row('a', { prio: '', key: 'two.example', title: 'two.example' })])
  expect(sectionsText([plain]).split('\n')[1]).toBe('  two.example  two.example')
})

test('children are indented two spaces per level and nothing is folded', () => {
  const child = row('PROJ-201', { key: 'PROJ-201', title: 'Child' }, { expandedByDefault: true })
  const root = row('ISS-1', { key: 'ISS-1', title: 'Root' }, { expandedByDefault: true, children: [child] })
  expect(sectionsText([section('jira', COLS, [root])])).toBe('jira  \n  ISS-1  Root\n    PROJ-201  Child')
})

test('a closed-by-default parent still lists its children', () => {
  const child = row('c', { key: 'c', title: 'Kid' })
  const root = row('p', { key: 'p', title: 'Top' }, { children: [child] })
  expect(
    sectionsText([section('jira', COLS, [root])])
      .split('\n')
      .slice(1),
  ).toEqual(['  p  Top', '    c  Kid'])
})

test('a file row with an empty tree cell keeps two spaces after the marker', () => {
  const r = row('f', { prio: '▲', key: '', title: 'docs/plan.md', type: 'created' })
  expect(sectionsText([section('file', FILES, [r])]).split('\n')[1]).toBe('  ▲  docs/plan.md  created')
})

test('a row with no cell at all is an empty indented line', () => {
  expect(sectionsText([section('web', COLS, [row('a', {})])]).split('\n')).toEqual(['web  ', '  '])
})

test('sections are separated by one empty line', () => {
  const a = section('a', COLS, [row('1', { key: 'one' })], { note: { text: 'n' } })
  const b = section('b', COLS, [row('2', { key: 'two' })])
  expect(sectionsText([a, b])).toBe('a  n\n  one\n\nb  \n  two')
})

test('detail, caps and N more never show', () => {
  const detailed = row('d', { key: 'd' }, { detail: () => [{ label: 'Body', cell: { text: 'Hello' } }] })
  expect(sectionsText([section('web', COLS, [detailed])])).toBe('web  \n  d')
  const long = sectionsText([section('web', COLS, webRows(400))])
  expect(long.split('\n')).toHaveLength(401)
  expect(long).not.toContain('more')
})

test("the text of today's fixtures", () => {
  const files = section(
    'file',
    FILES,
    [row('a', { prio: '', key: '', title: 'a.md', type: 'created', extra: 'viewed 2' })],
    {
      title: 'Files',
      note: { text: '1 files' },
    },
  )
  expect(sectionsText([files])).toBe('Files  1 files\n  a.md  created  viewed 2')
  const pr = row('p7', {
    prio: '★',
    key: '#7',
    title: 'Opened here',
    type: 'worktree-probe-wt',
    status: 'open',
    extra: '✓ checks',
  })
  expect(sectionsText([section('prs', PRS, [pr])]).split('\n')[1]).toBe(
    '  ★ #7  Opened here  worktree-probe-wt  open  ✓ checks',
  )
})
