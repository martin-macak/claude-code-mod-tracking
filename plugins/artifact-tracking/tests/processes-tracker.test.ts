// The processes tracker on fakePorts, through the LifecycleManager: the events it hears, the rows it keeps, the probe
// it runs and the state it publishes. Each case mirrors the kit test of the same subject in register.test.tsx.
// Plan: L3 Task 8.
import { expect, test } from 'claude-code/testing'
import { LifecycleManager } from '../core/infra/lifecycle'
import type { RowEvent, ToolCallEvent } from '../core/interfaces/events'
import type { ItemsHost, Json } from '../core/interfaces/items'
import type { AgentInfo, RunResult } from '../core/interfaces/ports'
import { processesConfig, processesTracker } from '../trackers/processes'
import { fakeConfig } from './fixtures/config-fs'
import type { ProcessRecord, ProcessUiState } from './fixtures/contracts'
import { IDLE_ITEMS } from './fixtures/items-host'
import {
  AGENT_RESUMED_NOTICE,
  BG_START_ASYNC_AGENT,
  BG_START_MAIN,
  BG_START_SYNC_AGENT,
  BG_START_WORKFLOW_AGENT,
  IDLE_NOTICE,
  MID_TURN_NOTICE,
  MONITOR_EVENT_NOTICE,
  MONITOR_EXPIRY_NOTICE,
  MONITOR_EXPIRY_NOTICE_IDLE,
  MONITOR_START,
  MONITOR_STREAM_ENDED_NOTICE,
  noticeBlock,
  QUEUED_NOTICE,
  SUBAGENT_MONITOR_EXPIRY_NOTICE,
  SUBAGENT_MONITOR_START,
  SUBAGENT_SPAWN,
  WORKFLOW_AGENT_ID,
  WORKFLOW_MONITOR_START,
  WORKFLOW_SPAWN,
} from './fixtures/notices'
import { fakePorts } from './fixtures/ports'

