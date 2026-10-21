// The views of the pane (issue #63, L3): by list, by tracker, by status, by reason and flat. A view groups, sorts and filters on
// the facets of the top-level rows and never on the text of a cell. Pure.
import { expect, test } from 'claude-code/testing'
import type { Effective } from '../core/interfaces/items'
import type { CoreReason } from '../core/interfaces/reasons'
import type { Facets, GroupSpec, RowStatus, SectionSpec, StatusToken, TreeRow, ViewId } from '../core/interfaces/view'
import {
  groupId,
  isViewId,
  listGroups,
  nextView,
  resolveView,
  VIEW_IDS,
  viewGroups,
  viewSummary,
} from '../core/lib/grouping'

const status = (token: StatusToken, label: string = token): RowStatus => ({ label, token })

/** Every row says the same cell text. Only the facets, the owner and the reasons tell the rows apart. */
const row = (
  id: string,
  facets: Facets = {},
  extra: Partial<TreeRow> & { reason?: CoreReason; owner?: string } = {},
): TreeRow => {
  const { reason, owner = 't', ...rest } = extra
  return {
    id,
    owner,
    cells: { name: { text: 'same' }, description: { text: 'same' }, status: { text: 'same' } },
    facets,
    ...(reason ? { reasons: { first: reason, all: [reason], strongest: reason } } : {}),
    ...rest,
  }
}
const withStatus = (
  id: string,
  token: StatusToken,
  more: Facets = {},
  extra: Parameters<typeof row>[2] = {},
): TreeRow => row(id, { status: status(token), ...more }, extra)
const section = (id: string, rows: TreeRow[], over: Partial<SectionSpec> = {}): SectionSpec => ({
  id,
  title: id.toUpperCase(),
  rows,
  ...over,
})
const ids = (rows: readonly TreeRow[]): string[] => rows.map(r => r.id)
const OFF = { touchedOnly: false }
const byId = (groups: readonly GroupSpec[]): Record<string, string[]> =>
  Object.fromEntries(groups.map(g => [g.id, ids(g.rows)]))
const level = (l: Effective): Facets => ({ level: l })

// ---------------------------------------------------------------- the ids and the cycle

test('the five views are by list, by tracker, by status, by reason and flat', () => {
  expect(VIEW_IDS).toEqual(['list', 'tracker', 'status', 'reason', 'flat'])
  for (const v of VIEW_IDS) expect(isViewId(v)).toBe(true)
  for (const bad of ['', 'List', 'type', 'level', 'toString', 7, null, undefined]) expect(isViewId(bad)).toBe(false)
})

test('g takes the next view of the list and wraps; a view the list lacks goes to its first view', () => {
  const views: ViewId[] = ['list', 'status', 'flat']
  expect(nextView('list', views)).toBe('status')
  expect(nextView('status', views)).toBe('flat')
  expect(nextView('flat', views)).toBe('list')
  // By tracker was set with /track view: it is not in the list, so g starts the cycle.
  expect(nextView('tracker', views)).toBe('list')
  expect(nextView('list', ['list'])).toBe('list')
  expect(nextView('flat', [])).toBe('flat')
})

test('the view is the choice of the person, else the configured view; a value that is no view is no choice', () => {
  expect(resolveView('flat', 'list')).toBe('flat')
  expect(resolveView(null, 'status')).toBe('status')
  expect(resolveView('bogus', 'status')).toBe('status')
  expect(resolveView('', 'tracker')).toBe('tracker')
})

test('the summary says the view, then the filter with the rows it hid, then whether the ended rows show', () => {
  const base = { view: 'status' as const, touchedOnly: false, showAll: false, hidden: 0 }
  expect(viewSummary(base)).toBe('View: status')
  expect(viewSummary({ ...base, touchedOnly: true })).toBe('View: status · touched only')
  expect(viewSummary({ ...base, touchedOnly: true, hidden: 3 })).toBe('View: status · touched only · 3 hidden')
  // A count of hidden rows means nothing while the filter is off.
  expect(viewSummary({ ...base, hidden: 3 })).toBe('View: status')
  expect(viewSummary({ ...base, touchedOnly: true, hidden: 1, showAll: true })).toBe(
    'View: status · touched only · 1 hidden · showing all',
  )
})

// ---------------------------------------------------------------- by list

