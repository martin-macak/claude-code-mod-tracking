// The auto tracker on fakePorts, through the LifecycleManager: the events it hears, the run it keeps in the `auto`
// member, the rounds it kicks and the facts it publishes. Git answers from a stub; the PR lane sees a gh that is not
// ready, so a round stops after the snapshot. Each case mirrors a kit test of auto-wiring.test.tsx.
// Plan: L3 Task 10.
import { expect, test } from 'claude-code/testing'
import { GLOBAL_DEFAULTS } from '../core/infra/global-defaults'
import { LifecycleManager } from '../core/infra/lifecycle'
import type { ToolCallEvent } from '../core/interfaces/events'
import type { ItemsHost, Json, StoredItem } from '../core/interfaces/items'
import type { RunResult } from '../core/interfaces/ports'
import type {
  AgentProof,
  AutoState,
  GitHubDiscoveryApi,
  GraphqlOutcome,
  ToolStatus,
  WorktreeProof,
} from '../hooks/contracts'
import { LIMITS } from '../hooks/contracts'
import { type AutoGithub, autoConfig, autoTracker } from '../trackers/auto'
import { autoDismiss } from '../trackers/auto/dismiss-store'
import { emptyAuto } from '../trackers/auto/ledger'
import * as ev from './fixtures/events'
import { discoveryData, prNode } from './fixtures/gh-discovery'
import { porcelain } from './fixtures/git'
import { fakePorts } from './fixtures/ports'
import { hostWorld } from './fixtures/tracker-host'

declare function setTimeout(fn: () => void, ms: number): unknown
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const res = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '' })

const ROOT = '/work'
const START_AT = 1_000_000
/** One debounce window of the scheduler, a little over. */
const WINDOW = LIMITS.autoDebounceMs + 10
const WF = 'wf-agent-1'
/** The clock after `running()`: the start round fired at the end of the window. */
const AFTER_START = START_AT + WINDOW

type SetupOpts = {
  items?: StoredItem[]
  /** The `gh` side of the PR lane. Default: not ready, no repo. */
  ready?: () => Promise<boolean>
  github?: Partial<AutoGithub>
  /** Answers `git worktree list`. */
  worktreeList?: () => Promise<string>
}

