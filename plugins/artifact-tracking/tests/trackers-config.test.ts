// The repos, processes and auto trackers read their numbers from the config views: the slice of the tracker and the
// global block. A changed file shows at the next call, except the values read once per load (decision C5). Each test
// uses a value that is not the default, so it fails on the old constant. Plan: L4 Task 8.
import { expect, test } from 'claude-code/testing'
import { dismiss } from '../core/infra/dismiss'
import { LifecycleManager } from '../core/infra/lifecycle'
import type { ItemsHost, Json, JsonObject } from '../core/interfaces/items'
import type { RunOpts, RunResult } from '../core/interfaces/ports'
import type { Tracker } from '../core/interfaces/tracker'
import type { AgentProof, AutoState, ProcessUiState, RepoRecord } from '../hooks/contracts'
import { auto as autoTracker } from '../trackers/auto'
import { trackAgents } from '../trackers/auto/agents'
import { autoDismiss } from '../trackers/auto/dismiss-store'
import { emptyAuto, pinRoot, recordAgentResult, recordEnter, recordSpawn } from '../trackers/auto/ledger'
import { AutoScheduler } from '../trackers/auto/scheduler'
import { trackWorktrees } from '../trackers/auto/worktrees'
import { processesTracker } from '../trackers/processes'
import { reposTracker } from '../trackers/repos'
import { RepoQueue } from '../trackers/repos/queue'
import { capRepoRows, upsertRepoRows } from '../trackers/repos/rows'
import { fakeConfig } from './fixtures/config-fs'
import * as ev from './fixtures/events'
import { porcelain } from './fixtures/git'
import { IDLE_ITEMS } from './fixtures/items-host'
import { type FakeWorld, fakePorts } from './fixtures/ports'

declare function setTimeout(fn: () => void, ms: number): unknown
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const res = (stdout = '', exitCode = 0, stderr = ''): RunResult => ({ exitCode, stdout, stderr })
const RAN = { result: { stdout: '', stderr: '', interrupted: false } }

/** An item host that holds nothing. */
function stubHost(): ItemsHost {
  return {
    ...IDLE_ITEMS,
    slot: {
      id: 'items',
      persist: true,
      read: async () => [],
      empty: () => true,
      settle: async live => live,
      restore: async () => {},
    },
    start: async () => {},
    capture: async () => {},
    replay: async () => {},
    tick: async () => {},
    sessionChanged: async () => {},
    dispose: () => {},
    list: async () => [],
    update: async () => false,
    track: async () => {},
    refresh: () => {},
  }
}

/** A manager over fakePorts and a fake config file: `file` is the parsed config file. */
function world(trackers: readonly Tracker[], file: JsonObject = {}, o: { now?: number; cwd?: string } = {}) {
  const w = fakePorts({ now: o.now ?? 1_000_000, session: { cwd: o.cwd ?? '/work' } })
  const cfg = fakeConfig({ specs: trackers, file })
  const m = new LifecycleManager(
    {
      trackers,
      items: stubHost(),
      dismiss: p => autoDismiss(p.state.slot),
      config: () => cfg,
      paneId: 'track',
    },
    w.ports,
  )
  return { w, m, cfg }
}

/** Records the argv and the options of every run, then lets the fake world answer. */
function recordRuns(w: FakeWorld): { argv: string[]; opts: RunOpts | undefined }[] {
  const seen: { argv: string[]; opts: RunOpts | undefined }[] = []
  const inner = w.ports.run
  Object.assign(w.ports, {
    run: (argv: readonly string[], opts: RunOpts) => {
      seen.push({ argv: [...argv], opts })
      return inner(argv, opts)
    },
  })
  return seen
}

// ---------------------------------------------------------------- repos

const SDK = 'git@github.com:acme/sdk.git'
const LIB = 'git@github.com:acme/lib.git'
const API = 'git@github.com:acme/api.git'

