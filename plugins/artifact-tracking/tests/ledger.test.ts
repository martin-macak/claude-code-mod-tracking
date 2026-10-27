// Ledger: root pin, proofs, agent records, carry-over. Pure.
import { expect, test } from 'claude-code/testing'
import {
  carryAuto,
  emptyAuto,
  pinRoot,
  recordActivity,
  recordAgentBranch,
  recordAgentResult,
  recordEnter,
  recordExit,
  recordPr,
  recordSpawn,
  recordTurnEnd,
  setRootTop,
} from '../trackers/auto/ledger'
import type { AutoState, SpawnFacts } from './fixtures/contracts'
import { LIMITS } from './fixtures/limits'

const AT = 1_000_000
const MIN = 60_000

const rooted = (): AutoState => setRootTop(pinRoot(emptyAuto(), '/r', 1), '/r')
const sp = (agentId: string, over: Partial<SpawnFacts> = {}): SpawnFacts => ({
  agentId,
  description: 'desc',
  subagentType: 'general-purpose',
  ...over,
})

test('pinRoot pins once; a second pin keeps the first cwd and the same object', () => {
  const a = pinRoot(emptyAuto(), '/r', 1)
  expect(a.root).toEqual({ cwd: '/r', at: 1 })
  const b = pinRoot(a, '/other', 2)
  expect(b).toBe(a)
})

test('setRootTop resolves once, also to null', () => {
  const a = pinRoot(emptyAuto(), '/r/sub', 1)
  const b = setRootTop(a, '/r')
  expect(b.root?.top).toBe('/r')
  expect(setRootTop(b, '/elsewhere')).toBe(b)
  expect(setRootTop(a, null).root?.top).toBeNull()
  expect(setRootTop(emptyAuto(), '/r')).toEqual(emptyAuto())
})

test('recordEnter adds a proof; the same path again is the same object; a new branch updates it', () => {
  const a = recordEnter(rooted(), { path: '/r/.claude/worktrees/w', branch: 'worktree-w' }, AT)
  expect(a.worktrees).toEqual([{ path: '/r/.claude/worktrees/w', origin: 'enter', branch: 'worktree-w', provenAt: AT }])
  expect(recordEnter(a, { path: '/r/.claude/worktrees/w', branch: 'worktree-w' }, AT + 1)).toBe(a)
  const b = recordEnter(a, { path: '/r/.claude/worktrees/w', branch: 'renamed' }, AT + 2)
  expect(b.worktrees[0]?.branch).toBe('renamed')
  expect(b.worktrees[0]?.provenAt).toBe(AT)
})

test('recordEnter ignores the root path, also with a trailing slash and the resolved top', () => {
  const s = setRootTop(pinRoot(emptyAuto(), '/link/r', 1), '/real/r')
  expect(recordEnter(s, { path: '/link/r' }, AT)).toBe(s)
  expect(recordEnter(s, { path: '/link/r/' }, AT)).toBe(s)
  expect(recordEnter(s, { path: '/real/r/' }, AT)).toBe(s)
})

test('recordEnter stores the path without a trailing slash and remembers the owner agent', () => {
  const a = recordEnter(rooted(), { path: '/r/.claude/worktrees/w/', agentId: 'ag1' }, AT)
  expect(a.worktrees[0]?.path).toBe('/r/.claude/worktrees/w')
  expect(a.worktrees[0]?.owner).toBe('ag1')
})

const W = '/r/.claude/worktrees/w'

test('recordEnter with a turn stamps a new proof for both stamps; with no turn it stamps nothing (issue #205)', () => {
  const a = recordEnter(rooted(), { path: W, branch: 'b' }, AT, LIMITS.maxProofs, 3)
  expect(a.worktrees).toEqual([{ path: W, origin: 'enter', branch: 'b', provenAt: AT, firstTurn: 3, lastTurn: 3 }])
  expect(recordEnter(rooted(), { path: W, branch: 'b' }, AT).worktrees[0]).not.toHaveProperty('firstTurn')
})

