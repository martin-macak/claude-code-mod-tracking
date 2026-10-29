// trackWorktrees: proven children only, row states, tracked branches. Pure.
import { expect, test } from 'claude-code/testing'
import { trackWorktrees } from '../trackers/auto/worktrees'
import type { AgentProof, AutoState, GitWorktree, WorktreeProof } from './fixtures/contracts'
import { LIMITS } from './fixtures/limits'

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

test('only a removed child whose prunable record git still lists is marked prunable (what /track clean may remove)', () => {
  const s = base({ worktrees: [proof(`${DIR}/gone`), proof(`${DIR}/dead`), proof(`${DIR}/w`)] })
  const list = [root(), rec(`${DIR}/dead`, 'b-dead', { prunable: 'gitdir missing' }), rec(`${DIR}/w`, 'b-w')]
  const v = trackWorktrees(s, list, AT)
  expect(v.rows.map(r => [r.id, r.state, r.prunable])).toEqual([
    [`wt:${MAIN}`, 'live', undefined],
    [`wt:${DIR}/gone`, 'removed', undefined], // no record at all: nothing is left to clean
    [`wt:${DIR}/dead`, 'removed', true],
    [`wt:${DIR}/w`, 'live', undefined],
  ])
})

test('a locked record is live: Claude locks its own session worktrees', () => {
  const s = base({ worktrees: [proof(`${DIR}/w`)] })
  const v = trackWorktrees(s, [root(), rec(`${DIR}/w`, 'b', { locked: 'claude agent running' })], AT)
  expect(v.rows[1]?.state).toBe('live')
})

