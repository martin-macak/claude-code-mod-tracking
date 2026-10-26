// AutoRound: the worktree and agent steps, writes in flight (A20) and quiet rounds (A22). Fake deps. The PR lane is the
// github tracker's since plan L5, Task 12: its cases moved to tests/pr-lane.test.ts, each split case keeps its name there.
import { expect, test } from 'claude-code/testing'
import { emptyAuto, pinRoot, recordAgentBranch, recordEnter, recordSpawn } from '../trackers/auto/ledger'
import { AutoRound, type RoundDeps } from '../trackers/auto/round'
import type { AutoReason, AutoState, LiveAgent } from './fixtures/contracts'
import { isRowId } from './fixtures/contracts'
import { porcelain as gitPorcelain, NOT_A_REPO_STDERR } from './fixtures/git'

const MAIN = '/x/repo'

const porcelain = (...kids: [string, string][]): string => gitPorcelain(MAIN, ...kids)

/** Lets every pending promise step run. The round uses promises only, no timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

type Setup = { seed?: AutoState; withChild?: boolean }

function rig(setup: Setup = {}) {
  let auto: AutoState =
    setup.seed ??
    (setup.withChild === false
      ? pinRoot(emptyAuto(), MAIN, 1)
      : recordEnter(
          pinRoot(emptyAuto(), MAIN, 1),
          { path: `${MAIN}/.claude/worktrees/probe-wt`, branch: 'worktree-probe-wt' },
          2,
        ))
  const log = { git: [] as string[][], saves: 0 }
  const state = {
    now: 1_000_000,
    isRepo: true,
    gitFail: false,
    agentFail: false,
    porcelain: porcelain(['probe-wt', 'worktree-probe-wt']),
    agents: [] as LiveAgent[],
    cwd: MAIN,
  }
  const gate: { agents?: Promise<void> } = {}

  const deps: RoundDeps = {
    now: () => state.now,
    load: async () => auto,
    save: async change => {
      const next = change(auto)
      if (next !== auto) {
        auto = next
        log.saves++
      }
      return auto
    },
    git: async argv => {
      log.git.push([...argv])
      if (state.gitFail) throw new Error('git broke')
      if (argv[0] === 'rev-parse')
        return state.isRepo
          ? { exitCode: 0, stdout: MAIN + '\n', stderr: '' }
          : { exitCode: 128, stdout: '', stderr: NOT_A_REPO_STDERR }
      return { exitCode: 0, stdout: state.porcelain, stderr: '' }
    },
    listAgents: async () => {
      await gate.agents
      if (state.agentFail) throw new Error('list failed')
      return state.agents
    },
    sessionCwd: async () => state.cwd,
  }
  const round = new AutoRound(deps)
  const hold = () => {
    let release = () => {}
    gate.agents = new Promise<void>(resolve => {
      release = resolve
    })
    return release
  }
  // The reasons belong to the scheduler, which publishes them with the branches; a round takes none.
  const run = (..._reasons: AutoReason[]) => round.run()
  return {
    deps,
    round,
    run,
    state,
    log,
    hold,
    auto: () => auto,
    setAuto: (change: (s: AutoState) => AutoState) => {
      auto = change(auto)
    },
  }
}

const spawn = (agentId: string) => ({ agentId, description: 'd', subagentType: 'general-purpose' })

test('a first round resolves the root once, tracks the proven child and finds the PR of a tracked branch', async () => {
  const t = rig()
  expect(await t.run('start')).toBe(true) // it reached the snapshot save, so the scheduler publishes its branches
  const snap = t.auto().snapshot!
  expect(t.auto().root?.top).toBe(MAIN)
  expect(snap.worktrees.map(r => [r.name, r.state])).toEqual([
    ['repo', 'live'],
    ['probe-wt', 'live'],
  ])
  expect(snap.agents.map(r => r.id)).toEqual(['ag:master'])
  // dismissOne tells a row id from an item key with isRowId: every row the round builds must pass it.
  expect([...snap.worktrees, ...snap.agents].every(r => isRowId(r.id))).toBe(true)
  expect(snap.branches).toEqual(['main', 'worktree-probe-wt']) // the PR step polls these (tests/pr-lane.test.ts)
  expect('prs' in snap).toBe(false) // the pull requests are the github tracker's
  expect(t.log.git).toEqual([
    ['rev-parse', '--show-toplevel'],
    ['worktree', 'list', '--porcelain'],
  ])
})

test('without a pinned root the round does nothing', async () => {
  const t = rig({ seed: emptyAuto() })
  expect(await t.run('start')).toBe(false) // nothing was polled: the scheduler publishes no branches
  expect(t.log.git).toHaveLength(0)
  expect(t.auto().snapshot).toBeNull()
})

test('rev-parse runs once per run; worktree list runs every round', async () => {
  const t = rig()
  await t.run('start')
  await t.run('agent')
  expect(t.log.git.filter(c => c[0] === 'rev-parse')).toHaveLength(1)
  expect(t.log.git.filter(c => c[0] === 'worktree')).toHaveLength(2)
})

test('not a git repository: no more git calls, agents still listed, PR step skips with no-branches', async () => {
  const t = rig({ withChild: false })
  t.state.isRepo = false
  t.state.agents = [{ id: 'a1', status: 'running' }]
  t.setAuto(s => recordSpawn(s, spawn('a1'), 5, MAIN))
  await t.run('start')
  expect(t.auto().root?.top).toBeNull()
  await t.run('tick')
  expect(t.log.git).toEqual([['rev-parse', '--show-toplevel']])
  const snap = t.auto().snapshot!
  expect(snap.worktrees).toEqual([])
  expect(snap.agents.map(r => r.id)).toEqual(['ag:master', 'ag:a1'])
  expect(snap.branches).toEqual([]) // nothing for the PR step to poll
})

test('a failed git call sets the note, keeps the last rows, still computes agents and polls the last branches', async () => {
  const t = rig()
  await t.run('start')
  t.state.gitFail = true
  t.state.agents = []
  await t.run('tick')
  const snap = t.auto().snapshot!
  expect(snap.git).toMatchObject({ ok: false, error: 'git broke' })
  expect(snap.worktrees.map(r => r.name)).toEqual(['repo', 'probe-wt'])
  expect(snap.agents.map(r => r.id)).toEqual(['ag:master'])
  expect(snap.branches).toEqual(['main', 'worktree-probe-wt']) // the last branches, for the PR step
})

test('a failed agent list sets agentList and keeps the statuses', async () => {
  const t = rig()
  t.setAuto(s => recordSpawn(s, spawn('a1'), 5, MAIN))
  t.state.agents = [{ id: 'a1', status: 'running' }]
  await t.run('start')
  t.state.agentFail = true
  await t.run('agent')
  const snap = t.auto().snapshot!
  expect(snap.agentList).toMatchObject({ ok: false, error: 'list failed' })
  expect(snap.agents.find(r => r.id === 'ag:a1')?.state).toBe('running')
})

test('an open breaker (blocked) still saves worktrees and agents', async () => {
  const t = rig()
  await t.run('start') // a blocked gh is the github tracker's note; the round saves its rows whatever gh does
  const snap = t.auto().snapshot!
  expect(snap.worktrees).toHaveLength(2)
  expect(snap.agents).toHaveLength(1)
})

test('writes in flight (a): a recordSpawn that lands while listAgents waits is in the saved snapshot', async () => {
  const t = rig()
  const release = t.hold()
  const p = t.run('start')
  await flush()
  t.setAuto(s => recordSpawn(s, spawn('a1'), 5, MAIN))
  release()
  await p
  expect(t.auto().agents.map(a => a.id)).toEqual(['a1'])
  expect(t.auto().snapshot!.agents.map(r => r.id)).toEqual(['ag:master', 'ag:a1'])
})

test('two rounds in a row with the same replies make no auto write and no item write (A22)', async () => {
  const t = rig()
  await t.run('start')
  const saves = t.log.saves
  t.state.now += 30_000
  await t.run('tick')
  expect(t.log.saves).toBe(saves) // the PR note is not in the snapshot, so it cannot move it
})

test('a locked record of a proven child: the row carries the lock, and rounds after the first make no auto write (A22)', async () => {
  const t = rig()
  t.state.porcelain = porcelain(['probe-wt', 'worktree-probe-wt']) + 'locked claude agent wf_1-1 (pid 5)\n'
  await t.run('start')
  expect(t.auto().snapshot?.worktrees.map(r => r.locked)).toEqual([undefined, 'claude agent wf_1-1 (pid 5)'])
  const saves = t.log.saves
  for (let i = 0; i < 3; i++) {
    t.state.now += 30_000
    await t.run('tick')
  }
  expect(t.log.saves).toBe(saves)
  // The lock goes: that is a change, so it is written once.
  t.state.porcelain = porcelain(['probe-wt', 'worktree-probe-wt'])
  await t.run('tick')
  expect(t.log.saves).toBe(saves + 1)
  expect(t.auto().snapshot?.worktrees.map(r => r.locked)).toEqual([undefined, undefined])
})

test('a prunable record of a proven child: rounds after the first make no auto write (A22)', async () => {
  const t = rig()
  t.state.porcelain =
    porcelain(['probe-wt', 'worktree-probe-wt']) + 'prunable gitdir file points to non-existent location\n'
  await t.run('start')
  expect(t.auto().snapshot?.worktrees.map(r => r.state)).toEqual(['live', 'removed'])
  const removedAt = t.auto().worktrees[0]?.removedAt // the first round dated the removal (issue #49)
  expect(removedAt).toBeDefined()
  const saves = t.log.saves
  for (let i = 0; i < 3; i++) {
    t.state.now += 30_000
    await t.run('tick')
  }
  expect(t.log.saves).toBe(saves)
  expect(t.auto().worktrees[0]?.removedAt).toBe(removedAt) // and the clock that moved did not move it
})

test('a workflow agent keeps the worktree it ran in after a new worktree checks out its branch (#120)', async () => {
  const t = rig({ withChild: false })
  const run = 'wf_a35565d1-fd4'
  const spawnWf = { agentId: 'w7', description: 'impl', subagentType: '', workflow: { runId: run, agentIndex: 7 } }
  t.setAuto(s => recordSpawn(s, spawnWf, 5, MAIN)) // the engine gives a workflow agent no cwd: the session cwd stands in
  t.state.porcelain = porcelain([`${run}-7`, 'fix/x'])
  await t.run('start') // no commit or push yet: the agent has no branch
  const agentRow = () => t.auto().snapshot!.agents.find(r => r.id === 'ag:w7')
  expect(agentRow()).toMatchObject({ worktree: `${run}-7`, branch: 'fix/x', worktreeLive: true })
  t.setAuto(s => recordAgentBranch(s, 'w7', 'fix/x'))
  // The worktree is removed. Another run checks out the same branch in a worktree of its own.
  t.state.porcelain = porcelain(['wf_0b519c0a-08c-1', 'fix/x'])
  t.state.now += 30_000
  await t.run('tick')
  expect(agentRow()).toMatchObject({ worktree: `${run}-7`, branch: 'fix/x', worktreeLive: false })
  expect(t.auto().agents[0]?.worktreePath).toBe(`${MAIN}/.claude/worktrees/${run}-7`)
})

test('run never rejects, also when a dependency throws', async () => {
  const t = rig()
  const broken = new AutoRound({
    ...t.deps,
    load: async () => {
      throw new Error('state refused')
    },
  })
  expect(await broken.run()).toBe(false)
  expect(t.log.git).toHaveLength(0)
  const failing = new AutoRound({
    ...t.deps,
    listAgents: async () => {
      throw new Error('list failed')
    },
    git: async () => {
      throw new Error('git broke')
    },
  })
  expect(await failing.run()).toBe(true) // a failed git call and a failed agent list are notes, not a failed round
  expect(t.auto().snapshot?.git).toMatchObject({ ok: false })
  expect(t.auto().snapshot?.agentList).toMatchObject({ ok: false })
})

test('a refused snapshot write does not reject the round; a refused root write does not stop it', async () => {
  const t = rig()
  await t.run('start')
  const good = t.deps.save
  t.deps.save = async () => {
    throw new Error('write refused')
  }
  expect(await t.run('tick')).toBe(true) // resolves: nothing rejects, and the round counts: its branches are published
  t.deps.save = good
  // A refused write of the root top does not stop the round: the snapshot is still written, the next round retries.
  const fresh = rig()
  const ok = fresh.deps.save
  let writes = 0
  fresh.deps.save = async change => {
    if (writes++ === 0) throw new Error('write refused') // the setRootTop write
    return ok(change)
  }
  await fresh.run('start')
  expect(fresh.auto().snapshot?.agents.map(r => r.id)).toEqual(['ag:master'])
  expect(fresh.auto().root?.top).toBeUndefined()
  await fresh.run('tick')
  expect(fresh.auto().root?.top).toBe(MAIN)
  expect(fresh.auto().snapshot?.worktrees.map(r => r.name)).toEqual(['repo', 'probe-wt'])
})
