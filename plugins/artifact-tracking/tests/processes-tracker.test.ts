// The processes tracker on fakePorts, through the LifecycleManager: the events it hears, the rows it keeps, the probe
// it runs and the state it publishes. Each case mirrors the kit test of the same subject in register.test.tsx.
// Plan: L3 Task 8.
import { expect, test } from 'claude-code/testing'
import { LifecycleManager } from '../core/infra/lifecycle'
import type { RowEvent, ToolCallEvent } from '../core/interfaces/events'
import type { ItemsHost, Json } from '../core/interfaces/items'
import type { RunResult } from '../core/interfaces/ports'
import { GLOBAL_DEFAULTS } from '../core/lib/global-config'
import type { ProcessRecord, ProcessUiState } from '../hooks/contracts'
import { processesConfig, processesTracker } from '../trackers/processes'
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

function setup(o: { cwd?: string } = {}) {
  // Engine time starts at the real time: `ps` start times in the cases below are real dates.
  const w = fakePorts({ now: Date.now(), session: { cwd: o.cwd ?? '/work' } })
  const host: ItemsHost = {
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
  const m = new LifecycleManager(
    {
      trackers: [processesTracker()],
      items: host,
      dismiss: () => ({ list: async () => new Set(), add: async () => {} }),
      global: GLOBAL_DEFAULTS,
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
    enabled: false,
    probeTimeoutMs: 2500,
    extra: 1,
  })
  expect(warns).toEqual(['extra: unknown key. The mod keeps it and ignores it.'])
  // A decimal or a string takes the default. A number out of range takes the nearest bound.
  expect(processesConfig.normalise({ probeTimeoutMs: 2500.4 }, d, warn)).toEqual(d)
  expect(processesConfig.normalise({ probeTimeoutMs: 'slow' }, d, warn)).toEqual(d)
  const bad = processesConfig.normalise({ enabled: 'yes', probeTimeoutMs: 5 }, d, warn)
  expect(bad).toEqual({ enabled: true, probeTimeoutMs: 1000 })
  expect(processesConfig.normalise({ probeTimeoutMs: 999999 }, d, warn)).toEqual({
    enabled: true,
    probeTimeoutMs: 120000,
  })
  expect(warns).toHaveLength(6)
  expect(d.enabled).toBe(true)
})
