// Row cases of the item trackers that the legacy view tests held (plan L6, Task 13): the Jira tree and its nesting (#48),
// the Jira and GitHub status words, and the checks cell. Pure: they call the row builders and `nestedJira` with small
// synthetic records. The pane-world cases are in item-sections.test.ts.
import { expect, test } from 'claude-code/testing'
import type { Effective } from '../core/interfaces/items'
import type { Cell, TreeRow } from '../core/interfaces/view'
import { addReason } from '../core/lib/reasons'
import { githubRow } from '../trackers/github/rows'
import { jiraSiteKey, nestedJira } from '../trackers/jira/nested'
import { type JiraEnv, jiraRow, trackedOf } from '../trackers/jira/rows'
import type { GitHubRecord, JiraNode, JiraRecord, ToolStatus } from './fixtures/contracts'
import { MENTIONED, reasonsOfSources } from './fixtures/reasons'

const SITE = 'acme.atlassian.net'
const acli = (site: string | null): ToolStatus => ({
  name: 'acli',
  available: true,
  loggedIn: true,
  breaker: 'closed',
  ...(site === null ? {} : { site }),
})
/** The active site is `site`; `null`: acli names none. */
const env = (site: string | null = SITE, levels: Record<string, Effective> = {}): JiraEnv => ({
  tools: { acli: acli(site) },
  levelOf: key => levels[key] ?? {},
})

const base = (key: string, url: string, label: string, firstSeen: number) => ({
  key,
  url,
  label,
  sources: ['prompt' as const],
  reasons: MENTIONED,
  firstSeen,
  lastSeen: firstSeen,
  seenCount: 1,
})

const node = (key: string, status: string, statusCategory: string, children: JiraNode[] = []): JiraNode => ({
  key,
  summary: 'S ' + key,
  issueType: 'Story',
  status,
  statusCategory,
  children,
})

const jira = (issueKey: string, over: Partial<JiraRecord> = {}): JiraRecord => ({
  ...base(`jira:${SITE}/${issueKey}`, `https://${SITE}/browse/${issueKey}`, issueKey, 10),
  category: 'jira',
  site: SITE,
  issueKey,
  trackOnly: false,
  children: [],
  ...over,
})

const text = (row: TreeRow | undefined, id: string): string => row?.cells[id]?.text ?? '<no cell>'
const cellOf = (row: TreeRow | undefined, id: string): Cell => row?.cells[id] ?? { text: '<no cell>' }

/** Every row of a tree with its depth, parents first. */
function flat(rows: readonly TreeRow[], depth = 0): { row: TreeRow; depth: number }[] {
  return rows.flatMap(row => [{ row, depth }, ...flat(row.children ?? [], depth + 1)])
}

/** The root rows of a Jira section made from `records`, as the section builds them (a nested record has none). */
function rootsOf(records: readonly JiraRecord[], e: JiraEnv = env()): TreeRow[] {
  const nested = nestedJira(records)
  const tracked = trackedOf(records, e.levelOf)
  return records.filter(r => !nested.has(jiraSiteKey(r.site, r.issueKey))).map(r => jiraRow(r, e, tracked))
}

const keysOf = (rows: readonly TreeRow[]) => flat(rows).map(({ row, depth }) => [text(row, 'key'), depth])

// ---------------------------------------------------------------- the Jira tree

const epic = jira('ISS-101', {
  summary: 'Onboarding',
  issueType: 'Epic',
  status: 'In Progress',
  statusCategory: 'indeterminate',
  children: [
    node('ISS-102', 'In Progress', 'indeterminate', [node('ISS-103', 'Done', 'done')]),
    node('ISS-110', 'To Do', 'new'),
  ],
})

test('jira tree: root, children and subtasks with depth, ids, links and tones', () => {
  const rows = flat(rootsOf([epic]))
  expect(rows.map(({ row, depth }) => [row.id, depth])).toEqual([
    [`jira:${SITE}/ISS-101`, 0],
    [`jira:${SITE}/ISS-101/ISS-102`, 1],
    [`jira:${SITE}/ISS-101/ISS-102/ISS-103`, 2],
    [`jira:${SITE}/ISS-101/ISS-110`, 1],
  ])
  const [root, child, sub, leaf] = rows.map(r => r.row)
  expect([text(root, 'key'), text(root, 'title'), text(root, 'type')]).toEqual(['ISS-101', 'Onboarding', 'Epic'])
  expect(cellOf(root, 'status')).toEqual({ text: 'In Progress', fg: 'warning' })
  expect(cellOf(root, 'key').href).toBe(`https://${SITE}/browse/ISS-101`)
  expect(cellOf(child, 'key').href).toBe(`https://${SITE}/browse/ISS-102`)
  expect(cellOf(sub, 'status')).toEqual({ text: 'Done', fg: 'success' })
  expect(cellOf(leaf, 'status')).toEqual({ text: 'To Do' })
  expect(root?.expandedByDefault).toBe(true)
  expect(sub?.expandedByDefault).toBeUndefined() // a leaf has nothing to open
})