test('recordEnter of a known path: the same turn is the same object, a later turn moves lastTurn, an older one lowers firstTurn only', () => {
  const a = recordEnter(rooted(), { path: W, branch: 'b' }, AT, LIMITS.maxProofs, 3)
  expect(recordEnter(a, { path: W, branch: 'b' }, AT + 1, LIMITS.maxProofs, 3)).toBe(a)
  expect(recordEnter(a, { path: W, branch: 'b' }, AT + 1)).toBe(a) // no turn running: nothing to stamp
  const b = recordEnter(a, { path: W, branch: 'b' }, AT + 2, LIMITS.maxProofs, 5)
  expect(b).not.toBe(a)
  expect(b.worktrees[0]).toMatchObject({ firstTurn: 3, lastTurn: 5, provenAt: AT })
  expect(recordEnter(b, { path: W, branch: 'b' }, AT + 3, LIMITS.maxProofs, 5)).toBe(b)
  expect(recordEnter(b, { path: W, branch: 'b' }, AT + 3, LIMITS.maxProofs, 4)).toBe(b) // inside the span already
  const c = recordEnter(b, { path: W, branch: 'b' }, AT + 4, LIMITS.maxProofs, 2) // late work of an older turn
  expect(c.worktrees[0]).toMatchObject({ firstTurn: 2, lastTurn: 5 })
})

test('recordEnter of a known path with a new branch and a new turn changes both in one step', () => {
  const a = recordEnter(rooted(), { path: W, branch: 'b' }, AT, LIMITS.maxProofs, 3)
  const b = recordEnter(a, { path: W, branch: 'renamed' }, AT + 1, LIMITS.maxProofs, 5)
  expect(b.worktrees[0]).toMatchObject({ branch: 'renamed', firstTurn: 3, lastTurn: 5 })
})

test('recordEnter gives a proof that no turn stamped (a round made it, or an event with no turn running) both stamps of the turn', () => {
  const a = recordEnter(rooted(), { path: W, branch: 'b' }, AT)
  const b = recordEnter(a, { path: W, branch: 'b' }, AT + 1, LIMITS.maxProofs, 4)
  expect(b.worktrees[0]).toMatchObject({ firstTurn: 4, lastTurn: 4 })
})

test('recordAgentResult with a turn stamps the proof of its path as recordEnter does; a repeat of the turn is the same object', () => {
  const s = recordSpawn(rooted(), sp('a1'), AT, '/r')
  const path = '/r/.claude/worktrees/agent-a1'
  const t = recordAgentResult(s, { agentId: 'a1', worktreePath: path }, AT + 1, LIMITS.maxProofs, 3)
  expect(t.worktrees[0]).toMatchObject({ path, origin: 'agent', firstTurn: 3, lastTurn: 3 })
  expect(recordAgentResult(t, { agentId: 'a1', worktreePath: path }, AT + 2, LIMITS.maxProofs, 3)).toBe(t)
  const u = recordAgentResult(t, { agentId: 'a1', worktreePath: path }, AT + 2, LIMITS.maxProofs, 6)
  expect(u.worktrees[0]).toMatchObject({ firstTurn: 3, lastTurn: 6 })
  expect(recordAgentResult(s, { agentId: 'a1' }, AT, LIMITS.maxProofs, 3)).toBe(s) // no path: nothing to stamp
  expect(recordAgentResult(s, { agentId: 'a1', worktreePath: '/r/' }, AT, LIMITS.maxProofs, 3)).toBe(s) // the root
})

test('recordExit stamps the proof of a known path and makes none: an unknown path, the root and no turn return the same object', () => {
  const a = recordEnter(rooted(), { path: W }, AT, LIMITS.maxProofs, 3)
  const b = recordExit(a, W, 5)
  expect(b.worktrees).toEqual([{ path: W, origin: 'enter', provenAt: AT, firstTurn: 3, lastTurn: 5 }])
  expect(recordExit(b, `${W}/`, 5)).toBe(b) // the same turn again, also with a trailing slash
  expect(recordExit(a, W, undefined)).toBe(a)
  expect(recordExit(a, '/r/.claude/worktrees/other', 5)).toBe(a)
  expect(recordExit(a, '/r', 5)).toBe(a)
  expect(recordExit(rooted(), W, 5).worktrees).toEqual([])
})

