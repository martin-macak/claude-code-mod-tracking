// The turn lineage of the rows of the three slot trackers (issue #133, P1b of #69), through the LifecycleManager over
// fakePorts: the processes, repos and auto trackers stamp `firstTurn` and `lastTurn` on their rows from `ctx.turn`, tell the
// ledger which rows an event named, and answer `Traceable.turnsOf`. The events come in the order of a live run (design study
// of #69, comment 2). The plumbing of the turn is in tests/slot-turns.test.ts, the kit spike in tests/slot-turns-wiring.test.tsx.
import { expect, test } from 'claude-code/testing'
import type { Json } from '../core/interfaces/items'
import type { RunResult } from '../core/interfaces/ports'
import type { Tracker } from '../core/interfaces/tracker'
import type { TreeRow } from '../core/interfaces/view'
import { PaneSession } from '../hooks/pane-session'
import { auto } from '../trackers/auto'
import { recordSpawn } from '../trackers/auto/ledger'
import { agentsOfRun, autoTurnsOf, runVisit, spawnSightings } from '../trackers/auto/turns'
import { githubTracker } from '../trackers/github'
import { processesTracker } from '../trackers/processes'
import { mergeProcessRows } from '../trackers/processes/rows'
import { processTurnsOf } from '../trackers/processes/turns'
import { reposTracker } from '../trackers/repos'
import { mergeRepoRows, upsertRepoRows } from '../trackers/repos/rows'
import { repoSightings, repoTurnsOf } from '../trackers/repos/turns'
import type { AgentProof, ProcessRecord, RepoRecord } from './fixtures/contracts'
import { detailBoxes, leaves } from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { BG_START_ASYNC_AGENT, BG_START_MAIN } from './fixtures/notices'
import { WORLD_SNAPSHOT } from './fixtures/pane-world'
import type { FakeWorld } from './fixtures/ports'
import { turnWorld } from './fixtures/turn-world'

declare function setTimeout(fn: () => void, ms: number): unknown
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const res = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '' })

type Stamps = { firstTurn?: number; lastTurn?: number }
const bg = BG_START_MAIN as unknown as Json
const bgAgent = BG_START_ASYNC_AGENT as unknown as Json

// ---------------------------------------------------------------- processes

function processes() {
  const t = turnWorld({ trackers: () => [processesTracker()] })
  const rows = () => (t.w.state.get('processes') ?? []) as unknown as (ProcessRecord & Stamps)[]
  return { ...t, procs: rows }
}

test('a process that a Bash call started in turn 3 carries firstTurn 3 and lastTurn 3, and /track turn 3 lists it as new', async () => {
  const t = processes()
  await t.idle(1)
  await t.idle(2)
  await t.prompt('run the server')
  await t.start('turn-3', 'run the server')
  await t.bash('npm run dev', { toolUseId: 'tu_bg3' }, bg)
  await t.end('turn-3')
  await t.idle(4)
  expect(t.procs()).toMatchObject([{ id: 'task:butoa45ib', firstTurn: 3, lastTurn: 3 }])
  expect(t.rec(3).new).toEqual([{ k: 'task:butoa45ib', c: 'process', r: 'created' }])
  expect(t.rec(4).new).toEqual([])
  const text = await t.text('turn 3')
  expect(text.split('\n')[0]).toMatch(/ · 1 new$/)
  expect(text).toMatch(/\n {2}new {4}.*npm run dev.* {2}created$/)
})

test('the pane row of a process carries its turns, so the detail shows the first and the last turn', async () => {
  const t = processes()
  await t.start('turn-1', 'run it')
  await t.bash('npm run dev', { toolUseId: 'tu_bg1' }, bg)
  await t.end('turn-1')
  expect((await t.rows()).find(r => r.id === 'task:butoa45ib')?.turns).toEqual({ first: 1, last: 1 })
})

test('the same task named again in turn 5 keeps firstTurn 3, moves lastTurn to 5 and is listed as seen again', async () => {
  const t = processes()
  await t.idle(1)
  await t.idle(2)
  await t.start('turn-3', 'run it')
  await t.bash('npm run dev', { toolUseId: 'tu_bg3' }, bg)
  await t.end('turn-3')
  await t.idle(4)
  await t.start('turn-5', 'again')
  await t.bash('npm run dev', { toolUseId: 'tu_bg5' }, bg)
  await t.end('turn-5')
  expect(t.procs()).toMatchObject([{ id: 'task:butoa45ib', firstTurn: 3, lastTurn: 5 }])
  expect(t.rec(5).seen).toEqual([{ k: 'task:butoa45ib', c: 'process', r: 'created' }])
  expect(t.rec(5).new).toEqual([])
  expect(await t.text('turn 5')).toMatch(/ · 1 seen again\n {2}again {2}.*npm run dev.* {2}created$/)
  expect(await t.text('turn 3')).toMatch(/\n {2}new {4}.*npm run dev.* {2}created$/)
})

test('a call that names the task twice in one turn lists it once, and a notice that ends the task stamps nothing', async () => {
  const t = processes()
  await t.start('turn-1', 'run it')
  await t.bash('npm run dev', { toolUseId: 'tu_a' }, bg)
  await t.bash('npm run dev', { toolUseId: 'tu_b' }, bg)
  await t.end('turn-1')
  await t.start('turn-2', 'more')
  await t.m.row(t.w.ports, {
    door: 'delivery',
    origin: 'task-notification',
    isMeta: true,
    hasMessage: true,
    text: '<task-notification>\n<task-id>butoa45ib</task-id>\n<tool-use-id>tu_a</tool-use-id>\n<status>completed</status>\n</task-notification>',
  })
  await t.end('turn-2')
  expect(t.procs()).toMatchObject([{ state: 'completed', firstTurn: 1, lastTurn: 1 }])
  expect(t.rec(1).new).toHaveLength(1)
  expect(t.rec(1).seen).toEqual([])
  expect(t.rec(2)).toMatchObject({ new: [], seen: [] })
})

test("a subagent's background task, started after its turn ended, belongs to the turn that spawned the agent and is late", async () => {
  const t = processes()
  await t.start('turn-1', 'spawn')
  await t.spawn('agent-1', 'tu_agent1')
  await t.end('turn-1')
  await t.start('turn-2', 'something else')
  await t.bash('sleep 9', { agentId: 'agent-1', toolUseId: 'tu_sub' }, bgAgent)
  expect(t.procs()).toMatchObject([{ id: 'task:brgzj6uhc', agentId: 'agent-1', firstTurn: 1, lastTurn: 1 }])
  expect(t.rec(1).new).toEqual([{ k: 'task:brgzj6uhc', c: 'process', r: 'created', late: true }])
  expect(t.rec(2).new).toEqual([])
  expect(await t.text('turn 1')).toContain('late (subagent)')
})

test('a process started with no turn running carries no turn and lists in none', async () => {
  const t = processes()
  await t.bash('npm run dev', { toolUseId: 'tu_bg0' }, bg)
  expect(t.procs()).toHaveLength(1)
  expect(t.procs()[0]).not.toHaveProperty('firstTurn')
  expect(t.procs()[0]).not.toHaveProperty('lastTurn')
  expect((await t.rows()).find(r => r.id === 'task:butoa45ib')?.turns).toBeUndefined()
  expect(await t.text('turn')).toBe('No turn tracked yet.')
})

