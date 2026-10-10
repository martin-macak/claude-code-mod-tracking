// trackAgents: rows, location (A6), end state (A7). Pure.
import { expect, test } from 'claude-code/testing'
import { classifyStatus, trackAgents } from '../hooks/auto/agents'
import type { AgentProof, AutoState, GitWorktree, LiveAgent, WorktreeProof } from '../hooks/contracts'
import { LIMITS } from '../hooks/contracts'

const AT = 5_000_000
const MAIN = '/x/repo'
const DIR = `${MAIN}/.claude/worktrees`

const rec = (path: string, branch?: string, extra: Partial<GitWorktree> = {}): GitWorktree => ({
  path,
  branch,
  detached: branch === undefined,
  bare: false,
  ...extra,
})
const LIST = [
  rec(MAIN, 'main'),
  rec(`${DIR}/probe-wt`, 'worktree-probe-wt'),
  rec(`${DIR}/agent-a1`, 'worktree-agent-a1'),
]
const agent = (id: string, over: Partial<AgentProof> = {}): AgentProof => ({
  id,
  kind: 'subagent',
  label: id,
  spawnedAt: 1,
  cwd: MAIN,
  ...over,
})
/** A pinned root with its toplevel resolved. A literal: this file must not depend on the ledger task. */
const state = (agents: AgentProof[], over: Partial<AutoState> = {}): AutoState => ({
  root: { cwd: MAIN, at: 1, top: MAIN },
  worktrees: [],
  agents,
  dismissed: [],
  snapshot: null,
  ...over,
})
const live = (id: string, status: string, teammateId?: string): LiveAgent => ({ id, status, teammateId })
const rowOf = (v: ReturnType<typeof trackAgents>, id: string) => v.rows.find(r => r.id === `ag:${id}`)!

test('the master row comes first and is located by the session cwd', () => {
  const v = trackAgents(state([]), [], LIST, `${DIR}/probe-wt/src`, AT)
  expect(v.rows).toHaveLength(1)
  expect(v.rows[0]).toMatchObject({
    id: 'ag:master',
    kind: 'master',
    label: 'this session',
    depth: 0,
    state: 'running',
    branch: 'worktree-probe-wt',
    worktree: 'probe-wt',
    worktreeLive: true,
  })
})

test('after the master enters a worktree an earlier subagent keeps its recorded spawn location', () => {
  const s = state([agent('a')])
  const v = trackAgents(s, [live('a', 'running')], LIST, `${DIR}/probe-wt`, AT)
  expect(rowOf(v, 'a')).toMatchObject({ branch: 'main', worktree: 'repo', worktreeLive: true })
  expect(v.rows[0]).toMatchObject({ branch: 'worktree-probe-wt' })
})

test('an isolated subagent is found by the agent-id convention path', () => {
  const v = trackAgents(state([agent('a1')]), [live('a1', 'running')], LIST, MAIN, AT)
  expect(rowOf(v, 'a1')).toMatchObject({ branch: 'worktree-agent-a1', worktree: 'agent-a1', worktreeLive: true })
})

test('the exact path from the Agent result wins; a removed worktree shows dimmed location, not the parent', () => {
  const exact = state([agent('a2', { worktreePath: `${DIR}/probe-wt` })])
  expect(rowOf(trackAgents(exact, [], LIST, MAIN, AT), 'a2').worktree).toBe('probe-wt')
  const gone = state([agent('a3', { worktreePath: `${DIR}/agent-a3`, branch: 'worktree-agent-a3' })])
  expect(rowOf(trackAgents(gone, [], LIST, MAIN, AT), 'a3')).toMatchObject({
    worktree: 'agent-a3',
    worktreeLive: false,
    branch: 'worktree-agent-a3',
  })
})

test('a convention path that was proven but is gone gives a not-live location', () => {
  const proof: WorktreeProof = { path: `${DIR}/agent-a4`, origin: 'agent', owner: 'a4', provenAt: 1, branch: 'b4' }
  const s = state([agent('a4')], { worktrees: [proof] })
  expect(rowOf(trackAgents(s, [], LIST, MAIN, AT), 'a4')).toMatchObject({ worktree: 'agent-a4', worktreeLive: false })
})

