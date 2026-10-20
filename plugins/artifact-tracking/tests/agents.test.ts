// trackAgents: rows, location (A6), end state (A7). Pure.
import { expect, test } from 'claude-code/testing'
import { classifyStatus, trackAgents } from '../trackers/auto/agents'
import type { AgentProof, AutoState, GitWorktree, LiveAgent, WorktreeProof } from './fixtures/contracts'
import { LIMITS } from './fixtures/limits'

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

// Workflow agents (issue #120). A workflow agent runs in `<main>/.claude/worktrees/<runId>-<agentIndex>`, and the engine
// gives `agent.spawn` no cwd for it. These cases build the list the way git prints it for a run.
const RUN = 'wf_a35565d1-fd4'
const wfAgent = (id: string, agentIndex: number, over: Partial<AgentProof> = {}): AgentProof =>
  agent(id, { kind: 'workflow', workflow: { runId: RUN, agentIndex }, spawnedAt: AT - 1000, ...over })
const wfRec = (n: number, branch: string): GitWorktree => rec(`${DIR}/${RUN}-${n}`, branch)

test('a running isolated workflow agent shows its worktree before any commit or push', () => {
  const list = [rec(MAIN, 'main'), wfRec(3, `worktree-${RUN}-3`)]
  const v = trackAgents(state([wfAgent('w3', 3)]), null, list, MAIN, AT)
  expect(rowOf(v, 'w3')).toMatchObject({ worktree: `${RUN}-3`, branch: `worktree-${RUN}-3`, worktreeLive: true })
})

test('a workflow agent that was not isolated still shows the main checkout', () => {
  const v = trackAgents(state([wfAgent('w1', 1)]), null, [rec(MAIN, 'main')], MAIN, AT)
  expect(rowOf(v, 'w1')).toMatchObject({ worktree: 'repo', branch: 'main', worktreeLive: true })
  expect(v.state.agents[0]?.worktreePath).toBeUndefined()
})

test('a workflow agent takes the worktree of its own index, not of a sibling', () => {
  const list = [rec(MAIN, 'main'), wfRec(1, 'b1'), wfRec(2, 'b2')]
  const v = trackAgents(state([wfAgent('w1', 1), wfAgent('w2', 2)]), null, list, MAIN, AT)
  expect(rowOf(v, 'w1')).toMatchObject({ worktree: `${RUN}-1`, branch: 'b1' })
  expect(rowOf(v, 'w2')).toMatchObject({ worktree: `${RUN}-2`, branch: 'b2' })
})

test('a worktree of the run for another index never goes to an agent that was not isolated', () => {
  const list = [rec(MAIN, 'main'), wfRec(1, 'b1')]
  const v = trackAgents(state([wfAgent('w1', 1), wfAgent('w2', 2)]), null, list, MAIN, AT)
  expect(rowOf(v, 'w1').worktree).toBe(`${RUN}-1`)
  expect(rowOf(v, 'w2')).toMatchObject({ worktree: 'repo', branch: 'main', worktreeLive: true })
})

test('an ended workflow agent keeps its worktree when a new worktree checks out the same branch', () => {
  const w = wfAgent('w7', 7, { branch: 'fix/x', endedAt: AT - 5 })
  const first = trackAgents(state([w]), null, [rec(MAIN, 'main'), wfRec(7, 'fix/x')], MAIN, AT)
  expect(rowOf(first, 'w7')).toMatchObject({ worktree: `${RUN}-7`, worktreeLive: true })
  // The old worktree is removed. A later run checks out the same branch in a worktree of its own.
  const later = [rec(MAIN, 'main'), rec(`${DIR}/wf_0b519c0a-08c-1`, 'fix/x')]
  const v = trackAgents(first.state, null, later, MAIN, AT + 60_000)
  expect(rowOf(v, 'w7')).toMatchObject({ worktree: `${RUN}-7`, worktreeLive: false, branch: 'fix/x' })
})

test('a removed workflow worktree stays on its agent, dimmed, with the last branch of its proof', () => {
  const w = wfAgent('w4', 4, { endedAt: AT - 5 })
  const first = trackAgents(state([w]), null, [rec(MAIN, 'main'), wfRec(4, 'fix/y')], MAIN, AT)
  const proof: WorktreeProof = { path: `${DIR}/${RUN}-4`, origin: 'workflow', runId: RUN, provenAt: 1, branch: 'fix/y' }
  const v = trackAgents({ ...first.state, worktrees: [proof] }, null, [rec(MAIN, 'main')], MAIN, AT + 60_000)
  expect(rowOf(v, 'w4')).toMatchObject({ state: 'ended', worktree: `${RUN}-4`, worktreeLive: false, branch: 'fix/y' })
})

test('a proven workflow worktree is written to the agent once, and a quiet round changes nothing', () => {
  const list = [rec(MAIN, 'main'), wfRec(2, 'b2')]
  const first = trackAgents(state([wfAgent('w2', 2)]), null, list, MAIN, AT)
  expect(first.state.agents[0]?.worktreePath).toBe(`${DIR}/${RUN}-2`)
  expect(trackAgents(first.state, null, list, MAIN, AT + 30_000).state).toBe(first.state)
})

test('a later agent with the same run and index does not take the worktree that an earlier agent proved', () => {
  // A resume of the run starts `agentIndex` over: the second agent is index 1 again.
  const list = [rec(MAIN, 'main'), wfRec(1, 'b1')]
  const first = trackAgents(state([wfAgent('old', 1)]), null, list, MAIN, AT)
  const both = { ...first.state, agents: [...first.state.agents, wfAgent('new', 1, { spawnedAt: AT + 10 })] }
  const v = trackAgents(both, null, list, MAIN, AT + 20)
  expect(rowOf(v, 'old')).toMatchObject({ worktree: `${RUN}-1`, branch: 'b1' })
  expect(rowOf(v, 'new')).toMatchObject({ worktree: 'repo', branch: 'main' })
})

test('an agent that has an exact path keeps it over the convention path of its index', () => {
  const w = wfAgent('w1', 1, { worktreePath: `${DIR}/probe-wt` })
  const list = [rec(MAIN, 'main'), rec(`${DIR}/probe-wt`, 'worktree-probe-wt'), wfRec(1, 'b1')]
  expect(rowOf(trackAgents(state([w]), null, list, MAIN, AT), 'w1').worktree).toBe('probe-wt')
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
