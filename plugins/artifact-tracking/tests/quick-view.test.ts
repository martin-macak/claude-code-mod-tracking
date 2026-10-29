// The quick view of the selected row (issue #276, L1 of #275): the lines below the `Selected:` line that the row cannot show. A line is
// the detail of the row, one row each, cut cell by cell: the cut cells and the links, then the detail() lines of the tracker, the
// reasons, the turns and the count of the children, and never a badge line (the first line has the badges). The tests draw one row
// of each kind of tracker at 96 and at 49 cells, and count the rows of every line. The rows that the quick view takes in a body are in
// status-area.test.ts. Pure.
import { expect, test } from 'claude-code/testing'
import { NO_VIEW } from '../core/infra/views'
import type { StatusLine, TreeRow } from '../core/interfaces/view'
import { listGroups } from '../core/lib/grouping'
import { callRow } from '../trackers/questions/rows'
import type { QuestionCall } from '../trackers/questions/types'
import { resetWidths, SHARED_COLUMNS, solveColumns } from '../ux/tree-data-table/columns'
import { findTreeRow } from '../ux/tree-data-table/layout'
import { quickLines } from '../ux/tree-data-table/quick'
import { selectedLine, statusLineBox, wholeCellsOf } from '../ux/tree-data-table/status'
import { nodes, texts } from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { heightOf } from './fixtures/height'
import { paneWorld } from './fixtures/pane-world'
import { row } from './fixtures/sections'

const PULL = 'https://github.com/martin-macak/claude-code-mod-tracking/pull/262'
const TITLE = 'feat(track): Track every file Claude reads or writes, with its type'

const pr = (extra: Partial<TreeRow> = {}): TreeRow =>
  row(
    'pr',
    {
      control: '●',
      name: { text: '#262', href: PULL },
      description: TITLE,
      type: 'feat/track-all-files',
      status: { text: 'open', fg: 'success' },
    },
    {
      owner: 'github',
      extras: [{ text: '✓ checks', fg: 'success' }, { text: 'mergeable' }],
      reasons: { first: 'created', all: ['created', 'updated', 'discovered'], strongest: 'created' },
      turns: { first: 3, last: 9 },
      ...extra,
    },
  )

/** The columns of the one table for these rows in a body `columns` wide, as the table solves them (the gutter takes 2). */
function solved(rows: readonly TreeRow[], columns: number) {
  resetWidths()
  return solveColumns(
    'pane',
    SHARED_COLUMNS,
    rows.map(r => ({ row: r, depth: 0 })),
    columns - 2,
  )
}

/** The quick view of `r` alone in a body `columns` wide. */
const quick = (r: TreeRow, columns: number): readonly StatusLine[] => quickLines(r, solved([r], columns), columns)

/** A line as `label text`: the label, then the text of its cells joined by a space. */
const shape = (lines: readonly StatusLine[]): string[] =>
  lines.map(l => `${l.label} ${l.cells.map(c => c.text).join(' ')}`.trim())

test('a PR at 49 cells: the cut description, the dropped type, the link, the reasons and the turns, and no badge line', () => {
  const lines = quick(pr(), 49)
  expect(shape(lines)).toEqual([
    `description: ${TITLE}`,
    'type: feat/track-all-files',
    `link: ${PULL}`,
    'reasons: created, updated, discovered',
    'turns: first 3 · last 9',
  ])
  // The badges are in the first line: no line of the quick view holds one.
  expect(shape(lines).join('\n')).not.toMatch(/checks|mergeable/)
})

test('a PR at 96 cells: the type fits its column, so only the cut description is a line, then the link, the reasons and the turns', () => {
  expect(shape(quick(pr(), 96)).map(s => s.split(':')[0])).toEqual(['description', 'link', 'reasons', 'turns'])
})

