// AutoRound: the three steps, the PR lane, writes in flight (A20) and quiet rounds (A22). Fake deps.
import { expect, test } from 'claude-code/testing'
import { autoIds, dismiss } from '../hooks/auto/dismiss'
import { emptyAuto, pinRoot, recordEnter, recordSpawn } from '../hooks/auto/ledger'
import { AutoRound, type RoundDeps } from '../hooks/auto/round'
import type {
  AutoReason,
  AutoState,
  DiscoveryApplied,
  GitHubDiscoveryApi,
  GraphqlOutcome,
  ItemRecord,
  LiveAgent,
  RepoRef,
  ToolStatus,
} from '../hooks/contracts'
import { isRowId } from '../hooks/contracts'
import { dropAuto } from '../hooks/model/discovered'
import { discoveryData, prNode } from './fixtures/gh-discovery'
import { porcelain as gitPorcelain, NOT_A_REPO_STDERR } from './fixtures/git'

const MAIN = '/x/repo'
const K7 = 'gh:github.com/acme/web#7'
const K1 = 'gh:github.com/acme/web#1'
const REPO: RepoRef = { host: 'github.com', owner: 'acme', repo: 'web' }

const porcelain = (...kids: [string, string][]): string => gitPorcelain(MAIN, ...kids)