test('jira child rows sort by priority inside their parent and stay in the tree', () => {
  const parent = jira('ISS-1', {
    summary: 'Parent',
    issueType: 'Epic',
    children: [
      node('ISS-2', 'In Progress', 'indeterminate'),
      { ...node('ISS-3', 'To Do', 'new'), priority: 'high' },
      { ...node('ISS-4', 'Done', 'done'), priority: 'low' },
    ],
  })
  expect(keysOf(rootsOf([parent])).map(([key]) => key)).toEqual(['ISS-1', 'ISS-3', 'ISS-2', 'ISS-4'])
})

test('jira title falls back to the label; not-found wins over everything', () => {
  const [row] = rootsOf([jira('ISS-5', { error: { kind: 'not-found', message: 'x', at: 1 } })])
  expect(text(row, 'title')).toBe('ISS-5')
  expect(cellOf(row, 'status')).toEqual({ text: 'not found', fg: 'error' })
})

test('jira on another site, or flagged trackOnly, shows track-only; an unknown active site does not', () => {
  const other = jira('ISS-200', { site: 'other.atlassian.net', status: 'Done', statusCategory: 'done' })
  expect(cellOf(rootsOf([other])[0], 'status')).toEqual({ text: 'track-only', dim: true })
  expect(cellOf(rootsOf([jira('ISS-201', { trackOnly: true })])[0], 'status')).toEqual({
    text: 'track-only',
    dim: true,
  })
  // The site comparison ignores case.
  const upper = jira('ISS-202', { site: SITE.toUpperCase(), status: 'To Do', statusCategory: 'new' })
  expect(text(rootsOf([upper])[0], 'status')).toBe('To Do')
  // With no active site known, a record is not track-only on that ground.
  expect(text(rootsOf([other], env(null))[0], 'status')).toBe('Done')
})

// ---------------------------------------------------------------- tracked Jira records drawn under another root (#48)

const subVia = ['gh:github.com/o/r#2659']
const subNode = (key: string) => ({ ...node(key, 'To Do', 'new'), summary: 'Sub ' + key, issueType: 'Sub-task' })
const subParent = jira('BUG-3184', {
  summary: 'Parent',
  issueType: 'Bug',
  status: 'In Progress',
  statusCategory: 'indeterminate',
  via: subVia,
  firstSeen: 1,
  children: [subNode('BUG-3202'), subNode('BUG-3203')],
})
const trackedSub = (key: string, firstSeen: number, over: Partial<JiraRecord> = {}) =>
  jira(key, {
    summary: 'Sub ' + key,
    issueType: 'Sub-task',
    status: 'To Do',
    statusCategory: 'new',
    via: subVia,
    firstSeen,
    ...over,
  })
const sub1 = trackedSub('BUG-3202', 2)
const sub2 = trackedSub('BUG-3203', 3)
const nestedKeys = (records: readonly JiraRecord[]) => [...nestedJira(records)].sort()

test('tracked jira child: renders once, nested under the shown parent', () => {
  expect(keysOf(rootsOf([subParent, sub1, sub2]))).toEqual([
    ['BUG-3184', 0],
    ['BUG-3202', 1],
    ['BUG-3203', 1],
  ])
  expect(nestedKeys([subParent, sub1, sub2])).toEqual([`${SITE}/BUG-3202`, `${SITE}/BUG-3203`])
})

test('tracked jira child: the nested row keeps the via marker and the level of the record, but no dismiss control', () => {
  const high = trackedSub('BUG-3202', 2, { priority: 'high' })
  const e = env(SITE, { [high.key]: { level: 'high' } })
  const [root] = rootsOf([subParent, high, sub2], e)
  const nested = root?.children?.[0]
  expect(nested?.id).toBe(`${subParent.key}/BUG-3202`)
  expect(text(nested, 'title')).toBe('↳#2659 Sub BUG-3202')
  expect(text(nested, 'prio')).toBe('▲')
  expect(nested?.can).toEqual({ dismiss: false, priority: true })
  expect(root?.can).toEqual({ dismiss: true, priority: true })
})

test('tracked jira child: the nested row carries the reasons of its own record, not those of the root (#62)', () => {
  const read = trackedSub('BUG-3202', 2, { sources: ['tool'], reasons: reasonsOfSources(['prompt', 'tool']) })
  expect(read.reasons).not.toEqual(subParent.reasons)
  const [root] = rootsOf([subParent, read, sub2])
  expect(root?.reasons).toEqual(subParent.reasons)
  const [first, second] = root?.children ?? []
  expect(first?.id).toBe(`${subParent.key}/BUG-3202`)
  expect(first?.reasons).toEqual(read.reasons)
  expect(second?.id).toBe(`${subParent.key}/BUG-3203`)
  expect(second?.reasons).toEqual(sub2.reasons)
})

test('tracked jira child: a record named by two PRs shows both on its nested row', () => {
  const both = trackedSub('BUG-3202', 2, {
    sources: ['prompt'],
    reasons: addReason(reasonsOfSources(['prompt']), 'discovered'),
    via: ['gh:github.com/o/r#1', 'gh:github.com/o/r#2'],
  })
  const rows = flat(rootsOf([subParent, both])).map(r => r.row)
  expect(rows.filter(r => text(r, 'key') === 'BUG-3202')).toHaveLength(1)
  expect(text(rows[1], 'title')).toBe('↳#1,#2 Sub BUG-3202')
})

