// AcliTool: active site, view, Epic tree, error classes, breaker, concurrency. Pure, fake Runner.
import { expect, test } from 'claude-code/testing'
import type { JiraTarget, Runner, RunResult } from '../hooks/contracts'
import { AcliTool, classifyAcliFailure, limit, nodeFromIssue, parseAuthStatus } from '../hooks/tools/acli-tool'
import * as fx from './fixtures/acli'

const SITE = '<site>.atlassian.net'

const res = (stdout: string, exitCode = 0, stderr = ''): RunResult => ({ exitCode, stdout, stderr })
const authOk = () => res(fx.AUTH_STATUS_STDOUT, fx.AUTH_STATUS_EXIT, fx.AUTH_STATUS_STDERR)
const authNo = () =>
  res(fx.AUTH_STATUS_UNAUTHENTICATED_STDOUT, fx.AUTH_STATUS_UNAUTHENTICATED_EXIT, fx.AUTH_STATUS_UNAUTHENTICATED_STDERR)
const viewNet = () => res(fx.VIEW_NETWORK_FAILURE_STDOUT, fx.VIEW_NETWORK_FAILURE_EXIT, fx.VIEW_NETWORK_FAILURE_STDERR)
const viewUnknown = () => res(fx.VIEW_UNKNOWN_KEY_STDOUT, fx.VIEW_UNKNOWN_KEY_EXIT, fx.VIEW_UNKNOWN_KEY_STDERR)

/** The same JSON with another top-level key, so one fixture can stand in for several issues. */
function withKey(json: string, key: string): string {
  const o = JSON.parse(json) as { key: string }
  o.key = key
  return JSON.stringify(o)
}

type Handler = (argv: readonly string[]) => RunResult | Error | Promise<RunResult>

function setup(handler: Handler) {
  const calls: string[][] = []
  const clock = { t: 1_000 }
  const run: Runner = async argv => {
    calls.push([...argv])
    const a = await handler(argv)
    if (a instanceof Error) throw a
    return a
  }
  const tool = new AcliTool(run, () => clock.t)
  return { tool, calls, clock, views: () => calls.filter(c => c[3] === 'view') }
}

function item(issueKey: string, over: Partial<JiraTarget> = {}): JiraTarget {
  return { key: `jira:${SITE}/${issueKey}`, site: SITE, issueKey, trackOnly: false, children: [], ...over }
}

/** Lets other pending tasks run: a few microtask turns. */
const tick = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

const isAuth = (a: readonly string[]) => a[2] === 'auth'
const isSearch = (a: readonly string[]) => a[3] === 'search'

// ---------------------------------------------------------------- fixtures

test('every JSON fixture parses', () => {
  for (const j of [fx.TASK_VIEW_JSON, fx.SUBTASK_VIEW_JSON, fx.EPIC_VIEW_JSON, fx.EPIC_CHILDREN_JSON]) {
    expect(() => JSON.parse(j)).not.toThrow()
  }
})

// ---------------------------------------------------------------- pure helpers

test('parseAuthStatus reads the site from the Site: line', () => {
  expect(parseAuthStatus(fx.AUTH_STATUS_STDOUT)).toBe(SITE)
  expect(parseAuthStatus('Site: https://Acme.Atlassian.net/\n')).toBe('acme.atlassian.net')
  expect(parseAuthStatus('')).toBe(null)
  expect(parseAuthStatus('✓ Authenticated\n')).toBe(null)
})

test('nodeFromIssue reads key, summary, type, status, category and subtasks', () => {
  const n = nodeFromIssue(JSON.parse(fx.TASK_VIEW_JSON))
  expect(n).toMatchObject({
    key: 'PROJ-200',
    summary: '<summary>',
    issueType: 'Task',
    status: 'Draft',
    statusCategory: 'new',
  })
  expect(n?.children.map(c => [c.key, c.issueType, c.status])).toEqual([
    ['PROJ-201', 'Sub-task', 'To Do'],
    ['PROJ-202', 'Sub-task', 'To Do'],
  ])
  expect(nodeFromIssue(null)).toBe(null)
  expect(nodeFromIssue({ fields: {} })).toBe(null)
  expect(nodeFromIssue({ key: 'A-1' })).toMatchObject({
    key: 'A-1',
    summary: '',
    issueType: '',
    status: '',
    children: [],
  })
})