test('a Monitor started in a turn is stamped too', async () => {
  const t = processes()
  await t.start('turn-1', 'watch')
  await t.m.toolCall(t.w.ports, {
    tool: 'Monitor',
    input: { tool: 'Monitor' } as Json,
    result: { result: { taskId: 'mon1' } } as Json,
    toolUseId: 'tu_mon1',
  })
  await t.end('turn-1')
  expect(t.procs()).toMatchObject([{ id: 'monitor:mon1', kind: 'monitor', firstTurn: 1, lastTurn: 1 }])
  expect(t.rec(1).new.map(e => e.k)).toEqual(['monitor:mon1'])
})

// ---------------------------------------------------------------- processes: TaskStop (issue #204)

const TASK = 'task:butoa45ib'

/** Turns 1 and 2 are empty, turn 3 starts the background task `butoa45ib`, turn 4 is empty. */
async function startedInTurn3(t: ReturnType<typeof processes>): Promise<void> {
  await t.idle(1)
  await t.idle(2)
  await t.start('turn-3', 'run it')
  await t.bash('npm run dev', { toolUseId: 'tu_bg3' }, bg)
  await t.end('turn-3')
  await t.idle(4)
}

/** How often the processes slot and the ledger were written. */
const writes = (t: ReturnType<typeof processes>) => ({
  processes: t.w.stateSets.processes ?? 0,
  turns: t.w.stateSets.turns ?? 0,
})

test('a TaskStop in turn 5 that stops the process of turn 3 moves lastTurn to 5 and lists the row as seen again', async () => {
  const t = processes()
  await startedInTurn3(t)
  await t.start('turn-5', 'stop it')
  await t.stop('butoa45ib', { toolUseId: 'tu_stop5' })
  await t.end('turn-5')
  expect(t.procs()).toMatchObject([{ id: TASK, state: 'killed', firstTurn: 3, lastTurn: 5 }])
  expect(t.rec(5).seen).toEqual([{ k: TASK, c: 'process', r: 'created' }])
  expect(t.rec(5).new).toEqual([])
  expect(await t.text('turn 5')).toMatch(/ · 1 seen again\n {2}again {2}.*npm run dev.* {2}created$/)
  expect(await t.text('turn 3')).toMatch(/\n {2}new {4}.*npm run dev.* {2}created$/)
  expect((await t.rows()).find(r => r.id === TASK)?.turns).toEqual({ first: 3, last: 5 })
})

test('a TaskStop for a task that no row owns stamps nothing, adds no entry and writes neither the slot nor the ledger', async () => {
  const t = processes()
  await startedInTurn3(t)
  await t.start('turn-5', 'stop it')
  const before = writes(t)
  const row = { ...t.procs()[0] }
  await t.stop('nobody', { toolUseId: 'tu_stop5' })
  expect(writes(t)).toEqual(before)
  expect(t.procs()).toEqual([row])
  await t.end('turn-5')
  expect(t.rec(5)).toMatchObject({ new: [], seen: [] })
  expect(await t.text('turn 5')).toMatch(/nothing tracked$/)
})

test('a second TaskStop of the same task in turn 5 is a repeat: the ledger is not written, one entry, the stamps stay', async () => {
  const t = processes()
  await startedInTurn3(t)
  await t.start('turn-5', 'stop it')
  await t.stop('butoa45ib', { toolUseId: 'tu_stop5a' })
  const before = writes(t)
  const stamps = { firstTurn: t.procs()[0]?.firstTurn, lastTurn: t.procs()[0]?.lastTurn }
  await t.stop('butoa45ib', { toolUseId: 'tu_stop5b' })
  expect(writes(t).turns).toBe(before.turns) // no new ledger write
  expect(t.rec(5).seen).toEqual([{ k: TASK, c: 'process', r: 'created' }]) // no new entry
  expect(t.procs()[0]).toMatchObject({ ...stamps, state: 'killed' })
})

// The two answers come from two engine paths: a run that failed, and a hook that refused the call.
const NOT_STOPPED: [string, Json][] = [
  [
    'an error answer (isError)',
    { result: 'Error: Task butoa45ib is not running (status: killed)', isError: true } as Json,
  ],
  ['a call that a hook refused ({ deny })', { deny: 'refused by a hook' } as Json],
]
for (const [name, answer] of NOT_STOPPED) {
  test(`a TaskStop with ${name} names no row and changes nothing`, async () => {
    const t = processes()
    await startedInTurn3(t)
    await t.start('turn-5', 'stop it')
    const before = writes(t)
    await t.stop('butoa45ib', {}, answer)
    expect(writes(t)).toEqual(before)
    expect(t.procs()).toMatchObject([{ state: 'running', firstTurn: 3, lastTurn: 3 }])
    await t.end('turn-5')
    expect(t.rec(5)).toMatchObject({ new: [], seen: [] })
  })
}

test('a process that turn 3 starts and stops is listed once, as new, and not as seen again', async () => {
  const t = processes()
  await t.idle(1)
  await t.idle(2)
  await t.start('turn-3', 'run it, then stop it')
  await t.bash('npm run dev', { toolUseId: 'tu_bg3' }, bg)
  await t.stop('butoa45ib', { toolUseId: 'tu_stop3' })
  await t.end('turn-3')
  expect(t.procs()).toMatchObject([{ id: TASK, state: 'killed', firstTurn: 3, lastTurn: 3 }])
  expect(t.rec(3).new).toEqual([{ k: TASK, c: 'process', r: 'created' }])
  expect(t.rec(3).seen).toEqual([])
})

test('a Monitor row is stamped by the TaskStop of its task id', async () => {
  const t = processes()
  await t.idle(1)
  await t.start('turn-2', 'watch')
  await t.m.toolCall(t.w.ports, {
    tool: 'Monitor',
    input: { tool: 'Monitor' } as Json,
    result: { result: { taskId: 'mon1' } } as Json,
    toolUseId: 'tu_mon1',
  })
  await t.end('turn-2')
  await t.start('turn-3', 'stop it')
  await t.stop('mon1', { toolUseId: 'tu_stop3' })
  await t.end('turn-3')
  expect(t.procs()).toMatchObject([{ id: 'monitor:mon1', state: 'killed', firstTurn: 2, lastTurn: 3 }])
  expect(t.rec(3).seen).toEqual([{ k: 'monitor:mon1', c: 'process', r: 'created' }])
})

test('a row that no turn stamped gets the turn of the TaskStop for both stamps and lists as seen again', async () => {
  const t = processes()
  await t.bash('npm run dev', { toolUseId: 'tu_bg0' }, bg) // no turn running: the row has no stamps
  expect(t.procs()[0]).not.toHaveProperty('firstTurn')
  await t.start('turn-1', 'stop it')
  await t.stop('butoa45ib', { toolUseId: 'tu_stop1' })
  await t.end('turn-1')
  expect(t.procs()).toMatchObject([{ id: TASK, state: 'killed', firstTurn: 1, lastTurn: 1 }])
  expect(t.rec(1).seen).toEqual([{ k: TASK, c: 'process', r: 'created' }])
  expect(t.rec(1).new).toEqual([])
})