test('a line is indented under the `Selected:` line, its label ends in a colon and its cell keeps no href: a link is plain text', () => {
  const lines = quick(pr(), 49)
  for (const l of lines) {
    expect(l.indent, l.label).toBe(2)
    expect(l.label.endsWith(':'), l.label).toBe(true)
    expect(l.cells, l.label).toHaveLength(1)
    expect(l.cells[0]?.href, l.label).toBeUndefined()
  }
  const link = lines.find(l => l.label === 'link:')
  expect(link?.cells[0]).toMatchObject({ text: PULL, clip: 'middle' }) // cut in the middle, as a path is
})

test('a Jira parent: the cut description, the link, the reasons, the turns and the count of its children', () => {
  const child = row('c', { name: 'ABC-11', description: 'one' })
  const epic = row(
    'epic',
    {
      control: '○',
      name: { text: 'ABC-10', href: 'https://example.atlassian.net/browse/ABC-10' },
      description: 'Show the assignee in the track pane for every ticket that Claude touches in a session',
      status: 'In Progress',
    },
    {
      owner: 'jira',
      children: [child, child, child, child],
      reasons: { first: 'mentioned', all: ['mentioned'], strongest: 'mentioned' },
      turns: { first: 2, last: 2 },
    },
  )
  expect(shape(quick(epic, 49))).toEqual([
    'description: Show the assignee in the track pane for every ticket that Claude touches in a session',
    'link: https://example.atlassian.net/browse/ABC-10',
    'reasons: mentioned',
    'turns: first 2 · last 2',
    'children: 4',
  ])
})

test('a file: the cut path and the type column that the pane dropped, the reasons and the turns, and no badge', () => {
  const file = row(
    'f',
    {
      control: '○',
      name: 'pane-session.ts',
      description: 'plugins/artifact-tracking/hooks/the/path/is/long/enough/to/be/cut',
      type: 'code',
      status: 'edited 3',
    },
    {
      owner: 'file',
      extras: [{ text: 'viewed 5' }, { text: 'subagent' }],
      reasons: { first: 'updated', all: ['updated', 'read', 'mentioned'], strongest: 'updated' },
      turns: { first: 1, last: 12 },
    },
  )
  expect(shape(quick(file, 49))).toEqual([
    'description: plugins/artifact-tracking/hooks/the/path/is/long/enough/to/be/cut',
    'type: code',
    'reasons: updated, read, mentioned',
    'turns: first 1 · last 12',
  ])
})

test('a row that shows whole and has no reason, no turn and no child has no line below the first: no filler line', () => {
  const process = row(
    'p',
    { control: '○', name: 'node', description: 'server.js', status: 'running' },
    { owner: 'processes' },
  )
  expect(quick(process, 96)).toEqual([])
  expect(quick(process, 49)).toEqual([])
})

test('a row with its own detail() shows the cut cells first, then those lines, then the reasons, the turns and the children', () => {
  const question = row(
    'q',
    {
      name: 'Q1',
      description: 'Which layout do you want for the pane, with the detail on a second level?',
      status: 'asked',
    },
    {
      owner: 'questions',
      detail: () => [
        { label: 'question', cell: { text: 'Which layout do you want?' } },
        { cell: { text: 'a line with no label' } },
      ],
      children: [row('q-0', { name: 'Layout', description: 'two levels' })],
      reasons: { first: 'created', all: ['created'], strongest: 'created' },
      turns: { first: 4, last: 4 },
    },
  )
  const lines = quick(question, 49)
  expect(shape(lines)).toEqual([
    'description: Which layout do you want for the pane, with the detail on a second level?',
    'question: Which layout do you want?',
    'a line with no label',
    'reasons: created',
    'turns: first 4 · last 4',
    'children: 1',
  ])
  expect(lines[2]).toMatchObject({ label: '', indent: 2 }) // a line with no label is indented too
})

