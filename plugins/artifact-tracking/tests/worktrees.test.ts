// trackWorktrees: proven children only, row states, tracked branches. Pure.
import { expect, test } from 'claude-code/testing'
import type { AgentProof, AutoState, GitWorktree, WorktreeProof } from '../hooks/contracts'
import { LIMITS } from '../hooks/contracts'
import { trackWorktrees } from '../trackers/auto/worktrees'

const AT = 5_000
const MAIN = '/x/repo'
const DIR = `${MAIN}/.claude/worktrees`

const rec = (path: string, branch?: string, extra: Partial<GitWorktree> = {}): GitWorktree => ({
  path,
  branch,
  detached: branch === undefined,
  bare: false,
  ...extra,
})
const proof = (path: string, over: Partial<WorktreeProof> = {}): WorktreeProof => ({
  path,
  origin: 'enter',
  provenAt: 1,
  ...over,
})
const agent = (id: string, over: Partial<AgentProof> = {}): AgentProof => ({
  id,
  kind: 'subagent',
  label: id,
  spawnedAt: 1,
  ...over,
})
/** A pinned root with its toplevel resolved. A literal: this file must not depend on the ledger task. */
const run = (top?: string | null): AutoState => ({
  root: { cwd: MAIN, at: 1, ...(top === undefined ? {} : { top }) },
  worktrees: [],
  agents: [],
  dismissed: [],
  snapshot: null,
})
const base = (over: Partial<AutoState> = {}): AutoState => ({ ...run(MAIN), ...over })
const root = () => rec(MAIN, 'main')

test('an EnterWorktree proof with a porcelain record is a live child with its branch', () => {
  const s = base({ worktrees: [proof(`${DIR}/probe-wt`, { provenAt: 2 })] })
  const v = trackWorktrees(s, [root(), rec(`${DIR}/probe-wt`, 'worktree-probe-wt')], AT)
  expect(v.rows.map(r => [r.id, r.depth, r.state, r.branch])).toEqual([
    [`wt:${MAIN}`, 0, 'live', 'main'],
    [`wt:${DIR}/probe-wt`, 1, 'live', 'worktree-probe-wt'],
  ])
  expect(v.rows[1]?.name).toBe('probe-wt')
  expect(v.state.worktrees[0]).toMatchObject({ branch: 'worktree-probe-wt', seenAt: AT })
})

test('a proof without a record is removed, also a prunable record', () => {
  const s = base({ worktrees: [proof(`${DIR}/gone`, { branch: 'worktree-gone' }), proof(`${DIR}/dead`)] })
  const v = trackWorktrees(s, [root(), rec(`${DIR}/dead`, 'worktree-dead', { prunable: 'gitdir missing' })], AT)
  expect(v.rows.map(r => r.state)).toEqual(['live', 'removed', 'removed'])
  expect(v.rows[1]?.branch).toBe('worktree-gone')
})

test('a locked record is live: Claude locks its own session worktrees', () => {
  const s = base({ worktrees: [proof(`${DIR}/w`)] })
  const v = trackWorktrees(s, [root(), rec(`${DIR}/w`, 'b', { locked: 'claude agent running' })], AT)
  expect(v.rows[1]?.state).toBe('live')
})

test('a removed child comes back live when its record returns', () => {
  const first = trackWorktrees(base({ worktrees: [proof(`${DIR}/w`)] }), [root(), rec(`${DIR}/w`, 'b')], AT)
  const withSnapshot: AutoState = {
    ...first.state,
    snapshot: {
      at: AT,
      worktrees: first.rows.map(r => (r.depth === 1 ? { ...r, state: 'removed' as const } : r)),
      agents: [],
      branches: [],
      overflow: 0,
      git: { ok: true, at: AT },
      agentList: { ok: true, at: AT },
      prs: { ok: true },
    },
  }
  const again = trackWorktrees(withSnapshot, [root(), rec(`${DIR}/w`, 'b')], AT + 10)
  expect(again.rows[1]?.state).toBe('live')
  expect(again.state.worktrees[0]?.seenAt).toBe(AT + 10)
})