test("a subagent's TaskStop, made after its turn ended, belongs to the turn that spawned the agent and is late", async () => {
  const t = processes()
  await t.start('turn-1', 'run it')
  await t.bash('npm run dev', { toolUseId: 'tu_bg1' }, bg)
  await t.end('turn-1')
  await t.start('turn-2', 'spawn')
  await t.spawn('agent-1', 'tu_agent2')
  await t.end('turn-2')
  await t.start('turn-3', 'something else')
  await t.stop('butoa45ib', { agentId: 'agent-1', toolUseId: 'tu_sub' })
  expect(t.procs()).toMatchObject([{ id: TASK, state: 'killed', firstTurn: 1, lastTurn: 2 }])
  expect(t.rec(2).seen).toEqual([{ k: TASK, c: 'process', r: 'created', late: true }])
  expect(t.rec(3)).toMatchObject({ new: [], seen: [] })
})

test('a TaskStop that a plugin raised (byPlugin) ends the row but stamps no turn and adds no entry', async () => {
  const t = processes()
  await startedInTurn3(t)
  await t.start('turn-5', 'clean up')
  await t.stop('butoa45ib', { byPlugin: true })
  await t.end('turn-5')
  expect(t.procs()).toMatchObject([{ id: TASK, state: 'killed', firstTurn: 3, lastTurn: 3 }])
  expect(t.rec(5)).toMatchObject({ new: [], seen: [] })
  expect(await t.text('turn 5')).toMatch(/nothing tracked$/)
})

const proc = (id: string, o: Partial<ProcessRecord & Stamps> = {}): ProcessRecord & Stamps => ({
  id,
  kind: 'background-task',
  name: id,
  state: 'running',
  firstSeen: 10,
  lastSeen: 10,
  ...o,
})

test('mergeProcessRows keeps the smallest firstTurn and the largest lastTurn of the copies, in either order', () => {
  const a = proc('p', { firstTurn: 3, lastTurn: 3 })
  const b = proc('p', { firstTurn: 5, lastTurn: 5 })
  expect(mergeProcessRows([a], [b], 99)[0]).toMatchObject({ firstTurn: 3, lastTurn: 5 })
  expect(mergeProcessRows([b], [a], 99)[0]).toMatchObject({ firstTurn: 3, lastTurn: 5 })
  expect(mergeProcessRows([proc('p')], [b], 99)[0]).toMatchObject({ firstTurn: 5, lastTurn: 5 }) // a copy from before the lineage
  expect(mergeProcessRows([a], [proc('p')], 99)[0]).toMatchObject({ firstTurn: 3, lastTurn: 3 })
  expect(mergeProcessRows([proc('p')], [proc('p')], 99)[0]).not.toHaveProperty('firstTurn')
})

test('processTurnsOf answers the span of the row, and nothing for an unknown row or a row no turn stamped', () => {
  const rows = [proc('a', { firstTurn: 2, lastTurn: 4 }), proc('b')] as unknown as Json
  expect(processTurnsOf(rows, 'a')).toEqual({ first: 2, last: 4 })
  expect(processTurnsOf(rows, 'b')).toBeUndefined()
  expect(processTurnsOf(rows, 'c')).toBeUndefined()
  expect(processTurnsOf(undefined, 'a')).toBeUndefined()
})

// ---------------------------------------------------------------- repos

const SDK_KEY = 'remote:github.com/acme/sdk'
const SDK_ID = `rp:${SDK_KEY}`

/** Answers the git calls of one repo at `/x/sdk`. `held` makes the rev-parse wait for a promise that the test releases. */
function sdkGit(held?: Promise<undefined>) {
  return async (argv: string[]): Promise<RunResult | undefined> => {
    if (argv[0] !== 'git' || argv[1] !== '-C' || !String(argv[2]).startsWith('/x/sdk')) return undefined
    if (argv[3] === 'rev-parse') {
      if (held) await held
      return res('/x/sdk\n/x/sdk/.git\n')
    }
    if (argv[3] === 'remote') return res('git@github.com:acme/sdk.git\n')
    return res('main\n')
  }
}

/** Waits until the queue has run: no new git call comes for a while. */
async function drain(w: FakeWorld): Promise<void> {
  let last = -1
  for (let i = 0; i < 100; i++) {
    await sleep(8)
    if (w.calls.length === last && i >= 3) return
    last = w.calls.length
  }
}

/** Answers the git calls of the repo at `/x/other`. Its rev-parse waits for `held`, so the jobs behind it wait in the queue. */
function otherGit(held: Promise<undefined>) {
  return async (argv: string[]): Promise<RunResult | undefined> => {
    if (argv[0] !== 'git' || argv[1] !== '-C' || !String(argv[2]).startsWith('/x/other')) return undefined
    if (argv[3] === 'rev-parse') {
      await held
      return res('/x/other\n/x/other/.git\n')
    }
    if (argv[3] === 'remote') return res('git@github.com:acme/other.git\n')
    return res('main\n')
  }
}

function repos(held?: Promise<undefined>, run: ReturnType<typeof sdkGit> = sdkGit(held)) {
  const t = turnWorld({ trackers: () => [reposTracker()], run })
  t.m.facts.publish('auto.root', { cwd: '/work', at: 0, top: '/work' })
  const rows = () => (t.w.state.get('repos') ?? []) as unknown as (RepoRecord & Stamps)[]
  return { ...t, repoRows: rows }
}

test('a repo visited in turn 3 and named again in turn 5 shows lastTurn 5, and /track turn 5 lists it as seen again', async () => {
  const t = repos()
  await t.idle(1)
  await t.idle(2)
  await t.start('turn-3', 'look at the sdk')
  await t.bash('cd /x/sdk && ls')
  await drain(t.w)
  await t.end('turn-3')
  expect(t.repoRows()).toMatchObject([{ key: SDK_KEY, firstTurn: 3, lastTurn: 3 }])
  await t.idle(4)
  const writes = t.w.stateSets.repos
  await t.start('turn-5', 'and the sdk again')
  await t.bash('cd /x/sdk && ls') // within tickMs of the first visit: only the turn moves
  await drain(t.w)
  await t.end('turn-5')
  expect(t.repoRows()).toMatchObject([{ key: SDK_KEY, firstTurn: 3, lastTurn: 5 }])
  expect(t.w.stateSets.repos).toBe((writes ?? 0) + 1) // a new turn is a change, though lastSeen did not move
  expect(t.rec(3).new).toEqual([{ k: SDK_ID, c: 'repo', r: 'read' }])
  expect(t.rec(5).seen).toEqual([{ k: SDK_ID, c: 'repo', r: 'read' }])
  expect(await t.text('turn 3')).toMatch(/\n {2}new {4}.*acme\/sdk.* {2}read$/)
  const text = await t.text('turn 5')
  expect(text.split('\n')[0]).toMatch(/ · 1 seen again$/)
  expect(text).toMatch(/\n {2}again {2}.*acme\/sdk.* {2}read$/)
})