// A call of the questions tracker as the tracker builds the row: the summary of the call is cut in the table at 49 cells, so it is
// the first line of the quick view, and the detail() lines of the call follow it (issue #276, review of PR #284, A3).
const ASK: QuestionCall = {
  id: 'c1',
  n: 1,
  kind: 'ask',
  state: 'answered',
  at: Date.UTC(2026, 9, 27, 10, 30),
  turn: 7,
  items: [
    {
      question: 'Where should the choice of e live?',
      header: 'Storage',
      multiSelect: false,
      options: [{ label: 'State only' }, { label: 'Config file' }],
      answer: 'State only',
    },
    {
      question: 'Which checks should run?',
      header: 'Checks',
      multiSelect: true,
      options: [{ label: 'Lint' }, { label: 'E2E' }],
      answer: 'Lint, E2E',
    },
  ],
}

test('a call of the questions tracker at 49 cells: the cut summary first, then the lines of the call, the reasons, the turns and the children', () => {
  // The pane row of a call: the builder makes the cells, the detail and the children, and the core puts `turns` on the row from the
  // `turnsOf` of the tracker (issue #201), so the test sets them as the core does.
  const call: TreeRow = { ...callRow(ASK, s => s), turns: { first: 7, last: 7 } }
  const lines = quickLines(call, solved([call, ...(call.children ?? [])], 49), 49)
  expect(shape(lines)).toEqual([
    'description: Storage → State only (+1)',
    'asked: 2026-10-27 10:30 UTC',
    'call: c1',
    'reasons: created',
    'turns: first 7 · last 7',
    'children: 2',
  ])
})

test('a plan call has no empty line in its quick view: a blank line of the plan draws no row, so it would count and show nothing', () => {
  const plan = callRow(
    {
      id: 'p1',
      n: 2,
      kind: 'plan',
      state: 'answered',
      at: Date.UTC(2026, 9, 27, 10, 30),
      plan: '# Plan\n\nStep one\n\nStep two',
    },
    s => s,
  )
  const lines = quickLines(plan, solved([plan], 49), 49)
  expect(shape(lines)).toEqual([
    'asked: 2026-10-27 10:30 UTC',
    'call: p1',
    'plan: # Plan',
    'Step one',
    'Step two',
    'reasons: created',
  ])
  for (const line of lines) expect(heightOf(statusLineBox(EL, line, 49), 49), line.label).toBe(1)
})

test('a detail() with blank lines gives no line for them, and keeps the lines around them', () => {
  const r = row(
    'r',
    { name: 'a', description: 'b' },
    {
      detail: () => [
        { label: 'x', cell: { text: 'a' } },
        { cell: { text: '' } },
        { cell: { text: '  ' } },
        { cell: { text: 'b' } },
      ],
    },
  )
  expect(shape(quick(r, 96))).toEqual(['x: a', 'b'])
})

test('the detail() of a row is called once per quick view', () => {
  const calls: string[] = []
  const r = pr({
    detail: () => {
      calls.push('detail')
      return [{ label: 'x', cell: { text: 'y' } }]
    },
  })
  quick(r, 49)
  expect(calls).toEqual(['detail'])
})

// ---- the cells that the first line cuts ---------------------------------------------------------------------------------------

// The `Selected:` line draws the label, the name, the status, the badges and the reason, each after a gap, and stops at the first
// cell that does not fit. A cell it draws whole needs no line below it. A cell it cuts or leaves out must have its line, else the
// text shows nowhere (issue #276, review of PR #284, M1).
const LONG = { control: '○', name: 'a-very-long-name-for-a-file.ts', status: 'a status that is long' }

test('a cell the first line shows whole is no line: at 96 cells the name and the status are in the `Selected:` line', () => {
  const r = row('r', LONG, { owner: 'file' })
  expect(quick(r, 96)).toEqual([])
})

test('a status that the first line cuts or leaves out has its line, where a narrow body gives the first line no room for it', () => {
  const r = row('r', LONG, { owner: 'file' })
  // 49 cells: the label, the name and the first cells of the status. 40 cells: the name fills the line and the status has no room.
  expect(shape(quick(r, 49))).toEqual(['status: a status that is long'])
  expect(shape(quick(r, 40))).toEqual(['status: a status that is long'])
})

