// The jira slice reaches the acli tool: the epic child limit is read at each search, the concurrency once, when the
// tool is built (decision C5). Each test uses a value that is not the default. Plan: L4 Task 7.
import { expect, test } from 'claude-code/testing'
import { AcliTool } from '../trackers/jira/acli-tool'
import { JIRA_DEFAULTS } from '../trackers/jira/config'
import * as fx from './fixtures/acli'
import type { JiraTarget, Runner, RunResult } from './fixtures/contracts'

const SITE = '<site>.atlassian.net'
const res = (stdout: string, exitCode = 0, stderr = ''): RunResult => ({ exitCode, stdout, stderr })
const item = (issueKey: string): JiraTarget => ({
  key: `jira:${SITE}/${issueKey}`,
  site: SITE,
  issueKey,
  trackOnly: false,
  children: [],
})
const tick = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

test('epicChildLimit 7 goes into the child search argv', async () => {
  const calls: string[][] = []
  const run: Runner = async argv => {
    calls.push([...argv])
    if (argv[2] === 'auth') return res(fx.AUTH_STATUS_STDOUT, fx.AUTH_STATUS_EXIT, fx.AUTH_STATUS_STDERR)
    if (argv[3] === 'search') return res(fx.EPIC_CHILDREN_JSON)
    if (argv[4] === 'PROJ-300') return res(fx.EPIC_VIEW_JSON)
    return res('{}', 1, 'unexpected')
  }
  const tool = new AcliTool(run, () => 1000, undefined, { limits: () => ({ ...JIRA_DEFAULTS, epicChildLimit: 7 }) })
  await tool.refreshItems([item('PROJ-300')])
  const search = calls.find(c => c[3] === 'search')
  expect(search?.[search.indexOf('--limit') + 1]).toBe('7')
})

test('the epic child limit is read at each search, so a changed file shows at the next one', async () => {
  const calls: string[][] = []
  const run: Runner = async argv => {
    calls.push([...argv])
    if (argv[2] === 'auth') return res(fx.AUTH_STATUS_STDOUT, fx.AUTH_STATUS_EXIT, fx.AUTH_STATUS_STDERR)
    if (argv[3] === 'search') return res(fx.EPIC_CHILDREN_JSON)
    if (argv[4] === 'PROJ-300') return res(fx.EPIC_VIEW_JSON)
    return res('{}', 1, 'unexpected')
  }
  let epicChildLimit = 7
  const tool = new AcliTool(run, () => 1000, undefined, { limits: () => ({ ...JIRA_DEFAULTS, epicChildLimit }) })
  await tool.refreshItems([item('PROJ-300')])
  epicChildLimit = 9
  await tool.refreshItems([item('PROJ-300')])
  const limits = calls.filter(c => c[3] === 'search').map(c => c[c.indexOf('--limit') + 1])
  expect(limits).toEqual(['7', '9'])
})

test('concurrency 1 runs one acli call at a time', async () => {
  let active = 0
  let peak = 0
  const run: Runner = async argv => {
    if (argv[2] === 'auth') return res(fx.AUTH_STATUS_STDOUT, fx.AUTH_STATUS_EXIT, fx.AUTH_STATUS_STDERR)
    active++
    peak = Math.max(peak, active)
    await tick()
    active--
    const o = JSON.parse(fx.TASK_VIEW_JSON) as { key: string }
    o.key = argv[4] as string
    return res(JSON.stringify(o))
  }
  const tool = new AcliTool(run, () => 1000, undefined, { limits: () => ({ ...JIRA_DEFAULTS, concurrency: 1 }) })
  await tool.loadActiveSite()
  await Promise.all([
    tool.refreshItems([item('PROJ-1')]),
    tool.refreshItems([item('PROJ-2')]),
    tool.refreshItems([item('PROJ-3')]),
  ])
  expect(peak).toBe(1)
})

test('with no opts the concurrency is 3, as before', async () => {
  let active = 0
  let peak = 0
  const run: Runner = async argv => {
    if (argv[2] === 'auth') return res(fx.AUTH_STATUS_STDOUT, fx.AUTH_STATUS_EXIT, fx.AUTH_STATUS_STDERR)
    active++
    peak = Math.max(peak, active)
    await tick()
    active--
    const o = JSON.parse(fx.TASK_VIEW_JSON) as { key: string }
    o.key = argv[4] as string
    return res(JSON.stringify(o))
  }
  const tool = new AcliTool(run, () => 1000)
  await tool.loadActiveSite()
  await Promise.all([1, 2, 3, 4, 5].map(n => tool.refreshItems([item(`PROJ-${n}`)])))
  expect(peak).toBe(3)
})