test('the pane row of a repo carries its turns', async () => {
  const t = repos()
  await t.idle(1)
  await t.start('turn-2', 'sdk')
  await t.bash('cd /x/sdk && ls')
  await drain(t.w)
  await t.idle(3)
  await t.start('turn-4', 'sdk')
  await t.bash('cd /x/sdk && ls')
  await drain(t.w)
  expect((await t.rows()).find(r => r.id === SDK_ID)?.turns).toEqual({ first: 2, last: 4 })
})

test('a second visit in the same turn is a repeat: no new write, one entry', async () => {
  const t = repos()
  await t.start('turn-1', 'sdk')
  await t.bash('cd /x/sdk && ls')
  await drain(t.w)
  const writes = t.w.stateSets.repos
  await t.bash('cd /x/sdk && ls')
  await drain(t.w)
  expect(t.w.stateSets.repos).toBe(writes)
  expect(t.rec(1).new).toHaveLength(1)
  expect(t.rec(1).seen).toEqual([])
})

test('a visit of a later turn is not dropped while the same visit of an earlier turn still waits in the queue', async () => {
  let release: () => void = () => {}
  const held = new Promise<undefined>(resolve => {
    release = () => resolve(undefined)
  })
  const sdk = sdkGit()
  const other = otherGit(held)
  const t = repos(undefined, async argv => (await other(argv)) ?? sdk(argv))
  await t.start('turn-1', 'look around')
  await t.bash('cd /x/other && ls') // its git call waits on `held`: the next jobs wait behind it
  await t.bash('cd /x/sdk && ls') // waits in the queue
  await t.end('turn-1')
  await t.start('turn-2', 'the sdk again')
  await t.bash('cd /x/sdk && ls') // the same visit, a later turn, while the first still waits
  release()
  await drain(t.w)
  await t.end('turn-2')
  expect(t.repoRows().find(r => r.key === SDK_KEY)).toMatchObject({ firstTurn: 1, lastTurn: 2 })
  expect(t.rec(1).new.map(e => e.k)).toContain(SDK_ID)
  expect(t.rec(2).seen.map(e => e.k)).toEqual([SDK_ID])
})

test('an edit in a later turn lists the repo as seen again with the reason updated; the first visit was a read', async () => {
  const t = repos()
  await t.start('turn-1', 'read it')
  await t.call('Read', { file_path: '/x/sdk/a.ts' }, null)
  await drain(t.w)
  await t.end('turn-1')
  await t.start('turn-2', 'edit it')
  await t.call('Edit', { file_path: '/x/sdk/a.ts' }, null)
  await drain(t.w)
  expect(t.rec(1).new).toEqual([{ k: SDK_ID, c: 'repo', r: 'read' }])
  expect(t.rec(2).seen).toEqual([{ k: SDK_ID, c: 'repo', r: 'updated' }])
})

test('a read in a later turn of a repo that an earlier turn edited lists it as seen again with the reason read', async () => {
  const t = repos()
  await t.start('turn-1', 'edit it')
  await t.call('Edit', { file_path: '/x/sdk/a.ts' }, null)
  await drain(t.w)
  await t.end('turn-1')
  await t.start('turn-2', 'only read it')
  await t.call('Read', { file_path: '/x/sdk/a.ts' }, null)
  await drain(t.w)
  expect(t.repoRows()).toMatchObject([{ key: SDK_KEY, mode: 'edit', firstTurn: 1, lastTurn: 2 }]) // the row keeps its edit
  expect(t.rec(1).new).toEqual([{ k: SDK_ID, c: 'repo', r: 'updated' }])
  expect(t.rec(2).seen).toEqual([{ k: SDK_ID, c: 'repo', r: 'read' }]) // turn 2 edited nothing
})

test('a repo visited with no turn running carries no turn and lists in none', async () => {
  const t = repos()
  await t.bash('cd /x/sdk && ls')
  await drain(t.w)
  expect(t.repoRows()).toHaveLength(1)
  expect(t.repoRows()[0]).not.toHaveProperty('firstTurn')
  expect(await t.text('turn')).toBe('No turn tracked yet.')
})

test('a lookup that ends after a /clear notes nothing in the carried turn, though the carried row is there: the generation moved', async () => {
  let release: () => void = () => {}
  const held = new Promise<undefined>(resolve => {
    release = () => resolve(undefined)
  })
  const t = repos(held)
  // The row is in the slot already, as a /clear carries it. The stale job would find it there and say "seen again".
  t.w.state.set('repos', [
    {
      key: SDK_KEY,
      name: 'acme/sdk',
      touchedBy: ['main'],
      mode: 'read',
      firstSeen: 1,
      lastSeen: 1,
      firstTurn: 1,
      lastTurn: 1,
    },
  ] as unknown as Json)
  await t.idle(1)
  await t.start('turn-2', 'sdk')
  await t.bash('cd /x/sdk && ls')
  await sleep(30) // the job waits on git
  await t.m.end(t.w.ports, 'clear', 1500)
  t.w.session.id = 'sess-2'
  await t.m.entry(t.w.ports) // finds the new id: a switch, the generation moves
  release()
  await drain(t.w)
  expect(t.repoRows()).toMatchObject([{ key: SDK_KEY, firstTurn: 1, lastTurn: 1 }]) // the stale job wrote nothing
  expect(t.rec(2).seen).toEqual([])
})

const repo = (key: string, o: Partial<RepoRecord & Stamps> = {}): RepoRecord & Stamps => ({
  key,
  name: key,
  touchedBy: ['main'],
  mode: 'read',
  firstSeen: 10,
  lastSeen: 10,
  ...o,
})
const visit = (turn?: number, at = 20) => ({
  key: 'k',
  name: 'k',
  touchedBy: 'main',
  mode: 'read' as const,
  at,
  ...(turn !== undefined ? { turn } : {}),
})

test('upsertRepoRows stamps a new row with the turn of the visit, and a known row with the span', () => {
  const first = upsertRepoRows([], visit(3), 1000)
  expect(first).toMatchObject([{ key: 'k', firstTurn: 3, lastTurn: 3 }])
  const again = upsertRepoRows(first, visit(5, 21), 1000) // within tickMs: lastSeen stays
  expect(again).toMatchObject([{ firstTurn: 3, lastTurn: 5, lastSeen: 20 }])
  expect(again).not.toBe(first)
  expect(upsertRepoRows(again, visit(5, 22), 1000)).toBe(again) // the same turn, nothing new
  expect(upsertRepoRows(again, visit(4, 22), 1000)).toBe(again) // late work of a turn between the two
  expect(upsertRepoRows(again, visit(1, 22), 1000)).toMatchObject([{ firstTurn: 1, lastTurn: 5 }])
})

test('upsertRepoRows with no turn leaves the stamps as they are, and stamps nothing new', () => {
  const stamped = upsertRepoRows([], visit(3), 1000)
  expect(upsertRepoRows(stamped, visit(undefined, 21), 1000)).toBe(stamped)
  const bare = upsertRepoRows([], visit(undefined), 1000)
  expect(bare[0]).not.toHaveProperty('firstTurn')
  const old = [repo('k')] // a row from before the lineage
  expect(upsertRepoRows(old, visit(7, 21), 1000)).toMatchObject([{ firstTurn: 7, lastTurn: 7 }])
})