const res = (stdout = '', exitCode = 0, stderr = ''): RunResult => ({ exitCode, stdout, stderr })
const argvIs = (argv: string[], ...head: string[]) => head.every((x, i) => argv[i] === x)

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** `ps -o lstart` text for a moment, in local time. */
function lstart(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getFullYear()}`
}
const CID = `${'c'.repeat(12)}${'0123456789abcdef'.repeat(3)}abcd`

function setup(o: { cwd?: string; agents?: AgentInfo[]; maxRows?: number } = {}) {
  // Engine time starts at the real time: `ps` start times in the cases below are real dates.
  const w = fakePorts({
    now: Date.now(),
    session: { cwd: o.cwd ?? '/work' },
    ...(o.agents ? { agents: o.agents } : {}),
  })
  const host: ItemsHost = {
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
    replay: async () => {},
    tick: async () => {},
    sessionChanged: async () => {},
    dispose: () => {},
    list: async () => [],
    update: async () => false,
    track: async () => {},
    refresh: () => {},
  }
  const trackers = [processesTracker()]
  const m = new LifecycleManager(
    {
      trackers,
      items: host,
      dismiss: () => ({ list: async () => new Set(), add: async () => {} }),
      config: () =>
        fakeConfig({
          specs: trackers,
          ...(o.maxRows !== undefined ? { file: { trackers: { processes: { maxRows: o.maxRows } } } } : {}),
        }),
      paneId: 'track',
    },
    w.ports,
  )
  const rows = () => (w.state.get('processes') ?? []) as unknown as ProcessRecord[]
  const ui = () => m.facts.read('processes.ui') as unknown as ProcessUiState | undefined
  const bash = (command: string, stdout = '', extra: Partial<ToolCallEvent> = {}, result?: unknown) =>
    m.toolCall(w.ports, {
      tool: 'Bash',
      input: { tool: 'Bash', command },
      result: (result ?? { result: { stdout, stderr: '', interrupted: false } }) as Json,
      ...extra,
    })
  const probe = () => m.command(w.ports, { sub: '', args: '', wait: true })
  const refresh = () => m.command(w.ports, { sub: 'refresh', args: '', wait: true })
  const notice = (text: string, extra: Partial<RowEvent> = {}) =>
    m.row(w.ports, { door: 'prompt', origin: 'task-notification', isMeta: false, hasMessage: true, text, ...extra })
  return { w, m, rows, ui, bash, probe, refresh, notice }
}

test('a background Bash task then its notice', async () => {
  const t = setup()
  await t.bash(
    'npm run dev',
    '',
    { toolUseId: 'toolu_bg_1' },
    {
      result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'task-bg-1' },
    },
  )
  expect(t.rows().map(r => [r.name, r.state, r.taskId])).toEqual([['npm run dev', 'running', 'task-bg-1']])
  await t.notice('done', { task: { id: 'task-bg-1', status: 'completed', toolUseId: 'toolu_bg_1' } })
  expect(t.rows()[0]?.state).toBe('completed')
})

test('a text-only notice completes it', async () => {
  const t = setup()
  await t.bash(
    'sleep 90',
    '',
    { toolUseId: 'toolu_1' },
    {
      result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bcsvumhut' },
    },
  )
  await t.notice(
    '<task-notification>\n<task-id>bcsvumhut</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n</task-notification>',
  )
  expect(t.rows()[0]?.state).toBe('completed')
})

test('typed notice text changes nothing', async () => {
  const t = setup()
  await t.bash('sleep 90', '', {}, { result: { stdout: '', stderr: '', backgroundTaskId: 'bcsvumhut' } })
  const typed = '<task-notification><task-id>bcsvumhut</task-id><status>killed</status></task-notification>'
  await t.m.row(t.w.ports, { door: 'prompt', origin: 'composer', isMeta: false, hasMessage: true, text: typed })
  expect(t.rows()[0]?.state).toBe('running')
})

test('a row on a door the tracker did not declare changes nothing', async () => {
  const t = setup()
  await t.bash('sleep 90', '', {}, { result: { stdout: '', stderr: '', backgroundTaskId: 'b1' } })
  await t.m.row(t.w.ports, {
    door: 'response',
    origin: 'task-notification',
    isMeta: false,
    hasMessage: true,
    text: '<task-notification><task-id>b1</task-id><status>completed</status></task-notification>',
  })
  expect(t.rows()[0]?.state).toBe('running')
})

test('docker missing shows docker not installed', async () => {
  const t = setup()
  t.w.run = argv => {
    throw new Error(`ENOENT: ${argv[0]} not found`)
  }
  await t.bash('docker run -d --name api nginx:latest', 'a1b2c3d4e5f6\n')
  await t.probe()
  expect(t.ui()?.dockerIssue).toBe('docker not installed')
})

test('a docker probe error is surfaced', async () => {
  const t = setup()
  await t.bash('docker run -d --name api nginx:latest', 'a1b2c3d4e5f6\n')
  await t.probe()
  expect(t.ui()?.dockerIssue).toContain('unexpected call: docker ps')
  expect(t.rows()[0]?.state).toBe('running') // an error never marks the container exited
})

test('docker run -d after docker info in one Bash call shows the container as up', async () => {
  const t = setup()
  t.w.run = argv =>
    argvIs(argv, 'docker', 'ps', '-a', '--no-trunc') ? res(`${CID}\ttrack-test-sleep\tUp 3 seconds\n`) : undefined
  await t.bash(
    "docker info --format '{{.ServerVersion}}'; docker run -d --name track-test-sleep alpine sleep 1800",
    `29.0.1\nContainerd fff62f14765df376e5fc36f5a8f8e795b5670f61\n${CID}\n`,
  )
  await t.probe()
  expect(t.rows().map(r => [r.name, r.state])).toEqual([['track-test-sleep', 'up']])
})

// A row of a name keeps no id that its latest run did not print (issue #231). The id comes from the tool result of each Bash
// call, and a run whose output went elsewhere makes the row hold none, also when an earlier call gave it an exact one.
test('a second sighting of a named container replaces the exact id of the first, also with none', async () => {
  const OTHER = 'd'.repeat(64)
  const t = setup()
  await t.bash('docker run -d --name api nginx', `${CID}\n`)
  expect(t.rows().map(r => [r.name, r.containerId, r.containerIdExact])).toEqual([['api', CID, true]])
  await t.bash('docker run -d --name api nginx > /dev/null; docker inspect -f "{{.Id}}" web', `${OTHER}\n`)
  expect(t.rows()).toHaveLength(1)
  expect(t.rows()[0]?.name).toBe('api')
  expect('containerId' in (t.rows()[0] as ProcessRecord)).toBe(false)
  expect('containerIdExact' in (t.rows()[0] as ProcessRecord)).toBe(false)
  await t.bash('docker run -d --name api nginx', `${OTHER}\n`)
  expect(t.rows().map(r => [r.name, r.containerId, r.containerIdExact])).toEqual([['api', OTHER, true]])
})

// A run that got no id (issue #231) is found by its `--name` in `docker ps`, not by the id of another container. A run with no id
// and no name is named by its command, so the probe finds no container for it and the row reads `exited` (README, "Container ids").
test('a run that got no id is found by its --name, and an unnamed one reads exited after the probe', async () => {
  const OTHER = 'd'.repeat(64)
  const t = setup()
  t.w.run = argv =>
    argvIs(argv, 'docker', 'ps', '-a', '--no-trunc')
      ? res(`${CID}\tapi\tUp 3 seconds\n${OTHER}\tweb\tUp 1 hour\n`)
      : undefined
  await t.bash('CID=$(docker run -d --name api nginx); docker ps -aq --no-trunc', `${OTHER}\n`)
  await t.bash('CID=$(docker run -d nginx); docker ps -aq --no-trunc', `${OTHER}\n`)
  await t.probe()
  expect(t.rows().map(r => [r.name, r.containerId, r.state])).toEqual([
    ['api', undefined, 'up'], // found by its name, not by the id of web
    ['docker run -d nginx', undefined, 'exited'], // no id and no name: nothing to find
  ])
})

test('docker compose up -d at the end of a compound command shows the project', async () => {
  const t = setup()
  t.w.run = argv =>
    argvIs(argv, 'docker', 'ps', '-a', '--filter', 'label=com.docker.compose.project=track-compose')
      ? res('Up 2 seconds\n')
      : argvIs(argv, 'docker', 'ps')
        ? res('')
        : undefined
  await t.bash(
    "mkdir -p /tmp/tc && printf 'services:\\n  web:\\n    image: nginx\\n' > /tmp/tc/docker-compose.yml && docker compose -p track-compose -f /tmp/tc/docker-compose.yml up -d",
  )
  await t.probe()
  expect(t.rows().map(r => [r.name, r.state])).toEqual([['track-compose', 'up']])
})

test('compose without -p takes my-app from cwdBefore', async () => {
  const t = setup({ cwd: '/elsewhere' })
  await t.bash('docker compose up -d', '', { cwdBefore: '/work/My-App' })
  expect(t.rows().map(r => r.name)).toEqual(['my-app'])
})

test('a live screen with exit 1 stays running', async () => {
  const t = setup()
  t.w.run = argv =>
    argvIs(argv, 'screen', '-ls')
      ? res('There is a screen on:\n\t7611.watch\t(Detached)\n1 Socket in /tmp/.screen.\n', 1)
      : undefined
  await t.bash('cd app && screen -dmS watch npm run watch')
  await t.probe()
  expect(t.rows().map(r => [r.name, r.state])).toEqual([['watch', 'running']])
})

test('a daemon error keeps docker rows and still probes tmux', async () => {
  const t = setup()
  t.w.run = argv =>
    argvIs(argv, 'docker', 'ps')
      ? res('', 1, 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?')
      : argvIs(argv, 'tmux', 'ls')
        ? res('', 1, 'no server running on /private/tmp/tmux-501/default')
        : undefined
  await t.bash('docker run -d --name api nginx; tmux new -d -s dev', `${CID}\n`)
  await t.probe()
  expect(t.ui()?.dockerIssue).toContain('Cannot connect to the Docker daemon')
  expect(Object.fromEntries(t.rows().map(r => [r.name, r.state]))).toEqual({ api: 'running', dev: 'exited' })
})

test('a daemon that stays down does not open the breaker', async () => {
  const t = setup()
  let tmuxUp = true
  t.w.run = argv =>
    argvIs(argv, 'docker', 'ps')
      ? res('', 1, 'Cannot connect to the Docker daemon')
      : argvIs(argv, 'tmux', 'ls')
        ? tmuxUp
          ? res('dev: 1 windows (created Tue)\n')
          : res('', 1, 'no server running on /private/tmp/tmux-501/default')
        : undefined
  await t.bash('docker run -d --name api nginx; tmux new -d -s dev', `${CID}\n`)
  for (let n = 0; n < 4; n++) await t.probe()
  expect(t.ui()?.breaker).toBe('closed')
  tmuxUp = false
  await t.probe()
  expect(t.rows().find(r => r.name === 'dev')?.state).toBe('exited')
})

test('a detached process found by ps -A, then followed by pid; one not found is exited', async () => {
  const t = setup()
  let alive = true
  t.w.run = argv => {
    if (argvIs(argv, 'ps', '-A')) return res(`  4321 ${lstart(Date.now() - 1000)} sleep 100\n`)
    if (argvIs(argv, 'ps', '-p', '4321')) return alive ? res(`${lstart(Date.now() - 1000)} sleep 100\n`) : res('', 1)
    return undefined
  }
  await t.bash('nohup sleep 100 > /dev/null 2>&1 &', '', { toolUseId: 'toolu_d' })
  await t.probe()
  expect(t.rows().map(r => [r.name, r.state, r.pid])).toEqual([['sleep 100', 'running', 4321]])
  alive = false
  await t.probe()
  expect(t.w.calls.some(c => argvIs(c, 'ps', '-p', '4321'))).toBe(true)
  expect(t.rows()[0]?.state).toBe('exited')
  const lost = setup()
  lost.w.run = argv => (argvIs(argv, 'ps', '-A') ? res('    1 Tue Oct 13 08:00:00 2026 /sbin/launchd\n') : undefined)
  await lost.bash('nohup sleep 100 > /dev/null 2>&1 &')
  await lost.probe()
  expect(lost.rows()[0]?.state).toBe('exited')
})

test('a ps -A that fails counts as a probe failure', async () => {
  const t = setup()
  t.w.run = argv => (argvIs(argv, 'ps', '-A') ? res('', 2, 'ps: bad option') : undefined)
  await t.bash('nohup sleep 100 > /dev/null 2>&1 &')
  await t.probe()
  expect(t.rows()[0]?.state).toBe('running')
  expect(t.ui()?.breaker).toBe('closed') // one failure does not open it
})

test('a Monitor row', async () => {
  const t = setup()
  await t.m.toolCall(t.w.ports, {
    tool: 'Monitor',
    input: { tool: 'Monitor' },
    result: { result: { taskId: 'mon-1' } },
    toolUseId: 'toolu_m',
  })
  expect(t.rows().map(r => [r.id, r.kind, r.state, r.toolUseId])).toEqual([
    ['monitor:mon-1', 'monitor', 'running', 'toolu_m'],
  ])
  await t.m.toolCall(t.w.ports, { tool: 'Monitor', input: {}, result: { result: {} } })
  await t.m.toolCall(t.w.ports, { tool: 'Monitor', input: {}, result: null })
  expect(t.rows()).toHaveLength(1) // no task id, no row
})

test('a TaskStop kill', async () => {
  const t = setup()
  await t.bash('sleep 90', '', {}, { result: { stdout: '', stderr: '', backgroundTaskId: 'task-9' } })
  await t.m.toolCall(t.w.ports, { tool: 'TaskStop', input: {}, result: { result: { task_id: 'task-9' } } })
  expect(t.rows()[0]?.state).toBe('killed')
  await t.m.toolCall(t.w.ports, { tool: 'TaskStop', input: {}, result: { result: { task_id: 'nope' } } })
  await t.m.toolCall(t.w.ports, { tool: 'TaskStop', input: {}, result: null })
  expect(t.rows()[0]?.state).toBe('killed')
})

test('three thrown probe errors open the breaker and processes.ui says open; refresh resets it', async () => {
  const t = setup()
  t.w.run = () => {
    throw new Error('spawn failed')
  }
  await t.bash('tmux new -d -s dev')
  for (let n = 0; n < 3; n++) await t.probe()
  expect(t.ui()?.breaker).toBe('open')
  expect(t.ui()?.openUntil).toBeGreaterThan(0)
  const callsBefore = t.w.calls.length
  await t.probe() // open: no probe
  expect(t.ui()?.breaker).toBe('open')
  expect(t.w.calls.length).toBe(callsBefore)
  t.w.run = argv => (argvIs(argv, 'tmux', 'ls') ? res('dev: 1 windows\n') : undefined)
  await t.refresh()
  expect(t.ui()?.breaker).toBe('closed')
  expect(t.rows()[0]?.state).toBe('running')
})

test('a command with another sub does nothing', async () => {
  const t = setup()
  await t.bash('tmux new -d -s dev')
  await t.m.command(t.w.ports, { sub: 'prio', args: 'x high', wait: true })
  expect(t.w.calls).toEqual([])
  expect(t.ui()).toBeUndefined()
})

test('the tick probes through the bus, once per period', async () => {
  const t = setup()
  t.w.run = argv => (argvIs(argv, 'tmux', 'ls') ? res('dev: 1 windows\n') : undefined)
  await t.bash('tmux new -d -s dev')
  await t.w.clock.advance(30000)
  expect(t.w.calls.filter(c => argvIs(c, 'tmux', 'ls'))).toHaveLength(1)
  await t.w.clock.advance(30000)
  expect(t.w.calls.filter(c => argvIs(c, 'tmux', 'ls'))).toHaveLength(2)
})

test('the probe keeps the docker issue while no docker row is probed, and clears it when one is', async () => {
  const t = setup()
  t.w.run = argv => (argvIs(argv, 'docker', 'ps') ? res('', 1, 'daemon down') : undefined)
  await t.bash('docker run -d --name api nginx', `${CID}\n`)
  await t.probe()
  expect(t.ui()?.dockerIssue).toBe('daemon down')
  t.w.state.set('processes', [])
  await t.probe()
  expect(t.ui()?.dockerIssue).toBe('daemon down') // nothing was probed: the last reason stands
  t.w.run = argv => (argvIs(argv, 'docker', 'ps') ? res(`${CID}\tapi\tUp 1 second\n`) : undefined)
  await t.bash('docker run -d --name api nginx', `${CID}\n`)
  await t.probe()
  expect(t.ui()?.dockerIssue).toBeUndefined()
})

test('settle and restore use mergeProcessRows; clear empties the slot', async () => {
  const t = setup()
  const row = (id: string, at: number, state = 'running') => ({
    id,
    kind: 'tmux',
    name: id,
    state,
    firstSeen: at,
    lastSeen: at,
  })
  t.w.state.set('processes', [row('live', 2)] as unknown as Json)
  await t.m.entry(t.w.ports)
  await t.m.end(t.w.ports, 'clear', 1500)
  const stored = t.w.store.get('v2:s:sess-1') as { processes: ProcessRecord[] }
  expect(stored.processes.map(r => r.id)).toEqual(['live'])
  await t.m.clear(t.w.ports)
  expect(t.w.state.get('processes')).toEqual([])
})

const row = (id: string, at: number, state: string) =>
  ({ id, kind: 'tmux', name: id, state, firstSeen: at, lastSeen: at }) as unknown as Json

test('a clear switch carries the leaving rows under the new ones', async () => {
  const t = setup()
  t.w.state.set('processes', [row('a', 1, 'running'), row('b', 2, 'running')] as unknown as Json)
  await t.m.entry(t.w.ports)
  await t.m.end(t.w.ports, 'clear', 1500)
  t.w.session.id = 'sess-2'
  t.w.state.set('processes', [row('a', 5, 'exited')] as unknown as Json)
  await t.m.entry(t.w.ports)
  expect(Object.fromEntries(t.rows().map(r => [r.id, r.state]))).toEqual({ a: 'exited', b: 'running' })
})

test('a resume switch folds the stored rows over the live ones; an empty stored list changes nothing', async () => {
  const t = setup()
  t.w.store.set('v2:s:sess-2', { processes: [row('a', 1, 'running')] })
  await t.m.entry(t.w.ports)
  await t.m.end(t.w.ports, 'resume', 1500)
  t.w.session.id = 'sess-2'
  t.w.state.set('processes', [row('a', 5, 'exited')] as unknown as Json)
  await t.m.entry(t.w.ports)
  expect(t.rows().map(r => r.state)).toEqual(['running'])
  t.w.store.set('v2:s:sess-3', { processes: [] })
  await t.m.end(t.w.ports, 'resume', 1500)
  t.w.session.id = 'sess-3'
  await t.m.entry(t.w.ports)
  expect(t.rows()).toHaveLength(1)
})

// ---------------------------------------------------------------- the cap of the stored rows (#134)

/** An ended row. A higher `i` started and ended later. */
const endedRow = (i: number) =>
  ({
    id: `e${i}`,
    kind: 'tmux',
    name: `e${i}`,
    state: 'completed',
    firstSeen: 10 + i,
    lastSeen: 10 + i,
    endedAt: 1000 + i,
  }) as unknown as Json
const endedRows = (n: number) => Array.from({ length: n }, (_, i) => endedRow(i))
/** The ids `e<from>` to `e<to - 1>`. */
const eIds = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `e${from + i}`)

test('the saved copy keeps the maxRows newest ended rows, and a load brings the same rows back', async () => {
  const t = setup({ maxRows: 20 })
  t.w.state.set('processes', endedRows(25))
  await t.m.entry(t.w.ports)
  await t.m.end(t.w.ports, 'resume', 1500)
  const stored = t.w.store.get('v2:s:sess-1') as { processes: ProcessRecord[] }
  expect(stored.processes.map(r => r.id)).toEqual(eIds(5, 25))
  t.w.session.id = 'sess-2' // another session, then back to the first: the load reads the copy
  t.w.state.set('processes', [])
  await t.m.entry(t.w.ports)
  await t.m.end(t.w.ports, 'resume', 1500)
  t.w.session.id = 'sess-1'
  await t.m.entry(t.w.ports)
  expect(t.rows().map(r => r.id)).toEqual(eIds(5, 25))
})

test('a stored copy that an older build wrote past the cap is cut when it loads', async () => {
  const t = setup({ maxRows: 20 })
  t.w.store.set('v2:s:sess-2', { processes: endedRows(25) })
  await t.m.entry(t.w.ports)
  await t.m.end(t.w.ports, 'resume', 1500)
  t.w.session.id = 'sess-2'
  await t.m.entry(t.w.ports)
  expect(t.rows().map(r => r.id)).toEqual(eIds(5, 25))
})

test('a clear switch cuts the carried rows to the cap too, and a live row stays', async () => {
  const t = setup({ maxRows: 20 })
  t.w.state.set('processes', [...endedRows(24), row('live', 1, 'running')])
  await t.m.entry(t.w.ports)
  await t.m.end(t.w.ports, 'clear', 1500)
  t.w.session.id = 'sess-2'
  t.w.state.set('processes', [])
  await t.m.entry(t.w.ports)
  expect(t.rows().map(r => r.id)).toEqual(['live', ...eIds(5, 24)])
})

test('a Bash row that joins a full slot pushes out the oldest ended row', async () => {
  const t = setup({ maxRows: 20 })
  t.w.state.set('processes', endedRows(20))
  await t.bash('tmux new -d -s dev')
  expect(t.rows().map(r => r.id)).toHaveLength(20)
  expect(t.rows().map(r => r.name)).toContain('dev')
  expect(t.rows().map(r => r.id)).not.toContain('e0')
  expect(t.rows().map(r => r.id)).toContain('e1')
})

test('a Bash row that joins a full slot pushes out the expired rows first: a failed row inside its TTL stays', async () => {
  const t = setup({ maxRows: 20 })
  const at = Date.now()
  const MIN = 60_000
  // `bad` ended 50 minutes ago and has 60. Each `old` row ended 40 minutes ago, after `bad`, and has 30 (the defaults).
  const old = (i: number) =>
    ({ ...(endedRow(i) as object), id: `old${i}`, name: `old${i}`, endedAt: at - 40 * MIN + i }) as unknown as Json
  const bad = { ...(endedRow(99) as object), id: 'bad', name: 'bad', state: 'failed', endedAt: at - 50 * MIN }
  t.w.state.set('processes', [bad as unknown as Json, ...Array.from({ length: 21 }, (_, i) => old(i))])
  await t.bash('tmux new -d -s dev') // 23 rows over a cap of 20: the 3 oldest expired rows go
  expect(t.rows().map(r => r.id)).toHaveLength(20)
  expect(t.rows().map(r => r.id)).toContain('bad')
  expect(t.rows().map(r => r.id)).not.toContain('old0')
  expect(t.rows().map(r => r.id)).not.toContain('old2')
  expect(t.rows().map(r => r.id)).toContain('old3')
})

test('a Monitor row that joins a full slot pushes out the oldest ended row', async () => {
  const t = setup({ maxRows: 20 })
  t.w.state.set('processes', endedRows(20))
  await armMonitor(t)
  expect(t.rows()).toHaveLength(20)
  expect(t.rows().map(r => r.kind)).toContain('monitor')
  expect(t.rows().map(r => r.id)).not.toContain('e0')
})

test('live rows over the cap all stay when a row joins', async () => {
  const t = setup({ maxRows: 20 })
  t.w.state.set('processes', [...Array.from({ length: 22 }, (_, i) => row(`run${i}`, i, 'running')), ...endedRows(3)])
  await t.bash('tmux new -d -s dev')
  expect(t.rows()).toHaveLength(23) // 22 live and the new one: no ended row is left
  expect(t.rows().every(r => r.state === 'running')).toBe(true)
})

test('init keeps one breaker per load: a second init does not close an open breaker', async () => {
  const t = setup()
  t.w.run = () => {
    throw new Error('spawn failed')
  }
  await t.bash('tmux new -d -s dev')
  for (let n = 0; n < 3; n++) await t.probe()
  await t.m.start(t.w.ports, { fromSessionStart: true }) // init again
  await t.probe()
  expect(t.ui()?.breaker).toBe('open')
})

test('config: normalise keeps the defaults for a missing or bad value and warns once per problem', () => {
  const warns: string[] = []
  const warn = (p: string) => void warns.push(p)
  const d = processesConfig.defaults
  expect(processesConfig.normalise({}, d, warn)).toEqual(d)
  expect(warns).toEqual([])
  expect(processesConfig.normalise({ enabled: false, probeTimeoutMs: 2500, extra: 1 }, d, warn)).toEqual({
    ...d,
    enabled: false,
    probeTimeoutMs: 2500,
    extra: 1,
  })
  expect(warns).toEqual(['extra: unknown key. The mod keeps it and ignores it.'])
  // A decimal or a string takes the default. A number out of range takes the nearest bound.
  expect(processesConfig.normalise({ probeTimeoutMs: 2500.4 }, d, warn)).toEqual(d)
  expect(processesConfig.normalise({ probeTimeoutMs: 'slow' }, d, warn)).toEqual(d)
  const bad = processesConfig.normalise({ enabled: 'yes', probeTimeoutMs: 5 }, d, warn)
  expect(bad).toEqual({ ...d, enabled: true, probeTimeoutMs: 1000 })
  expect(processesConfig.normalise({ probeTimeoutMs: 999999 }, d, warn)).toEqual({
    ...d,
    enabled: true,
    probeTimeoutMs: 120000,
  })
  expect(warns).toHaveLength(6)
  expect(d.enabled).toBe(true)
})

// ---------------------------------------------------------------- the end state of a task (#56)
// The rows in tests/fixtures/notices.ts are the ones Claude Code 2.1.304 gave in a headless spike.

const asRow = (r: RowEvent | Readonly<RowEvent>): RowEvent => r as RowEvent
const turnEnd = (t: ReturnType<typeof setup>, agentId?: string, reason = 'answer') =>
  t.m.turnComplete(t.w.ports, { input: { reason, ...(agentId !== undefined ? { agentId } : {}) } as unknown as Json })
const startedBy = (taskId: string, toolUseId: string, agentId?: string) => ({ taskId, toolUseId, agentId })

test('case A: a notice folded into a running turn ends the task of the main loop', async () => {
  const t = setup()
  await t.bash('sleep 20; echo done', '', { toolUseId: 'toolu_0167pQhp2xvXTrduu7Tmndwj' }, BG_START_MAIN)
  expect(t.rows().map(r => [r.taskId, r.state])).toEqual([['butoa45ib', 'running']])
  await t.m.row(t.w.ports, asRow(MID_TURN_NOTICE))
  expect(t.rows().map(r => r.state)).toEqual(['completed'])
})

test('a folded notice sets failed and killed too', async () => {
  for (const status of ['failed', 'killed']) {
    const t = setup()
    await t.bash('make test', '', { toolUseId: 'toolu_0167pQhp2xvXTrduu7Tmndwj' }, BG_START_MAIN)
    const text = MID_TURN_NOTICE.text.replace('<status>completed</status>', `<status>${status}</status>`)
    await t.m.row(t.w.ports, { ...asRow(MID_TURN_NOTICE), text })
    expect(t.rows().map(r => r.state)).toEqual([status])
  }
})

test('the idle notice (door prompt) still ends the task', async () => {
  const t = setup()
  await t.bash(
    'sleep 20; echo done',
    '',
    { toolUseId: 'toolu_01HuNkdPzUZzPDgWgG1j5mcq' },
    { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bk3esczyt' } },
  )
  await t.m.row(t.w.ports, asRow(IDLE_NOTICE))
  expect(t.rows().map(r => r.state)).toEqual(['completed'])
})

test('a notice in the loop of a subagent ends the task of that agent', async () => {
  const s = startedBy('brgzj6uhc', 'toolu_01TtGGwz9hCGHFBUan4gnesV', 'ad428bf287aed5d65')
  // Resumed with the notice as its prompt (door prompt, agent id).
  const resumed = setup()
  await resumed.bash('sleep 15; echo late', '', { toolUseId: s.toolUseId, agentId: s.agentId }, BG_START_ASYNC_AGENT)
  expect(resumed.rows()[0]).toMatchObject({ taskId: s.taskId, agentId: s.agentId, state: 'running' })
  await resumed.m.row(resumed.w.ports, asRow(AGENT_RESUMED_NOTICE))
  expect(resumed.rows().map(r => r.state)).toEqual(['completed'])
  // Folded into the turn of a running agent (door delivery, agent id).
  const folded = setup()
  await folded.bash('sleep 15; echo late', '', { toolUseId: s.toolUseId, agentId: s.agentId }, BG_START_ASYNC_AGENT)
  await folded.m.row(folded.w.ports, { ...asRow(MID_TURN_NOTICE), agentId: s.agentId, text: AGENT_RESUMED_NOTICE.text })
  expect(folded.rows().map(r => r.state)).toEqual(['completed'])
})

test('a notice on another door, or one that a person, a peer or the queue wrote, changes nothing', async () => {
  const t = setup()
  await t.bash('sleep 20; echo done', '', { toolUseId: 'toolu_0167pQhp2xvXTrduu7Tmndwj' }, BG_START_MAIN)
  const same = asRow(MID_TURN_NOTICE)
  // The queue repeats the text with the origin `engine`: it is not a conversation row, so the tracker does not read it.
  await t.m.row(t.w.ports, asRow(QUEUED_NOTICE))
  // A person types the text while a turn runs: the engine folds it in as a delivery of the person.
  await t.m.row(t.w.ports, { ...same, origin: 'composer' })
  // A subagent's report quotes the text: a delivery of a peer.
  await t.m.row(t.w.ports, { ...same, origin: 'peer' })
  // The model prints it: a response.
  await t.m.row(t.w.ports, { ...same, door: 'response', origin: 'model' })
  expect(t.rows().map(r => r.state)).toEqual(['running'])
})

test('a task of a foreground subagent ends as killed when its agent ends', async () => {
  const t = setup()
  const agentId = 'afe82f2c44b349772'
  await t.bash('sleep 15; echo late', '', { toolUseId: 'toolu_s', agentId }, BG_START_SYNC_AGENT)
  expect(t.rows()[0]).toMatchObject({ taskId: 'be2c4m7c3', agentId, endsWithAgent: true, state: 'running' })
  await turnEnd(t, 'another-agent')
  await turnEnd(t) // the main loop's turn
  expect(t.rows()[0]?.state).toBe('running')
  await turnEnd(t, agentId)
  expect(t.rows()[0]?.state).toBe('killed')
})

test('a task of a workflow agent ends as killed when its agent ends', async () => {
  // AC3b of #56. The Bash result is the one a workflow agent got on Claude Code 2.1.304: the engine set the flag, as for
  // a foreground subagent, and no notice followed the agent's answer.
  const t = setup()
  await t.bash(
    'sleep 300',
    '',
    { toolUseId: 'toolu_01YQ9iu5Uow38DqGp6qnCSZ1', agentId: WORKFLOW_AGENT_ID },
    BG_START_WORKFLOW_AGENT,
  )
  expect(t.rows()[0]).toMatchObject({
    taskId: 'byxhckpak',
    agentId: WORKFLOW_AGENT_ID,
    endsWithAgent: true,
    state: 'running',
  })
  await turnEnd(t) // the main loop's turn: the workflow runs on, so the task goes on
  await turnEnd(t, 'another-agent')
  expect(t.rows()[0]?.state).toBe('running')
  await turnEnd(t, WORKFLOW_AGENT_ID)
  expect(t.rows()[0]?.state).toBe('killed')
})

test('every end reason of an agent ends its tasks', async () => {
  for (const reason of ['answer', 'aborted', 'error', 'refusal']) {
    const t = setup()
    await t.bash('sleep 15', '', { toolUseId: 'toolu_s', agentId: 'a1' }, BG_START_SYNC_AGENT)
    await turnEnd(t, 'a1', reason)
    expect(t.rows()[0]?.state).toBe('killed')
  }
})

test('a task of a background subagent survives the end of the agent: its notice comes later', async () => {
  const t = setup()
  await t.bash(
    'sleep 15; echo late',
    '',
    { toolUseId: 'toolu_01TtGGwz9hCGHFBUan4gnesV', agentId: 'ad428bf287aed5d65' },
    BG_START_ASYNC_AGENT,
  )
  await turnEnd(t, 'ad428bf287aed5d65')
  expect(t.rows()[0]?.state).toBe('running')
  await t.m.row(t.w.ports, asRow(AGENT_RESUMED_NOTICE))
  expect(t.rows()[0]?.state).toBe('completed')
})

test('the end of an agent leaves a task that already ended as it is', async () => {
  const t = setup()
  await t.bash('make', '', { toolUseId: 'toolu_s', agentId: 'a1' }, BG_START_SYNC_AGENT)
  await t.m.toolCall(t.w.ports, { tool: 'TaskStop', input: {}, result: { result: { task_id: 'be2c4m7c3' } } })
  expect(t.rows()[0]?.state).toBe('killed')
  await t.m.row(t.w.ports, {
    ...asRow(MID_TURN_NOTICE),
    text: noticeBlock('be2c4m7c3', 'toolu_s', 'completed'),
  })
  expect(t.rows()[0]?.state).toBe('completed')
  await turnEnd(t, 'a1')
  expect(t.rows()[0]?.state).toBe('completed')
})

test('a task of a headless main loop ends with the main loop', async () => {
  const t = setup()
  await t.bash('sleep 15', '', { toolUseId: 'toolu_h' }, BG_START_SYNC_AGENT) // the flag, no agent
  await turnEnd(t, 'a1')
  expect(t.rows()[0]?.state).toBe('running')
  await turnEnd(t)
  expect(t.rows()[0]?.state).toBe('killed')
  // The flag is absent in a session that waits for its tasks: its rows go on.
  const live = setup()
  await live.bash('sleep 15', '', { toolUseId: 'toolu_l' }, BG_START_MAIN)
  await turnEnd(live)
  expect(live.rows()[0]?.state).toBe('running')
})

test('a turn.complete without a usable input changes nothing', async () => {
  const t = setup()
  await t.bash('sleep 15', '', { toolUseId: 'toolu_s', agentId: 'a1' }, BG_START_SYNC_AGENT)
  await t.m.turnComplete(t.w.ports, { input: null })
  await t.m.turnComplete(t.w.ports, { input: { agentId: 7, reason: 'answer' } })
  await t.m.turnComplete(t.w.ports, { input: { agentId: '', reason: 'answer' } })
  expect(t.rows()[0]?.state).toBe('running')
})

// ---------------------------------------------------------------- Monitor rows (#118)
// The notices are in tests/fixtures/notices.ts, from the transcript of a Claude Code 2.1.304 session.

/** Arms a Monitor. The call data is the one of `MONITOR_START`, whose notices carry its tool-use id; `result` names another task. */
const armMonitor = (t: ReturnType<typeof setup>, agentId?: string, result: { taskId: string } = MONITOR_START.result) =>
  t.m.toolCall(t.w.ports, {
    tool: 'Monitor',
    input: { command: 'sleep 1; echo waiting', description: 'no-op', timeout_ms: 1000 },
    result: { result },
    toolUseId: result === MONITOR_START.result ? 'toolu_01CtnZ5oNavyRd3PdEpn78pH' : `toolu_${result.taskId}`,
    ...(agentId !== undefined ? { agentId } : {}),
  })

test('a Monitor row keeps the agent that armed it', async () => {
  const t = setup()
  await armMonitor(t, WORKFLOW_AGENT_ID)
  expect(t.rows()[0]).toMatchObject({ taskId: 'bj0e6042y', kind: 'monitor', agentId: WORKFLOW_AGENT_ID })
  const main = setup()
  await armMonitor(main)
  expect(main.rows()[0]).not.toHaveProperty('agentId') // the main loop has none
})

test('the expiry notice of a Monitor ends its row', async () => {
  // The engine kills a Monitor at its deadline and sends one notice. It has no <status>: before #118 the row stayed running.
  const t = setup()
  await armMonitor(t, WORKFLOW_AGENT_ID)
  expect(t.rows().map(r => r.state)).toEqual(['running'])
  await t.m.row(t.w.ports, asRow(MONITOR_EXPIRY_NOTICE))
  expect(t.rows().map(r => [r.taskId, r.state])).toEqual([['bj0e6042y', 'completed']])
  // The idle session gets the same text on door `prompt`, without the wrapper.
  const idle = setup()
  await armMonitor(idle)
  await idle.m.row(idle.w.ports, asRow(MONITOR_EXPIRY_NOTICE_IDLE))
  expect(idle.rows().map(r => r.state)).toEqual(['completed'])
})

test('the notice of a Monitor whose source ended still ends its row', async () => {
  const t = setup()
  await armMonitor(t, WORKFLOW_AGENT_ID)
  await t.m.row(t.w.ports, asRow(MONITOR_STREAM_ENDED_NOTICE))
  expect(t.rows().map(r => r.state)).toEqual(['completed'])
})

test('an event of a Monitor that goes on leaves its row running', async () => {
  // An event has no <status> either. Only the text of the expiry ends the row.
  const t = setup()
  await armMonitor(t, WORKFLOW_AGENT_ID)
  await t.m.row(t.w.ports, asRow(MONITOR_EVENT_NOTICE))
  expect(t.rows().map(r => r.state)).toEqual(['running'])
})

test('an expiry notice for a task the tracker does not know changes nothing', async () => {
  const t = setup()
  await armMonitor(t, WORKFLOW_AGENT_ID)
  const other = MONITOR_EXPIRY_NOTICE.text.replace('<task-id>bj0e6042y</task-id>', '<task-id>bzzzzzzzz</task-id>')
  await t.m.row(t.w.ports, { ...asRow(MONITOR_EXPIRY_NOTICE), text: other })
  expect(t.rows().map(r => [r.taskId, r.state])).toEqual([['bj0e6042y', 'running']])
})

test('the text of an expiry that a person, a peer or the model wrote changes nothing', async () => {
  const t = setup()
  await armMonitor(t)
  const same = asRow(MONITOR_EXPIRY_NOTICE)
  await t.m.row(t.w.ports, { ...same, origin: 'composer' })
  await t.m.row(t.w.ports, { ...same, origin: 'peer' })
  await t.m.row(t.w.ports, { ...same, door: 'response', origin: 'model' })
  expect(t.rows().map(r => r.state)).toEqual(['running'])
})

const running = (id: string): AgentInfo => ({ id, status: 'running' })
const spawned = (t: ReturnType<typeof setup>, s: { input: unknown; answer: unknown }) =>
  t.m.agentSpawn(t.w.ports, { input: s.input as Json, answer: s.answer as Json })

test('a Monitor of a workflow agent ends as killed when its agent ends: the engine stops it and sends no notice', async () => {
  // The probe: the heartbeat of the Monitor stopped at the agent's turn.complete, and no notice followed.
  const t = setup()
  await spawned(t, WORKFLOW_SPAWN)
  await armMonitor(t, WORKFLOW_SPAWN.answer.agentId, WORKFLOW_MONITOR_START.result)
  expect(t.rows()[0]).toMatchObject({
    kind: 'monitor',
    taskId: 'b3rzu489p',
    agentId: 'a0c9a4ae500c4b290',
    endsWithAgent: true,
    state: 'running',
  })
  await turnEnd(t) // the main loop's turn: the workflow runs on
  await turnEnd(t, 'another-agent')
  expect(t.rows()[0]?.state).toBe('running')
  await turnEnd(t, WORKFLOW_SPAWN.answer.agentId)
  expect(t.rows()[0]?.state).toBe('killed')
})

test('a Monitor of a subagent survives the end of its agent: the engine resumes the agent for the expiry notice', async () => {
  // The probe: the agent answered, the Monitor ran its full 2 min, and its expiry resumed the agent.
  const t = setup({ agents: [running(SUBAGENT_SPAWN.answer.agentId)] }) // the list names a running subagent
  await spawned(t, SUBAGENT_SPAWN)
  await armMonitor(t, SUBAGENT_SPAWN.answer.agentId, SUBAGENT_MONITOR_START.result)
  expect(t.rows()[0]).toMatchObject({ taskId: 'buzl5d17x', agentId: 'a773c79c962984204', state: 'running' })
  expect(t.rows()[0]).not.toHaveProperty('endsWithAgent')
  await turnEnd(t, SUBAGENT_SPAWN.answer.agentId)
  expect(t.rows()[0]?.state).toBe('running')
  await t.m.row(t.w.ports, asRow(SUBAGENT_MONITOR_EXPIRY_NOTICE))
  expect(t.rows()[0]?.state).toBe('completed')
})

test('a Monitor of the main loop, or of a listed agent the tracker did not see start, has no end with an agent', async () => {
  const t = setup({ agents: [running('a-never-spawned')] })
  await armMonitor(t, undefined, { taskId: 'bmain0001' })
  await armMonitor(t, 'a-never-spawned', { taskId: 'bunknown1' })
  await turnEnd(t)
  await turnEnd(t, 'a-never-spawned')
  expect(t.rows().map(r => [r.taskId, r.state])).toEqual([
    ['bmain0001', 'running'],
    ['bunknown1', 'running'],
  ])
  expect(t.rows().some(r => 'endsWithAgent' in r)).toBe(false)
})

test('a spawn the tracker cannot read marks no workflow agent', async () => {
  const t = setup({ agents: [running('a1')] }) // listed, so the list does not make it one either
  await t.m.agentSpawn(t.w.ports, { input: { workflow: { runId: 'wf_x', agentIndex: 1 } }, answer: {} }) // no agent id
  await t.m.agentSpawn(t.w.ports, { input: null, answer: { agentId: 'a1' } })
  await t.m.agentSpawn(t.w.ports, { input: { workflow: 'yes' }, answer: { agentId: 'a1' } }) // `workflow` is no object
  await armMonitor(t, 'a1', { taskId: 'bx' })
  expect(t.rows()[0]).not.toHaveProperty('endsWithAgent')
})

test('after a reload, a Monitor of an agent that the agent list does not name ends with its agent', async () => {
  // A reload resets the module and does not replay `agent.spawn`, so this load never saw the spawn. The engine's list names
  // the subagents and teammates, not a workflow's agents (d.ts 302:3262-3268): an agent it does not name is a workflow's.
  const t = setup({ agents: [running('a-some-subagent')] })
  await armMonitor(t, WORKFLOW_SPAWN.answer.agentId, WORKFLOW_MONITOR_START.result)
  expect(t.rows()[0]).toMatchObject({ endsWithAgent: true, state: 'running' })
  await turnEnd(t, 'a-some-subagent')
  expect(t.rows()[0]?.state).toBe('running')
  await turnEnd(t, WORKFLOW_SPAWN.answer.agentId)
  expect(t.rows()[0]?.state).toBe('killed')
})

test('an agent list that cannot be read gives a Monitor no end with its agent', async () => {
  const t = setup()
  Object.assign(t.w.ports.agents, {
    list: async () => {
      throw new Error('the list is not there')
    },
  })
  await armMonitor(t, WORKFLOW_SPAWN.answer.agentId, WORKFLOW_MONITOR_START.result)
  expect(t.rows()[0]).not.toHaveProperty('endsWithAgent')
  await turnEnd(t, WORKFLOW_SPAWN.answer.agentId)
  expect(t.rows()[0]?.state).toBe('running')
})

test('the workflow agents are kept per load: a spawn on one load flags no Monitor of another', async () => {
  // As the breaker is per load (see "init keeps one breaker per load"): a Set shared by every load passes the other tests.
  const first = setup()
  const second = setup({ agents: [running(WORKFLOW_SPAWN.answer.agentId)] }) // the list names it: only a shared Set could flag it
  await spawned(first, WORKFLOW_SPAWN)
  await armMonitor(second, WORKFLOW_SPAWN.answer.agentId, WORKFLOW_MONITOR_START.result) // same agent id, never spawned here
  expect(second.rows()[0]).not.toHaveProperty('endsWithAgent')
  await turnEnd(second, WORKFLOW_SPAWN.answer.agentId)
  expect(second.rows()[0]?.state).toBe('running')
  await armMonitor(first, WORKFLOW_SPAWN.answer.agentId, WORKFLOW_MONITOR_START.result) // the load that saw the spawn
  expect(first.rows()[0]).toMatchObject({ endsWithAgent: true })
})

test('case C: a detached process whose command names a variable is found and stays running', async () => {
  const t = setup()
  let alive = true
  t.w.run = argv => {
    if (argvIs(argv, 'ps', '-A')) return res(`  4321 ${lstart(Date.now() - 1000)} node /work/srv.mjs\n`)
    if (argvIs(argv, 'ps', '-p', '4321'))
      return alive ? res(`${lstart(Date.now() - 1000)} node /work/srv.mjs\n`) : res('', 1)
    return undefined
  }
  await t.bash('F=$PWD/srv.mjs; (nohup node $F > srv.log 2>&1 &); sleep 1', '', { cwdBefore: '/work' })
  expect(t.rows().map(r => r.name)).toEqual(['node /work/srv.mjs']) // not `node $F`
  await t.probe()
  expect(t.rows().map(r => [r.state, r.pid])).toEqual([['running', 4321]])
  await t.probe()
  expect(t.rows()[0]?.state).toBe('running')
  alive = false
  await t.probe()
  expect(t.rows()[0]?.state).toBe('exited')
})

test('a variable the command does not set: the process is found by the rest of its command, else unknown', async () => {
  const t = setup()
  let ps = '    1 Tue Oct 13 08:00:00 2026 /sbin/launchd\n'
  t.w.run = argv => {
    if (argvIs(argv, 'ps', '-A')) return res(ps)
    if (argvIs(argv, 'ps', '-p', '4400')) return res(`${lstart(Date.now() - 1000)} node /srv/real/app.mjs --port 80\n`)
    return undefined
  }
  await t.bash('node $APP_DIR/app.mjs --port 80 > /dev/null 2>&1 &')
  expect(t.rows().map(r => r.name)).toEqual(['node $APP_DIR/app.mjs --port 80'])
  await t.probe()
  expect(t.rows().map(r => [r.state, r.pid])).toEqual([['unknown', undefined]]) // never `exited`: the command is opaque
  ps = `    1 Tue Oct 13 08:00:00 2026 /sbin/launchd\n 4400 ${lstart(Date.now() - 1000)} node /srv/real/app.mjs --port 80\n`
  await t.probe()
  expect(t.rows().map(r => [r.state, r.pid])).toEqual([['running', 4400]])
  await t.probe() // followed by pid: the stored fingerprint still names the variable
  expect(t.rows()[0]?.state).toBe('running')
})

test('a variable the mod cannot read: another process of the same program is not taken for it', async () => {
  // The row keeps `node $F`: the command sets no `F`. That fingerprint alone would fit this unrelated dev server, so the
  // row must show `unknown`, not `running` with its pid (#56 review, m1).
  const t = setup()
  t.w.run = argv =>
    argvIs(argv, 'ps', '-A') ? res(`  77 ${lstart(Date.now() - 1000)} node /other/project/dev-server.js\n`) : undefined
  await t.bash('node $F > /dev/null 2>&1 &')
  await t.probe()
  expect(t.rows().map(r => [r.state, r.pid])).toEqual([['unknown', undefined]])
  // A fingerprint with a literal part still finds its process.
  const found = setup()
  found.w.run = argv =>
    argvIs(argv, 'ps', '-A') ? res(`  77 ${lstart(Date.now() - 1000)} node /tmp/run-1/s.js\n`) : undefined
  await found.bash('D=/tmp/run-$(date +%s); node $D/s.js > /dev/null 2>&1 &')
  expect(found.rows().map(r => r.name)).toEqual(['node $D/s.js']) // not `node /tmp/run-/s.js`
  await found.probe()
  expect(found.rows().map(r => [r.state, r.pid])).toEqual([['running', 77]])
})

test('a detached process with echo $! and a variable it does not know is not marked exited', async () => {
  const t = setup()
  t.w.run = argv =>
    argvIs(argv, 'ps', '-p', '4500') ? res(`${lstart(Date.now() - 1000)} node /srv/real/app.mjs\n`) : undefined
  await t.bash('nohup node $APP > /dev/null 2>&1 & echo $!', '4500\n')
  await t.probe()
  expect(t.rows().map(r => [r.id, r.state])).toEqual([['pid:4500', 'running']])
})

// ---------------------------------------------------------------- endedAt (issue #49)

test('a row gets endedAt when its notice ends it, and not before', async () => {
  const t = setup()
  await t.bash(
    'sleep 90',
    '',
    { toolUseId: 'toolu_e' },
    { result: { stdout: '', stderr: '', backgroundTaskId: 'b-e' } },
  )
  expect('endedAt' in (t.rows()[0] as ProcessRecord)).toBe(false)
  t.w.clock.now += 5000
  const at = t.w.clock.now
  await t.notice('x', { task: { id: 'b-e', status: 'completed', toolUseId: 'toolu_e' } })
  expect(t.rows()[0]).toMatchObject({ state: 'completed', endedAt: at, lastSeen: at })
})

test('a TaskStop sets endedAt, and a later notice keeps the first one', async () => {
  const t = setup()
  await t.bash('make', '', { toolUseId: 'toolu_s', agentId: 'a1' }, BG_START_SYNC_AGENT)
  t.w.clock.now += 1000
  const first = t.w.clock.now
  await t.m.toolCall(t.w.ports, { tool: 'TaskStop', input: {}, result: { result: { task_id: 'be2c4m7c3' } } })
  expect(t.rows()[0]).toMatchObject({ state: 'killed', endedAt: first })
  t.w.clock.now += 9000
  await t.m.row(t.w.ports, { ...asRow(MID_TURN_NOTICE), text: noticeBlock('be2c4m7c3', 'toolu_s', 'completed') })
  expect(t.rows()[0]).toMatchObject({ state: 'completed', endedAt: first })
})

test('the end of an agent sets endedAt on the tasks it kills', async () => {
  const t = setup()
  await t.bash('make', '', { toolUseId: 'toolu_s', agentId: 'a1' }, BG_START_SYNC_AGENT)
  t.w.clock.now += 2000
  const at = t.w.clock.now
  await turnEnd(t, 'a1')
  expect(t.rows()[0]).toMatchObject({ state: 'killed', endedAt: at })
})

test('the probe sets endedAt when it finds a process gone, and drops it when the process is found again', async () => {
  const t = setup()
  let alive = true
  t.w.run = argv => {
    if (argvIs(argv, 'ps', '-A')) return res(`  4321 ${lstart(Date.now() - 1000)} sleep 100\n`)
    if (argvIs(argv, 'ps', '-p', '4321')) return alive ? res(`${lstart(Date.now() - 1000)} sleep 100\n`) : res('', 1)
    return undefined
  }
  await t.bash('nohup sleep 100 > /dev/null 2>&1 &', '', { toolUseId: 'toolu_d' })
  await t.probe()
  expect('endedAt' in (t.rows()[0] as ProcessRecord)).toBe(false)
  alive = false
  t.w.clock.now += 7000
  const gone = t.w.clock.now
  await t.probe()
  expect(t.rows()[0]).toMatchObject({ state: 'exited', endedAt: gone })
  t.w.clock.now += 7000
  await t.probe() // still gone: the first time stays
  expect(t.rows()[0]?.endedAt).toBe(gone)
  alive = true
  await t.probe()
  expect(t.rows()[0]?.state).toBe('running')
  expect('endedAt' in (t.rows()[0] as ProcessRecord)).toBe(false)
})

test('a probe that changes nothing writes nothing, ended rows included', async () => {
  const t = setup()
  t.w.state.set('processes', [
    { id: 'gone', kind: 'tmux', name: 'gone', state: 'exited', firstSeen: 1, lastSeen: 1, endedAt: 1 },
  ] as unknown as Json)
  t.w.run = argv => (argvIs(argv, 'tmux', 'ls') ? res('', 1) : undefined)
  await t.probe()
  t.w.stateSets = {}
  await t.probe()
  expect(t.w.stateSets.processes).toBeUndefined()
})

// ---------------------------------------------------------------- endedAt through settle and restore (issue #49)
// Which copy wins decides the time: `settle` and `restore('carry')` put the live copy on the added side, so a live row
// clears the stored time. `restore('load')` puts the stored copy there, so the stored state and its time stay together.

const ended = (id: string, state: string, endedAt?: number) =>
  ({
    id,
    kind: 'tmux',
    name: id,
    state,
    firstSeen: 1,
    lastSeen: 1,
    ...(endedAt !== undefined ? { endedAt } : {}),
  }) as unknown as Json
const storedRows = (t: ReturnType<typeof setup>, session = 'sess-1') =>
  (t.w.store.get(`v2:s:${session}`) as { processes: ProcessRecord[] }).processes

test('settle: a live copy over a stored ended copy gives a row with no endedAt', async () => {
  const t = setup()
  t.w.store.set('v2:s:sess-1', { processes: [ended('a', 'completed', 100)] })
  t.w.state.set('processes', [ended('a', 'running')] as unknown as Json)
  await t.m.entry(t.w.ports)
  await t.m.end(t.w.ports, 'clear', 1500)
  expect(storedRows(t)[0]).toMatchObject({ id: 'a', state: 'running' })
  expect('endedAt' in (storedRows(t)[0] as ProcessRecord)).toBe(false)
})

test("restore('carry'): a live copy over a leaving ended copy gives a row with no endedAt", async () => {
  const t = setup()
  t.w.state.set('processes', [ended('a', 'completed', 100)] as unknown as Json)
  await t.m.entry(t.w.ports)
  await t.m.end(t.w.ports, 'clear', 1500)
  t.w.session.id = 'sess-2'
  t.w.state.set('processes', [ended('a', 'running')] as unknown as Json)
  await t.m.entry(t.w.ports)
  expect(t.rows()[0]).toMatchObject({ id: 'a', state: 'running' })
  expect('endedAt' in (t.rows()[0] as ProcessRecord)).toBe(false)
})

test("restore('load'): the stored ended copy wins over a live one, and its endedAt stays with its state", async () => {
  const t = setup()
  t.w.store.set('v2:s:sess-2', { processes: [ended('a', 'completed', 100)] })
  await t.m.entry(t.w.ports)
  await t.m.end(t.w.ports, 'resume', 1500)
  t.w.session.id = 'sess-2'
  t.w.state.set('processes', [ended('a', 'running')] as unknown as Json)
  await t.m.entry(t.w.ports)
  expect(t.rows()[0]).toMatchObject({ id: 'a', state: 'completed', endedAt: 100 })
})

test("restore('load') over an empty slot keeps the stored endedAt", async () => {
  const t = setup()
  t.w.store.set('v2:s:sess-2', { processes: [ended('a', 'exited', 100)] })
  await t.m.entry(t.w.ports)
  await t.m.end(t.w.ports, 'resume', 1500)
  t.w.session.id = 'sess-2'
  await t.m.entry(t.w.ports)
  expect(t.rows()[0]).toMatchObject({ id: 'a', state: 'exited', endedAt: 100 })
})

// The container id and its mark go through the store with the row (issue #231). `restore('load')` puts the stored copy on the
// added side, so it decides the id and the mark: a copy of an older build, with no mark, takes the mark off a live row.
const exactRow = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    kind: 'docker-container',
    name: id,
    state: 'running',
    firstSeen: 1,
    lastSeen: 1,
    containerId: CID,
    containerIdExact: true,
    ...extra,
  }) as unknown as Json

test("restore('load'): a stored row comes back with its container id and its mark", async () => {
  const t = setup()
  t.w.store.set('v2:s:sess-2', { processes: [exactRow('docker:ctr:api')] })
  await t.m.entry(t.w.ports)
  await t.m.end(t.w.ports, 'resume', 1500)
  t.w.session.id = 'sess-2'
  await t.m.entry(t.w.ports)
  expect(t.rows().map(r => [r.id, r.containerId, r.containerIdExact])).toEqual([['docker:ctr:api', CID, true]])
})

test('settle: a row that holds an exact container id stores the id and the mark', async () => {
  const t = setup()
  t.w.state.set('processes', [exactRow('docker:ctr:api')] as unknown as Json)
  await t.m.entry(t.w.ports)
  await t.m.end(t.w.ports, 'clear', 1500)
  expect(storedRows(t).map(r => [r.id, r.containerId, r.containerIdExact])).toEqual([['docker:ctr:api', CID, true]])
})

test("restore('load'): a stored copy with no mark takes the mark off a live exact row, as the stored state wins", async () => {
  const t = setup()
  const noMark = exactRow('docker:ctr:api') as unknown as Record<string, unknown>
  delete noMark.containerIdExact
  t.w.store.set('v2:s:sess-2', { processes: [noMark as unknown as Json] })
  await t.m.entry(t.w.ports)
  await t.m.end(t.w.ports, 'resume', 1500)
  t.w.session.id = 'sess-2'
  t.w.state.set('processes', [exactRow('docker:ctr:api')] as unknown as Json)
  await t.m.entry(t.w.ports)
  expect(t.rows()[0]?.containerId).toBe(CID)
  expect('containerIdExact' in (t.rows()[0] as ProcessRecord)).toBe(false)
})

test('settle and restore stamp an ended row that has no endedAt with the engine clock, not with Date.now()', async () => {
  const t = setup()
  t.w.clock.now = 5_000_000
  t.w.state.set('processes', [ended('old', 'completed')] as unknown as Json)
  await t.m.entry(t.w.ports)
  await t.m.end(t.w.ports, 'clear', 1500)
  expect(storedRows(t)[0]).toMatchObject({ id: 'old', endedAt: 5_000_000 })
  t.w.clock.now = 6_000_000
  t.w.session.id = 'sess-2'
  t.w.state.set('processes', [ended('new', 'unknown')] as unknown as Json)
  await t.m.entry(t.w.ports) // restore('carry'): the leaving row 'old' joins the live one
  expect(Object.fromEntries(t.rows().map(r => [r.id, r.endedAt]))).toMatchObject({ old: 5_000_000, new: 6_000_000 })
})