test('tracked jira child: without the parent (dismissed or never tracked) the children are roots', () => {
  expect(keysOf(rootsOf([sub1, sub2]))).toEqual([
    ['BUG-3202', 0],
    ['BUG-3203', 0],
  ])
  const other = jira('OTHER-1', { firstSeen: 4, children: [node('OTHER-2', 'To Do', 'new')] })
  expect(
    keysOf(rootsOf([subParent, other]))
      .filter(([, depth]) => depth === 0)
      .map(([key]) => key),
  ).toEqual(['BUG-3184', 'OTHER-1'])
})

test('tracked jira child: an epic, a task and a sub-task, all tracked: only the epic is a root', () => {
  const records = (children: JiraNode[]) => [
    jira('EP-1', { firstSeen: 1, children }),
    jira('T-1', { firstSeen: 2, children: [node('S-1', 'To Do', 'new')] }),
    jira('S-1', { firstSeen: 3 }),
  ]
  const tree = [node('T-1', 'To Do', 'new', [node('S-1', 'To Do', 'new')])]
  expect(keysOf(rootsOf(records(tree)))).toEqual([
    ['EP-1', 0],
    ['T-1', 1],
    ['S-1', 2],
  ])
  // The epic's snapshot can stop at the task. The sub-task then stays a root: it never vanishes.
  expect(keysOf(rootsOf(records([node('T-1', 'To Do', 'new')])))).toEqual([
    ['EP-1', 0],
    ['T-1', 1],
    ['S-1', 0],
  ])
})

test('tracked jira child: identity is site and key: case does not matter, another site does', () => {
  const a = jira('A-1', { firstSeen: 1, site: 'ACME.Atlassian.net', children: [node('a-2', 'To Do', 'new')] })
  expect(keysOf(rootsOf([a, jira('A-2', { firstSeen: 2 })]))).toEqual([
    ['A-1', 0],
    ['a-2', 1],
  ])
  const elsewhere = jira('A-2', {
    ...base('jira:other.atlassian.net/A-2', 'https://other.atlassian.net/browse/A-2', 'A-2', 2),
    site: 'other.atlassian.net',
  })
  const rows = rootsOf([a, elsewhere])
  expect(keysOf(rows)).toEqual([
    ['A-1', 0],
    ['a-2', 1],
    ['A-2', 0],
  ])
  expect(cellOf(rows[1], 'key').href).toContain('other.atlassian.net')
})

test('tracked jira child: a cycle in stale data keeps every record as a root', () => {
  const ring = (keys: string[]) =>
    keys.map((k, i) => jira(k, { firstSeen: i + 1, children: [node(keys[(i + 1) % keys.length]!, 'To Do', 'new')] }))
  expect(nestedKeys(ring(['A', 'B']))).toEqual([])
  expect(nestedKeys(ring(['A', 'B', 'C']))).toEqual([])
  expect(rootsOf(ring(['A', 'B', 'C'])).map(r => text(r, 'key'))).toEqual(['A', 'B', 'C'])
})

// ---------------------------------------------------------------- GitHub status words

const gh = (over: Partial<GitHubRecord> = {}): GitHubRecord => ({
  ...base('gh:github.com/o/r#1', 'https://github.com/o/r/pull/1', '#1', 20),
  category: 'github',
  host: 'github.com',
  owner: 'o',
  repo: 'r',
  number: 1,
  type: 'pr',
  ...over,
})
const ghEnv = { facts: { read: () => undefined }, levelOf: () => ({}) } as unknown as Parameters<typeof githubRow>[1]

test('github status and tone: open ok, merged and closed dim, draft dim, not found bad', () => {
  const st = (over: Partial<GitHubRecord>) => cellOf(githubRow(gh(over), ghEnv), 'status')
  expect(st({ state: 'open' })).toEqual({ text: 'open', fg: 'success' })
  expect(st({ state: 'merged' })).toEqual({ text: 'merged', dim: true })
  expect(st({ state: 'closed' })).toEqual({ text: 'closed', dim: true })
  expect(st({ state: 'open', isDraft: true })).toEqual({ text: 'draft', dim: true })
  expect(st({ error: { kind: 'not-found', message: 'x', at: 1 } })).toEqual({ text: 'not found', fg: 'error' })
  expect(text(githubRow(gh({ type: 'issue' }), ghEnv), 'type')).toBe('Issue')
})

test('github checks: failure red, pending yellow, success green; none and absent leave the cell empty', () => {
  const extra = (checks: GitHubRecord['checks']) => cellOf(githubRow(gh({ state: 'open', checks }), ghEnv), 'extra')
  expect(extra('failure')).toEqual({ text: '✗ checks', fg: 'error' })
  expect(extra('pending')).toEqual({ text: '… checks', fg: 'warning' })
  expect(extra('success')).toEqual({ text: '✓ checks', fg: 'success' })
  expect(extra('none').text).toBe('')
  expect(extra(undefined).text).toBe('')
})