test('mergeRepoRows keeps the smallest firstTurn and the largest lastTurn of the copies, in either order', () => {
  const a = repo('k', { firstTurn: 3, lastTurn: 4 })
  const b = repo('k', { firstTurn: 2, lastTurn: 9, lastSeen: 50 })
  expect(mergeRepoRows([a], [b])[0]).toMatchObject({ firstTurn: 2, lastTurn: 9 })
  expect(mergeRepoRows([b], [a])[0]).toMatchObject({ firstTurn: 2, lastTurn: 9 })
  expect(mergeRepoRows([a], [repo('k')])[0]).toBe(a) // a copy with no turn changes nothing
  expect(mergeRepoRows([repo('k')], [a])[0]).toMatchObject({ firstTurn: 3, lastTurn: 4 })
})

test('repoTurnsOf answers the span of the row rp:<key>, and nothing for an unknown row or one no turn stamped', () => {
  const rows = [repo('a', { firstTurn: 2, lastTurn: 4 }), repo('b')]
  expect(repoTurnsOf(rows, 'rp:a')).toEqual({ first: 2, last: 4 })
  expect(repoTurnsOf(rows, 'rp:b')).toBeUndefined()
  expect(repoTurnsOf(rows, 'rp:c')).toBeUndefined()
  expect(repoTurnsOf(undefined, 'rp:a')).toBeUndefined()
})

test('repoSightings: the reason is the strongest mode of the visits of the batch, not the mode the row accumulated', () => {
  const edited = repo('k', { mode: 'edit', firstTurn: 1, lastTurn: 1 })
  const reasonOf = (visits: { key: string; mode: 'read' | 'edit' }[]) =>
    repoSightings(2, visits, [edited], [{ ...edited, lastTurn: 2 }]).seen.map(e => e.r)
  expect(reasonOf([{ key: 'k', mode: 'read' }])).toEqual(['read'])
  expect(
    reasonOf([
      { key: 'k', mode: 'read' },
      { key: 'k', mode: 'edit' },
    ]),
  ).toEqual(['updated'])
  expect(
    reasonOf([
      { key: 'k', mode: 'edit' },
      { key: 'k', mode: 'read' },
    ]),
  ).toEqual(['updated'])
})

// ---------------------------------------------------------------- agents (auto)

/** Every row of the tree, depth first: the agents nest under the master. */
const all = (rs: readonly TreeRow[]): TreeRow[] => rs.flatMap(r => [r, ...all(r.children ?? [])])

/** A row of the snapshot of a round: the template agent of the pane world, with `o` over it. */
const snapshotAgent = (o: Record<string, unknown>) => ({ ...WORLD_SNAPSHOT.agents[1], ...o })

/** An agent proof of the auto state: a plain subagent, or an agent of workflow run `runId`, with the turn stamps over it. */
const proofOf = (id: string, runId?: string, stamps: Stamps = {}) =>
  ({
    id,
    kind: runId === undefined ? 'subagent' : 'workflow',
    label: id,
    spawnedAt: 1,
    ...(runId === undefined ? {} : { workflow: { runId, agentIndex: 1 } }),
    ...stamps,
  }) as AgentProof & Stamps

/** The auto state that holds `list` as its agent proofs. */
const autoStateOf = (...list: (AgentProof & Stamps)[]) =>
  ({ root: null, worktrees: [], agents: list, dismissed: [], snapshot: null }) as never

function agents(trackers: () => readonly Tracker[] = () => [auto]) {
  const t = turnWorld({ trackers })
  const proofs = () =>
    ((t.w.state.get('auto') as unknown as { agents?: (AgentProof & Stamps)[] } | undefined)?.agents ??
      []) as (AgentProof & Stamps)[]
  /** The Agents section draws more than the master row only from a snapshot of a round. A round needs git: seed the snapshot. */
  const seed = (rows: readonly Record<string, unknown>[]) => {
    const held = t.w.state.get('auto') as unknown as Record<string, Json>
    const snapshot = { ...WORLD_SNAPSHOT, agents: [WORLD_SNAPSHOT.agents[0], ...rows] }
    t.w.state.set('auto', { ...held, snapshot } as unknown as Json)
  }
  return { ...t, proofs, seed }
}

const SPAWN = { description: 'explore the code', subagentType: 'general-purpose' }

test('an agent that turn 2 spawned carries firstTurn 2 and lastTurn 2, and /track turn 2 lists it as new', async () => {
  const t = agents()
  await t.idle(1)
  await t.start('turn-2', 'spawn one')
  await t.spawn('agent-7', 'tu_agent2', SPAWN)
  await t.end('turn-2')
  expect(t.proofs()).toMatchObject([{ id: 'agent-7', label: 'explore the code', firstTurn: 2, lastTurn: 2 }])
  expect(t.rec(2).new).toEqual([{ k: 'ag:agent-7', c: 'agent', r: 'created' }])
  const text = await t.text('turn 2')
  expect(text.split('\n')[0]).toMatch(/ · 1 new$/)
  expect(text).toMatch(/\n {2}new {4}.*ag:agent-7.* {2}created$/)
})

test('a spawn of the same agent in turn 4 keeps firstTurn 2, moves lastTurn to 4 and is listed as seen again', async () => {
  const t = agents()
  await t.idle(1)
  await t.start('turn-2', 'spawn one')
  await t.spawn('agent-7', 'tu_agent2', SPAWN)
  await t.end('turn-2')
  await t.idle(3)
  await t.start('turn-4', 'resume it')
  await t.spawn('agent-7', 'tu_agent4', SPAWN)
  await t.end('turn-4')
  expect(t.proofs()).toMatchObject([{ id: 'agent-7', firstTurn: 2, lastTurn: 4 }])
  expect(t.rec(4).seen).toEqual([{ k: 'ag:agent-7', c: 'agent', r: 'created' }])
  expect(t.rec(4).new).toEqual([])
})

test('the pane row of an agent carries its turns, and /track turn 2 names the agent by the words of its row', async () => {
  const t = agents()
  await t.idle(1)
  await t.start('turn-2', 'spawn one')
  await t.spawn('agent-7', 'tu_agent2', SPAWN)
  await t.end('turn-2')
  t.seed([snapshotAgent({ id: 'ag:agent-7', label: 'explore the code', depth: 1 })])
  const rows = all(await t.rows())
  expect(rows.find(r => r.id === 'ag:agent-7')?.turns).toEqual({ first: 2, last: 2 })
  expect(rows.find(r => r.id === 'ag:master')?.turns).toBeUndefined() // the master agent has no proof
  const text = await t.text('turn 2')
  expect(text).toMatch(/\n {2}new {4}.*explore the code.* {2}created/)
  expect(text).not.toContain('ag:agent-7') // the label of the row stands in for the raw id
})

// ---------------------------------------------------------------- workflow runs (issue #203)