test('the agent convention path proves only a recorded agent id', () => {
  const s = base({ agents: [agent('a1')] })
  const list = [root(), rec(`${DIR}/agent-a1`, 'worktree-agent-a1'), rec(`${DIR}/agent-x`, 'worktree-agent-x')]
  const v = trackWorktrees(s, list, AT)
  expect(v.rows.map(r => r.name)).toEqual(['repo', 'agent-a1'])
  expect(v.state.worktrees[0]).toMatchObject({ origin: 'agent', owner: 'a1', path: `${DIR}/agent-a1` })
})

test('a manual worktree outside .claude/worktrees never shows', () => {
  const v = trackWorktrees(base(), [root(), rec('/x/manual-wt', 'manual'), rec(`${DIR}/hand-made`, 'hand')], AT)
  expect(v.rows).toHaveLength(1)
  expect(v.state.worktrees).toEqual([])
})

test('the run-prefix proof: a workflow worktree <runId>-<digits> for a recorded run id', () => {
  const wf = (runId: string) => agent('w', { kind: 'workflow', workflow: { runId, agentIndex: 1 } })
  const list = [root(), rec(`${DIR}/wf_a35565d1-fd4-21`, 'wf-branch')]
  const yes = trackWorktrees(base({ agents: [wf('wf_a35565d1-fd4')] }), list, AT)
  expect(yes.rows).toHaveLength(2)
  expect(yes.state.worktrees[0]).toMatchObject({ origin: 'workflow', runId: 'wf_a35565d1-fd4' })
  expect(trackWorktrees(base({ agents: [wf('wf_a35565d1')] }), list, AT).rows).toHaveLength(1)
  expect(trackWorktrees(base(), list, AT).rows).toHaveLength(1)
  const bad = [root(), rec(`${DIR}/wf_a35565d1-fd4-x`, 'wf-branch')]
  expect(trackWorktrees(base({ agents: [wf('wf_a35565d1-fd4')] }), bad, AT).rows).toHaveLength(1)
})

test('a symlinked proof path falls back to the same branch', () => {
  const s = base({ worktrees: [proof('/private/x/repo/.claude/worktrees/w', { branch: 'worktree-w' })] })
  const v = trackWorktrees(s, [root(), rec(`${DIR}/w`, 'worktree-w')], AT)
  expect(v.rows[1]).toMatchObject({ state: 'live', branch: 'worktree-w' })
})

test('branches: root first, live newest first, removed last; detached and duplicates left out', () => {
  const s = base({
    worktrees: [
      proof(`${DIR}/old`, { provenAt: 1, branch: 'b-old' }),
      proof(`${DIR}/mid`, { provenAt: 2 }),
      proof(`${DIR}/new`, { provenAt: 3 }),
      proof(`${DIR}/det`, { provenAt: 4 }),
      proof(`${DIR}/dup`, { provenAt: 5 }),
    ],
  })
  const list = [
    root(),
    rec(`${DIR}/mid`, 'b-mid'),
    rec(`${DIR}/new`, 'b-new'),
    rec(`${DIR}/det`),
    rec(`${DIR}/dup`, 'b-new'),
  ]
  expect(trackWorktrees(s, list, AT).branches).toEqual(['main', 'b-new', 'b-mid', 'b-old'])
})

test('a detached live child has no branch, even when its proof remembers one, and it is not polled', () => {
  const s = base({ worktrees: [proof(`${DIR}/det`, { provenAt: 2, branch: 'worktree-det' })] })
  const v = trackWorktrees(s, [root(), rec(`${DIR}/det`)], AT)
  expect(v.rows[1]).toMatchObject({ state: 'live', detached: true })
  expect(v.rows[1]?.branch).toBeUndefined()
  expect(v.branches).toEqual(['main'])
  // A removed child keeps the last known branch (spec 8.1).
  const gone = trackWorktrees(s, [root()], AT)
  expect(gone.rows[1]).toMatchObject({ state: 'removed', branch: 'worktree-det' })
  expect(gone.branches).toEqual(['main', 'worktree-det'])
})

