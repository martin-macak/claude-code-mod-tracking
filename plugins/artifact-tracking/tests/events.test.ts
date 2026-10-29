// Raw engine events to plain facts. Pure. This file is the only automated cover of agent-scoped events (spec 13.3).
import { expect, test } from 'claude-code/testing'
import {
  fromAgentResult,
  fromBash,
  fromEnterResult,
  fromExitResult,
  fromSpawn,
  fromTurnEnd,
  GIT_CMD,
} from '../trackers/auto/events'
import * as fx from './fixtures/events'

test('fromEnterResult: path and branch; an agent id rides along', () => {
  expect(fromEnterResult(fx.ENTER_RAN)).toEqual({
    path: '/x/repo/.claude/worktrees/probe-wt',
    branch: 'worktree-probe-wt',
  })
  expect(fromEnterResult(fx.ENTER_RAN, 'a1')).toMatchObject({ agentId: 'a1' })
})

test('fromEnterResult: no result or an unknown shape gives null', () => {
  expect(fromEnterResult(undefined)).toBeNull()
  expect(fromEnterResult({})).toBeNull()
  expect(fromEnterResult({ result: {} })).toBeNull()
  expect(fromEnterResult({ result: { worktreePath: 7 } })).toBeNull()
  expect(fromEnterResult('text')).toBeNull()
})

test('fromExitResult: the worktree path of an ExitWorktree result, whether it kept or removed the tree', () => {
  expect(fromExitResult(fx.EXIT_RAN)).toEqual({ path: '/x/repo/.claude/worktrees/probe-wt' })
  expect(fromExitResult(fx.EXIT_KEEP_RAN)).toEqual({ path: '/x/repo/.claude/worktrees/probe-wt' })
})

test('fromExitResult: a refused call (its result is a string), no result or an unknown shape gives null', () => {
  expect(fromExitResult({ result: 'Cannot remove: uncommitted files', isError: true })).toBeNull()
  expect(fromExitResult(undefined)).toBeNull()
  expect(fromExitResult({})).toBeNull()
  expect(fromExitResult({ result: {} })).toBeNull()
  expect(fromExitResult({ result: { worktreePath: 7 } })).toBeNull()
  expect(fromExitResult('text')).toBeNull()
})

test('fromAgentResult: completed has the path and branch; async_launched has the id only', () => {
  expect(fromAgentResult(fx.AGENT_DONE_RAN)).toEqual({
    agentId: 'a94bdd45b56e2c631',
    worktreePath: '/x/repo/.claude/worktrees/agent-a94bdd45b56e2c631',
    worktreeBranch: 'worktree-agent-a94bdd45b56e2c631',
  })
  expect(fromAgentResult(fx.AGENT_ASYNC_RAN)).toEqual({ agentId: 'a94bdd45b56e2c631' })
})

test('fromAgentResult: another status, no id or no result gives null', () => {
  expect(fromAgentResult({ result: { status: 'teammate_spawned', agentId: 'x' } })).toBeNull()
  expect(fromAgentResult({ result: { status: 'completed' } })).toBeNull()
  expect(fromAgentResult(undefined)).toBeNull()
})

test('fromSpawn: a subagent', () => {
  expect(fromSpawn(fx.SPAWN_INPUT, fx.SPAWN_ANSWER)).toEqual({
    agentId: 'a94bdd45b56e2c631',
    name: 'iso-agent',
    description: 'iso agent',
    subagentType: 'general-purpose',
  })
})

test('fromSpawn: a nested child keeps parentAgentId; a workflow agent keeps workflow and cwd', () => {
  expect(fromSpawn(fx.NESTED_SPAWN_INPUT, { model: 'm', agentId: 'c1' })).toMatchObject({
    agentId: 'c1',
    parentAgentId: 'a94bdd45b56e2c631',
  })
  const wf = fromSpawn(fx.WORKFLOW_SPAWN_INPUT, { model: 'm', agentId: 'w1' })
  expect(wf).toMatchObject({ agentId: 'w1', workflow: { runId: 'wf_a35565d1-fd4', agentIndex: 3 }, cwd: '/x/repo' })
  expect(wf?.name).toBeUndefined()
})

test('fromSpawn: an answer without an agentId, or an unknown shape, gives null', () => {
  expect(fromSpawn(fx.SPAWN_INPUT, { model: 'm' })).toBeNull()
  expect(fromSpawn(fx.SPAWN_INPUT, undefined)).toBeNull()
  expect(fromSpawn(undefined, fx.SPAWN_ANSWER)).toBeNull()
})

test('fromBash: gitOperation.pr kicks pr-event', () => {
  expect(fromBash('gh pr create --draft', fx.BASH_PR_RAN).kick).toBe('pr-event')
})