test('by list is today: one group for each section, in order, with the notes, as listGroups gives them', () => {
  const sections = [
    section('prs', [withStatus('a', 'active'), withStatus('b', 'failed')], { note: { text: 'gh · ok' } }),
    section('web', [row('c')], { empty: 'none' }),
    section('empty', [], { empty: 'nothing here' }),
  ]
  const { groups, hidden } = viewGroups(sections, 'list', OFF)
  expect(groups).toEqual(listGroups(sections))
  expect(groups.map(g => g.id)).toEqual(['list:prs', 'list:web', 'list:empty'])
  expect(hidden).toBe(0)
})

test('by list keeps the order of the rows that a tracker gave: no re-sort', () => {
  const rows = [row('z', { firstSeen: 1 }), row('a', { firstSeen: 9 }), row('m', { firstSeen: 5 })]
  expect(ids(viewGroups([section('s', rows)], 'list', OFF).groups[0]?.rows ?? [])).toEqual(['z', 'a', 'm'])
})

test('by list keeps a tree whole: the children of the root stay below it', () => {
  const root = row('root', {}, { lift: true, children: [withStatus('kid', 'failed')] })
  const [g] = viewGroups([section('agents', [root], { count: 2 })], 'list', OFF).groups
  expect(g?.rows[0]?.children?.map(c => c.id)).toEqual(['kid'])
  expect(g?.count).toBe(2)
  expect(g?.failing).toBe(1)
})

// ---------------------------------------------------------------- pinned

test('a row at level top, or at the high that the person set, is pinned: first group, in every view, drawn once', () => {
  const sections = [
    section('prs', [
      withStatus('star', 'active', level({ level: 'top', auto: true })),
      withStatus('mine', 'failed', level({ level: 'high' })),
      withStatus('plain', 'active', level({ level: 'normal' })),
    ]),
    section('web', [row('link', level({ level: 'low' }))]),
  ]
  for (const view of VIEW_IDS) {
    const { groups } = viewGroups(sections, view, OFF)
    expect(groups[0]?.id).toBe(groupId(view, 'pinned'))
    expect(groups[0]?.title).toBe('Pinned')
    expect(ids(groups[0]?.rows ?? [])).toEqual(['star', 'mine'])
    const rest = groups.slice(1).flatMap(g => ids(g.rows))
    expect(rest.sort()).toEqual(['link', 'plain'])
  }
})

test('a high that a rule gave (auto) is no pin: only the high of the person is', () => {
  const sections = [
    section('github', [
      withStatus('issue', 'active', level({ level: 'high', auto: true })),
      withStatus('chosen', 'active', level({ level: 'high' })),
    ]),
  ]
  const { groups } = viewGroups(sections, 'list', OFF)
  expect(byId(groups)).toEqual({ 'list:pinned': ['chosen'], 'list:github': ['issue'] })
})

test('the pinned group sorts by level (top first), then first seen, then id; its count and failing follow its rows', () => {
  const sections = [
    section('s', [
      withStatus('h2', 'failed', { level: { level: 'high' }, firstSeen: 2 }),
      withStatus('h1b', 'active', { level: { level: 'high' }, firstSeen: 1 }),
      withStatus('h1a', 'active', { level: { level: 'high' }, firstSeen: 1 }),
      withStatus('t', 'active', { level: { level: 'top', auto: true }, firstSeen: 9 }),
    ]),
  ]
  const [pinned] = viewGroups(sections, 'status', OFF).groups
  expect(ids(pinned?.rows ?? [])).toEqual(['t', 'h1a', 'h1b', 'h2'])
  expect(pinned?.count).toBe(4)
  expect(pinned?.failing).toBe(1)
})

test('by list: a pinned row leaves its section, and the count of a section that sets one follows', () => {
  const sections = [
    section('prs', [withStatus('a', 'active', level({ level: 'high' })), withStatus('b', 'active')]),
    section('tree', [row('root', {}, { children: [row('c1'), row('c2')] })], { count: 3 }),
  ]
  const { groups } = viewGroups(sections, 'list', OFF)
  expect(groups.map(g => [g.id, g.count])).toEqual([
    ['list:pinned', 1],
    ['list:prs', 1],
    ['list:tree', 3],
  ])
  // A pinned tree takes its children with it: the section count drops by the rows of the whole tree.
  const trees = [
    section('tree', [row('p', level({ level: 'high' }), { children: [row('k')] }), row('q')], { count: 3 }),
  ]
  expect(viewGroups(trees, 'list', OFF).groups.map(g => [g.id, g.count])).toEqual([
    ['list:pinned', 1],
    ['list:tree', 1],
  ])
})