function setup(o: SetupOpts = {}) {
  const w = fakePorts({ now: START_AT, session: { cwd: ROOT } })
  const seen = { ready: 0 }
  const gh: AutoGithub = {
    discovery: {} as AutoGithub['discovery'],
    ready: async () => {
      seen.ready++
      return (await o.ready?.()) ?? false
    },
    repo: async () => null,
    hosts: () => [],
    ...o.github,
  }
  const held = { list: o.items ?? ([] as StoredItem[]), refreshed: [] as string[][] }
  const host: ItemsHost = {
    slot: {
      id: 'items',
      persist: true,
      read: async () => held.list as unknown as Json,
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
    list: async () => held.list,
    update: async change => {
      const dismissed = await autoDismiss(w.ports.state.slot).list()
      const next = change(held.list, dismissed)
      const wrote = next !== held.list
      held.list = next
      return wrote
    },
    track: async () => {},
    refresh: keys => void held.refreshed.push([...(keys ?? [])]),
  }
  const m = new LifecycleManager(
    {
      trackers: [autoTracker(gh)],
      items: host,
      dismiss: p => autoDismiss(p.state.slot),
      global: GLOBAL_DEFAULTS,
      paneId: 'track',
    },
    w.ports,
  )
  w.run = async argv => {
    if (argv[0] !== 'git') return undefined
    if (argv[1] === 'rev-parse') return res(`${ROOT}\n`)
    if (argv[1] === 'worktree') return res((await o.worktreeList?.()) ?? porcelain(ROOT))
    return undefined
  }
  const auto = () => w.state.get('auto') as unknown as AutoState | undefined
  /** The rounds that ran: one `git worktree list` each. */
  const rounds = () => w.calls.filter(c => c[1] === 'worktree').length
  const call = (tool: string, input: Record<string, unknown>, result: unknown, extra: Partial<ToolCallEvent> = {}) =>
    m.toolCall(w.ports, { tool, input: { tool, ...input } as Json, result: result as Json, ...extra })
  const spawn = (input: unknown = ev.SPAWN_INPUT, answer: unknown = ev.SPAWN_ANSWER, sessionCwd?: string) =>
    m.agentSpawn(w.ports, {
      input: input as Json,
      answer: answer as Json,
      ...(sessionCwd !== undefined ? { sessionCwd } : {}),
    })
  /** A session.start with the cwd: the root is pinned and the start round is kicked. */
  const start = () => m.start(w.ports, { cwd: ROOT, fromSessionStart: true })
  /** Moves the clock over `ms`, then lets a PR step in its own lane run on. */
  const settle = async (ms: number) => {
    await w.clock.advance(ms)
    await sleep(15)
  }
  /** A started run whose first round has ended: the counters start from here. */
  const running = async () => {
    await start()
    await settle(WINDOW)
    return rounds()
  }
  return { w, m, gh, seen, held, auto, rounds, call, spawn, start, settle, running }
}

test('start with a cwd pins the root and kicks start; a second start keeps the root', async () => {
  const t = setup()
  await t.start()
  expect(t.auto()?.root).toEqual({ cwd: ROOT, at: START_AT })
  expect(t.rounds()).toBe(0) // start joins the debounce window
  await t.settle(WINDOW)
  expect(t.rounds()).toBe(1)
  expect(t.seen.ready).toBe(1) // start is a reason that opens the PR step
  t.w.clock.now += 5000
  await t.m.start(t.w.ports, { cwd: '/elsewhere', fromSessionStart: true })
  expect(t.auto()?.root).toEqual({ cwd: ROOT, at: START_AT, top: ROOT }) // a reload keeps the pin; the round set the top
})

test('a lazy start (no cwd) pins nothing and kicks nothing', async () => {
  const t = setup()
  await t.m.ensureStarted(t.w.ports)
  await t.settle(WINDOW)
  expect(t.auto()).toBeUndefined()
  expect(t.rounds()).toBe(0)
  expect(t.m.facts.read('auto.root')).toBeUndefined()
})

test('EnterWorktree records a proof and kicks worktree', async () => {
  const t = setup()
  const before = await t.running()
  await t.call('EnterWorktree', { name: 'probe-wt' }, ev.ENTER_RAN)
  expect(t.auto()?.worktrees).toEqual([
    {
      path: '/x/repo/.claude/worktrees/probe-wt',
      origin: 'enter',
      branch: 'worktree-probe-wt',
      provenAt: AFTER_START,
    } satisfies WorktreeProof,
  ])
  expect(t.rounds()).toBe(before)
  await t.settle(WINDOW)
  expect(t.rounds()).toBe(before + 1)
  await t.call('EnterWorktree', { name: 'x' }, { result: { message: 'refused' } }) // no path: no proof
  expect(t.auto()?.worktrees).toHaveLength(1)
})

test('ExitWorktree kicks worktree', async () => {
  const t = setup()
  const before = await t.running()
  await t.call('ExitWorktree', { action: 'remove' }, ev.EXIT_RAN)
  await t.settle(WINDOW)
  expect(t.rounds()).toBe(before + 1)
})

test('an Agent result with a worktree records it', async () => {
  const t = setup()
  const before = await t.running()
  await t.spawn()
  await t.call('Agent', { description: 'iso agent' }, ev.AGENT_ASYNC_RAN) // launched: the id only, no proof
  expect(t.auto()?.worktrees).toEqual([])
  await t.call('Agent', { description: 'iso agent' }, ev.AGENT_DONE_RAN)
  const a = ev.AGENT_DONE_RAN.result
  expect(t.auto()?.worktrees).toEqual([
    { path: a.worktreePath, origin: 'agent', owner: a.agentId, branch: a.worktreeBranch, provenAt: AFTER_START },
  ])
  expect(t.auto()?.agents[0]).toMatchObject({ id: a.agentId, worktreePath: a.worktreePath, branch: a.worktreeBranch })
  await t.settle(WINDOW)
  expect(t.rounds()).toBe(before + 1)
})

test('a Bash commit records the agent branch; a pr result kicks the PR step; a plain command kicks nothing', async () => {
  const t = setup()
  const before = await t.running()
  const readyBefore = t.seen.ready
  await t.spawn()
  const id = ev.SPAWN_ANSWER.agentId
  await t.call('Bash', { command: 'git commit -m x' }, ev.BASH_COMMIT_RAN, { agentId: id })
  expect(t.auto()?.agents[0]?.branch).toBe('feat/x')
  await t.settle(WINDOW)
  expect(t.rounds()).toBe(before + 1) // the spawn and the commit joined one window
  expect(t.seen.ready).toBe(readyBefore) // a git kick opens no PR step when the branches did not change
  await t.call('Bash', { command: 'gh pr create' }, ev.BASH_PR_RAN)
  await t.settle(WINDOW)
  expect(t.rounds()).toBe(before + 2)
  expect(t.seen.ready).toBe(readyBefore + 1) // pr-event opens it
  await t.call('Bash', { command: 'echo ok' }, ev.BASH_PLAIN_RAN)
  await t.call('Bash', { command: 'echo ok' }, { result: null }) // no result: nothing
  await t.settle(WINDOW)
  expect(t.rounds()).toBe(before + 2)
})

test('Monitor, TaskStop, Write, Edit and Read touch a workflow agent', async () => {
  const t = setup()
  await t.running()
  await t.spawn(ev.WORKFLOW_SPAWN_INPUT, { agentId: WF })
  const agent = (): AgentProof | undefined => t.auto()?.agents.find(a => a.id === WF)
  expect(agent()?.kind).toBe('workflow')
  expect(agent()?.lastActiveAt).toBeUndefined()
  for (const tool of ['Monitor', 'TaskStop', 'Write', 'Edit', 'Read']) {
    t.w.clock.now += 61_000 // a touch under a minute after the last one changes nothing
    await t.call(tool, {}, { result: {} }, { agentId: WF })
    expect([tool, agent()?.lastActiveAt]).toEqual([tool, t.w.clock.now])
  }
  const sets = t.w.stateSets.auto
  t.w.clock.now += 61_000
  await t.call('Read', {}, { result: {} }) // the main loop has no agent id
  expect(t.w.stateSets.auto).toBe(sets)
})

test('a spawn records the agent with the session cwd', async () => {
  const t = setup()
  const before = await t.running()
  await t.spawn(ev.SPAWN_INPUT, ev.SPAWN_ANSWER, ROOT)
  expect(t.auto()?.agents).toEqual([
    {
      id: ev.SPAWN_ANSWER.agentId,
      kind: 'subagent',
      label: 'iso-agent',
      spawnedAt: AFTER_START,
      cwd: ROOT,
    } satisfies AgentProof,
  ])
  await t.settle(WINDOW)
  expect(t.rounds()).toBe(before + 1)
  await t.spawn(ev.SPAWN_INPUT, { model: 'x' }) // no agent id in the answer: no record, still a kick
  expect(t.auto()?.agents).toHaveLength(1)
})

test('turnComplete records the end and kicks agent', async () => {
  const t = setup()
  const before = await t.running()
  await t.spawn(ev.SPAWN_INPUT, { agentId: 'a1' })
  await t.spawn(ev.SPAWN_INPUT, { agentId: 'a2' })
  await t.settle(WINDOW)
  const after = t.rounds()
  expect(after).toBe(before + 1)
  t.w.clock.now += 1000
  await t.m.turnComplete(t.w.ports, { input: ev.turnEnd('answer', 'a1') as unknown as Json })
  await t.m.turnComplete(t.w.ports, { input: ev.turnEnd('error', 'a2') as unknown as Json })
  const [a1, a2] = t.auto()?.agents ?? []
  expect(a1).toMatchObject({ id: 'a1', endedAt: t.w.clock.now })
  expect(a1?.failed).toBeUndefined()
  expect(a2).toMatchObject({ id: 'a2', endedAt: t.w.clock.now, failed: true })
  await t.settle(WINDOW)
  expect(t.rounds()).toBe(after + 1)
  const sets = t.w.stateSets.auto
  await t.m.turnComplete(t.w.ports, { input: ev.turnEnd('answer') as unknown as Json }) // the main loop: no fact
  await t.settle(WINDOW)
  expect(t.w.stateSets.auto).toBe(sets)
  expect(t.rounds()).toBe(after + 1)
})

test('tick kicks tick: a round runs at once, with no window', async () => {
  const t = setup()
  const before = await t.running()
  await t.m.tick()
  await sleep(20)
  expect(t.rounds()).toBe(before + 1)
  expect(t.seen.ready).toBe(2) // tick opens the PR step too
})

test('command clear dismisses the auto ids of the current items', async () => {
  const mk = (key: string, sources: string[]) => ({ key, category: 'github', sources, firstSeen: 1, lastSeen: 1 })
  const t = setup({ items: [mk('gh:github.com/acme/web#7', ['auto']), mk('gh:github.com/acme/web#8', ['prompt'])] })
  await t.running()
  await t.m.command(t.w.ports, { sub: 'clear', args: '', wait: true })
  expect(t.auto()?.dismissed).toEqual(['gh:github.com/acme/web#7'])
  await t.m.command(t.w.ports, { sub: 'clear', args: '', wait: true }) // again: known ids change nothing
  expect(t.auto()?.dismissed).toEqual(['gh:github.com/acme/web#7'])
})

test('command refresh with wait settles after the round and its PR step; manual does not wait', async () => {
  let listed = 0
  let prDone = false
  const t = setup({
    worktreeList: async () => {
      await sleep(25)
      listed++
      return porcelain(ROOT)
    },
    ready: async () => {
      await sleep(25)
      prDone = true
      return false
    },
  })
  await t.running()
  prDone = false
  const before = listed
  await t.m.command(t.w.ports, { sub: 'refresh', args: '', wait: true })
  expect(listed).toBe(before + 1)
  expect(prDone).toBe(true)
  prDone = false
  await t.m.command(t.w.ports, { sub: 'manual', args: '', wait: false })
  expect(prDone).toBe(false) // it returned before the round ended
  await sleep(120)
  expect(listed).toBe(before + 2)
  expect(prDone).toBe(true)
  await t.m.command(t.w.ports, { sub: 'other', args: '', wait: true }) // a sub the tracker does not know
  await sleep(40)
  expect(listed).toBe(before + 2)
})

/** A gh that answers every discovery query with the given nodes for the head branches it is asked about. */
function discoveryGh(nodes: Record<string, unknown[]>, queries: string[]): GitHubDiscoveryApi {
  return {
    isAvailable: true,
    canCall: () => true,
    status: (): ToolStatus => ({ name: 'gh', available: true, loggedIn: true, breaker: 'closed' }),
    isHostAuthed: () => true,
    graphql: async (_host: string, q: string): Promise<GraphqlOutcome> => {
      queries.push(q)
      const data: Record<string, unknown[]> = {}
      for (const m of q.matchAll(/(([hb])\d+): pullRequests\((head|base)RefName: ("(?:[^"\\]|\\.)*")/g))
        data[m[1]!] = nodes[`${m[3]}:${JSON.parse(m[4]!) as string}`] ?? []
      return { ok: true, reply: { data: discoveryData(data, 'main'), errors: [] } }
    },
  } as unknown as GitHubDiscoveryApi
}

test('the PR lane writes its items through the item store and asks for the refresh of the new keys', async () => {
  const queries: string[] = []
  const t = setup({
    ready: async () => true,
    worktreeList: async () => porcelain(ROOT, ['probe-wt', 'worktree-probe-wt']),
    github: {
      discovery: discoveryGh(
        { 'head:worktree-probe-wt': [prNode({ number: 7, headRefName: 'worktree-probe-wt', body: 'Part of #1' })] },
        queries,
      ),
      repo: async () => ({ host: 'github.com', owner: 'acme', repo: 'web' }),
      hosts: () => ['github.com'],
    },
  })
  await t.start()
  await t.call(
    'EnterWorktree',
    { name: 'probe-wt' },
    {
      result: { worktreePath: `${ROOT}/.claude/worktrees/probe-wt`, worktreeBranch: 'worktree-probe-wt' },
    },
  )
  await t.settle(WINDOW)
  expect(queries.length).toBeGreaterThan(0)
  expect(t.held.list.map(i => i.key)).toEqual(['gh:github.com/acme/web#7', 'gh:github.com/acme/web#1'])
  expect(t.held.list.every(i => i.sources.every(s => s === 'auto' || s === 'pr-body'))).toBe(true)
  expect(t.held.refreshed).toEqual([['gh:github.com/acme/web#1']]) // only the key the PR body added
  expect(t.auto()?.snapshot?.prs).toMatchObject({ ok: true })
})

test('restore uses carryAuto: a held root fills an empty state and never replaces one', async () => {
  const world = hostWorld([autoTracker({} as AutoGithub)])
  await world.host.init()
  const slot = world.host.slots().find(s => s.id === 'auto')
  if (!slot) throw new Error('no auto slot')
  expect(slot.persist).toBe(false)
  const held = { ...emptyAuto(), root: { cwd: '/old', at: 1 } }
  await slot.restore(held as unknown as Json, 'carry')
  expect((world.w.state.get('auto') as unknown as AutoState).root).toEqual({ cwd: '/old', at: 1 })
  expect(world.facts.read('auto.root')).toEqual({ cwd: '/old', at: 1 })
  await slot.restore({ ...emptyAuto(), root: { cwd: '/other', at: 2 } } as unknown as Json, 'load')
  expect((world.w.state.get('auto') as unknown as AutoState).root).toEqual({ cwd: '/old', at: 1 })
  expect(slot.empty(undefined)).toBe(true)
  expect(slot.empty(held as unknown as Json)).toBe(false)
})

test('the facts auto.root, auto.agents and auto.checkedAt follow the slot', async () => {
  const t = setup()
  await t.start()
  expect(t.m.facts.read('auto.root')).toEqual({ cwd: ROOT, at: START_AT })
  expect(t.m.facts.read('auto.checkedAt')).toBeUndefined()
  await t.spawn(ev.SPAWN_INPUT, ev.SPAWN_ANSWER, ROOT)
  expect(t.m.facts.read<AgentProof[]>('auto.agents')?.map(a => a.id)).toEqual([ev.SPAWN_ANSWER.agentId])
  await t.settle(WINDOW)
  expect(t.m.facts.read('auto.checkedAt')).toBe(START_AT + LIMITS.autoDebounceMs) // when the round fired
  expect(t.m.facts.read('auto.root')).toEqual({ cwd: ROOT, at: START_AT, top: ROOT }) // the round set the top
})

test('a hot reload keeps the slot and loses the facts: init publishes what the slot holds', async () => {
  const world = hostWorld([autoTracker({} as AutoGithub)])
  world.w.state.set('auto', { ...emptyAuto(), root: { cwd: ROOT, at: 5 } } as unknown as Json)
  await world.host.init()
  expect(world.facts.read('auto.root')).toEqual({ cwd: ROOT, at: 5 })
  expect(world.facts.read('auto.agents')).toEqual([])
  expect(world.host.failed()).toEqual([])
})

test('an unreadable slot at init does not fail the tracker', async () => {
  const world = hostWorld([autoTracker({} as AutoGithub)])
  world.w.ports.state.slot.get = async () => {
    throw new Error('state gone')
  }
  await world.host.init()
  expect(world.host.failed()).toEqual([])
  expect(world.facts.read('auto.root')).toBeUndefined()
})

test('autoDismiss adds ids and drops their snapshot rows', async () => {
  const w = fakePorts()
  const dismiss = autoDismiss(w.ports.state.slot)
  expect([...(await dismiss.list())]).toEqual([]) // never written
  const snapshot = {
    worktrees: [
      { id: 'wt-a', depth: 0 },
      { id: 'wt-b', depth: 1 },
      { id: 'wt-c', depth: 1 },
    ],
    agents: [
      { id: 'master', depth: 0, kind: 'master' },
      { id: 'ag-1', depth: 1, kind: 'subagent' },
      { id: 'ag-1-child', depth: 2, kind: 'subagent' },
      { id: 'ag-2', depth: 1, kind: 'subagent' },
    ],
  }
  w.state.set('auto', { ...emptyAuto(), root: { cwd: ROOT, at: 1 }, snapshot } as unknown as Json)
  await dismiss.add(['wt-b', 'ag-1'])
  const next = w.state.get('auto') as unknown as AutoState
  expect([...(await dismiss.list())]).toEqual(['wt-b', 'ag-1'])
  expect(next.root).toEqual({ cwd: ROOT, at: 1 })
  expect(next.snapshot?.worktrees.map(r => r.id)).toEqual(['wt-a', 'wt-c'])
  expect(next.snapshot?.agents.map(r => r.id)).toEqual(['master', 'ag-2']) // the subtree of ag-1 goes with it
  const fresh = fakePorts()
  await autoDismiss(fresh.ports.state.slot).add(['k']) // no run yet: an empty one holds the list
  expect((fresh.state.get('auto') as unknown as AutoState).dismissed).toEqual(['k'])
})

test('a refused auto write leaves the tool result alone', async () => {
  const t = setup()
  await t.running()
  t.w.ports.state.slot.update = async () => {
    throw new Error('refused')
  }
  await t.call('EnterWorktree', { name: 'probe-wt' }, ev.ENTER_RAN) // resolves: the handler logs and goes on
  expect(t.w.logs.filter(l => l.startsWith('auto: EnterWorktree failed: refused'))).toHaveLength(1)
  await t.call('Bash', { command: 'git commit' }, ev.BASH_COMMIT_RAN, { agentId: 'a1' })
})

test('normalise keeps a valid slice, rounds numbers and falls back per field with one warning each', () => {
  const warns: string[] = []
  const warn = (p: string) => void warns.push(p)
  expect(autoConfig.normalise({}, autoConfig.defaults, warn)).toEqual(autoConfig.defaults)
  expect(warns).toEqual([])
  const out = autoConfig.normalise(
    { enabled: false, debounceMs: 100.4, gitTimeoutMs: 1, workflowIdleMs: 'soon', maxAgents: 3000, extra: 1 },
    autoConfig.defaults,
    warn,
  )
  expect(out).toMatchObject({
    enabled: false,
    debounceMs: 100,
    gitTimeoutMs: LIMITS.gitTimeoutMs,
    workflowIdleMs: LIMITS.workflowIdleMs,
    maxAgents: LIMITS.maxAgents,
    extra: 1,
  })
  expect(warns).toHaveLength(3)
  expect(Object.isFrozen(out)).toBe(true)
  expect(autoConfig.normalise({ enabled: 'yes' }, autoConfig.defaults, warn).enabled).toBe(true)
  expect(warns).toHaveLength(4)
})