test('proofs and agents are capped at the newest', () => {
  let s = rooted()
  for (let i = 0; i < LIMITS.maxProofs + 5; i++) s = recordEnter(s, { path: `/r/.claude/worktrees/w${i}` }, AT + i)
  expect(s.worktrees).toHaveLength(LIMITS.maxProofs)
  expect(s.worktrees[LIMITS.maxProofs - 1]?.path).toBe(`/r/.claude/worktrees/w${LIMITS.maxProofs + 4}`)
  let t = rooted()
  for (let i = 0; i < LIMITS.maxAgents + 5; i++) t = recordSpawn(t, sp(`a${i}`), AT + i, '/r')
  expect(t.agents).toHaveLength(LIMITS.maxAgents)
})

test('recordSpawn: a subagent takes label from name, then description, then type', () => {
  const s = rooted()
  expect(recordSpawn(s, sp('a', { name: 'iso-agent' }), AT, '/r').agents[0]).toMatchObject({
    id: 'a',
    kind: 'subagent',
    label: 'iso-agent',
    spawnedAt: AT,
  })
  expect(recordSpawn(s, sp('b'), AT, '/r').agents[0]?.label).toBe('desc')
  expect(recordSpawn(s, sp('c', { description: '' }), AT, '/r').agents[0]?.label).toBe('general-purpose')
})

test('recordSpawn: a workflow agent has kind workflow and keeps run id and index', () => {
  const a = recordSpawn(rooted(), sp('w1', { workflow: { runId: 'wf_x-1', agentIndex: 3 } }), AT, '/r').agents[0]
  expect(a).toMatchObject({ kind: 'workflow', workflow: { runId: 'wf_x-1', agentIndex: 3 } })
})

test('recordSpawn: cwd is the event cwd, else the parent cwd for a nested child, else the session cwd', () => {
  let s = rooted()
  s = recordSpawn(s, sp('top'), AT, '/r/.claude/worktrees/w')
  expect(s.agents[0]?.cwd).toBe('/r/.claude/worktrees/w')
  s = recordSpawn(s, sp('kid', { parentAgentId: 'top' }), AT, '/somewhere/else')
  expect(s.agents[1]).toMatchObject({ parentId: 'top', cwd: '/r/.claude/worktrees/w' })
  s = recordSpawn(s, sp('own', { cwd: '/own' }), AT, '/r')
  expect(s.agents[2]?.cwd).toBe('/own')
})

test('recordSpawn: a second spawn event for a known id (a retry) keeps the first record', () => {
  const s = recordSpawn(rooted(), sp('a', { name: 'first' }), AT, '/r')
  expect(recordSpawn(s, sp('a', { name: 'second' }), AT + 5, '/r')).toBe(s)
})

test('recordActivity: sets lastActiveAt of an old workflow agent', () => {
  const s = recordSpawn(rooted(), sp('w', { workflow: { runId: 'wf_x', agentIndex: 1 } }), AT, '/r')
  const t = recordActivity(s, 'w', AT + 2 * MIN)
  expect(t.agents[0]?.lastActiveAt).toBe(AT + 2 * MIN)
})

test('recordActivity returns the same object for an unknown id, a subagent and a bump under 60 s old', () => {
  let s = recordSpawn(rooted(), sp('sub'), AT, '/r')
  s = recordSpawn(s, sp('w', { workflow: { runId: 'wf_x', agentIndex: 1 } }), AT, '/r')
  expect(recordActivity(s, 'nope', AT + 5 * MIN)).toBe(s)
  expect(recordActivity(s, 'sub', AT + 5 * MIN)).toBe(s)
  expect(recordActivity(s, 'w', AT + 30_000)).toBe(s)
  const bumped = recordActivity(s, 'w', AT + 2 * MIN)
  expect(recordActivity(bumped, 'w', AT + 2 * MIN + 10_000)).toBe(bumped)
})