test('classifyAcliFailure', () => {
  expect(classifyAcliFailure(fx.VIEW_UNKNOWN_KEY_STDERR)).toBe('item-error')
  expect(
    classifyAcliFailure('failed to parse JQL query: issue does not exist or you do not have permission to see it.'),
  ).toBe('item-error')
  expect(classifyAcliFailure(fx.AUTH_STATUS_UNAUTHENTICATED_STDERR)).toBe('auth')
  expect(classifyAcliFailure(fx.VIEW_NETWORK_FAILURE_STDERR)).toBe('tool-failure')
  expect(classifyAcliFailure('failed to parse JQL')).toBe('tool-failure')
  expect(classifyAcliFailure('')).toBe('tool-failure')
})

test('limit never runs more than n tasks at once and runs them all', async () => {
  const lim = limit(2)
  let active = 0
  let max = 0
  const done: number[] = []
  await Promise.all(
    [1, 2, 3, 4, 5].map(i =>
      lim(async () => {
        active++
        max = Math.max(max, active)
        await tick()
        active--
        done.push(i)
        return i
      }),
    ),
  )
  expect(max).toBe(2)
  expect(done.length).toBe(5)
})

// ---------------------------------------------------------------- active site

test('not logged in: site null, loggedIn false, no view, and no call at all on the next refresh', async () => {
  const { tool, calls } = setup(a => (isAuth(a) ? authNo() : new Error('unexpected')))
  const it = item('PROJ-200')
  await tool.refreshItems([it])
  expect(tool.activeSite).toBe(null)
  expect(tool.status().loggedIn).toBe(false)
  expect(calls).toEqual([['acli', 'jira', 'auth', 'status']])
  expect(it.refreshedAt).toBeUndefined()
  await tool.refreshItems([it])
  expect(calls.length).toBe(1)
  expect(tool.canCall(1_000)).toBe(false)
})

test('reset after not logged in loads the site again', async () => {
  let loggedIn = false
  const { tool, calls } = setup(a => (isAuth(a) ? (loggedIn ? authOk() : authNo()) : res(fx.TASK_VIEW_JSON)))
  const it = item('PROJ-200')
  await tool.refreshItems([it])
  loggedIn = true
  tool.reset()
  await tool.refreshItems([it])
  expect(tool.activeSite).toBe(SITE)
  expect(calls.filter(isAuth).length).toBe(2)
  expect(it.issueType).toBe('Task')
})

test('loadActiveSite: a network failure leaves the site unknown and counts as a failure', async () => {
  const { tool } = setup(() => res('', 1, '✗ Error: failed to retrieve authenticated status'))
  expect(await tool.loadActiveSite()).toBe(null)
  expect(tool.activeSite).toBeUndefined()
  expect(tool.status().loggedIn).toBe(null)
  expect(tool.status().lastError).toContain('failed to retrieve')
})

test('status().site is set after the load', async () => {
  const { tool } = setup(a => (isAuth(a) ? authOk() : res(fx.TASK_VIEW_JSON)))
  expect(tool.status().site).toBeUndefined()
  await tool.refreshItems([item('PROJ-200')])
  expect(tool.status().site).toBe(SITE)
  expect(tool.status().loggedIn).toBe(true)
})

// ---------------------------------------------------------------- view

test('a Task view fills summary, type, status, category and subtasks', async () => {
  const { tool, calls, clock } = setup(a => (isAuth(a) ? authOk() : res(fx.TASK_VIEW_JSON)))
  const it = item('PROJ-200', { error: { kind: 'failed', message: 'old', at: 1 } })
  await tool.refreshItems([it])
  expect(calls[1]).toEqual([
    'acli',
    'jira',
    'workitem',
    'view',
    'PROJ-200',
    '--fields',
    'issuetype,status,summary,parent,subtasks',
    '--json',
  ])
  expect(it).toMatchObject({
    summary: '<summary>',
    issueType: 'Task',
    status: 'Draft',
    statusCategory: 'new',
    refreshedAt: clock.t,
  })
  expect(it.error).toBeUndefined()
  expect(it.children.map(c => [c.key, c.issueType, c.status])).toEqual([
    ['PROJ-201', 'Sub-task', 'To Do'],
    ['PROJ-202', 'Sub-task', 'To Do'],
  ])
  expect(calls.length).toBe(2) // no search for a Task
})