/** Git answers for repos at the given tops (top to remote). `held` makes a rev-parse wait. */
function gitAt(w: FakeWorld, tops: Record<string, string>, held?: Promise<undefined>) {
  w.run = async argv => {
    if (argv[0] !== 'git' || argv[1] !== '-C') return undefined
    const dir = String(argv[2])
    const top = Object.keys(tops).find(t => dir === t || dir.startsWith(`${t}/`))
    if (top === undefined) return undefined
    if (argv[3] === 'rev-parse') {
      if (held) await held
      return res(`${top}\n${top}/.git\n`)
    }
    if (argv[3] === 'remote') return res(`${tops[top]}\n`)
    return res('main\n')
  }
}

async function drain(w: FakeWorld): Promise<void> {
  let last = -1
  for (let i = 0; i < 100; i++) {
    await sleep(8)
    if (w.calls.length === last && i >= 3) return
    last = w.calls.length
  }
}

function repos(file: JsonObject = {}) {
  const t = world([reposTracker()], file)
  t.m.facts.publish('auto.root', { cwd: '/work', at: 0, top: '/work' })
  const read = (path: string) =>
    t.m.toolCall(t.w.ports, { tool: 'Read', input: { tool: 'Read', file_path: path } as Json, result: RAN as Json })
  const rows = () => (t.w.state.get('repos') ?? []) as unknown as RepoRecord[]
  return { ...t, read, rows }
}

test('repos: maxRepos 2 keeps two rows', async () => {
  const t = repos({ trackers: { repos: { maxRepos: 2 } } })
  gitAt(t.w, { '/x/sdk': SDK, '/x/lib': LIB, '/x/api': API })
  await t.read('/x/sdk/a.ts')
  await t.read('/x/lib/a.ts')
  await t.read('/x/api/a.ts')
  await drain(t.w)
  expect(t.rows()).toHaveLength(2)
  const all = repos()
  gitAt(all.w, { '/x/sdk': SDK, '/x/lib': LIB, '/x/api': API })
  await all.read('/x/sdk/a.ts')
  await all.read('/x/lib/a.ts')
  await all.read('/x/api/a.ts')
  await drain(all.w)
  expect(all.rows()).toHaveLength(3) // the default is 50
})

test('repos: gitTimeoutMs reaches git', async () => {
  const t = repos({ trackers: { repos: { gitTimeoutMs: 900 } } })
  gitAt(t.w, { '/x/sdk': SDK })
  const seen = recordRuns(t.w)
  await t.read('/x/sdk/a.ts')
  await drain(t.w)
  const git = seen.filter(c => c.argv[0] === 'git')
  expect(git.length).toBeGreaterThan(0)
  expect(git.every(c => c.opts?.timeoutMs === 900)).toBe(true)
})

test('repos: with no file the git timeout is 5000, as before', async () => {
  const t = repos()
  gitAt(t.w, { '/x/sdk': SDK })
  const seen = recordRuns(t.w)
  await t.read('/x/sdk/a.ts')
  await drain(t.w)
  expect(seen.filter(c => c.argv[0] === 'git').every(c => c.opts?.timeoutMs === 5000)).toBe(true)
})

test('repos: the branch cache follows global.refresh.tickMs', async () => {
  const branchReads = (w: FakeWorld) => w.calls.filter(c => c[3] === 'branch').length
  const short = repos({ global: { refresh: { tickMs: 5000 } } })
  gitAt(short.w, { '/x/sdk': SDK })
  await short.read('/x/sdk/a.ts')
  await drain(short.w)
  expect(branchReads(short.w)).toBe(1)
  await short.w.clock.advance(6000) // over 5000, under the default 30000
  await short.read('/x/sdk/b.ts')
  await drain(short.w)
  expect(branchReads(short.w)).toBe(2)

  const dflt = repos()
  gitAt(dflt.w, { '/x/sdk': SDK })
  await dflt.read('/x/sdk/a.ts')
  await drain(dflt.w)
  await dflt.w.clock.advance(6000)
  await dflt.read('/x/sdk/b.ts')
  await drain(dflt.w)
  expect(branchReads(dflt.w)).toBe(1)
})

/** Git finds a repo at each top and fails on `remote get-url`, so every first lookup counts one fault. */
function faultyRemote(w: FakeWorld, tops: readonly string[]) {
  w.run = async argv => {
    if (argv[0] !== 'git' || argv[1] !== '-C') return undefined
    const dir = String(argv[2])
    const top = tops.find(t => dir === t || dir.startsWith(`${t}/`))
    if (top === undefined) return undefined
    if (argv[3] === 'rev-parse') return res(`${top}\n${top}/.git\n`)
    if (argv[3] === 'remote') throw new Error('timeout')
    return res('main\n')
  }
}

