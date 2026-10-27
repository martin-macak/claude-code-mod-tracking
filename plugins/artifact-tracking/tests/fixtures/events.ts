// Engine events and results as the live probe saw them (2.1.296).
// Sources: docs/knowledge-base/claude-code-auto-tracking/sources/live-probe-2026-10-10/events-run1.jsonl
// and gh-pr-create-tool-result.jsonl. Paths are shortened to /x/repo.
// The transcript uses at the end are the stored shape after a cold `--resume` (Claude Code 2.1.310):
// docs/knowledge-base/claude-code-auto-tracking/sources/replay-probe-2026-10-26/.

import type { SessionRow } from '../../core/interfaces/ports'

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
/** The answer of a Bash call: its `stdout`, and the `gitOperation` the engine read from it when there is one. */
export const bashRan = (stdout: string, gitOperation?: unknown) => ({
  result: { stdout, stderr: '', interrupted: false, ...(gitOperation !== undefined ? { gitOperation } : {}) },
  text: stdout,
})
/** A Bash result whose `gitOperation.pr` is `{number, url, action}`: `action` defaults to `created`, `null` leaves it out. */
export const createdPr = (url: string, number: number, action: string | null = 'created') =>
  bashRan(url, { pr: { number, url, ...(action !== null ? { action } : {}) } })
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
/**
 * An assistant message with one Bash use, as `$.session.messages()` gives it after a cold `--resume`: the use keeps the
 * `result` of the live call, with its `gitOperation`. Evidence: docs/knowledge-base/claude-code-auto-tracking/pull-requests.md,
 * "The replayed Bash result after a cold `--resume`", and `sources/replay-probe-2026-10-26/logs/ev-6a3ea756.jsonl`.
 * `answer` is what the transcript stored for it: `result` and `text`, a string `result` and `isError` for a failed call,
 * only `text` for a call of a subagent, nothing for a call with no answer.
 */
export const bashUse = (
  id: string,
  command: string,
  answer: { result?: unknown; text?: string; isError?: true } = {},
): SessionRow =>
  ({
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command, description: 'x' }, ...answer }],
  }) as SessionRow

/** The base URL of the demo pull requests: `${DEMO_PULL}/7` is the PR of `BASH_PR_RAN`. */
export const DEMO_PULL = 'https://github.com/octo/demo/pull'
/**
 * A created PR as a headless (`-p`) transcript may store it: the types file says Bash blanks its `stdout`. The
 * `gitOperation` stays, and the replay reads that, not the output.
 */
export const headlessPr = (url: string, number: number) => {
  const ran = createdPr(url, number)
  return { ...ran, result: { ...ran.result, stdout: '' } }
}
/**
 * Uses of a transcript that made no PR:
 * - a view, a list, a failed create (a string `result` and `isError`), a merge and a comment;
 * - a create with no stored answer, and a create with only `text`: a subagent's transcript stores no `result`, and the
 *   URL in its text is no proof (follow-up #247);
 * - a `git worktree` command with no `gitOperation` (the `GIT_CMD` route of `fromBash`), and a `git merge` whose
 *   `gitOperation` has no `pr` (the operation route).
 */
export const NO_PR_USES: readonly SessionRow[] = [
  bashUse('t_view', 'gh pr view 7', bashRan('title: demo pr')),
  bashUse('t_list', 'gh pr list', bashRan('7  demo pr  feat/x  OPEN')),
  bashUse('t_fail', 'gh pr create --title x', {
    result: 'Error: Exit code 1\nfake gh: a pull request for branch already exists',
    text: 'Exit code 1\nfake gh: a pull request for branch already exists',
    isError: true,
  }),
  bashUse('t_merge', 'gh pr merge 7 --squash', bashRan('Merged', { pr: { number: 7, action: 'merged' } })),
  bashUse(
    't_comment',
    'gh pr comment 7',
    bashRan(`${DEMO_PULL}/7#c1`, { pr: { number: 7, url: `${DEMO_PULL}/7`, action: 'commented' } }),
  ),
  bashUse('t_open', 'gh pr create --title y'),
  bashUse('t_text_only', 'gh pr create --title z', { text: `${DEMO_PULL}/99` }),
  bashUse('t_wt', 'git worktree add -q -b feat/x ../wt', bashRan('')),
  bashUse('t_gmerge', 'git merge feat/x', bashRan('', { branch: { ref: 'feat/x', action: 'merged' } })),
]

/** A `turn.complete` input of a subagent's turn. */
export const turnEnd = (reason: 'answer' | 'aborted' | 'error' | 'refusal', agentId?: string) => ({
  turnId: 't1',
  ...(agentId !== undefined ? { agentId } : {}),
  reason,
  isAborted: reason === 'aborted',
  answer: '',
})
