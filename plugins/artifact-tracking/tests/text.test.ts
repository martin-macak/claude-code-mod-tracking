// The /track text of a list of groups (plan L6 Task 9, decision G2). Pure. One line of text per row, whatever the columns
// of the pane: the badges of the extras column are cells of their own (issue #63, L1).
import { expect, test } from 'claude-code/testing'
import { EMPTY_TEXT, groupsText, moreLines, quietTitles, titleLine } from '../ux/tree-data-table/text'
import { group, row, webRows } from './fixtures/sections'

test('no sections gives No tracked items yet.', () => {
  expect(groupsText([])).toBe(EMPTY_TEXT)
  expect(EMPTY_TEXT).toBe('No tracked items yet.')
})

// Issue #63, L3: a group of a view (Pinned, Failed, All) has no note, and its title line ends at the title with no trailing
// space. A section of the by-list view always has a note in the pane, so its line is the one it was.
test('the title line is the title, two spaces and the note', () => {
  const web = group('web', [], { title: 'Web links', note: { text: '2 links' } })
  expect(groupsText([web])).toBe('Web links  2 links')
  expect(groupsText([group('agents', [], { title: 'Agents' })])).toBe('Agents')
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
  expect(groupsText([group('jira', [root])])).toBe('jira\n  ISS-1  Root\n    PROJ-201  Child')
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
  expect(groupsText([group('web', [row('a', {})])]).split('\n')).toEqual(['web', '  '])
})

test('sections are separated by one empty line', () => {
  const a = group('a', [row('1', { name: 'one' })], { note: { text: 'n' } })
  const b = group('b', [row('2', { name: 'two' })])
  expect(groupsText([a, b])).toBe('a  n\n  one\n\nb\n  two')
})

test('detail, caps and N more never show', () => {
  const detailed = row('d', { name: 'd' }, { detail: () => [{ label: 'Body', cell: { text: 'Hello' } }] })
  expect(groupsText([group('web', [detailed])])).toBe('web\n  d')
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

// A view other than by list mixes the rows of several sections in one group. The view marks the rows of a quiet section
// (`quiet`), and the text prints nothing for such a row, with its children, wherever the row sits.
const quietRow = (id: string) =>
  row(
    id,
    { name: `Q-${id}`, description: 'typed: hunter2' },
    { quiet: true, children: [row(`${id}:0`, { name: 'Storage' })] },
  )

test('a quiet row prints nothing, with its children, and the other rows of its group print as ever', () => {
  const mixed = group('status:done', [row('a', { name: 'PR 1', description: 'Fix it' }), quietRow('q1')], {
    title: 'Done',
  })
  expect(groupsText([mixed])).toBe('Done\n  PR 1  Fix it')
  // Only the flag counts: the same row with no mark prints.
  const loud = group('status:done', [{ ...quietRow('q1'), quiet: undefined }], { title: 'Done' })
  expect(groupsText([loud])).toContain('hunter2')
})

test('a group that holds only quiet rows prints no title line either: the end of the text names them', () => {
  const only = group('status:gone', [quietRow('q1'), quietRow('q2')], { title: 'Gone' })
  const other = group('status:done', [row('a', { name: 'PR 1' })], { title: 'Done' })
  expect(groupsText([only, other])).toBe('Done\n  PR 1')
  expect(groupsText([only])).toBe('')
  // An empty group still prints its title (it has no rows to be quiet), and a group with text title keeps its line.
  expect(groupsText([group('x', [], { title: 'Empty' })])).toBe('Empty')
  const titled = group('questions', [quietRow('q1')], { title: 'Questions', note: { text: '1 call' }, text: 'title' })
  expect(groupsText([titled])).toBe('Questions  1 call')
})

test('quietTitles gives the title line of each section with text title and a row: the title and the note, never a row', () => {
  const qa = {
    title: 'Questions',
    note: { text: '2 calls · /track qa prints them' },
    text: 'title' as const,
    rows: [quietRow('q1')],
  }
  const empty = { title: 'Notes', text: 'title' as const, rows: [] }
  const loud = { title: 'PRs', note: { text: 'gh' }, rows: [row('a', { name: 'PR 1' })] }
  const bare = { title: 'Plans', text: 'title' as const, rows: [quietRow('p1')] }
  expect(quietTitles([loud, qa, empty, bare])).toEqual(['Questions  2 calls · /track qa prints them', 'Plans'])
  expect(quietTitles([])).toEqual([])
})

test('titleLine is the title, and two spaces and the note when the group has one', () => {
  expect(titleLine({ title: 'Questions', note: { text: '2 calls · /track qa prints them' } })).toBe(
    'Questions  2 calls · /track qa prints them',
  )
  expect(titleLine({ title: 'Done' })).toBe('Done')
})

test('a group with text title prints its title line and no row: the model reads every /track reply', () => {
  const secret = row(
    'q',
    { name: 'Q1', description: 'typed: hunter2' },
    { children: [row('q:0', { name: 'Storage' })] },
  )
  const quiet = group('questions', [secret], { title: 'Questions', note: { text: '1 call' }, text: 'title' })
  const plain = group('prs', [row('a', { name: 'PR 1', description: 'Fix it' })], { title: 'PRs' })
  expect(groupsText([quiet])).toBe('Questions  1 call')
  expect(groupsText([quiet, plain])).toBe('Questions  1 call\n\nPRs\n  PR 1  Fix it')
  expect(groupsText([{ ...quiet, text: 'rows' }])).toContain('hunter2')
})

// Issue #57: a section that leaves its read-only rows out of the text says how many in one line (`SectionSpec.textMore`).
// In the by-list view the line ends the group, indented as a row. In another view it comes once at the end (`moreLines`).
test('the textMore line of a group ends it, indented as a row, after the rows that print', () => {
  const files = group('list:file', [row('a', { name: 'a.ts' }), quietRow('q1')], {
    title: 'Files',
    note: { text: '1 files · 2 read' },
    textMore: '2 more files read only',
  })
  expect(groupsText([files])).toBe('Files  1 files · 2 read\n  a.ts\n  2 more files read only')
  // The line comes last, after a child too.
  const parent = row('p', { name: 'p' }, { children: [row('c', { name: 'c' })] })
  expect(groupsText([group('x', [parent], { textMore: 'and 3 more' })])).toBe('x\n  p\n    c\n  and 3 more')
})

test('a group of quiet rows with a textMore line prints its title and the line; with none it prints nothing', () => {
  const quiet = [quietRow('q1'), quietRow('q2')]
  const with_ = group('list:file', quiet, {
    title: 'Files',
    note: { text: '0 files · 2 read' },
    textMore: '2 more files read only',
  })
  expect(groupsText([with_])).toBe('Files  0 files · 2 read\n  2 more files read only')
  expect(groupsText([{ ...with_, textMore: undefined }])).toBe('')
  // A group with text title keeps its title line only, as before.
  expect(groupsText([{ ...with_, text: 'title' }])).toBe('Files  0 files · 2 read')
})

test('moreLines gives the title and the more line of each section that has one, never a row', () => {
  const files = {
    title: 'Files',
    textMore: { line: '188 more files read only', rows: ['q1'] },
    rows: [quietRow('q1')],
  }
  const prs = { title: 'PRs', rows: [row('a', { name: 'PR 1' })] }
  const none = { title: 'Notes', textMore: undefined, rows: [] }
  expect(moreLines([prs, files, none])).toEqual(['Files  188 more files read only'])
  expect(moreLines([])).toEqual([])
})
