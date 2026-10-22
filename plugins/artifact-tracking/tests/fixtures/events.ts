// Engine events and results as the live probe saw them (2.1.296).
// Sources: docs/knowledge-base/claude-code-auto-tracking/sources/live-probe-2026-10-10/events-run1.jsonl
// and gh-pr-create-tool-result.jsonl. Paths are shortened to /x/repo.

const ENTER_TEXT = 'Created worktree at /x/repo/.claude/worktrees/probe-wt on branch worktree-probe-wt.'

/** `await next(e)` of an EnterWorktree tool.call. */
export const ENTER_RAN = {
  result: {
    worktreePath: '/x/repo/.claude/worktrees/probe-wt',
    worktreeBranch: 'worktree-probe-wt',
    message: ENTER_TEXT,
  },
  text: ENTER_TEXT,
}

export const EXIT_RAN = {
  result: {
    action: 'remove',
    originalCwd: '/x/repo',
    worktreePath: '/x/repo/.claude/worktrees/probe-wt',
    worktreeBranch: 'worktree-probe-wt',
    message: 'Removed worktree',
  },
  text: 'Removed worktree',
}

/** A background Agent call: the launch result has the id and no path. */
export const AGENT_ASYNC_RAN = {
  result: {
    isAsync: true,
    status: 'async_launched',
    agentId: 'a94bdd45b56e2c631',
    description: 'iso agent',
    resolvedModel: 'claude-opus-5-5',
    prompt: 'run pwd',
    canReadOutputFile: true,
    canContinueAgent: true,
  },
  text: 'Async agent launched successfully.',
}

/** A foreground Agent call with worktree isolation, settled. */
export const AGENT_DONE_RAN = {
  result: {
    status: 'completed',
    agentId: 'a94bdd45b56e2c631',
    prompt: 'run pwd',
    worktreePath: '/x/repo/.claude/worktrees/agent-a94bdd45b56e2c631',
    worktreeBranch: 'worktree-agent-a94bdd45b56e2c631',
  },
  text: 'done',
}

/** The `agent.spawn` input of the probe (subagent). */
export const SPAWN_INPUT = {
  tool_use_id: 'toolu_A1',
  prompt: 'run pwd',
  description: 'iso agent',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
  permissionMode: 'bypassPermissions',
  background: true,
  fork: false,
  name: 'iso-agent',
}
export const SPAWN_ANSWER = { model: 'claude-opus-5-5', agentId: 'a94bdd45b56e2c631' }

export const NESTED_SPAWN_INPUT = { ...SPAWN_INPUT, name: undefined, parentAgentId: 'a94bdd45b56e2c631' }
export const WORKFLOW_SPAWN_INPUT = {
  ...SPAWN_INPUT,
  name: undefined,
  description: 'architect',
  workflow: { runId: 'wf_a35565d1-fd4', agentIndex: 3 },
  cwd: '/x/repo',
}

export const BASH_PR_RAN = {
  result: {
    stdout: 'https://github.com/octo/demo/pull/7',
    stderr: '',
    interrupted: false,
    gitOperation: { pr: { number: 7, url: 'https://github.com/octo/demo/pull/7', action: 'created' } },
  },
  text: 'https://github.com/octo/demo/pull/7',
}
/** A Bash result whose `gitOperation.pr` is `{number, url, action}`: `action` defaults to `created`, `null` leaves it out. */
export const createdPr = (url: string, number: number, action: string | null = 'created') => ({
  result: {
    stdout: url,
    stderr: '',
    interrupted: false,
    gitOperation: { pr: { number, url, ...(action !== null ? { action } : {}) } },
  },
  text: url,
})
export const BASH_COMMIT_RAN = {
  result: {
    stdout: '[feat/x abc1234] msg',
    stderr: '',
    gitOperation: { commit: { sha: 'abc1234', kind: 'committed', branch: 'feat/x' } },
  },
  text: '[feat/x abc1234] msg',
}
export const BASH_PUSH_RAN = {
  result: { stdout: '', stderr: 'To origin', gitOperation: { push: { branch: 'feat/x' } } },
  text: '',
}
export const BASH_PLAIN_RAN = { result: { stdout: 'ok', stderr: '' }, text: 'ok' }

/** A `turn.complete` input of a subagent's turn. */
export const turnEnd = (reason: 'answer' | 'aborted' | 'error' | 'refusal', agentId?: string) => ({
  turnId: 't1',
  ...(agentId !== undefined ? { agentId } : {}),
  reason,
  isAborted: reason === 'aborted',
  answer: '',
})
