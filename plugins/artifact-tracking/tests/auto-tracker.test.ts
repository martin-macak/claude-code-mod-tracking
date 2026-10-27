// The auto tracker on fakePorts, through the LifecycleManager: the events it hears, the run it keeps in the `auto`
// member, the rounds it kicks and the facts it publishes. Git answers from a stub. The PR lane is the github tracker's
// since plan L5, Task 12 (tests/pr-lane.test.ts). Each case mirrors a kit test of auto-wiring.test.tsx.
// Plan: L3 Task 10.
import { expect, test } from 'claude-code/testing'
import { LifecycleManager } from '../core/infra/lifecycle'
import type { ToolCallEvent } from '../core/interfaces/events'
import type { ItemsHost, Json, StoredItem } from '../core/interfaces/items'
import type { RunResult } from '../core/interfaces/ports'
import { autoConfig, auto as autoTracker } from '../trackers/auto'
import { autoDismiss } from '../trackers/auto/dismiss-store'
import { emptyAuto } from '../trackers/auto/ledger'
import { PR_REASONS } from '../trackers/github/lane'
import { fakeConfig } from './fixtures/config-fs'
import type { AgentProof, AutoState, WorktreeProof } from './fixtures/contracts'
import * as ev from './fixtures/events'
import { porcelain } from './fixtures/git'
import { IDLE_ITEMS } from './fixtures/items-host'
import { LIMITS } from './fixtures/limits'
import { fakePorts } from './fixtures/ports'
import { DISCOVERED, reasonsOfSources } from './fixtures/reasons'
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
  /** Answers `git worktree list`. */
  worktreeList?: () => Promise<string>
}