test('no pinned row, no Pinned group; a section whose rows are all pinned stays, with no row', () => {
  expect(viewGroups([section('s', [row('a')])], 'list', OFF).groups.map(g => g.id)).toEqual(['list:s'])
  const all = [section('s', [row('a', level({ level: 'high' }))], { note: { text: 'gh · ok' } })]
  const { groups } = viewGroups(all, 'list', OFF)
  expect(groups.map(g => [g.id, g.rows.length, g.count])).toEqual([
    ['list:pinned', 1, 1],
    ['list:s', 0, 0],
  ])
  expect(groups[1]?.note).toEqual({ text: 'gh · ok' })
})

// ---------------------------------------------------------------- by status

test('by status groups on the token of the row, in the order failed, waiting, active, done, gone, none', () => {
  const sections = [
    section('a', [withStatus('n1', 'none'), withStatus('d1', 'done'), withStatus('ac1', 'active')]),
    section('b', [withStatus('f1', 'failed'), withStatus('w1', 'waiting'), withStatus('g1', 'gone'), row('bare')]),
  ]
  const { groups } = viewGroups(sections, 'status', OFF)
  expect(groups.map(g => g.id)).toEqual([
    'status:failed',
    'status:waiting',
    'status:active',
    'status:done',
    'status:gone',
    'status:none',
  ])
  expect(groups.map(g => g.title)).toEqual(['Failed', 'Waiting', 'Active', 'Done', 'Gone', 'No status'])
  expect(byId(groups)).toEqual({
    'status:failed': ['f1'],
    'status:waiting': ['w1'],
    'status:active': ['ac1'],
    'status:done': ['d1'],
    'status:gone': ['g1'],
    'status:none': ['bare', 'n1'],
  })
  expect(groups.map(g => g.count)).toEqual([1, 1, 1, 1, 1, 2])
})

test('by status reads the token, never the text: the same cells with other tokens give other groups', () => {
  const sections = [section('s', [withStatus('x', 'failed'), withStatus('y', 'active')])]
  expect(byId(viewGroups(sections, 'status', OFF).groups)).toEqual({ 'status:failed': ['x'], 'status:active': ['y'] })
  const swapped = [section('s', [withStatus('x', 'active'), withStatus('y', 'failed')])]
  expect(byId(viewGroups(swapped, 'status', OFF).groups)).toEqual({ 'status:failed': ['y'], 'status:active': ['x'] })
})

test('by status leaves out a group with no row, and no group at all when there is no row', () => {
  expect(viewGroups([section('s', [withStatus('a', 'done')])], 'status', OFF).groups.map(g => g.id)).toEqual([
    'status:done',
  ])
  expect(viewGroups([section('s', [], { empty: 'none' })], 'status', OFF).groups).toEqual([])
  expect(viewGroups([], 'flat', OFF).groups).toEqual([])
})

test('a tree lands in the failed group when a row below it failed, and the title counts it once', () => {
  const jira = withStatus('epic', 'active', {}, { children: [withStatus('sub', 'failed')] })
  const calm = withStatus('calm', 'active', {}, { children: [withStatus('sub2', 'done')] })
  const { groups } = viewGroups([section('jira', [jira, calm])], 'status', OFF)
  expect(byId(groups)).toEqual({ 'status:failed': ['epic'], 'status:active': ['calm'] })
  expect(groups[0]?.failing).toBe(1)
  // A Jira sub-task stays a child of its parent in every view.
  for (const view of VIEW_IDS) {
    const all = viewGroups([section('jira', [jira])], view, OFF).groups.flatMap(g => g.rows)
    expect(all.map(r => r.id)).toEqual(['epic'])
    expect(all[0]?.children?.map(c => c.id)).toEqual(['sub'])
  }
})

// ---------------------------------------------------------------- trees that lift

/** The Agents section: a master root over a healthy agent, a failed one, and a run that folded around a failed member. */
const agents = (): SectionSpec =>
  section(
    'agents',
    [
      row(
        'ag:master',
        { status: status('active', 'running') },
        {
          lift: true,
          children: [
            withStatus('ag:ok', 'active', { firstSeen: 5 }, { lift: true }),
            withStatus('ag:bad', 'failed', { firstSeen: 6 }, { lift: true }),
            withStatus(
              'ag:nest',
              'active',
              { firstSeen: 7 },
              { lift: true, children: [withStatus('ag:deep', 'failed', { firstSeen: 8 }, { lift: true })] },
            ),
            withStatus(
              'ag:wf:run',
              'failed',
              { firstSeen: 4 },
              { children: [withStatus('ag:m1', 'failed'), withStatus('ag:m2', 'done')] },
            ),
          ],
        },
      ),
    ],
    { count: 6 },
  )