const RUN = 'wf_a35565d1-fd4'
const RUN_ROW = `ag:wf:${RUN}`
const wf = (runId: string, agentIndex: number) => ({ ...SPAWN, workflow: { runId, agentIndex } })

/** The auto tracker beside the processes and github trackers, so a turn can hold a later entry of another kind. */
function workflows() {
  const t = agents(() => [githubTracker(), auto, processesTracker()])
  /** The snapshot of a round: the master and `n` workflow agents of `runId`, all in `state`. `failed` of them failed. */
  const seedRun = (runId: string, n: number, state: 'ended' | 'running', failed = 0) =>
    t.seed(
      Array.from({ length: n }, (_, i) =>
        snapshotAgent({
          id: `ag:agent-${i + 1}`,
          label: `step ${i + 1}`,
          kind: 'workflow',
          state: i < failed ? 'failed' : state,
          workflow: { runId, agentIndex: i + 1 },
        }),
      ),
    )
  return { ...t, seedRun }
}

test('a run of 15 workflow agents is one entry of its turn, and every agent is still stamped', async () => {
  const t = workflows()
  await t.idle(1)
  await t.start('turn-2', 'run the workflow')
  for (let i = 1; i <= 15; i++) await t.spawn(`agent-${i}`, `tu_${i}`, wf(RUN, i))
  await t.end('turn-2')
  expect(t.proofs()).toHaveLength(15)
  for (const p of t.proofs()) expect(p).toMatchObject({ kind: 'workflow', firstTurn: 2, lastTurn: 2 })
  expect(t.rec(2).new).toEqual([{ k: RUN_ROW, c: 'workflow', r: 'created' }])
  expect(t.rec(2).seen).toEqual([])
  expect((await t.text('turn 2')).split('\n')[0]).toMatch(/ · 1 new$/)
})

test('a plain subagent of the turn of a run still takes its own entry beside the one of the run', async () => {
  const t = workflows()
  await t.idle(1)
  await t.start('turn-2', 'run the workflow')
  await t.spawn('agent-1', 'tu_wf1', wf(RUN, 1))
  await t.spawn('agent-2', 'tu_wf2', wf(RUN, 2))
  await t.spawn('agent-7', 'tu_agent7', SPAWN)
  await t.end('turn-2')
  expect(t.rec(2).new).toEqual([
    { k: RUN_ROW, c: 'workflow', r: 'created' },
    { k: 'ag:agent-7', c: 'agent', r: 'created' },
  ])
})

test('a run that turns 2 and 4 spawned in: new in turn 2, seen again in turn 4, and its drawn row shows both turns', async () => {
  const t = workflows()
  await t.idle(1)
  await t.start('turn-2', 'run it')
  await t.spawn('agent-1', 'tu_1', wf(RUN, 1))
  await t.spawn('agent-2', 'tu_2', wf(RUN, 2))
  await t.end('turn-2')
  await t.idle(3)
  await t.start('turn-4', 'more')
  await t.spawn('agent-3', 'tu_3', wf(RUN, 3))
  await t.end('turn-4')
  expect(t.rec(2).new).toEqual([{ k: RUN_ROW, c: 'workflow', r: 'created' }])
  expect(t.rec(4).new).toEqual([])
  expect(t.rec(4).seen).toEqual([{ k: RUN_ROW, c: 'workflow', r: 'created' }])
  t.seedRun(RUN, 3, 'ended', 1)
  // The run row is drawn from its agents: its turns are the span of their stamps, and the open row prints them in its detail.
  expect(all(await t.rows()).find(r => r.id === RUN_ROW)?.turns).toEqual({ first: 2, last: 4 })
  t.w.state.set('expanded', [RUN_ROW]) // the master row is open by default, so the run row is drawn
  const drawn = await new PaneSession().draw(t.w.ports, t.m, EL, { bodyColumns: 120 })
  expect(detailBoxes(drawn).flatMap(leaves).slice(-2)).toEqual(['turns:', 'first 2 · last 4'])
  const text = await t.text('turn 2')
  expect(text).toMatch(/\n {2}new {4}.*wf_a35565.*3 agents · 1 failed/) // the words of the drawn row
  expect(text).not.toContain(RUN_ROW)
})

test('a run that still runs is listed once under its id: its agents are rows and no run row is drawn', async () => {
  const t = workflows()
  await t.idle(1)
  await t.start('turn-2', 'run it')
  await t.spawn('agent-1', 'tu_1', wf(RUN, 1))
  await t.spawn('agent-2', 'tu_2', wf(RUN, 2))
  await t.end('turn-2')
  t.seedRun(RUN, 2, 'running')
  const rows = all(await t.rows())
  expect(rows.some(r => r.id === RUN_ROW)).toBe(false)
  expect(rows.find(r => r.id === 'ag:agent-1')?.turns).toEqual({ first: 2, last: 2 })
  expect(t.rec(2).new).toEqual([{ k: RUN_ROW, c: 'workflow', r: 'created' }])
  expect(await t.text('turn 2')).toContain(`workflow ${RUN_ROW}`) // the raw words of an entry with no row
})

test('a run of one agent is listed once under its id and never folds: its agent row has the turns', async () => {
  const t = workflows()
  await t.idle(1)
  await t.start('turn-2', 'run it')
  await t.spawn('agent-1', 'tu_1', wf(RUN, 1))
  await t.end('turn-2')
  t.seedRun(RUN, 1, 'ended')
  const rows = all(await t.rows())
  expect(rows.some(r => r.id === RUN_ROW)).toBe(false)
  expect(rows.find(r => r.id === 'ag:agent-1')?.turns).toEqual({ first: 2, last: 2 })
  expect(t.rec(2).new).toEqual([{ k: RUN_ROW, c: 'workflow', r: 'created' }])
  expect(await t.text('turn 2')).toContain(`workflow ${RUN_ROW}`)
})

test('the run is one slot of the 50 of its list, so a later entry of the turn is listed and not pushed into N more', async () => {
  const t = workflows()
  await t.start('turn-1', 'busy')
  for (let i = 1; i <= 40; i++) await t.spawn(`sub-${i}`, `tu_s${i}`, SPAWN) // 40 entries
  for (let i = 1; i <= 15; i++) await t.spawn(`agent-${i}`, `tu_w${i}`, wf(RUN, i)) // one entry, not 15
  await t.bash('npm run dev', { toolUseId: 'tu_bg' }, bg) // a later entry: a process
  await t.prompt('review https://github.com/acme/web/pull/12') // a later entry of the kind that the issue names: a PR link
  await t.end('turn-1')
  expect(t.rec(1).new).toHaveLength(43)
  expect(t.rec(1).moreNew).toBeUndefined()
  expect(t.rec(1).new.slice(-2)).toMatchObject([{ c: 'process' }, { c: 'github', k: 'gh:github.com/acme/web#12' }])
})