function setup(o: SetupOpts = {}) {
  const w = fakePorts({ now: START_AT, session: { cwd: ROOT } })
  const held = { list: o.items ?? ([] as StoredItem[]), refreshed: [] as string[][] }
  const host: ItemsHost = {
    ...IDLE_ITEMS,
    slot: {
      id: 'items',
      persist: true,
      read: async () => held.list as unknown as Json,
      empty: () => true,
      settle: async live => live,
      restore: async () => {},
    },
    start: async () => {},
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
  const trackers = [autoTracker]
  const m = new LifecycleManager(
    {
      trackers,
      items: host,
      dismiss: p => autoDismiss(p.state.slot),
      config: () => fakeConfig({ specs: trackers }),
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
  /** The fact the round published last: its `seq` counts the rounds and its `reasons` say what started the last one. */
  const branches = () => m.facts.read<{ seq: number; reasons: string[] }>('auto.branches')
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
  return { w, m, held, auto, branches, rounds, call, spawn, start, settle, running }
}

test('start with a cwd pins the root and kicks start; a second start keeps the root', async () => {
  const t = setup()
  await t.start()
  expect(t.auto()?.root).toEqual({ cwd: ROOT, at: START_AT })
  expect(t.rounds()).toBe(0) // start joins the debounce window
  await t.settle(WINDOW)
  expect(t.rounds()).toBe(1)
  expect(t.branches()).toMatchObject({ seq: 1, reasons: ['start'] }) // start is a reason that opens the PR step
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

test('a round with no pinned root publishes no branches: there is nothing for the PR step to poll', async () => {
  const t = setup()
  await t.m.ensureStarted(t.w.ports)
  expect(t.branches()).toEqual({ seq: 0, reasons: [], branches: [], overflow: 0 }) // the init publish
  await t.m.tick()
  await t.m.tick()
  await sleep(20)
  expect(t.branches()?.seq).toBe(0) // the ticks ran rounds that returned at once
  expect(t.m.facts.read('auto.checkedAt')).toBeDefined() // the Worktrees note still learns that a round ran
  await t.start() // the cwd pins the root; from here a round has a run behind it
  await t.settle(WINDOW)
  expect(t.branches()).toMatchObject({ seq: 1, reasons: ['start'] })
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

test('a Bash commit records the agent branch; a pr result kicks a round; a plain command kicks nothing', async () => {
  const t = setup()
  const before = await t.running()
  await t.spawn()
  const id = ev.SPAWN_ANSWER.agentId
  await t.call('Bash', { command: 'git commit -m x' }, ev.BASH_COMMIT_RAN, { agentId: id })
  expect(t.auto()?.agents[0]?.branch).toBe('feat/x')
  await t.settle(WINDOW)
  expect(t.rounds()).toBe(before + 1) // the spawn and the commit joined one window
  expect(t.branches()?.reasons).toEqual(expect.arrayContaining(['agent', 'git'])) // no reason of the PR step among them
  expect(t.branches()?.reasons.filter(r => PR_REASONS.has(r))).toEqual([])
  await t.call('Bash', { command: 'gh pr create' }, ev.BASH_PR_RAN)
  await t.settle(WINDOW)
  expect(t.rounds()).toBe(before + 2)
  expect(t.branches()?.reasons).toEqual(['pr-event']) // pr-event opens the PR step
  await t.call('Bash', { command: 'echo ok' }, ev.BASH_PLAIN_RAN)
  await t.call('Bash', { command: 'echo ok' }, { result: null }) // no result: nothing
  await t.settle(WINDOW)
  expect(t.rounds()).toBe(before + 2)
})

// Issue #158: a PR the run created is a proof, in any repo, by any agent. The fact `auto.prs` carries it to the PR lane.
const OTHER_PR = ev.createdPr('https://github.com/VerticeOne/vertice-iam/pull/657', 657)

test('a Bash result that created a PR records the proof, publishes auto.prs and opens the PR step', async () => {
  const t = setup()
  const before = await t.running()
  expect(t.m.facts.read('auto.prs')).toEqual([])
  await t.call('Bash', { command: 'gh pr create --repo VerticeOne/vertice-iam' }, OTHER_PR)
  const proof = { host: 'github.com', owner: 'VerticeOne', repo: 'vertice-iam', number: 657 }
  expect(t.auto()?.prs).toEqual([proof])
  expect(t.m.facts.read('auto.prs')).toEqual([proof])
  await t.settle(WINDOW)
  expect(t.rounds()).toBe(before + 1)
  expect(t.branches()?.reasons).toEqual(['pr-event'])
  // The same PR again, and a PR that was only merged, write no more proof.
  const sets = t.w.stateSets.auto
  await t.call('Bash', { command: 'gh pr create' }, OTHER_PR)
  await t.call(
    'Bash',
    { command: 'gh pr merge 657' },
    ev.createdPr('https://github.com/VerticeOne/vertice-iam/pull/700', 700, 'merged'),
  )
  expect(t.auto()?.prs).toEqual([proof])
  expect(t.w.stateSets.auto).toBe(sets)
})

test('a subagent that created a PR leaves a proof too', async () => {
  const t = setup()
  await t.running()
  await t.spawn()
  await t.call('Bash', { command: 'gh pr create' }, ev.BASH_PR_RAN, { agentId: ev.SPAWN_ANSWER.agentId })
  expect(t.auto()?.prs?.map(p => `${p.owner}/${p.repo}#${p.number}`)).toEqual(['octo/demo#7'])
})

test('the proofs of a run hold up to maxProofs PRs, the newest', async () => {
  const t = setup()
  await t.running()
  const max = autoConfig.defaults.maxProofs
  for (let n = 1; n <= max + 2; n++)
    await t.call('Bash', { command: 'gh pr create' }, ev.createdPr(`https://github.com/o/r/pull/${n}`, n))
  const numbers = t.auto()?.prs?.map(p => p.number) ?? []
  expect(numbers).toHaveLength(max)
  expect([numbers[0], numbers.at(-1)]).toEqual([3, max + 2])
})

// Issue #202: a cold `--resume` fires no hook for the old calls, so the transcript is read back and the proofs of the PRs
// the earlier process created are rebuilt from it. The stored use keeps `gitOperation`, as a live answer has it
// (docs/knowledge-base/claude-code-auto-tracking/pull-requests.md, "The replayed Bash result after a cold `--resume`").
const DEMO_7 = { host: 'github.com', owner: 'octo', repo: 'demo', number: 7 }
const DEMO_8 = { host: 'github.com', owner: 'octo', repo: 'demo', number: 8 }
const DEMO_9 = { host: 'github.com', owner: 'octo', repo: 'demo', number: 9 }

test('a replay rebuilds the proof of each PR the transcript shows as created, and no other', async () => {
  const t = setup()
  const before = await t.running()
  t.w.session.messages = [
    ev.bashUse('t_c7', 'gh pr create --title t --body y', ev.createdPr(`${ev.DEMO_PULL}/7`, 7)),
    ...ev.NO_PR_USES,
    ev.bashUse('t_c8', 'git status --short && gh pr create --title chained', ev.createdPr(`${ev.DEMO_PULL}/8`, 8)),
    // A headless transcript may store a Bash result with a blank `stdout`: the proof reads `gitOperation`, not the output.
    ev.bashUse('t_h9', 'gh pr create --title headless', ev.headlessPr(`${ev.DEMO_PULL}/9`, 9)),
  ]
  await t.m.replay()
  expect(t.auto()?.prs).toEqual([DEMO_7, DEMO_8, DEMO_9])
  expect(t.m.facts.read('auto.prs')).toEqual([DEMO_7, DEMO_8, DEMO_9])
  await t.settle(WINDOW)
  expect(t.rounds()).toBe(before + 1) // one pr-event round for the batch, none for the git command or the merge
  expect(t.branches()?.reasons).toEqual(['pr-event'])
})

test('a replay of a transcript with no created PR records no proof and starts no round', async () => {
  const t = setup()
  const before = await t.running()
  // A tool other than Bash never makes a proof, whatever its stored result says.
  const other = { tool_use_id: 't_other', tool: 'Read', input: {}, ...ev.createdPr(`${ev.DEMO_PULL}/9`, 9) }
  t.w.session.messages = [...ev.NO_PR_USES, { role: 'assistant', text: '', toolUses: [other] }]
  const sets = t.w.stateSets.auto
  await t.m.replay()
  expect(t.auto()?.prs).toBeUndefined()
  expect(t.w.stateSets.auto).toBe(sets)
  await t.settle(WINDOW)
  expect(t.rounds()).toBe(before)
})

const CREATED_7 = ev.bashUse('t_c7', 'gh pr create', ev.createdPr(`${ev.DEMO_PULL}/7`, 7))
const liveCreate7 = (t: ReturnType<typeof setup>) => t.call('Bash', { command: 'gh pr create' }, ev.BASH_PR_RAN)
/** A switch carries the proofs of the run: the state of the run holds `prs` before the replay of the resumed session. */
const carry = (t: ReturnType<typeof setup>, prs: (typeof DEMO_7)[]) =>
  t.w.state.set('auto', { ...emptyAuto(), root: { cwd: ROOT, at: START_AT }, prs } as unknown as Json)

test('a replay after the live event of the same PR keeps one proof and writes nothing', async () => {
  const t = setup()
  await t.running()
  await liveCreate7(t)
  expect(t.auto()?.prs).toEqual([DEMO_7])
  const sets = t.w.stateSets.auto
  t.w.session.messages = [CREATED_7]
  await t.m.replay()
  expect(t.auto()?.prs).toEqual([DEMO_7])
  expect(t.w.stateSets.auto).toBe(sets)
})

test('a live event after the replay of the same PR keeps one proof, also when the replay repeats', async () => {
  const t = setup()
  await t.running()
  t.w.session.messages = [CREATED_7]
  await t.m.replay()
  expect(t.auto()?.prs).toEqual([DEMO_7]) // the replay alone made the proof
  await liveCreate7(t)
  expect(t.auto()?.prs).toEqual([DEMO_7])
  await t.m.replay()
  expect(t.auto()?.prs).toEqual([DEMO_7])
})

test('a replay on top of carried proofs adds only the new PR, and starts one round for it', async () => {
  const t = setup()
  const before = await t.running()
  carry(t, [DEMO_7])
  t.w.session.messages = [CREATED_7, ev.bashUse('t_c8', 'gh pr create', ev.createdPr(`${ev.DEMO_PULL}/8`, 8))]
  await t.m.replay()
  expect(t.auto()?.prs).toEqual([DEMO_7, DEMO_8])
  await t.settle(WINDOW)
  expect(t.rounds()).toBe(before + 1)
  expect(t.branches()?.reasons).toEqual(['pr-event'])
})

// The kick of the replay exists because the start round can run before the proof is there. When the proofs were there
// already (a carry, or a reload gap before a cold load), the first round has asked for these PRs: a kick would only
// start a git round and a PR step (a GraphQL query) that find nothing new.
test('a replay of PRs that the run already proved writes nothing and starts no round', async () => {
  const t = setup()
  const before = await t.running()
  carry(t, [DEMO_7])
  const sets = t.w.stateSets.auto
  t.w.session.messages = [CREATED_7]
  await t.m.replay()
  expect(t.auto()?.prs).toEqual([DEMO_7])
  expect(t.w.stateSets.auto).toBe(sets) // the replay itself wrote nothing
  await t.settle(WINDOW)
  expect(t.rounds()).toBe(before)
  expect(t.w.stateSets.auto).toBe(sets) // and no round wrote after it
})

test('a replay holds up to maxProofs PRs, the newest of the transcript', async () => {
  const t = setup()
  await t.running()
  const max = autoConfig.defaults.maxProofs
  t.w.session.messages = Array.from({ length: max + 2 }, (_, i) =>
    ev.bashUse(`t_${i + 1}`, 'gh pr create', ev.createdPr(`https://github.com/o/r/pull/${i + 1}`, i + 1)),
  )
  await t.m.replay()
  const numbers = t.auto()?.prs?.map(p => p.number) ?? []
  expect([numbers.length, numbers[0], numbers.at(-1)]).toEqual([max, 3, max + 2])
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
  expect(t.branches()?.reasons).toEqual(['tick']) // tick opens the PR step too
})

test('command clear dismisses the auto ids of the current items', async () => {
  const mk = (key: string, sources: string[], reasons = reasonsOfSources(sources)) => ({
    key,
    category: 'github',
    sources,
    reasons,
    firstSeen: 1,
    lastSeen: 1,
  })
  const t = setup({
    items: [mk('gh:github.com/acme/web#7', [], DISCOVERED), mk('gh:github.com/acme/web#8', ['prompt'])],
  })
  await t.running()
  await t.m.command(t.w.ports, { sub: 'clear', args: '', wait: true })
  expect(t.auto()?.dismissed).toEqual(['gh:github.com/acme/web#7'])
  await t.m.command(t.w.ports, { sub: 'clear', args: '', wait: true }) // again: known ids change nothing
  expect(t.auto()?.dismissed).toEqual(['gh:github.com/acme/web#7'])
})

test('command refresh with wait settles after the round; manual does not wait', async () => {
  let listed = 0
  const t = setup({
    worktreeList: async () => {
      await sleep(25)
      listed++
      return porcelain(ROOT)
    },
  })
  await t.running()
  const before = listed
  await t.m.command(t.w.ports, { sub: 'refresh', args: '', wait: true })
  expect(listed).toBe(before + 1)
  await t.m.command(t.w.ports, { sub: 'manual', args: '', wait: false })
  expect(listed).toBe(before + 1) // it returned before the round ended
  await sleep(120)
  expect(listed).toBe(before + 2)
  await t.m.command(t.w.ports, { sub: 'other', args: '', wait: true }) // a sub the tracker does not know
  await sleep(40)
  expect(listed).toBe(before + 2)
})

test('restore uses carryAuto: a held root fills an empty state and never replaces one', async () => {
  const world = hostWorld([autoTracker])
  await world.host.init()
  const slot = world.host.slots().find(s => s.id === 'auto')
  if (!slot) throw new Error('no auto slot')
  expect(slot.persist).toBe(false)
  const prs = [{ host: 'github.com', owner: 'o', repo: 'r', number: 4 }]
  const held = { ...emptyAuto(), root: { cwd: '/old', at: 1 }, prs }
  await slot.restore(held as unknown as Json, 'carry')
  expect((world.w.state.get('auto') as unknown as AutoState).root).toEqual({ cwd: '/old', at: 1 })
  expect((world.w.state.get('auto') as unknown as AutoState).prs).toEqual(prs) // the PR proofs survive /clear
  expect(world.facts.read('auto.prs')).toEqual(prs)
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
  const world = hostWorld([autoTracker])
  const prs = [{ host: 'github.com', owner: 'o', repo: 'r', number: 4 }]
  world.w.state.set('auto', { ...emptyAuto(), root: { cwd: ROOT, at: 5 }, prs } as unknown as Json)
  await world.host.init()
  expect(world.facts.read('auto.root')).toEqual({ cwd: ROOT, at: 5 })
  expect(world.facts.read('auto.agents')).toEqual([])
  expect(world.facts.read('auto.prs')).toEqual(prs)
  expect(world.host.failed()).toEqual([])
})

test('an unreadable slot at init does not fail the tracker', async () => {
  const world = hostWorld([autoTracker])
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

test('normalise keeps a valid slice, clamps numbers, falls back per field and names each problem once', () => {
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
    debounceMs: LIMITS.autoDebounceMs, // 100.4 is no whole number: the default
    gitTimeoutMs: 500, // below the min: the min
    workflowIdleMs: LIMITS.workflowIdleMs, // no number: the default
    maxAgents: 2000, // above the max: the max
    extra: 1,
  })
  expect(warns).toEqual([
    'debounceMs: 100.4 is not a whole number. Using 750.',
    'gitTimeoutMs: 1 is below the min 500. Using 500.',
    'workflowIdleMs: "soon" is not a number. Using 3600000.',
    'maxAgents: 3000 is above the max 2000. Using 2000.',
    'extra: unknown key. The mod keeps it and ignores it.',
  ])
  expect(autoConfig.normalise({ enabled: 'yes' }, autoConfig.defaults, warn).enabled).toBe(true)
  expect(warns).toHaveLength(6)
})