test('a refresh keeps the priority the person set on a child, matched by key', async () => {
  const { tool } = setup(a => (isAuth(a) ? authOk() : res(fx.TASK_VIEW_JSON)))
  const old = (key: string, priority: 'high' | 'low' | 'normal') => ({
    key,
    priority,
    summary: '',
    issueType: '',
    status: '',
    children: [],
  })
  const it = item('PROJ-200', { children: [old('PROJ-202', 'high'), old('PROJ-999', 'low')] })
  await tool.refreshItems([it])
  // PROJ-201 is new: acli gives no mark, so it has none. PROJ-999 is gone, and its mark with it.
  expect(it.children.map(c => [c.key, c.priority])).toEqual([
    ['PROJ-201', undefined],
    ['PROJ-202', 'high'],
  ])
  expect('priority' in it.children[0]!).toBe(false)
})

test('a sub-task view has no children', async () => {
  const { tool } = setup(a => (isAuth(a) ? authOk() : res(fx.SUBTASK_VIEW_JSON)))
  const it = item('PROJ-205', { children: [{ key: 'X-1', summary: '', issueType: '', status: '', children: [] }] })
  await tool.refreshItems([it])
  expect(it).toMatchObject({ issueType: 'Sub-task', status: 'To Do', children: [] })
})

test('an Epic makes view, search, then one view per child and builds a 3-level tree', async () => {
  const { tool, calls } = setup(a => {
    if (isAuth(a)) return authOk()
    if (isSearch(a)) return res(fx.EPIC_CHILDREN_JSON)
    if (a[4] === 'PROJ-300') return res(fx.EPIC_VIEW_JSON)
    if (a[4] === 'PROJ-301') return res(withKey(fx.TASK_VIEW_JSON, 'PROJ-301')) // stands in for a child with subtasks
    if (a[4] === 'OTHER-5') return res(fx.SUBTASK_VIEW_JSON.replace('PROJ-205', 'OTHER-5'))
    return new Error('unexpected ' + a.join(' '))
  })
  const it = item('PROJ-300')
  await tool.refreshItems([it])
  expect(calls[1]?.[4]).toBe('PROJ-300')
  expect(calls[2]).toEqual([
    'acli',
    'jira',
    'workitem',
    'search',
    '--jql',
    'parent = PROJ-300',
    '--fields',
    'issuetype,status,summary',
    '--limit',
    '50',
    '--json',
  ])
  expect(
    calls
      .slice(3)
      .map(c => c[4])
      .sort(),
  ).toEqual(['OTHER-5', 'PROJ-301'])
  expect(it.issueType).toBe('Epic')
  expect(it.children.map(c => [c.key, c.issueType])).toEqual([
    ['OTHER-5', 'Task'],
    ['PROJ-301', 'Bug'],
  ])
  const bug = it.children.find(c => c.key === 'PROJ-301')
  expect(bug?.children.map(c => c.key)).toEqual(['PROJ-201', 'PROJ-202'])
  expect(bug?.children[0]).toMatchObject({ issueType: 'Sub-task', status: 'To Do' })
  expect(it.children.find(c => c.key === 'OTHER-5')?.children).toEqual([])
})

test('an Epic: a failed child view leaves that child without children; a failed search keeps the old tree', async () => {
  const old = { key: 'PROJ-399', summary: 's', issueType: 'Task', status: 'To Do', children: [] }
  let searchFails = false
  const { tool } = setup(a => {
    if (isAuth(a)) return authOk()
    if (isSearch(a)) return searchFails ? res('', 1, '✗ Error: failed to parse JQL') : res(fx.EPIC_CHILDREN_JSON)
    if (a[4] === 'PROJ-300') return res(fx.EPIC_VIEW_JSON)
    return viewNet()
  })
  const it = item('PROJ-300', { children: [old] })
  await tool.refreshItems([it])
  expect(it.children.map(c => [c.key, c.children.length])).toEqual([
    ['OTHER-5', 0],
    ['PROJ-301', 0],
  ])
  expect(it.refreshedAt).toBeDefined()
  searchFails = true
  await tool.refreshItems([it])
  expect(it.children.map(c => c.key)).toEqual(['OTHER-5', 'PROJ-301']) // kept
})

test('an unknown key gives not-found and the breaker stays closed', async () => {
  const { tool, clock } = setup(a => (isAuth(a) ? authOk() : viewUnknown()))
  const it = item('ZZZZ-99999')
  for (let i = 0; i < 5; i++) await tool.refreshItems([it])
  expect(it.error).toMatchObject({ kind: 'not-found', at: clock.t })
  expect(it.error?.message).toContain('does not exist')
  expect(it.refreshedAt).toBe(clock.t)
  expect(tool.status()).toMatchObject({ breaker: 'closed', loggedIn: true })
})