test('recordActivity clears a stale end, but does not revive an agent that an event ended', () => {
  let s = recordSpawn(rooted(), sp('w', { workflow: { runId: 'wf_x', agentIndex: 1 } }), AT, '/r')
  const stale: AutoState = { ...s, agents: [{ ...s.agents[0]!, endedAt: AT + 90 * MIN, stale: true }] }
  const back = recordActivity(stale, 'w', AT + 100 * MIN)
  expect(back.agents[0]?.endedAt).toBeUndefined()
  expect(back.agents[0]?.stale).toBeUndefined()
  expect(back.agents[0]?.lastActiveAt).toBe(AT + 100 * MIN)
  s = recordTurnEnd(s, 'w', 'answer', AT + 10 * MIN)
  expect(recordActivity(s, 'w', AT + 20 * MIN)).toBe(s)
})

test('recordTurnEnd: unknown id is the same object; error and refusal fail; answer and aborted end', () => {
  const s = recordSpawn(rooted(), sp('w', { workflow: { runId: 'wf_x', agentIndex: 1 } }), AT, '/r')
  expect(recordTurnEnd(s, 'nope', 'answer', AT)).toBe(s)
  expect(recordTurnEnd(s, 'w', 'answer', AT + 5).agents[0]).toMatchObject({ endedAt: AT + 5 })
  expect(recordTurnEnd(s, 'w', 'aborted', AT + 5).agents[0]?.failed).toBeUndefined()
  expect(recordTurnEnd(s, 'w', 'error', AT + 5).agents[0]).toMatchObject({ endedAt: AT + 5, failed: true })
  expect(recordTurnEnd(s, 'w', 'refusal', AT + 5).agents[0]?.failed).toBe(true)
})

test('recordTurnEnd: ends only an agent the list does not hold; a second end is the same object', () => {
  let s = recordSpawn(rooted(), sp('sub'), AT, '/r')
  s = { ...s, agents: [{ ...s.agents[0]!, listed: true, status: 'running' }] }
  expect(recordTurnEnd(s, 'sub', 'answer', AT + 5)).toBe(s)
  const dropped: AutoState = { ...s, agents: [{ ...s.agents[0]!, listed: true, status: 'idle' }] }
  const ended = recordTurnEnd(dropped, 'sub', 'answer', AT + 5)
  expect(ended.agents[0]?.endedAt).toBe(AT + 5)
  expect(recordTurnEnd(ended, 'sub', 'answer', AT + 9)).toBe(ended)
})

test('recordAgentResult: an exact path becomes an agent proof and sets the agent worktree and branch', () => {
  const s = recordSpawn(rooted(), sp('a1'), AT, '/r')
  const t = recordAgentResult(
    s,
    { agentId: 'a1', worktreePath: '/r/.claude/worktrees/agent-a1', worktreeBranch: 'worktree-agent-a1' },
    AT + 1,
  )
  expect(t.worktrees[0]).toMatchObject({ path: '/r/.claude/worktrees/agent-a1', origin: 'agent', owner: 'a1' })
  expect(t.agents[0]).toMatchObject({ worktreePath: '/r/.claude/worktrees/agent-a1', branch: 'worktree-agent-a1' })
})

test('recordAgentResult: no path, the root path and a repeat change nothing', () => {
  const s = recordSpawn(rooted(), sp('a1'), AT, '/r')
  expect(recordAgentResult(s, { agentId: 'a1' }, AT)).toBe(s)
  expect(recordAgentResult(s, { agentId: 'a1', worktreePath: '/r/' }, AT)).toBe(s)
  const t = recordAgentResult(s, { agentId: 'a1', worktreePath: '/r/.claude/worktrees/agent-a1' }, AT)
  expect(recordAgentResult(t, { agentId: 'a1', worktreePath: '/r/.claude/worktrees/agent-a1' }, AT + 9)).toBe(t)
})

test('recordAgentBranch sets the branch once; unknown id and the same branch are the same object', () => {
  const s = recordSpawn(rooted(), sp('a1'), AT, '/r')
  const t = recordAgentBranch(s, 'a1', 'feat/x')
  expect(t.agents[0]?.branch).toBe('feat/x')
  expect(recordAgentBranch(t, 'a1', 'feat/x')).toBe(t)
  expect(recordAgentBranch(s, 'nope', 'feat/x')).toBe(s)
})