test('repos: the breaker opens after global.tools.breaker.threshold faults; the default is three', async () => {
  const remoteCalls = (w: FakeWorld) => w.calls.filter(c => c[3] === 'remote').length
  const tops = ['/x/a', '/x/b', '/x/c', '/x/d']
  const two = repos({ global: { tools: { breaker: { threshold: 2, openMs: 2000 } } } })
  faultyRemote(two.w, tops)
  for (const top of tops) await two.read(`${top}/f.ts`)
  await drain(two.w)
  expect(remoteCalls(two.w)).toBe(2)

  const dflt = repos()
  faultyRemote(dflt.w, tops)
  for (const top of tops) await dflt.read(`${top}/f.ts`)
  await drain(dflt.w)
  expect(remoteCalls(dflt.w)).toBe(3)
})

test('repos: maxRepoQueue 1 drops a lookup when one already waits', async () => {
  let release: () => void = () => {}
  const held = new Promise<undefined>(resolve => {
    release = () => resolve(undefined)
  })
  const t = repos({ trackers: { repos: { maxRepoQueue: 1 } } })
  gitAt(t.w, { '/x/sdk': SDK, '/x/lib': LIB, '/x/api': API }, held)
  await t.read('/x/sdk/a.ts') // runs, held in rev-parse
  await t.read('/x/lib/a.ts') // waits
  await t.read('/x/api/a.ts') // the queue is full: dropped
  release()
  await drain(t.w)
  expect(
    t
      .rows()
      .map(r => r.name)
      .sort(),
  ).toEqual(['acme/lib', 'acme/sdk'])
})

test('RepoQueue and the row helpers keep today numbers with no argument', async () => {
  const q = new RepoQueue()
  let ran = 0
  for (let i = 0; i < 40; i++) q.push(`k${i}`, async () => void ran++)
  await q.idle()
  expect(ran).toBe(32) // the default queue holds 32 waiting jobs; the rest are dropped
  const row = (key: string, lastSeen: number, agents: string[]): RepoRecord => ({
    key,
    name: key,
    touchedBy: agents,
    firstSeen: 1,
    lastSeen,
  })
  const many = Array.from({ length: 51 }, (_, i) => row(`r${i}`, i, ['a']))
  expect(capRepoRows(many)).toHaveLength(50)
  expect(
    capRepoRows([
      row(
        'x',
        1,
        Array.from({ length: 9 }, (_, i) => `a${i}`),
      ),
    ])[0]?.touchedBy,
  ).toHaveLength(8)
  expect(capRepoRows(many, { maxRepos: 5, maxRepoAgents: 1 })).toHaveLength(5)
  expect(capRepoRows([row('x', 1, ['a', 'b'])], { maxRepos: 5, maxRepoAgents: 1 })[0]?.touchedBy).toEqual(['a'])
})

test('upsertRepoRows moves lastSeen after tickMs, 30000 by default', () => {
  const cur: RepoRecord = {
    key: 'k',
    name: 'n',
    root: '/r',
    mode: 'read',
    touchedBy: ['main'],
    firstSeen: 1,
    lastSeen: 1000,
  }
  const visit = { key: 'k', name: 'n', root: '/r', mode: 'read' as const, touchedBy: 'main', at: 7000 }
  expect(upsertRepoRows([cur], visit)[0]?.lastSeen).toBe(1000) // 6000 later: under 30000
  expect(upsertRepoRows([cur], visit, 5000)[0]?.lastSeen).toBe(7000)
})

// ---------------------------------------------------------------- processes

const CID = `${'c'.repeat(12)}${'0123456789abcdef'.repeat(3)}abcd`

function processes(file: JsonObject = {}) {
  const t = world([processesTracker()], file, { now: Date.now() })
  const bash = (command: string, stdout = '') =>
    t.m.toolCall(t.w.ports, {
      tool: 'Bash',
      input: { tool: 'Bash', command },
      result: { result: { stdout, stderr: '', interrupted: false } } as Json,
    })
  const probe = () => t.m.command(t.w.ports, { sub: '', args: '', wait: true })
  const ui = () => t.m.facts.read('processes.ui') as unknown as ProcessUiState | undefined
  return { ...t, bash, probe, ui }
}