// Issue #123: the plan of `/track clean` is pure, so the dry run can name a lock only when the row carries it.
test('a locked record gives its child row the lock reason; an empty reason stays, an unlocked or removed child has none', () => {
  const s = base({ worktrees: [proof(`${DIR}/a`), proof(`${DIR}/b`), proof(`${DIR}/c`), proof(`${DIR}/gone`)] })
  const list = [
    root(),
    rec(`${DIR}/a`, 'b-a', { locked: 'claude agent wf_1-1 (pid 5)' }),
    rec(`${DIR}/b`, 'b-b', { locked: '' }),
    rec(`${DIR}/c`, 'b-c'),
  ]
  const v = trackWorktrees(s, list, AT)
  expect(v.rows.map(r => [r.name, r.locked])).toEqual([
    ['repo', undefined], // the root row never carries a lock
    ['a', 'claude agent wf_1-1 (pid 5)'],
    ['b', ''],
    ['c', undefined],
    ['gone', undefined],
  ])
  expect(v.rows[2]).toHaveProperty('locked', '')
  expect(v.rows[3]).not.toHaveProperty('locked')
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

// The premise of the clean recheck: a record that a symlink alias reaches by branch can be prunable, so the round marks the
// row, and `/track clean` must find the same record (tests/clean-worktrees.test.ts, "a proof matched by branch ...").
test('a symlinked proof path matched by branch to a prunable record is a removed row, marked prunable', () => {
  const alias = '/private/x/repo/.claude/worktrees/w'
  const s = base({ worktrees: [proof(alias, { branch: 'worktree-w' })] })
  const v = trackWorktrees(s, [root(), rec(`${DIR}/w`, 'worktree-w', { prunable: 'gitdir missing' })], AT)
  expect(v.rows[1]).toMatchObject({ id: `wt:${alias}`, path: alias, state: 'removed', prunable: true })
})

// A symlink alias changes the start of a path and never its last segments. A record of the same branch somewhere else is
// a manual worktree that reuses the branch: it is not the child of the proof, live or prunable.
test('a record of the remembered branch at an unrelated path is not the proof: the child stays removed', () => {
  const s = base({ worktrees: [proof(`${DIR}/w`, { branch: 'worktree-w' })] })
  const prunable = trackWorktrees(
    s,
    [root(), rec('/manual/checkout', 'worktree-w', { prunable: 'gitdir missing' })],
    AT,
  )
  expect(prunable.rows[1]).toMatchObject({ state: 'removed' })
  expect(prunable.rows[1]?.prunable).toBeUndefined()
  const live = trackWorktrees(s, [root(), rec('/manual/checkout', 'worktree-w')], AT)
  expect(live.rows[1]).toMatchObject({ state: 'removed' })
  expect(live.state.worktrees[0]?.removedAt).toBe(AT)
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

test('a round keeps the turn stamps of a proof, live, quiet and removed, and gives a proof that it makes none (issue #205)', () => {
  const s = base({ worktrees: [proof(`${DIR}/w`, { firstTurn: 3, lastTurn: 5 })], agents: [agent('abc')] })
  const list = [root(), rec(`${DIR}/w`, 'b'), rec(`${DIR}/agent-abc`, 'wt-abc')]
  const first = trackWorktrees(s, list, AT)
  expect(first.state.worktrees[0]).toMatchObject({ path: `${DIR}/w`, firstTurn: 3, lastTurn: 5 })
  const found = first.state.worktrees.find(p => p.path === `${DIR}/agent-abc`)
  expect(found).toMatchObject({ origin: 'agent', owner: 'abc' })
  expect(found).not.toHaveProperty('firstTurn') // a round has no turn
  const quiet = trackWorktrees(first.state, list, AT + 30_000)
  expect(quiet.state).toBe(first.state) // a round that only lists them again writes nothing
  const gone = trackWorktrees(first.state, [root()], AT + 60_000)
  expect(gone.state.worktrees[0]).toMatchObject({ firstTurn: 3, lastTurn: 5, removedAt: AT + 60_000 })
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
  // The first round that finds the child removed dates it (issue #49). Only `removedAt` is new: `seenAt` stays.
  expect(first.state.worktrees).toEqual([{ ...s.worktrees[0], removedAt: AT }])
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

// Issue #49: a removed child gets `removedAt` once, so the view can hide it after `removedTtlMs`. It is the only write.
test('a proof with no record gets removedAt at the first round that finds it removed, and the next round keeps it (A22)', () => {
  const s = base({ worktrees: [proof(`${DIR}/gone`, { seenAt: 2 })] })
  const first = trackWorktrees(s, [root()], AT)
  expect(first.rows[1]?.state).toBe('removed')
  expect(first.state.worktrees[0]).toMatchObject({ seenAt: 2, removedAt: AT })
  const saved = withRows(first.state, first.rows)
  const second = trackWorktrees(saved, [root()], AT + 60_000)
  expect(second.state.worktrees[0]?.removedAt).toBe(AT) // the first time stays
  expect(second.state).toBe(saved) // and a quiet round changes nothing
})

test('a prunable record counts as removed: it sets removedAt too', () => {
  const list = [root(), rec(`${DIR}/dead`, 'worktree-dead', { prunable: 'gitdir missing' })]
  const v = trackWorktrees(base({ worktrees: [proof(`${DIR}/dead`, { seenAt: 2 })] }), list, AT)
  expect(v.rows[1]?.state).toBe('removed')
  expect(v.state.worktrees[0]?.removedAt).toBe(AT)
})

test('a live child has no removedAt, and a removed child that comes back live loses it', () => {
  const live = trackWorktrees(base({ worktrees: [proof(`${DIR}/w`)] }), [root(), rec(`${DIR}/w`, 'b')], AT)
  expect(live.state.worktrees[0]).not.toHaveProperty('removedAt')
  const gone = trackWorktrees(live.state, [root()], AT + 10)
  expect(gone.state.worktrees[0]?.removedAt).toBe(AT + 10)
  const back = trackWorktrees(withRows(gone.state, gone.rows), [root(), rec(`${DIR}/w`, 'b')], AT + 20)
  expect(back.rows[1]?.state).toBe('live')
  expect(back.state.worktrees[0]).not.toHaveProperty('removedAt')
})

test('a dismissed removed child leaves the rows and its proof is dated once as well', () => {
  const s = base({ worktrees: [proof(`${DIR}/gone`)], dismissed: [`wt:${DIR}/gone`] })
  const v = trackWorktrees(s, [root()], AT)
  expect(v.rows).toHaveLength(1)
  expect(v.state.worktrees[0]?.removedAt).toBe(AT)
  expect(trackWorktrees(v.state, [root()], AT + 5).state).toBe(v.state)
})