test('a failed sub-agent lands in the failed group, not under its healthy master', () => {
  const { groups } = viewGroups([agents()], 'status', OFF)
  const failed = groups.find(g => g.id === 'status:failed')
  expect(ids(failed?.rows ?? [])).toEqual(['ag:wf:run', 'ag:bad', 'ag:deep'])
  expect(failed?.count).toBe(3)
  // The master, the healthy agent and the one with a failed child stay out of the failed group.
  const active = groups.find(g => g.id === 'status:active')
  expect(ids(active?.rows ?? [])).toEqual(['ag:master', 'ag:ok', 'ag:nest'])
})

test('a view other than by list lifts the children of a row that says lift; the lifted row keeps no child', () => {
  const { groups } = viewGroups([agents()], 'flat', OFF)
  const rows = groups[0]?.rows ?? []
  expect(ids(rows)).toEqual(['ag:master', 'ag:wf:run', 'ag:ok', 'ag:bad', 'ag:nest', 'ag:deep'])
  expect(rows.find(r => r.id === 'ag:master')?.children).toBeUndefined()
  expect(rows.find(r => r.id === 'ag:nest')?.children).toBeUndefined()
  // A folded run is one unit: it has no lift, so its members stay below it.
  expect(rows.find(r => r.id === 'ag:wf:run')?.children?.map(c => c.id)).toEqual(['ag:m1', 'ag:m2'])
})

test('by list does not lift: the tree is the one the tracker gave, as the same row', () => {
  const section0 = agents()
  const [g] = viewGroups([section0], 'list', OFF).groups
  expect(g?.rows[0]).toBe(section0.rows[0])
})

test('the rows of a lifted tree sort as the rows of a group: level, then first seen, then id', () => {
  const sections = [agents(), section('web', [row('w', { firstSeen: 1 })])]
  const [g] = viewGroups(sections, 'flat', OFF).groups
  // No first sighting (the master) sorts first, then by first seen: the run (4), the web link (1) comes before both.
  expect(ids(g?.rows ?? [])).toEqual(['ag:master', 'w', 'ag:wf:run', 'ag:ok', 'ag:bad', 'ag:nest', 'ag:deep'])
})

// ---------------------------------------------------------------- flat, by tracker, by reason

test('flat is one group of every row, sorted by level, first seen and id', () => {
  const sections = [
    section('a', [
      withStatus('late', 'active', { firstSeen: 9 }),
      withStatus('low', 'active', { firstSeen: 1, level: { level: 'low' } }),
    ]),
    section('b', [withStatus('b2', 'failed', { firstSeen: 2 }), withStatus('b1', 'done', { firstSeen: 2 })]),
  ]
  const { groups } = viewGroups(sections, 'flat', OFF)
  expect(groups.map(g => [g.id, g.title, g.count, g.failing])).toEqual([['flat:all', 'All', 4, 1]])
  // normal rows by first seen then id, the low row after them.
  expect(ids(groups[0]?.rows ?? [])).toEqual(['b1', 'b2', 'late', 'low'])
})

test('by tracker groups on the owner of the row, in the order the owners first show, titled by their sections', () => {
  const sections = [
    section('worktrees', [row('wt', {}, { owner: 'auto' })], { title: 'Worktrees' }),
    section('agents', [row('ag', {}, { owner: 'auto' })], { title: 'Agents' }),
    section('prs', [row('pr', {}, { owner: 'github' })], { title: 'Pull requests' }),
    section('jira', [row('j', {}, { owner: 'jira' })], { title: 'Jira work items' }),
    section('github', [row('is', {}, { owner: 'github' })], { title: 'GitHub' }),
  ]
  const { groups } = viewGroups(sections, 'tracker', OFF)
  expect(groups.map(g => [g.id, g.title])).toEqual([
    ['tracker:auto', 'Worktrees, Agents'],
    ['tracker:github', 'Pull requests, GitHub'],
    ['tracker:jira', 'Jira work items'],
  ])
  // The rows of a group sort by level, first seen and id: none has a first sighting here, so the id decides.
  expect(byId(groups)).toEqual({ 'tracker:auto': ['ag', 'wt'], 'tracker:github': ['is', 'pr'], 'tracker:jira': ['j'] })
})

