// The /track text of a list of groups (plan L6 Task 9, decision G2). Pure. One line of text per row, whatever the columns
// of the pane: the badges of the extras column are cells of their own (issue #63, L1).
import { expect, test } from 'claude-code/testing'
import { EMPTY_TEXT, groupsText } from '../ux/tree-data-table/text'
import { group, row, webRows } from './fixtures/sections'

test('no sections gives No tracked items yet.', () => {
  expect(groupsText([])).toBe(EMPTY_TEXT)
  expect(EMPTY_TEXT).toBe('No tracked items yet.')
})

test('the title line is the title, two spaces and the note', () => {
  const web = group('web', [], { title: 'Web links', note: { text: '2 links' } })
  expect(groupsText([web])).toBe('Web links  2 links')
  expect(groupsText([group('agents', [], { title: 'Agents' })])).toBe('Agents  ')
})

test('the marker and the tree cell join with one space, the rest with two, empty cells are left out', () => {
  const marked = group('web', [row('a', { control: '▲', name: 'two.example', description: 'two.example' })])
  expect(groupsText([marked]).split('\n')[1]).toBe('  ▲ two.example  two.example')
  const plain = group('web', [row('a', { control: '', name: 'two.example', description: 'two.example' })])
  expect(groupsText([plain]).split('\n')[1]).toBe('  two.example  two.example')
})

test('children are indented two spaces per level and nothing is folded', () => {
  const child = row('PROJ-201', { name: 'PROJ-201', description: 'Child' }, { expandedByDefault: true })
  const root = row('ISS-1', { name: 'ISS-1', description: 'Root' }, { expandedByDefault: true, children: [child] })
  expect(groupsText([group('jira', [root])])).toBe('jira  \n  ISS-1  Root\n    PROJ-201  Child')
})

test('a closed-by-default parent still lists its children', () => {
  const child = row('c', { name: 'c', description: 'Kid' })
  const root = row('p', { name: 'p', description: 'Top' }, { children: [child] })
  expect(
    groupsText([group('jira', [root])])
      .split('\n')
      .slice(1),
  ).toEqual(['  p  Top', '    c  Kid'])
})

test('a file row with an empty tree cell keeps two spaces after the marker', () => {
  const r = row('f', { control: '▲', name: '', description: 'docs/plan.md', type: 'created' })
  expect(groupsText([group('file', [r])]).split('\n')[1]).toBe('  ▲  docs/plan.md  created')
})

test('a row with no cell at all is an empty indented line', () => {
  expect(groupsText([group('web', [row('a', {})])]).split('\n')).toEqual(['web  ', '  '])
})

test('sections are separated by one empty line', () => {
  const a = group('a', [row('1', { name: 'one' })], { note: { text: 'n' } })
  const b = group('b', [row('2', { name: 'two' })])
  expect(groupsText([a, b])).toBe('a  n\n  one\n\nb  \n  two')
})

test('detail, caps and N more never show', () => {
  const detailed = row('d', { name: 'd' }, { detail: () => [{ label: 'Body', cell: { text: 'Hello' } }] })
  expect(groupsText([group('web', [detailed])])).toBe('web  \n  d')
  const long = groupsText([group('web', webRows(400))])
  expect(long.split('\n')).toHaveLength(401)
  expect(long).not.toContain('more')
})

test("the text of today's fixtures", () => {
  const files = group(
    'file',
    [row('a', { control: '', name: '', description: 'a.md', type: 'created' }, { extras: [{ text: 'viewed 2' }] })],
    { title: 'Files', note: { text: '1 files' } },
  )
  expect(groupsText([files])).toBe('Files  1 files\n  a.md  created  viewed 2')
  const pr = row(
    'p7',
    { control: '★', name: '#7', description: 'Opened here', type: 'worktree-probe-wt', status: 'open' },
    { extras: [{ text: '✓ checks' }] },
  )
  expect(groupsText([group('prs', [pr])]).split('\n')[1]).toBe('  ★ #7  Opened here  worktree-probe-wt  open  ✓ checks')
})

test('each badge is a cell of its own after the status, two spaces apart; an empty badge adds none', () => {
  const badges = [
    { text: '✗ conflicts', fg: 'error' as const },
    { text: '' },
    { text: '✓ checks' },
    { text: 'no worktree' },
  ]
  const pr = row('p7', { name: '#7', description: 'Title', status: 'open' }, { extras: badges })
  expect(groupsText([group('prs', [pr])]).split('\n')[1]).toBe('  #7  Title  open  ✗ conflicts  ✓ checks  no worktree')
})

test('the counts of a group are for the pane: the text prints the title and the note only', () => {
  const g = group('prs', webRows(3), { title: 'Pull requests', failing: 2, note: { text: 'gh · ok' } })
  expect(groupsText([g]).split('\n')[0]).toBe('Pull requests  gh · ok')
})