test('a branch from gitOperation locates a workflow agent', () => {
  const wf = agent('w1', {
    kind: 'workflow',
    workflow: { runId: 'wf_x', agentIndex: 2 },
    cwd: undefined,
    branch: 'worktree-probe-wt',
    spawnedAt: AT - 1000,
  })
  const v = trackAgents(state([wf]), null, LIST, MAIN, AT)
  expect(rowOf(v, 'w1')).toMatchObject({ kind: 'workflow', worktree: 'probe-wt', branch: 'worktree-probe-wt' })
  expect(rowOf(v, 'w1').workflow).toEqual({ runId: 'wf_x', agentIndex: 2 })
})

test('with no other clue an agent takes its parent location, a child takes the parent agent', () => {
  const s = state([agent('p', { cwd: `${DIR}/probe-wt` }), agent('c', { parentId: 'p', cwd: undefined })])
  const v = trackAgents(s, [live('p', 'running'), live('c', 'running')], LIST, MAIN, AT)
  expect(rowOf(v, 'c')).toMatchObject({ depth: 2, worktree: 'probe-wt' })
})

test('a listed agent with no agent.spawn record makes no row', () => {
  const v = trackAgents(state([]), [live('ghost', 'running')], LIST, MAIN, AT)
  expect(v.rows.map(r => r.id)).toEqual(['ag:master'])
})

test('classifyStatus is the A7 table; an unknown word is running', () => {
  expect(classifyStatus('pending', false)).toBe('running')
  expect(classifyStatus('running', false)).toBe('running')
  expect(classifyStatus('waiting', false)).toBe('waiting')
  expect(classifyStatus('idle', true)).toBe('waiting')
  expect(classifyStatus('idle', false)).toBe('ended')
  expect(classifyStatus('completed', false)).toBe('ended')
  expect(classifyStatus('failed', false)).toBe('failed')
  expect(classifyStatus('killed', false)).toBe('failed')
  expect(classifyStatus('brand-new-word', false)).toBe('running')
})

test('list statuses set the row state, completed sets endedAt, failed marks it failed', () => {
  const s = state([agent('a'), agent('b'), agent('c')])
  const v = trackAgents(s, [live('a', 'waiting'), live('b', 'completed'), live('c', 'killed')], LIST, MAIN, AT)
  expect(rowOf(v, 'a').state).toBe('waiting')
  expect(rowOf(v, 'b').state).toBe('ended')
  expect(rowOf(v, 'c').state).toBe('failed')
  expect(v.state.agents.find(a => a.id === 'b')).toMatchObject({ endedAt: AT, listed: true, status: 'completed' })
})

test('listed then dropped ends the agent; never listed and absent stays running', () => {
  const s = state([agent('a', { listed: true, status: 'running' }), agent('b')])
  const v = trackAgents(s, [], LIST, MAIN, AT)
  expect(rowOf(v, 'a').state).toBe('ended')
  expect(rowOf(v, 'b').state).toBe('running')
})

test('turn.complete then a listed running makes the agent run again', () => {
  const s = state([agent('a', { listed: true, status: 'idle', endedAt: AT - 10 })])
  const v = trackAgents(s, [live('a', 'running')], LIST, MAIN, AT)
  expect(rowOf(v, 'a').state).toBe('running')
  expect(v.state.agents[0]?.endedAt).toBeUndefined()
})

test('a null list keeps the last statuses', () => {
  const s = state([agent('a', { listed: true, status: 'waiting' })])
  const v = trackAgents(s, null, LIST, MAIN, AT)
  expect(rowOf(v, 'a').state).toBe('waiting')
  expect(v.state).toBe(s)
})