test('by reason groups on the strongest reason, strongest first, and puts a row with no reason in Context last', () => {
  const sections = [
    section('s', [
      row('m', {}, { reason: 'mentioned' }),
      row('c', {}, { reason: 'created' }),
      row('ctx'),
      row('d', {}, { reason: 'discovered' }),
      row('u', {}, { reason: 'updated' }),
    ]),
  ]
  const { groups } = viewGroups(sections, 'reason', OFF)
  expect(groups.map(g => [g.id, g.title])).toEqual([
    ['reason:created', 'Created'],
    ['reason:updated', 'Updated'],
    ['reason:discovered', 'Discovered'],
    ['reason:mentioned', 'Mentioned'],
    ['reason:context', 'Context'],
  ])
  expect(groups.map(g => ids(g.rows))).toEqual([['c'], ['u'], ['d'], ['m'], ['ctx']])
})

// ---------------------------------------------------------------- touched only

test('touched only hides the top-level rows that were discovered or mentioned, and counts them; context stays', () => {
  const sections = [
    section('prs', [
      row('found', {}, { reason: 'discovered' }),
      row('named', {}, { reason: 'mentioned' }),
      row('made', {}, { reason: 'created' }),
      row('seen', {}, { reason: 'read' }),
      row('ctx'),
    ]),
  ]
  const { groups, hidden } = viewGroups(sections, 'list', { touchedOnly: true })
  expect(ids(groups[0]?.rows ?? [])).toEqual(['made', 'seen', 'ctx'])
  expect(groups[0]?.count).toBe(3)
  expect(hidden).toBe(2)
  for (const view of VIEW_IDS) expect(viewGroups(sections, view, { touchedOnly: true }).hidden).toBe(2)
  expect(viewGroups(sections, 'list', OFF).hidden).toBe(0)
})

test('touched only reads the strongest reason: a row that was mentioned and read stays', () => {
  const both = row('x', {}, { reasons: { first: 'mentioned', all: ['read', 'mentioned'], strongest: 'read' } })
  const { groups, hidden } = viewGroups([section('s', [both])], 'flat', { touchedOnly: true })
  expect(ids(groups[0]?.rows ?? [])).toEqual(['x'])
  expect(hidden).toBe(0)
})

test('touched only filters top-level rows: a child stays with its parent, and a lifted child is a row of its own', () => {
  const jira = row('epic', {}, { reason: 'created', children: [row('sub', {}, { reason: 'mentioned' })] })
  const kept = viewGroups([section('jira', [jira])], 'list', { touchedOnly: true })
  expect(kept.groups[0]?.rows[0]?.children?.map(c => c.id)).toEqual(['sub'])
  expect(kept.hidden).toBe(0)
  // The children of a lift row are rows of their own, so the filter reaches them in every view.
  const wt = row(
    'root',
    {},
    { lift: true, children: [row('found', {}, { reason: 'discovered' }), row('mine', {}, { reason: 'created' })] },
  )
  for (const view of VIEW_IDS) {
    const out = viewGroups([section('worktrees', [wt])], view, { touchedOnly: true })
    const rows = out.groups.flatMap(g => g.rows)
    const all = rows.flatMap(r => [r.id, ...(r.children ?? []).map(c => c.id)])
    expect(all).toContain('mine')
    expect(all).not.toContain('found')
    expect(out.hidden).toBe(1)
  }
})

test('touched only hides a row before it can be pinned', () => {
  const sections = [section('prs', [row('star', level({ level: 'top', auto: true }), { reason: 'discovered' })])]
  const { groups, hidden } = viewGroups(sections, 'status', { touchedOnly: true })
  expect(groups).toEqual([])
  expect(hidden).toBe(1)
})

// ---------------------------------------------------------------- caps and ids

test('every group id is <view>:<key>, so the caps never mistake a status group for a section', () => {
  const sections = [section('prs', [withStatus('a', 'failed')])]
  expect(viewGroups(sections, 'status', OFF).groups[0]?.id).toBe('status:failed')
  expect(viewGroups(sections, 'list', OFF).groups[0]?.id).toBe('list:prs')
  expect(viewGroups(sections, 'flat', OFF).groups[0]?.id).toBe('flat:all')
})