test('processes: probeTimeoutMs reaches each probe', async () => {
  const t = processes({ trackers: { processes: { probeTimeoutMs: 2000 } } })
  await t.bash('docker run -d --name api nginx; tmux new -d -s dev', `${CID}\n`)
  const seen = recordRuns(t.w)
  await t.probe()
  expect(seen.length).toBeGreaterThanOrEqual(2)
  expect(seen.every(c => c.opts?.timeoutMs === 2000)).toBe(true)
})

test('processes: the breaker opens after global.tools.breaker.threshold failures', async () => {
  const t = processes({ global: { tools: { breaker: { threshold: 1, openMs: 2000 } } } })
  t.w.run = () => {
    throw new Error('spawn failed')
  }
  await t.bash('tmux new -d -s dev')
  await t.probe() // one thrown probe
  expect(t.ui()?.breaker).toBe('open')
  expect(t.ui()?.openUntil).toBe(t.w.clock.now + 2000)
})

test('processes: with no file three failures open the breaker for 300000, as before', async () => {
  const t = processes()
  t.w.run = () => {
    throw new Error('spawn failed')
  }
  await t.bash('tmux new -d -s dev')
  await t.probe()
  await t.probe()
  expect(t.ui()?.breaker).toBe('closed')
  await t.probe()
  expect(t.ui()?.breaker).toBe('open')
  expect(t.ui()?.openUntil).toBe(t.w.clock.now + 300000)
})

// ---------------------------------------------------------------- auto

const ROOT = '/work'
const START_AT = 1_000_000

function auto(file: JsonObject = {}) {
  const t = world([autoTracker], file, { now: START_AT, cwd: ROOT })
  t.w.run = async argv => {
    if (argv[0] !== 'git') return undefined
    if (argv[1] === 'rev-parse') return res(`${ROOT}\n`)
    if (argv[1] === 'worktree') return res(porcelain(ROOT))
    return undefined
  }
  const state = () => t.w.state.get('auto') as unknown as AutoState | undefined
  const rounds = () => t.w.calls.filter(c => c[1] === 'worktree').length
  const start = () => t.m.start(t.w.ports, { cwd: ROOT, fromSessionStart: true })
  const enter = (name: string) =>
    t.m.toolCall(t.w.ports, {
      tool: 'EnterWorktree',
      input: { tool: 'EnterWorktree', name },
      result: { result: { worktreePath: `${ROOT}/.claude/worktrees/${name}`, worktreeBranch: `b-${name}` } } as Json,
    })
  const spawn = (agentId: string) =>
    t.m.agentSpawn(t.w.ports, { input: ev.SPAWN_INPUT as Json, answer: { ...ev.SPAWN_ANSWER, agentId } as Json })
  return { ...t, state, rounds, start, enter, spawn }
}

test('auto: debounceMs 100 runs a kicked round after 100 ms', async () => {
  const t = auto({ trackers: { auto: { debounceMs: 100 } } })
  await t.start()
  await t.w.clock.advance(110)
  await sleep(15)
  expect(t.rounds()).toBe(1)
  const dflt = auto()
  await dflt.start()
  await dflt.w.clock.advance(110)
  await sleep(15)
  expect(dflt.rounds()).toBe(0) // the default window is 750
})

test('auto: maxAgents 10 keeps ten agents', async () => {
  const t = auto({ trackers: { auto: { maxAgents: 10 } } })
  await t.start()
  for (let i = 0; i < 12; i++) await t.spawn(`agent-${i}`)
  expect(t.state()?.agents.map(a => a.id)).toEqual(Array.from({ length: 10 }, (_, i) => `agent-${i + 2}`))
})

test('auto: maxProofs 10 keeps ten worktree proofs', async () => {
  const t = auto({ trackers: { auto: { maxProofs: 10 } } })
  await t.start()
  for (let i = 0; i < 12; i++) await t.enter(`w${i}`)
  expect(t.state()?.worktrees).toHaveLength(10)
})