/** Lets every pending promise step run. The round uses promises only, no timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

/** The reply for a discovery query: nodes by `head:<branch>` or `base:<branch>`. */
function replyFor(q: string, nodes: Record<string, unknown[]>): GraphqlOutcome {
  const data: Record<string, unknown[]> = {}
  for (const m of q.matchAll(/(([hb])\d+): pullRequests\((head|base)RefName: ("(?:[^"\\]|\\.)*")/g))
    data[m[1]!] = nodes[`${m[3]}:${JSON.parse(m[4]!) as string}`] ?? []
  return { ok: true, reply: { data: discoveryData(data, 'main'), errors: [] } }
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
  let items: ItemRecord[] = []
  const log = {
    git: [] as string[][],
    gh: [] as string[],
    added: [] as string[][],
    saves: 0,
    itemWrites: 0,
  }
  const state = {
    now: 1_000_000,
    isRepo: true,
    gitFail: false,
    agentFail: false,
    porcelain: porcelain(['probe-wt', 'worktree-probe-wt']),
    agents: [] as LiveAgent[],
    cwd: MAIN,
    repo: REPO as RepoRef | null,
    nodes: {} as Record<string, unknown[]>,
    outcome: undefined as GraphqlOutcome | undefined,
  }
  const gate: { agents?: Promise<void>; gh?: Promise<void> } = {}

  const gh = {
    isAvailable: true,
    canCall: () => true,
    status: (): ToolStatus => ({
      name: 'gh',
      available: true,
      loggedIn: true,
      breaker: 'closed',
      lastError: 'timeout',
    }),
    isHostAuthed: () => true,
    graphql: async (_host: string, q: string): Promise<GraphqlOutcome> => {
      log.gh.push(q)
      await gate.gh
      return state.outcome ?? replyFor(q, state.nodes)
    },
  } as unknown as GitHubDiscoveryApi

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
    repo: async () => state.repo,
    gh,
    ghReady: async () => true,
    githubHosts: () => [],
    applyItems: async (change): Promise<DiscoveryApplied> => {
      const r = change(items, new Set(auto.dismissed))
      if (r.list !== items) {
        items = r.list
        log.itemWrites++
      }
      return r
    },
    onAdded: keys => log.added.push(keys),
  }
  const round = new AutoRound(deps)
  const hold = (which: 'agents' | 'gh') => {
    let release = () => {}
    gate[which] = new Promise<void>(resolve => {
      release = resolve
    })
    return release
  }
  const run = (...reasons: AutoReason[]) => round.run(new Set(reasons))
  return {
    deps,
    round,
    run,
    state,
    log,
    hold,
    auto: () => auto,
    items: () => items,
    setAuto: (change: (s: AutoState) => AutoState) => {
      auto = change(auto)
    },
    setItems: (change: (l: ItemRecord[]) => ItemRecord[]) => {
      items = change(items)
    },
  }
}

const spawn = (agentId: string) => ({ agentId, description: 'd', subagentType: 'general-purpose' })

test('a first round resolves the root once, tracks the proven child and finds the PR of a tracked branch', async () => {
  const t = rig()
  t.state.nodes['head:worktree-probe-wt'] = [
    prNode({ number: 7, headRefName: 'worktree-probe-wt', body: 'Part of #1', rollup: 'FAILURE' }),
  ]
  await t.run('start')
  await t.round.idle()
  const snap = t.auto().snapshot!
  expect(t.auto().root?.top).toBe(MAIN)
  expect(snap.worktrees.map(r => [r.name, r.state])).toEqual([
    ['repo', 'live'],
    ['probe-wt', 'live'],
  ])
  expect(snap.agents.map(r => r.id)).toEqual(['ag:master'])
  // dismissOne tells a row id from an item key with isRowId: every row the round builds must pass it, no item key may.
  expect([...snap.worktrees, ...snap.agents].every(r => isRowId(r.id))).toBe(true)
  expect(t.items().some(i => isRowId(i.key))).toBe(false)
  expect(snap.branches).toEqual(['main', 'worktree-probe-wt'])
  expect(snap.prs).toMatchObject({ ok: true })
  expect(snap.defaultBranch).toBe('main')
  expect(t.items().map(i => i.key)).toEqual([K7, K1])
  expect(t.log.added).toEqual([[K1]])
  expect(t.log.git).toEqual([
    ['rev-parse', '--show-toplevel'],
    ['worktree', 'list', '--porcelain'],
  ])
})

test('without a pinned root the round does nothing', async () => {
  const t = rig({ seed: emptyAuto() })
  await t.run('start')
  await t.round.idle()
  expect(t.log.git).toHaveLength(0)
  expect(t.log.gh).toHaveLength(0)
})

test('rev-parse runs once per run; worktree list runs every round', async () => {
  const t = rig()
  await t.run('start')
  await t.run('agent')
  await t.round.idle()
  expect(t.log.git.filter(c => c[0] === 'rev-parse')).toHaveLength(1)
  expect(t.log.git.filter(c => c[0] === 'worktree')).toHaveLength(2)
})

test('not a git repository: no more git calls, agents still listed, PR step skips with no-branches', async () => {
  const t = rig({ withChild: false })
  t.state.isRepo = false
  t.state.agents = [{ id: 'a1', status: 'running' }]
  t.setAuto(s => recordSpawn(s, spawn('a1'), 5, MAIN))
  await t.run('start')
  await t.round.idle()
  expect(t.auto().root?.top).toBeNull()
  await t.run('tick')
  await t.round.idle()
  expect(t.log.git).toEqual([['rev-parse', '--show-toplevel']])
  const snap = t.auto().snapshot!
  expect(snap.worktrees).toEqual([])
  expect(snap.agents.map(r => r.id)).toEqual(['ag:master', 'ag:a1'])
  expect(snap.prs).toMatchObject({ ok: false, skipped: 'no-branches' })
  expect(t.log.gh).toHaveLength(0)
})

test('a failed git call sets the note, keeps the last rows, still computes agents and polls the last branches', async () => {
  const t = rig()
  await t.run('start')
  await t.round.idle()
  t.state.gitFail = true
  t.state.agents = []
  await t.run('tick')
  await t.round.idle()
  const snap = t.auto().snapshot!
  expect(snap.git).toMatchObject({ ok: false, error: 'git broke' })
  expect(snap.worktrees.map(r => r.name)).toEqual(['repo', 'probe-wt'])
  expect(snap.agents.map(r => r.id)).toEqual(['ag:master'])
  expect(t.log.gh).toHaveLength(2)
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
  t.state.outcome = { ok: false, kind: 'blocked' }
  await t.run('start')
  await t.round.idle()
  const snap = t.auto().snapshot!
  expect(snap.prs).toMatchObject({ ok: false, skipped: 'paused' })
  expect(snap.worktrees).toHaveLength(2)
})

test('each failed GraphQL outcome maps to the Pull requests note of spec 8.3', async () => {
  const cases: [GraphqlOutcome, object][] = [
    [
      { ok: false, kind: 'blocked' },
      { ok: false, skipped: 'paused' },
    ],
    [
      { ok: false, kind: 'auth' },
      { ok: false, skipped: 'not-logged-in' },
    ],
    [
      { ok: false, kind: 'no-gh' },
      { ok: false, skipped: 'no-gh' },
    ],
    [
      { ok: false, kind: 'transport' },
      { ok: false, error: 'timeout' },
    ],
    [
      { ok: false, kind: 'truncated' },
      { ok: false, error: 'reply over 4 MiB' },
    ],
    [
      { ok: false, kind: 'query-error', error: 'Field x' },
      { ok: false, error: 'Field x' },
    ],
  ]
  for (const [outcome, want] of cases) {
    const t = rig()
    t.state.outcome = outcome
    await t.run('start')
    await t.round.idle()
    expect(t.auto().snapshot!.prs).toMatchObject(want)
    expect(t.items()).toEqual([])
  }
})

test('no session repo: the PR step skips with no-repo', async () => {
  const t = rig()
  t.state.repo = null
  await t.run('start')
  await t.round.idle()
  expect(t.auto().snapshot!.prs).toMatchObject({ ok: false, skipped: 'no-repo' })
})

test('PR step gating: an agent kick without a branch change makes no gh call; a tick does', async () => {
  const t = rig()
  await t.run('start')
  await t.round.idle()
  expect(t.log.gh).toHaveLength(1)
  await t.run('agent')
  await t.round.idle()
  expect(t.log.gh).toHaveLength(1)
  await t.run('tick')
  await t.round.idle()
  expect(t.log.gh).toHaveLength(2)
})

test('PR step gating: a new tracked branch starts a PR step even on an agent kick', async () => {
  const t = rig()
  await t.run('start')
  await t.round.idle()
  t.setAuto(s => recordEnter(s, { path: `${MAIN}/.claude/worktrees/second`, branch: 'second-b' }, 9))
  t.state.porcelain = porcelain(['probe-wt', 'worktree-probe-wt'], ['second', 'second-b'])
  await t.run('agent')
  await t.round.idle()
  expect(t.log.gh).toHaveLength(2)
  expect(t.log.gh[1]).toContain('"second-b"')
})

test('the default branch learned in the first reply gets no alias in the next query', async () => {
  const t = rig()
  await t.run('start')
  await t.round.idle()
  await t.run('tick')
  await t.round.idle()
  expect(t.log.gh[0]).toContain('headRefName: "main"')
  expect(t.log.gh[1]).not.toContain('headRefName: "main"')
})

test('writes in flight (a): a recordSpawn that lands while listAgents waits is in the saved snapshot', async () => {
  const t = rig()
  const release = t.hold('agents')
  const p = t.run('start')
  await flush()
  t.setAuto(s => recordSpawn(s, spawn('a1'), 5, MAIN))
  release()
  await p
  await t.round.idle()
  expect(t.auto().agents.map(a => a.id)).toEqual(['a1'])
  expect(t.auto().snapshot!.agents.map(r => r.id)).toEqual(['ag:master', 'ag:a1'])
})

async function withTrackedPr() {
  const t = rig()
  t.state.nodes['head:worktree-probe-wt'] = [
    prNode({ number: 7, headRefName: 'worktree-probe-wt', body: 'Part of #1' }),
  ]
  await t.run('start')
  await t.round.idle()
  expect(t.items().map(i => i.key)).toEqual([K7, K1])
  return t
}

test('writes in flight (b): an x dismiss of a PR while gh waits leaves the PR and its auto-only refs absent', async () => {
  const t = await withTrackedPr()
  const release = t.hold('gh')
  await t.run('tick')
  t.setAuto(s => dismiss(s, [K7]))
  t.setItems(l => dropAuto(l, new Set([K7])))
  release()
  await t.round.idle()
  expect(t.items()).toEqual([])
})

test('writes in flight (c): /track clear while gh waits leaves no auto item back', async () => {
  const t = await withTrackedPr()
  const release = t.hold('gh')
  await t.run('tick')
  const ids = autoIds(t.auto(), t.items())
  t.setAuto(s => dismiss(s, ids))
  t.setItems(l => dropAuto(l, new Set(ids)))
  release()
  await t.round.idle()
  expect(t.items()).toEqual([])
})

test('PR lane: a second run settles while gh waits; two more requests queue as one gh call; idle waits for it', async () => {
  const t = rig()
  const release = t.hold('gh')
  await t.run('start')
  await flush()
  expect(t.log.gh).toHaveLength(1)
  t.setAuto(s => recordEnter(s, { path: `${MAIN}/.claude/worktrees/second`, branch: 'second-b' }, 9))
  t.state.porcelain = porcelain(['probe-wt', 'worktree-probe-wt'], ['second', 'second-b'])
  await t.run('worktree')
  expect(t.auto().snapshot!.worktrees.map(r => r.name)).toContain('second')
  await t.run('tick')
  await t.run('tick')
  let settled = false
  void t.round.idle().then(() => {
    settled = true
  })
  await flush()
  expect(settled).toBe(false)
  expect(t.log.gh).toHaveLength(1)
  release()
  await t.round.idle()
  expect(settled).toBe(true)
  expect(t.log.gh).toHaveLength(2)
})

test('two rounds in a row with the same replies make no auto write and no item write (A22)', async () => {
  const t = await withTrackedPr()
  const saves = t.log.saves
  const writes = t.log.itemWrites
  t.state.now += 30_000
  await t.run('tick')
  await t.round.idle()
  expect(t.log.gh).toHaveLength(2)
  expect(t.log.saves).toBe(saves)
  expect(t.log.itemWrites).toBe(writes)
})

test('a prunable record of a proven child: rounds after the first make no auto write (A22)', async () => {
  const t = rig()
  t.state.porcelain =
    porcelain(['probe-wt', 'worktree-probe-wt']) + 'prunable gitdir file points to non-existent location\n'
  await t.run('start')
  await t.round.idle()
  expect(t.auto().snapshot?.worktrees.map(r => r.state)).toEqual(['live', 'removed'])
  const saves = t.log.saves
  for (let i = 0; i < 3; i++) {
    t.state.now += 30_000
    await t.run('tick')
    await t.round.idle()
  }
  expect(t.log.saves).toBe(saves)
})

test('a throw in the PR step after discovery lands in the Pull requests note and clears on the next good step', async () => {
  const t = await withTrackedPr()
  expect(t.auto().snapshot?.prs).toMatchObject({ ok: true })
  let breakItems = true
  const applyItems = t.deps.applyItems
  const broken = new AutoRound({
    ...t.deps,
    applyItems: async change => {
      if (breakItems) throw new Error('item write refused')
      return applyItems(change)
    },
  })
  t.state.now += 30_000
  await broken.run(new Set(['tick']))
  await broken.idle()
  expect(t.auto().snapshot?.prs).toMatchObject({ ok: false, error: 'item write refused' })
  // A dependency that throws before discovery is recorded the same way.
  const noRepo = new AutoRound({
    ...t.deps,
    repo: async () => {
      throw new Error('repo lookup failed')
    },
  })
  t.state.now += 30_000
  await noRepo.run(new Set(['tick']))
  await noRepo.idle()
  expect(t.auto().snapshot?.prs).toMatchObject({ ok: false, error: 'repo lookup failed' })
  // The next good step clears it.
  breakItems = false
  t.state.now += 30_000
  await broken.run(new Set(['tick']))
  await broken.idle()
  expect(t.auto().snapshot?.prs).toMatchObject({ ok: true })
  expect(t.auto().snapshot?.prs.error).toBeUndefined()
})

test('run never rejects, also when a dependency throws', async () => {
  const t = rig()
  const broken = new AutoRound({
    ...t.deps,
    load: async () => {
      throw new Error('state refused')
    },
  })
  await broken.run(new Set(['start']))
  await broken.idle()
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
  await failing.run(new Set(['start']))
  await failing.idle()
  expect(t.auto().snapshot?.git).toMatchObject({ ok: false })
  expect(t.auto().snapshot?.agentList).toMatchObject({ ok: false })
})

test('a refused snapshot write does not skip the PR step; a refused root write does not stop the round', async () => {
  const t = rig()
  await t.run('start')
  await t.round.idle()
  expect(t.log.gh).toHaveLength(1)
  const good = t.deps.save
  t.deps.save = async () => {
    throw new Error('write refused')
  }
  await t.run('tick') // resolves: nothing rejects
  await t.round.idle()
  expect(t.log.gh).toHaveLength(2) // the PR step still ran
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
  await fresh.round.idle()
  expect(fresh.auto().snapshot?.agents.map(r => r.id)).toEqual(['ag:master'])
  expect(fresh.auto().root?.top).toBeUndefined()
  await fresh.run('tick')
  await fresh.round.idle()
  expect(fresh.auto().root?.top).toBe(MAIN)
  expect(fresh.auto().snapshot?.worktrees.map(r => r.name)).toEqual(['repo', 'probe-wt'])
})