test('a name that is empty falls to the description, as the first line does: the description has a line where the first line cuts it', () => {
  const address = 'https://example.test/a/very/long/address/that/the/column/cuts/early/on'
  const r = row('r', { name: '', description: address }, { owner: 'web' })
  expect(quick(r, 96)).toEqual([]) // the first line holds the address whole
  expect(shape(quick(r, 49))).toEqual([`description: ${address}`])
  expect(shape(quick(r, 40))).toEqual([`description: ${address}`])
})

test('a name that the first line and the table cut has its line; the status that the table shows whole has none', () => {
  const name = 'a-name-that-is-longer-than-the-first-line-of-a-narrow-pane-can-draw.ts'
  const r = row('r', { control: '○', name, description: 'd', status: 'edited 3' }, { owner: 'file' })
  // The first line cuts the name and has no room for the status. The table draws the status whole, so only the name needs a line.
  expect(shape(quick(r, 40))).toEqual([`name: ${name}`])
})

test('the cells that the quick view takes for whole are the cells that statusLineBox draws whole, at every width', () => {
  const r = row('r', LONG, {
    owner: 'file',
    extras: [{ text: '✓ checks' }, { text: 'mergeable' }],
    reasons: { first: 'created', all: ['created'], strongest: 'created' },
  })
  const seen = new Set<string>()
  for (let columns = 10; columns <= 100; columns++) {
    const words = texts(statusLineBox(EL, selectedLine(r), columns)).map(([, s]) => s)
    const whole = wholeCellsOf(r, columns)
    expect(whole.has('name'), `name at ${columns}`).toBe(words.includes(LONG.name))
    expect(whole.has('status'), `status at ${columns}`).toBe(words.includes(LONG.status))
    seen.add(`${whole.has('name')} ${whole.has('status')}`)
  }
  expect([...seen].sort()).toEqual(['false false', 'true false', 'true true']) // every case came up
})

// ---- the rows of the trackers ---------------------------------------------------------------------------------------------------

// One row of each kind that the trackers make, drawn by the real builders over the pane world, in a body of 96 and of 49 cells: the
// columns are solved over every row of the world, as the table solves them. Each line is `label text`.
const WORLD_LINES: readonly (readonly [id: string, columns: number, lines: readonly string[]])[] = [
  // auto: an agent with no reason shows no line at 96 cells, and no filler
  ['ag:build', 96, []],
  ['ag:build', 49, []],
  ['ag:master', 96, ['children: 3']],
  ['ag:master', 49, ['type: feat-x', 'children: 3']],
  ['wt:/work', 96, ['children: 3']],
  ['wt:/work', 49, ['children: 3']],
  // repos
  ['rp:remote:github.com/acme/sdk', 96, ['reasons: updated']],
  ['rp:remote:github.com/acme/sdk', 49, ['type: main, planner', 'reasons: updated']],
  // github: a PR, an issue
  ['gh:github.com/acme/web#22', 96, ['link: https://github.com/acme/web/pull/22', 'reasons: discovered']],
  [
    'gh:github.com/acme/web#22',
    49,
    [
      'description: Stacked on the scan',
      'type: →feat/x',
      'link: https://github.com/acme/web/pull/22',
      'reasons: discovered',
    ],
  ],
  ['gh:github.com/acme/web#5', 49, ['type: Issue', 'link: https://github.com/acme/web/issues/5', 'reasons: mentioned']],
  // jira: a parent with children and a leaf
  [
    'jira:acme.atlassian.net/ISS-1',
    49,
    [
      'description: ↳#21 The epic',
      'type: Epic',
      'link: https://acme.atlassian.net/browse/ISS-1',
      'reasons: mentioned',
      'children: 2',
    ],
  ],
  [
    'jira:acme.atlassian.net/ISS-1/PROJ-201/PROJ-301',
    49,
    ['description: The subtask', 'type: Sub-task', 'link: https://acme.atlassian.net/browse/PROJ-301'],
  ],
  // artifact: a published one has a link, a deleted one has none
  [
    'art:11111111-1111-4111-8111-111111111111',
    49,
    [
      'description: 11111111-1111-4111-8111-111111111111',
      'type: published',
      'link: https://claude.ai/artifact/11111111-1111-4111-8111-111111111111',
      'reasons: published',
    ],
  ],
  [
    'art:22222222-2222-4222-8222-222222222222',
    49,
    ['description: 22222222-2222-4222-8222-222222222222', 'type: published', 'reasons: deleted, published'],
  ],
  // web
  [
    'web:https://docs.example/a',
    49,
    ['description: ↳#21 docs.example/a', 'link: https://docs.example/a?x=1', 'reasons: mentioned'],
  ],
  ['web:https://docs.example/a', 96, ['link: https://docs.example/a?x=1', 'reasons: mentioned']],
  // file and process
  ['file:/work/plan.md', 49, ['type: docs', 'reasons: created']],
  ['bg:1', 49, ['type: background task', 'reasons: created']],
]