test('auto: a changed slice reaches the next round with no restart', async () => {
  const t = auto({ trackers: { auto: { maxBranches: 1 } } })
  t.w.run = async argv => {
    if (argv[0] !== 'git') return undefined
    if (argv[1] === 'rev-parse') return res(`${ROOT}\n`)
    if (argv[1] === 'worktree') return res(porcelain(ROOT, ['w1', 'b-w1'], ['w2', 'b-w2'], ['w3', 'b-w3']))
    return undefined
  }
  await t.start()
  for (const name of ['w1', 'w2', 'w3']) await t.enter(name)
  const refresh = () => t.m.command(t.w.ports, { sub: 'refresh', args: '', wait: true })
  await refresh()
  expect(t.state()?.snapshot?.branches).toEqual(['main'])
  t.cfg.set({ trackers: { auto: { maxBranches: 3 } } })
  await refresh()
  expect(t.state()?.snapshot?.branches).toHaveLength(3)
})

test('auto: workflowIdleMs reaches the round', async () => {
  const t = auto({ trackers: { auto: { workflowIdleMs: 60000 } } })
  await t.start()
  await t.m.agentSpawn(t.w.ports, {
    input: ev.WORKFLOW_SPAWN_INPUT as Json,
    answer: ev.SPAWN_ANSWER as Json,
  })
  await t.w.clock.advance(61_000)
  await t.m.command(t.w.ports, { sub: 'refresh', args: '', wait: true })
  expect(t.state()?.agents[0]).toMatchObject({ stale: true })
  const dflt = auto()
  await dflt.start()
  await dflt.m.agentSpawn(dflt.w.ports, { input: ev.WORKFLOW_SPAWN_INPUT as Json, answer: ev.SPAWN_ANSWER as Json })
  await dflt.w.clock.advance(61_000)
  await dflt.m.command(dflt.w.ports, { sub: 'refresh', args: '', wait: true })
  expect(dflt.state()?.agents[0]?.stale).toBeUndefined() // the default is 3600000
})

test('auto: the git timeout is read at each call', async () => {
  const t = auto({ trackers: { auto: { gitTimeoutMs: 800 } } })
  const seen = recordRuns(t.w)
  await t.start()
  await t.m.command(t.w.ports, { sub: 'refresh', args: '', wait: true })
  const git = seen.filter(c => c.argv[0] === 'git')
  expect(git.length).toBeGreaterThan(0)
  expect(git.every(c => c.opts?.timeoutMs === 800)).toBe(true)
})

// ---------------------------------------------------------------- the auto helpers, with their trailing numbers

const MAIN = '/x/repo'

test('recordEnter and recordAgentResult keep maxProofs proofs; the default is 100', () => {
  let s = pinRoot(emptyAuto(), MAIN, 1)
  for (let i = 0; i < 12; i++) s = recordEnter(s, { path: `${MAIN}/.claude/worktrees/w${i}` }, 2 + i, 10)
  expect(s.worktrees).toHaveLength(10)
  for (let i = 0; i < 3; i++)
    s = recordAgentResult(s, { agentId: `a${i}`, worktreePath: `${MAIN}/.claude/worktrees/g${i}` }, 20 + i, 10)
  expect(s.worktrees).toHaveLength(10)
  let d = pinRoot(emptyAuto(), MAIN, 1)
  for (let i = 0; i < 101; i++) d = recordEnter(d, { path: `${MAIN}/.claude/worktrees/w${i}` }, 2 + i)
  expect(d.worktrees).toHaveLength(100)
})

test('recordSpawn keeps maxAgents agents; the default is 200', () => {
  const facts = (i: number) => ({ agentId: `a${i}`, description: 'd', subagentType: 'general-purpose' })
  let s = emptyAuto()
  for (let i = 0; i < 12; i++) s = recordSpawn(s, facts(i), 1, undefined, 10)
  expect(s.agents).toHaveLength(10)
  let d = emptyAuto()
  for (let i = 0; i < 201; i++) d = recordSpawn(d, facts(i), 1)
  expect(d.agents).toHaveLength(200)
})