// Issue #158: a PR the run created is a proof, kept like a worktree proof.
const PR = { host: 'github.com', owner: 'VerticeOne', repo: 'vertice-iam', number: 657 }

test('recordPr adds the PR with the case it came with; the same PR in any case is the same object', () => {
  const a = recordPr(rooted(), PR)
  expect(a.prs).toEqual([PR])
  expect(recordPr(a, { ...PR, owner: 'verticeone', repo: 'VERTICE-IAM', host: 'GitHub.com' })).toBe(a)
  const b = recordPr(a, { ...PR, number: 658 })
  expect(b.prs?.map(p => p.number)).toEqual([657, 658])
  // The same number in another repo, or on another host, is another PR.
  expect(recordPr(b, { ...PR, repo: 'other' }).prs).toHaveLength(3)
  expect(recordPr(b, { ...PR, host: 'ghe.example' }).prs).toHaveLength(3)
})

test('recordPr keeps the newest maxProofs, and the root is not needed', () => {
  let s = emptyAuto()
  for (let n = 1; n <= 5; n++) s = recordPr(s, { ...PR, number: n }, 3)
  expect(s.prs?.map(p => p.number)).toEqual([3, 4, 5])
  expect(s.root).toBeNull()
})

test('recordPr starts the list of a slot from before #158, which has no prs', () => {
  const old = rooted()
  expect('prs' in old).toBe(false)
  expect(recordPr(old, PR).prs).toHaveLength(1)
})

test('carryAuto keeps the PR proofs over /clear, with the other proofs', () => {
  const held = recordPr(pinRoot(emptyAuto(), '/held', 1), PR)
  expect(carryAuto(held, emptyAuto()).prs).toEqual([PR])
  expect(carryAuto(held, undefined).prs).toHaveLength(1)
})

test('carryAuto: cur with a root wins, even over a held copy with a root', () => {
  const held = pinRoot(emptyAuto(), '/held', 1)
  const cur = pinRoot(emptyAuto(), '/cur', 2)
  expect(carryAuto(held, cur)).toBe(cur)
})

test('carryAuto: held wins only when cur has no root (after /clear)', () => {
  const held = pinRoot(emptyAuto(), '/held', 1)
  expect(carryAuto(held, emptyAuto())).toBe(held)
  expect(carryAuto(held, undefined)).toBe(held)
})

test('carryAuto: after a reload held is undefined; with nothing at all it is empty', () => {
  const cur = pinRoot(emptyAuto(), '/cur', 2)
  expect(carryAuto(undefined, cur)).toBe(cur)
  expect(carryAuto(undefined, undefined)).toEqual(emptyAuto())
  expect(carryAuto(emptyAuto(), emptyAuto())).toEqual(emptyAuto())
})

/** Models `update`: read, apply, write with ifVersion, retry on a miss. */
function atomOf(initial: AutoState) {
  let value = initial
  let version = 0
  let before: (() => void) | undefined
  return {
    get value() {
      return value
    },
    beforeCommit(fn: () => void) {
      before = fn
    },
    write(change: (cur: AutoState) => AutoState) {
      value = change(value)
      version++
    },
    update(change: (cur: AutoState) => AutoState): AutoState {
      for (;;) {
        const seen = version
        const next = change(value)
        const hook = before
        before = undefined
        hook?.()
        if (seen === version) {
          value = next
          version++
          return next
        }
      }
    },
  }
}

test('two writers that interleave through update-with-retry both survive', () => {
  const atom = atomOf(rooted())
  atom.beforeCommit(() => atom.write(s => recordEnter(s, { path: '/r/.claude/worktrees/w' }, AT)))
  atom.update(s => recordSpawn(s, sp('a1'), AT, '/r'))
  expect(atom.value.agents.map(a => a.id)).toEqual(['a1'])
  expect(atom.value.worktrees.map(w => w.path)).toEqual(['/r/.claude/worktrees/w'])
})