test('band key 9 selects a drawn run row, and passes over a run with no row, with a toast when it is the only entry', async () => {
  const folded = workflows()
  await folded.start('turn-1', 'run it')
  await folded.spawn('agent-1', 'tu_1', wf(RUN, 1))
  await folded.spawn('agent-2', 'tu_2', wf(RUN, 2))
  await folded.end('turn-1')
  folded.seedRun(RUN, 2, 'ended')
  await new PaneSession().openTurn(folded.w.ports, folded.m)
  expect(folded.w.state.get('selected')).toBe(RUN_ROW)
  expect(folded.w.ui.toasts).toEqual([])

  const running = workflows()
  await running.start('turn-1', 'run it')
  await running.spawn('agent-1', 'tu_1', wf(RUN, 1))
  await running.spawn('agent-2', 'tu_2', wf(RUN, 2))
  await running.end('turn-1')
  running.seedRun(RUN, 2, 'running') // no run row is drawn: the entry has nothing to select
  await new PaneSession().openTurn(running.w.ports, running.m)
  expect(running.w.state.get('selected') ?? null).toBeNull()
  expect(running.w.ui.toasts).toEqual(['turn 1: its rows are not listed'])
})

test('a workflow spawn made with no turn running lists nothing, and a later spawn of the run in a turn reads seen again', async () => {
  const t = workflows()
  await t.spawn('agent-1', 'tu_1', wf(RUN, 1))
  expect(t.proofs()).toHaveLength(1)
  expect(t.proofs()[0]).not.toHaveProperty('firstTurn')
  expect(await t.text('turn')).toBe('No turn tracked yet.')
  await t.start('turn-1', 'run it')
  await t.spawn('agent-2', 'tu_2', wf(RUN, 2))
  await t.end('turn-1')
  expect(t.rec(1).new).toEqual([])
  expect(t.rec(1).seen).toEqual([{ k: RUN_ROW, c: 'workflow', r: 'created' }])
})

test('a spawn made with no turn running carries no turn and lists in none', async () => {
  const t = agents()
  await t.spawn('agent-7', 'tu_agent0', SPAWN)
  expect(t.proofs()).toHaveLength(1)
  expect(t.proofs()[0]).not.toHaveProperty('firstTurn')
  expect(await t.text('turn')).toBe('No turn tracked yet.')
})

test('recordSpawn stamps a new agent with the turn, and a known one with the span; a spawn with no turn changes nothing', () => {
  const facts = { agentId: 'a', description: 'd', subagentType: 't' }
  const s0 = { root: null, worktrees: [], agents: [], dismissed: [], snapshot: null }
  const s1 = recordSpawn(s0, facts, 10, '/work', 50, 2)
  expect(s1.agents).toMatchObject([{ id: 'a', firstTurn: 2, lastTurn: 2 }])
  const s2 = recordSpawn(s1, facts, 11, '/work', 50, 4)
  expect(s2.agents).toMatchObject([{ id: 'a', firstTurn: 2, lastTurn: 4, spawnedAt: 10 }])
  expect(recordSpawn(s2, facts, 12, '/work', 50, 4)).toBe(s2)
  expect(recordSpawn(s2, facts, 12, '/work', 50)).toBe(s2)
  expect(recordSpawn(s0, facts, 10, '/work', 50).agents[0]).not.toHaveProperty('firstTurn')
})

test('autoTurnsOf answers the span of the row ag:<id> of an agent proof, and nothing for any other row', () => {
  const state = autoStateOf(proofOf('a', undefined, { firstTurn: 2, lastTurn: 3 }), proofOf('b'))
  expect(autoTurnsOf(state, 'ag:a')).toEqual({ first: 2, last: 3 })
  expect(autoTurnsOf(state, 'ag:b')).toBeUndefined() // no turn stamped it
  expect(autoTurnsOf(state, 'ag:master')).toBeUndefined()
  expect(autoTurnsOf(state, 'wt:/x')).toBeUndefined()
  expect(autoTurnsOf(undefined, 'ag:a')).toBeUndefined()
})

test('autoTurnsOf answers the span of the agents of a run for the row ag:wf:<runId>, and nothing for a run it does not know', () => {
  const state = autoStateOf(
    proofOf('a', 'r1', { firstTurn: 2, lastTurn: 2 }),
    proofOf('b', 'r1', { firstTurn: 3, lastTurn: 5 }),
    proofOf('c', 'r1'), // no stamp: it adds no turn
    proofOf('d', 'r2'), // a run whose agents have no stamp
    proofOf('e', undefined, { firstTurn: 9, lastTurn: 9 }), // a subagent is no part of a run
  )
  expect(autoTurnsOf(state, 'ag:wf:r1')).toEqual({ first: 2, last: 5 })
  expect(autoTurnsOf(state, 'ag:wf:r2')).toBeUndefined()
  expect(autoTurnsOf(state, 'ag:wf:r3')).toBeUndefined()
  expect(autoTurnsOf(undefined, 'ag:wf:r1')).toBeUndefined()
})

test('runVisit: no agent held makes the run new, a held agent makes it a known row with the span of the held stamps', () => {
  const held = (o: Stamps): AgentProof & Stamps => ({ id: 'a', kind: 'workflow', label: 'a', spawnedAt: 1, ...o })
  expect(runVisit('r1', [])).toEqual({ id: 'ag:wf:r1', category: 'workflow', reason: 'created', held: undefined })
  expect(runVisit('r1', [held({ firstTurn: 2, lastTurn: 2 }), held({ firstTurn: 3, lastTurn: 4 })]).held).toEqual({
    firstTurn: 2,
    lastTurn: 4,
  })
  expect(runVisit('r1', [held({})]).held).toEqual({}) // a held agent that no turn stamped: the run is known, of no turn
})

test('agentsOfRun picks the agents of one run by its id: no plain subagent, no agent of another run', () => {
  const list = [proofOf('a', 'r1'), proofOf('b', 'r2'), proofOf('c'), proofOf('d', 'r1')]
  expect(agentsOfRun(list, 'r1').map(a => a.id)).toEqual(['a', 'd'])
  expect(agentsOfRun(list, 'r2').map(a => a.id)).toEqual(['b'])
  expect(agentsOfRun(list, 'r3')).toEqual([])
})

test('spawnSightings: a plain subagent is its own entry, a run is one entry, each read from the state before the spawn', () => {
  const sub = (id: string) => ({ agentId: id, description: 'd', subagentType: 't' })
  const run = (id: string, runId: string) => ({ ...sub(id), workflow: { runId, agentIndex: 2 } })
  const agent = (id: string) => ({ k: `ag:${id}`, c: 'agent', r: 'created' })
  const wfRun = (runId: string) => ({ k: `ag:wf:${runId}`, c: 'workflow', r: 'created' })

  // A plain subagent: its own row, `new` when no proof is held, `seen again` for a resumed one.
  expect(spawnSightings(3, sub('a'), autoStateOf())).toEqual({ added: [agent('a')], seen: [] })
  expect(spawnSightings(4, sub('a'), autoStateOf(proofOf('a', undefined, { firstTurn: 2, lastTurn: 2 })))).toEqual({
    added: [],
    seen: [agent('a')],
  })
  // A run: the run row, whatever the agent. The agents of another run and the plain subagents are no part of it.
  const others = [
    proofOf('x', 'r2', { firstTurn: 1, lastTurn: 1 }),
    proofOf('y', undefined, { firstTurn: 1, lastTurn: 1 }),
  ]
  expect(spawnSightings(3, run('a', 'r1'), autoStateOf(...others))).toEqual({ added: [wfRun('r1')], seen: [] })
  // A second agent of the run in the same turn is `repeat`, in a later turn it is `seen again`.
  const held = [...others, proofOf('a', 'r1', { firstTurn: 2, lastTurn: 3 })]
  expect(spawnSightings(3, run('b', 'r1'), autoStateOf(...held))).toEqual({
    added: [],
    seen: [],
    repeat: [wfRun('r1')],
  })
  expect(spawnSightings(5, run('b', 'r1'), autoStateOf(...held))).toEqual({ added: [], seen: [wfRun('r1')] })
  // An agent that no turn stamped is a known row of no turn: a resumed subagent and a run read `seen again` alike (G5 of #203).
  expect(spawnSightings(1, sub('a'), autoStateOf(proofOf('a'))).seen).toEqual([agent('a')])
  expect(spawnSightings(1, run('b', 'r1'), autoStateOf(proofOf('a', 'r1'))).seen).toEqual([wfRun('r1')])
})