test('branches are capped at maxBranches and the rest counts as overflow', () => {
  const worktrees = Array.from({ length: 15 }, (_, i) => proof(`${DIR}/w${i}`, { provenAt: i }))
  const list = [root(), ...worktrees.map((p, i) => rec(p.path, `b${i}`))]
  const v = trackWorktrees(base({ worktrees }), list, AT)
  expect(v.branches).toHaveLength(LIMITS.maxBranches)
  expect(v.overflow).toBe(16 - LIMITS.maxBranches)
})

test('a dismissed child leaves the rows and the branches', () => {
  const s = base({ worktrees: [proof(`${DIR}/w`)], dismissed: [`wt:${DIR}/w`] })
  const v = trackWorktrees(s, [root(), rec(`${DIR}/w`, 'b')], AT)
  expect(v.rows).toHaveLength(1)
  expect(v.branches).toEqual(['main'])
})

test('a root in detached HEAD still has a row, with no branch, and adds no branch to poll', () => {
  const s = base({ worktrees: [proof(`${DIR}/w`)] })
  const v = trackWorktrees(s, [rec(MAIN), rec(`${DIR}/w`, 'b')], AT)
  expect(v.rows[0]).toMatchObject({ depth: 0, detached: true })
  expect(v.rows[0]?.branch).toBeUndefined()
  expect(v.branches).toEqual(['b'])
})

test('an unresolved or missing top, or an empty list, gives no rows', () => {
  expect(trackWorktrees(run(), [root()], AT).rows).toEqual([])
  expect(trackWorktrees(run(null), [root()], AT).rows).toEqual([])
  expect(trackWorktrees(base(), [], AT).rows).toEqual([])
  expect(trackWorktrees({ ...run(), root: null }, [root()], AT).rows).toEqual([])
})

test('a second call on the returned state changes nothing: same state object', () => {
  const s = base({ worktrees: [proof(`${DIR}/w`)] })
  const list = [root(), rec(`${DIR}/w`, 'b')]
  const first = trackWorktrees(s, list, AT)
  const second = trackWorktrees(first.state, list, AT + 30_000)
  expect(second.state).toBe(first.state)
  expect(second.rows).toEqual(first.rows)
})

/** The state as a round saves it: the rows become the snapshot, so the next call sees the previous row states. */
const withRows = (s: AutoState, rows: ReturnType<typeof trackWorktrees>['rows']): AutoState => ({
  ...s,
  snapshot: {
    at: AT,
    worktrees: rows,
    agents: [],
    branches: [],
    overflow: 0,
    git: { ok: true, at: AT },
    agentList: { ok: true, at: AT },
    prs: { ok: true },
  },
})

test('a prunable record never renews seenAt: rounds with the same record give the same state (A22)', () => {
  const list = [root(), rec(`${DIR}/dead`, 'worktree-dead', { prunable: 'gitdir missing' })]
  let s = base({ worktrees: [proof(`${DIR}/dead`, { seenAt: 2, branch: 'worktree-dead' })] })
  const first = trackWorktrees(s, list, AT)
  expect(first.state).toBe(s)
  for (const step of [10, 20, 30]) {
    s = withRows(first.state, first.rows)
    const again = trackWorktrees(s, list, AT + step)
    expect(again.rows[1]?.state).toBe('removed')
    expect(again.state).toBe(s)
  }
  // A proof never seen live gets no seenAt from a prunable record either.
  const fresh = trackWorktrees(base({ worktrees: [proof(`${DIR}/dead`)] }), list, AT)
  expect(fresh.state.worktrees[0]?.seenAt).toBeUndefined()
})

test('more convention worktrees than maxProofs: the list stays full and a second round changes nothing (A22)', () => {
  const total = LIMITS.maxProofs + 1
  const list = [root()]
  const names = Array.from({ length: total }, (_, i) => `wf_r-${i + 1}`)
  for (const n of names) list.push(rec(`${DIR}/${n}`, `b-${n}`))
  const s = base({ agents: [agent('w', { kind: 'workflow', workflow: { runId: 'wf_r', agentIndex: 1 } })] })
  const first = trackWorktrees(s, list, AT)
  expect(first.state.worktrees).toHaveLength(LIMITS.maxProofs)
  const second = trackWorktrees(first.state, list, AT + 10)
  expect(second.state).toBe(first.state)
  expect(second.rows).toEqual(first.rows)
})