test('a workflow agent with no sign of life for workflowIdleMs ends with stale', () => {
  const wf = (over: Partial<AgentProof> = {}) =>
    agent('w', {
      kind: 'workflow',
      workflow: { runId: 'wf_x', agentIndex: 1 },
      spawnedAt: AT - LIMITS.workflowIdleMs - 1,
      ...over,
    })
  const stale = trackAgents(state([wf()]), null, LIST, MAIN, AT)
  expect(rowOf(stale, 'w').state).toBe('ended')
  expect(stale.state.agents[0]).toMatchObject({ endedAt: AT, stale: true })
  const alive = trackAgents(state([wf({ lastActiveAt: AT - 1000 })]), null, LIST, MAIN, AT)
  expect(rowOf(alive, 'w').state).toBe('running')
})

test('a subagent never ends by the idle bound', () => {
  const s = state([agent('a', { spawnedAt: AT - 10 * LIMITS.workflowIdleMs })])
  expect(rowOf(trackAgents(s, [live('a', 'running')], LIST, MAIN, AT), 'a').state).toBe('running')
})

test('an agent ended by turn.complete shows ended or failed', () => {
  const s = state([
    agent('w1', { kind: 'workflow', endedAt: AT - 5 }),
    agent('w2', { kind: 'workflow', endedAt: AT - 5, failed: true }),
  ])
  const v = trackAgents(s, null, LIST, MAIN, AT)
  expect(rowOf(v, 'w1').state).toBe('ended')
  expect(rowOf(v, 'w2').state).toBe('failed')
})

test('depth is parent plus one, at most 3; a dismissed agent hides its subtree', () => {
  const chain = [
    agent('a', { spawnedAt: 1 }),
    agent('b', { parentId: 'a', spawnedAt: 2 }),
    agent('c', { parentId: 'b', spawnedAt: 3 }),
    agent('d', { parentId: 'c', spawnedAt: 4 }),
  ]
  const v = trackAgents(state(chain), null, LIST, MAIN, AT)
  expect(v.rows.map(r => [r.id, r.depth])).toEqual([
    ['ag:master', 0],
    ['ag:a', 1],
    ['ag:b', 2],
    ['ag:c', 3],
    ['ag:d', 3],
  ])
  const hidden = trackAgents(state(chain, { dismissed: ['ag:b'] }), null, LIST, MAIN, AT)
  expect(hidden.rows.map(r => r.id)).toEqual(['ag:master', 'ag:a'])
})

test('rows come in spawn order; a child of an unknown parent hangs under the master', () => {
  const s = state([
    agent('late', { spawnedAt: 9 }),
    agent('early', { spawnedAt: 2 }),
    agent('orphan', { parentId: 'nobody', spawnedAt: 5 }),
  ])
  const v = trackAgents(s, null, LIST, MAIN, AT)
  expect(v.rows.map(r => [r.id, r.depth])).toEqual([
    ['ag:master', 0],
    ['ag:early', 1],
    ['ag:orphan', 1],
    ['ag:late', 1],
  ])
})

test('a failed session cwd keeps the master location of the last snapshot', () => {
  const first = trackAgents(state([]), null, LIST, `${DIR}/probe-wt`, AT)
  const s = state([], {
    snapshot: {
      at: AT,
      worktrees: [],
      agents: first.rows,
      branches: [],
      overflow: 0,
      git: { ok: true, at: AT },
      agentList: { ok: true, at: AT },
      prs: { ok: true },
    },
  })
  const v = trackAgents(s, null, LIST, null, AT + 1)
  expect(v.rows[0]).toMatchObject({ branch: 'worktree-probe-wt', worktree: 'probe-wt' })
})

test('with no list of worktrees there is no branch and no worktree', () => {
  const v = trackAgents(state([agent('a')]), [live('a', 'running')], [], MAIN, AT)
  expect(v.rows[0]?.branch).toBeUndefined()
  expect(rowOf(v, 'a').worktree).toBeUndefined()
})

test('a second call with the same inputs returns the same state object', () => {
  const s = state([agent('a')])
  const first = trackAgents(s, [live('a', 'running')], LIST, MAIN, AT)
  const second = trackAgents(first.state, [live('a', 'running')], LIST, MAIN, AT + 30_000)
  expect(second.state).toBe(first.state)
})