test('trackWorktrees caps branches and new proofs by its caps argument', () => {
  const dir = `${MAIN}/.claude/worktrees`
  const git = (path: string, branch: string) => ({ path, branch, detached: false, bare: false })
  const top = { ...emptyAuto(), root: { cwd: MAIN, at: 1, top: MAIN } }
  // Four proven children: branches are cut at maxBranches and the rest counts as overflow.
  const proven = {
    ...top,
    worktrees: [0, 1, 2, 3].map(i => ({ path: `${dir}/w${i}`, origin: 'enter' as const, provenAt: 1 })),
  }
  const list = [git(MAIN, 'main'), ...[0, 1, 2, 3].map(i => git(`${dir}/w${i}`, `b${i}`))]
  const cut = trackWorktrees(proven, list, 5, { maxProofs: 100, maxBranches: 2 })
  expect(cut.branches).toHaveLength(2)
  expect(cut.overflow).toBe(3)
  // Two agent worktrees would get a proof each: with room for one, only one does.
  const agents = [0, 1].map((i): AgentProof => ({ id: `x${i}`, kind: 'subagent', label: 'a', spawnedAt: 1 }))
  const agentList = [git(MAIN, 'main'), git(`${dir}/agent-x0`, 'g0'), git(`${dir}/agent-x1`, 'g1')]
  const roomy = trackWorktrees({ ...top, agents }, agentList, 5)
  expect(roomy.state.worktrees).toHaveLength(2)
  const tight = trackWorktrees({ ...top, agents }, agentList, 5, { maxProofs: 1, maxBranches: 12 })
  expect(tight.state.worktrees).toHaveLength(1)
})

test('trackAgents ends a workflow agent after idleMs; the default is an hour', () => {
  const wf: AgentProof = {
    id: 'w',
    kind: 'workflow',
    label: 'w',
    spawnedAt: 0,
    workflow: { runId: 'wf_x', agentIndex: 1 },
  }
  const s: AutoState = { ...emptyAuto(), root: { cwd: MAIN, at: 1, top: MAIN }, agents: [wf] }
  const list = [{ path: MAIN, branch: 'main', detached: false, bare: false }]
  expect(trackAgents(s, null, list, MAIN, 60_001, 60_000).state.agents[0]).toMatchObject({ stale: true })
  expect(trackAgents(s, null, list, MAIN, 60_001).state.agents[0]?.stale).toBeUndefined()
})

test('the scheduler window follows debounceMs()', async () => {
  const timers: { ms: number }[] = []
  let now = 0
  const scheduler = new AutoScheduler({
    now: () => now,
    after: ms => {
      timers.push({ ms })
      return { cancel() {} }
    },
    run: async () => {},
    debounceMs: () => 100,
  })
  scheduler.kick('agent')
  expect(timers.map(t => t.ms)).toEqual([100])
  now = 250 // over twice the window: the timer is overdue
  scheduler.kick('agent')
  expect(timers.map(t => t.ms)).toEqual([100, 100])
  const plain = new AutoScheduler({
    now: () => 0,
    after: ms => {
      timers.push({ ms })
      return { cancel() {} }
    },
    run: async () => {},
  })
  plain.kick('agent')
  expect(timers.at(-1)?.ms).toBe(750)
})

// ---------------------------------------------------------------- the dismiss list

test('autoDismiss caps the list at max()', async () => {
  const w = fakePorts()
  let max = 2
  const list = autoDismiss(w.ports.state.slot, () => max)
  await list.add(['a', 'b', 'c'])
  expect([...(await list.list())]).toEqual(['b', 'c'])
  max = 3
  await list.add(['d'])
  expect([...(await list.list())]).toEqual(['b', 'c', 'd'])
  const plain = autoDismiss(fakePorts().ports.state.slot)
  await plain.add(Array.from({ length: 501 }, (_, i) => `id${i}`))
  expect((await plain.list()).size).toBe(500)
})

test('dismiss(state, ids, max) keeps the last max ids', () => {
  const s = dismiss(emptyAuto(), ['a', 'b', 'c'], 2)
  expect(s.dismissed).toEqual(['b', 'c'])
  expect(dismiss(emptyAuto(), ['a', 'b', 'c']).dismissed).toEqual(['a', 'b', 'c'])
})