test('a view with unauthorized stderr marks the tool logged out and leaves the item alone', async () => {
  const { tool } = setup(a =>
    isAuth(a) ? authOk() : res('', 1, "unauthorized: use 'acli [product] auth login' to authenticate"),
  )
  const it = item('PROJ-200', { status: 'Done' })
  await tool.refreshItems([it])
  expect(tool.status().loggedIn).toBe(false)
  expect(it.status).toBe('Done')
  expect(it.error).toBeUndefined()
})

test('unparsable output is a tool failure and leaves the item alone', async () => {
  const { tool } = setup(a => (isAuth(a) ? authOk() : res('not json at all')))
  const it = item('PROJ-200', { status: 'Done' })
  await tool.refreshItems([it])
  expect(it.status).toBe('Done')
  expect(tool.status().lastError).toBe('unparsable acli output')
})

// ---------------------------------------------------------------- breaker

test('a network failure three times opens the breaker; then no call is made', async () => {
  const { tool, calls, views } = setup(a => (isAuth(a) ? authOk() : viewNet()))
  const it = item('PROJ-200')
  for (let i = 0; i < 3; i++) await tool.refreshItems([it])
  expect(tool.status().breaker).toBe('open')
  expect(it.error).toBeUndefined()
  const n = calls.length
  await tool.refreshItems([it])
  expect(calls.length).toBe(n)
  expect(views().length).toBe(3)
})

test('after the open period one half-open call reloads the site and then refreshes', async () => {
  let down = true
  const { tool, calls, clock } = setup(a => (isAuth(a) ? authOk() : down ? viewNet() : res(fx.TASK_VIEW_JSON)))
  const it = item('PROJ-200')
  for (let i = 0; i < 3; i++) await tool.refreshItems([it])
  expect(tool.status().breaker).toBe('open')
  clock.t += 5 * 60_000
  down = false
  const authsBefore = calls.filter(isAuth).length
  await tool.refreshItems([it])
  expect(calls.filter(isAuth).length).toBe(authsBefore + 1) // site re-checked
  expect(tool.status().breaker).toBe('closed')
  expect(it.issueType).toBe('Task')
})

// ---------------------------------------------------------------- skipped items

test('items on another site, track-only items, bad keys and lower-case keys make no call', async () => {
  const { tool, calls } = setup(a => (isAuth(a) ? authOk() : res(fx.TASK_VIEW_JSON)))
  const other = item('PROJ-1', { site: 'other.atlassian.net' })
  const track = item('PROJ-2', { trackOnly: true })
  const lower = item('proj-3')
  const bad = item('PROJ-4; rm -rf')
  const dash = item('--help')
  await tool.refreshItems([other, track, lower, bad, dash])
  expect(calls.filter(c => !isAuth(c))).toEqual([])
  for (const i of [other, track, lower, bad, dash]) {
    expect(i.refreshedAt).toBeUndefined()
    expect(i.error).toBeUndefined()
  }
})

test('the site match ignores case', async () => {
  const { tool, views } = setup(a => (isAuth(a) ? authOk() : res(fx.TASK_VIEW_JSON)))
  await tool.refreshItems([item('PROJ-200', { site: SITE.toUpperCase() })])
  expect(views().length).toBe(1)
})

test('items with the same Jira key share one view', async () => {
  const { tool, views } = setup(a => (isAuth(a) ? authOk() : res(fx.TASK_VIEW_JSON)))
  const a = item('PROJ-200')
  const b = item('PROJ-200')
  await tool.refreshItems([a, b])
  expect(views().length).toBe(1)
  expect(a.issueType).toBe('Task')
  expect(b.issueType).toBe('Task')
})

// ---------------------------------------------------------------- concurrency

test('at most 3 acli calls run at once', async () => {
  let inflight = 0
  let max = 0
  const { tool, views } = setup(async a => {
    if (isAuth(a)) return authOk()
    inflight++
    max = Math.max(max, inflight)
    await tick()
    inflight--
    return res(fx.TASK_VIEW_JSON)
  })
  const items = ['AB-1', 'AB-2', 'AB-3', 'AB-4', 'AB-5', 'AB-6'].map(k => item(k))
  await tool.refreshItems(items)
  expect(views().length).toBe(6)
  expect(max).toBeLessThanOrEqual(3)
  expect(max).toBeGreaterThan(1)
})

test('the tool never calls login, logout or switch', async () => {
  const { tool, calls } = setup(a => (isAuth(a) ? authNo() : res(fx.TASK_VIEW_JSON)))
  await tool.refreshItems([item('PROJ-200')])
  for (const c of calls) expect(c.some(p => ['login', 'logout', 'switch'].includes(p))).toBe(false)
})