// Issue #158: the one signal that says the session made this PR is a proof, in any repo.
test('fromBash: a created gitOperation.pr is a proof: host, owner, repo and number, with the case of the URL', () => {
  expect(fromBash('gh pr create --draft', fx.BASH_PR_RAN)).toEqual({
    kick: 'pr-event',
    pr: { host: 'github.com', owner: 'octo', repo: 'demo', number: 7 },
  })
  const other = fx.createdPr('https://github.com/VerticeOne/vertice-iam/pull/657', 657)
  expect(fromBash('gh pr create --repo VerticeOne/vertice-iam', other).pr).toEqual({
    host: 'github.com',
    owner: 'VerticeOne',
    repo: 'vertice-iam',
    number: 657,
  })
})

test('fromBash: the proof of a PR of another host reads the host from the URL, lower-cased', () => {
  const ghe = fx.createdPr('https://GHE.Acme.example/team/svc/pull/12', 12)
  expect(fromBash('gh pr create', ghe).pr).toEqual({ host: 'ghe.acme.example', owner: 'team', repo: 'svc', number: 12 })
  const www = fx.createdPr('https://www.github.com/a/b/pull/3', 3)
  expect(fromBash('gh pr create', www).pr?.host).toBe('github.com')
})

test('fromBash: a PR operation that is not a creation kicks pr-event and is no proof', () => {
  for (const action of ['merged', 'closed', 'commented', 'edited', null]) {
    const ran = fx.createdPr('https://github.com/octo/demo/pull/7', 7, action)
    expect(fromBash('gh pr merge 7', ran)).toEqual({ kick: 'pr-event' })
  }
})

test('fromBash: a created PR with no readable URL, or a number that the URL does not carry, is no proof', () => {
  for (const [url, number] of [
    ['', 7],
    ['not a url', 7],
    ['ftp://github.com/octo/demo/pull/7', 7],
    ['https://github.com/octo/demo/issues/7', 7],
    ['https://github.com/octo/demo/pull/seven', 7],
    ['https://github.com/octo/demo/pull/7', 8],
  ] as const)
    expect(fromBash('gh pr create', fx.createdPr(url, number))).toEqual({ kick: 'pr-event' })
  const noUrl = { result: { gitOperation: { pr: { number: 7, action: 'created' } } } }
  expect(fromBash('gh pr create', noUrl)).toEqual({ kick: 'pr-event' })
})

test('fromBash: an agent commit or push gives its branch and kicks git', () => {
  expect(fromBash('git commit -m msg', fx.BASH_COMMIT_RAN, 'a1')).toEqual({
    agentId: 'a1',
    branch: 'feat/x',
    kick: 'git',
  })
  expect(fromBash('git push', fx.BASH_PUSH_RAN, 'a1')).toEqual({ agentId: 'a1', branch: 'feat/x', kick: 'git' })
})

test('fromBash: the main loop gives no branch fact', () => {
  expect(fromBash('git commit -m msg', fx.BASH_COMMIT_RAN)).toEqual({ kick: 'git' })
})

test('fromBash: a git worktree command with no operation kicks git; echo git does not', () => {
  expect(fromBash('git worktree add ../x', fx.BASH_PLAIN_RAN)).toEqual({ kick: 'git' })
  expect(fromBash('git -C /x/repo switch main', fx.BASH_PLAIN_RAN)).toEqual({ kick: 'git' })
  expect(fromBash('echo git', fx.BASH_PLAIN_RAN)).toEqual({})
  expect(fromBash('ls', fx.BASH_PLAIN_RAN)).toEqual({})
})

test('fromBash: no result gives nothing, also for a git command', () => {
  expect(fromBash('git worktree add ../x', undefined)).toEqual({})
  expect(fromBash('git worktree add ../x', { text: 'denied' })).toEqual({})
})

test('GIT_CMD matches worktree, checkout, switch and branch only', () => {
  for (const c of ['git worktree list', 'git checkout -b x', 'git switch x', 'git branch -d x', 'git -C ../r branch'])
    expect(GIT_CMD.test(c)).toBe(true)
  for (const c of ['git status', 'git log', 'echo git', 'digit worktree']) expect(GIT_CMD.test(c)).toBe(false)
})

test('fromTurnEnd: each reason with an agent id; the main loop and unknown shapes give null', () => {
  for (const reason of ['answer', 'aborted', 'error', 'refusal'] as const)
    expect(fromTurnEnd(fx.turnEnd(reason, 'a1'))).toEqual({ agentId: 'a1', reason })
  expect(fromTurnEnd(fx.turnEnd('answer'))).toBeNull()
  expect(fromTurnEnd({ agentId: 'a1', reason: 'weird' })).toBeNull()
  expect(fromTurnEnd(undefined)).toBeNull()
})