test('a row of every kind of tracker, as its real builder makes it: the lines at 96 and at 49 cells, and no badge line', async () => {
  const t = await paneWorld()
  const groups = listGroups(await t.m.paneData(t.w.ports, NO_VIEW))
  const every = (rows: readonly TreeRow[]): TreeRow[] => rows.flatMap(r => [r, ...every(r.children ?? [])])
  const rows = groups.flatMap(g => every(g.rows))
  for (const [id, columns, expected] of WORLD_LINES) {
    const r = findTreeRow(groups, id) as TreeRow
    expect(r, id).toBeDefined()
    const lines = quickLines(r, solved(rows, columns), columns)
    expect(shape(lines), `${id} at ${columns}`).toEqual(expected)
    for (const badge of r.extras ?? []) {
      expect(
        lines.flatMap(l => l.cells.map(c => c.text)),
        `${id} at ${columns}: no line holds the badge ${badge.text}`,
      ).not.toContain(badge.text)
    }
  }
})

// ---- one row per line ------------------------------------------------------------------------------------------------------

test('every line of the quick view takes one row at 96 and at 49 cells, however long its text, and a link is cut in the middle', () => {
  const long = pr({
    detail: () => [
      { label: 'question', cell: { text: 'word '.repeat(300) } },
      { label: 'plan', cell: { text: 'x'.repeat(2000) } },
    ],
  })
  for (const columns of [96, 49, 40, 24]) {
    const lines = quick(long, columns)
    expect(lines.length, String(columns)).toBeGreaterThan(0)
    for (const line of lines) {
      expect(heightOf(statusLineBox(EL, line, columns), columns), `${columns} ${line.label}`).toBe(1)
    }
  }
  const link = quick(pr(), 49).find(l => l.label === 'link:') as StatusLine
  const words = texts(statusLineBox(EL, link, 49)).map(([, s]) => s)
  expect(words[0]).toBe('link:')
  expect(words[1]?.startsWith('https://github.com/')).toBe(true) // the head of the address stays
  expect(words[1]?.endsWith('/pull/262')).toBe(true) // and so does its tail
  expect(words[1]).toContain('…')
})

test('a line that carries an href draws plain text: no Link and no Tab stop, and the cell keeps no href', () => {
  // A tracker's detail() line can hold a link cell. The quick view draws it as text: a Link would be a stop for the ring.
  const r = pr({ detail: () => [{ label: 'about', cell: { text: 'docs', href: PULL } }] })
  const lines = quick(r, 49)
  const about = lines.find(l => l.label === 'about:') as StatusLine
  expect(about.cells[0]?.href).toBeUndefined()
  expect(nodes(statusLineBox(EL, about, 49), 'Link')).toHaveLength(0)
  // And the link line the table cut makes, which has no href of its own, draws no Link either.
  const link = lines.find(l => l.label === 'link:') as StatusLine
  expect(nodes(statusLineBox(EL, link, 49), 'Link')).toHaveLength(0)
})