// ---------------------------------------------------------------- /clear and /resume

/** The order of a live /clear or /resume: the end sees the leaving id, the id changes, the engine resets `$.state`. */
async function leave(t: ReturnType<typeof turnWorld>, to: string, reason: 'clear' | 'resume'): Promise<void> {
  await t.m.end(t.w.ports, reason, 1500)
  t.w.session.id = to
  for (const slot of ['turns', 'items', 'processes', 'repos', 'auto']) t.w.state.delete(slot)
  await t.m.entry(t.w.ports)
}

const slotTrackers = () => [processesTracker(), reposTracker(), auto]

/** A world with the three slot trackers: a process, a repo and an agent named in turn 1, the repo again in turn 3. */
async function lineage() {
  const t = turnWorld({ trackers: slotTrackers, run: sdkGit() })
  await t.m.start(t.w.ports, { cwd: '/work', fromSessionStart: true }) // the auto tracker pins the root, and owns the fact
  await t.start('turn-1', 'start things')
  await t.bash('npm run dev', { toolUseId: 'tu_bg1' }, bg)
  await t.bash('cd /x/sdk && ls')
  await t.spawn('agent-7', 'tu_agent1', SPAWN)
  await drain(t.w)
  await t.end('turn-1')
  await t.idle(2)
  await t.start('turn-3', 'the sdk again')
  await t.bash('cd /x/sdk && ls')
  await drain(t.w)
  await t.end('turn-3')
  return { ...t, ...slotReaders(t) }
}

function slotReaders(t: ReturnType<typeof turnWorld>) {
  const procs = () => (t.w.state.get('processes') ?? []) as unknown as (ProcessRecord & Stamps)[]
  const repoRows = () => (t.w.state.get('repos') ?? []) as unknown as (RepoRecord & Stamps)[]
  const agentRows = () =>
    ((t.w.state.get('auto') as unknown as { agents?: (AgentProof & Stamps)[] } | undefined)?.agents ??
      []) as (AgentProof & Stamps)[]
  const turnsOfRow = async (id: string) => (await t.rows()).find(r => r.id === id)?.turns
  return { procs, repoRows, agentRows, turnsOfRow }
}

const TASK_ID = 'task:butoa45ib'

test('processes, repos and agents keep firstTurn and lastTurn and their pane turns over /clear, and the ordinals go on', async () => {
  const t = await lineage()
  expect(t.procs()).toMatchObject([{ id: TASK_ID, firstTurn: 1, lastTurn: 1 }])
  expect(t.repoRows()).toMatchObject([{ key: SDK_KEY, firstTurn: 1, lastTurn: 3 }])
  expect(t.agentRows()).toMatchObject([{ id: 'agent-7', firstTurn: 1, lastTurn: 1 }])
  await leave(t, 'sess-2', 'clear')
  expect(t.procs()).toMatchObject([{ id: TASK_ID, firstTurn: 1, lastTurn: 1 }])
  expect(t.repoRows()).toMatchObject([{ key: SDK_KEY, firstTurn: 1, lastTurn: 3 }])
  expect(t.agentRows()).toMatchObject([{ id: 'agent-7', firstTurn: 1, lastTurn: 1 }])
  expect(await t.turnsOfRow(TASK_ID)).toEqual({ first: 1, last: 1 })
  expect(await t.turnsOfRow(SDK_ID)).toEqual({ first: 1, last: 3 })
  const text = await t.text('turn 1')
  expect(text).toContain('Turn 1 (earlier session)')
  expect(text).toMatch(/\n {2}new {4}.*npm run dev/)
  expect(text).toMatch(/\n {2}new {4}.*acme\/sdk/)
  expect(t.rec(3).seen.map(e => e.k)).toEqual([SDK_ID])
  // The new session counts on from the ledger: the repo named again is "seen again" in turn 4.
  await t.start('turn-4', 'sdk once more')
  await t.bash('cd /x/sdk && ls')
  await drain(t.w)
  expect(t.repoRows()).toMatchObject([{ key: SDK_KEY, firstTurn: 1, lastTurn: 4 }])
  expect(t.rec(4).seen.map(e => e.k)).toEqual([SDK_ID])
})

test('processes and repos keep their turns over /resume of a stored session, and /track turn still lists them', async () => {
  const first = await lineage()
  await first.m.flushNow()
  const stored = first.w.store.get('v2:s:sess-1')!
  const t = turnWorld({ trackers: slotTrackers, run: sdkGit() })
  const read = slotReaders(t)
  t.w.store.set('v2:s:sess-b', stored)
  await t.m.entry(t.w.ports)
  await leave(t, 'sess-b', 'resume')
  expect(read.procs()).toMatchObject([{ id: TASK_ID, firstTurn: 1, lastTurn: 1 }])
  expect(read.repoRows()).toMatchObject([{ key: SDK_KEY, firstTurn: 1, lastTurn: 3 }])
  expect(await read.turnsOfRow(SDK_ID)).toEqual({ first: 1, last: 3 })
  expect(await read.turnsOfRow(TASK_ID)).toEqual({ first: 1, last: 1 })
  const text = await t.text('turn 1')
  expect(text).toMatch(/\n {2}new {4}.*npm run dev/)
  expect(text).toMatch(/\n {2}new {4}.*acme\/sdk/)
})

test('an agent row belongs to the run: a cold /resume has no proof of it, and /track turn still lists its entry by the raw id', async () => {
  const first = await lineage()
  await first.m.flushNow()
  const stored = first.w.store.get('v2:s:sess-1') as unknown as Record<string, Json>
  expect('auto' in stored).toBe(false) // the auto tracker is not persisted
  const t = turnWorld({ trackers: slotTrackers, run: sdkGit() })
  const read = slotReaders(t)
  t.w.store.set('v2:s:sess-b', stored as unknown as Json)
  await t.m.entry(t.w.ports)
  await leave(t, 'sess-b', 'resume')
  expect(read.agentRows()).toEqual([])
  expect(await t.text('turn 1')).toMatch(/\n {2}new {4}agent ag:agent-7 +created\n/)
})
