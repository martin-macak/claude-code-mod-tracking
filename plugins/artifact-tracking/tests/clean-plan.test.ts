// The plan of `/track clean` as lines, through the real LifecycleManager and the PaneHost contract (issue #199). The pane key of
// issue #199 reads `PaneHost.cleanPlan`. It must give the lines that `/track clean` prints, check the config file first as the
// command does, start the manager itself, and never apply: no step handed to a tracker, no slot write, no store write, no
// process, and the `hidden` atom as it was. The words of the lines run in tests/clean-text.test.ts, the order of the calls of
// the router in tests/commands.test.ts. The proof runs over stub trackers and over the real processes tracker on a fake task
// port, so no real task or worktree is touched.
import { expect, test } from 'claude-code/testing'
import { ConfigManager } from '../core/infra/config-manager'
import type { CleanStep, PlanLine } from '../core/interfaces/clean'
import type { Tracker } from '../core/interfaces/tracker'
import type { PaneHost } from '../hooks/pane-text'
import { processesTracker } from '../trackers/processes'
import { fakeConfig, fakeConfigFs } from './fixtures/config-fs'
import type { ProcessRecord } from './fixtures/contracts'
import { managerWorld } from './fixtures/manager'

const NOW = 1_000_000
const CONFIG_PATH = '/h/.config/claude-code/mods/tracker/config.json'

const task = (id: string, f: Partial<CleanStep> = {}): CleanStep => ({
  kind: 'tasks',
  id,
  label: `run ${id}`,
  action: 'stop',
  ...f,
})
const tree = (id: string, f: Partial<CleanStep> = {}): CleanStep => ({
  kind: 'worktrees',
  id,
  label: id,
  action: 'remove-record',
  ...f,
})

/** A tracker that plans `steps()` (or throws) and writes each step it is asked to apply to `applied`. */
function stub(id: string, order: number, steps: () => CleanStep[], applied: CleanStep[] = []): Tracker {
  return {
    id,
    order,
    config: { defaults: { enabled: true }, normalise: (raw, defaults) => ({ ...defaults, ...(raw as object) }) },
    init: () => {},
    store: ctx => ctx.config.slice(),
    cleanup: {
      plan: () => steps(),
      apply: async (_ctx, got) => {
        applied.push(...got)
        return got.map(s => ({ id: s.id, outcome: 'done' }))
      },
    },
  }
}

function world(trackers: Tracker[]) {
  const w = managerWorld({ trackers: () => trackers, fake: { now: NOW }, config: specs => fakeConfig({ specs }) })
  const host: PaneHost = w.m // the manager fits the contract: a change of either side breaks the compile here
  return { ...w, host }
}

/** The plan of a host that started: it gives a plan whenever the item host is ready. */
async function planOf(host: PaneHost, ports: Parameters<PaneHost['cleanPlan']>[0]): Promise<readonly PlanLine[]> {
  const lines = await host.cleanPlan(ports)
  if (lines === undefined) throw new Error('the host gave no plan')
  return lines
}

test('PaneHost.cleanPlan gives the lines that /track clean prints, in the order of the trackers', async () => {
  const a = stub('a', 1, () => [task('task:1'), tree('wt:/x')])
  const b = stub('b', 2, () => [task('task:2', { skip: 'no task id' })])
  const t = world([b, a])
  const lines = await planOf(t.host, t.w.ports)
  expect(lines.filter(l => l.role === 'step').map(l => l.text)).toEqual([
    '  run task:1: stop',
    '  run task:2: skipped: no task id',
    '  wt:/x: remove record',
  ])
  expect(lines.map(l => l.text).join('\n')).toBe((await t.m.track(t.w.ports, 'clean')).text)
})

test('a tracker whose plan throws is a problem line, and the steps of the others stay', async () => {
  const bad = stub('bad', 1, () => {
    throw new Error('boom')
  })
  const good = stub('good', 2, () => [task('task:1')])
  const t = world([bad, good])
  const lines = await planOf(t.host, t.w.ports)
  expect(lines.filter(l => l.role === 'problem').map(l => l.text)).toEqual(['  bad: plan failed: boom'])
  expect(lines.filter(l => l.role === 'step').map(l => l.text)).toEqual(['  run task:1: stop'])
})

test('with nothing to clean the plan is the empty plan, not an error', async () => {
  const t = world([stub('a', 1, () => [])])
  const lines = await planOf(t.host, t.w.ports)
  expect(lines.map(l => l.role)).toEqual(['title', 'blank', 'head', 'blank', 'hint', 'hint'])
  expect(lines[2]?.text).toBe('Nothing to stop or remove.')
})

test('cleanPlan starts the manager itself: it needs no call of the pane before it', async () => {
  const t = world([stub('a', 1, () => [task('task:1')])])
  // No ensureStarted, no `/track`: the first hook of a load may be the press of a pane key.
  expect(t.m.items.ready).toBe(false)
  const lines = await planOf(t.host, t.w.ports)
  expect(t.m.items.ready).toBe(true) // the entry ran the start sequence
  expect(lines.filter(l => l.role === 'step').map(l => l.text)).toEqual(['  run task:1: stop'])
})

test('cleanPlan gives no plan when the item host did not start, and reads no tracker', async () => {
  let planned = 0
  const t = world([
    stub('a', 1, () => {
      planned++
      return [task('task:1')]
    }),
  ])
  await t.m.ensureStarted(t.w.ports)
  // A start that failed leaves the flag false, and `/track` answers `not ready`. The guard belongs to the callee, so the pane has none.
  Object.defineProperty(t.m.items, 'ready', { get: () => false })
  expect(await t.host.cleanPlan(t.w.ports)).toBeUndefined()
  expect(planned).toBe(0)
  expect((await t.m.track(t.w.ports, 'clean')).text).toBe('artifact-tracking: not ready.') // the command says the same
})

test('cleanPlan makes the whole entry: the session check runs, not only the start', async () => {
  const t = world([stub('a', 1, () => [task('task:1')])])
  await t.m.ensureStarted(t.w.ports)
  const id = t.w.ports.session.id
  let reads = 0
  t.w.ports.session.id = async () => {
    reads += 1
    return id()
  }
  await t.host.cleanPlan(t.w.ports) // a plan read right after a /clear must not read the old session
  expect(reads).toBeGreaterThan(0)
})

test('cleanPlan never applies: no step to a tracker, no slot or store write, no process, and hidden.before stays', async () => {
  const applied: CleanStep[] = []
  const t = world([stub('a', 1, () => [task('task:1'), tree('wt:/x')], applied)])
  await t.m.ensureStarted(t.w.ports)
  await t.m.track(t.w.ports, 'clean --hide')
  expect(t.w.state.get('hidden')).toEqual({ showAll: false, before: NOW })
  const before = { sets: { ...t.w.stateSets }, store: t.w.storeSets, calls: t.w.calls.length, stops: t.w.stops.length }
  await t.host.cleanPlan(t.w.ports)
  await t.host.cleanPlan(t.w.ports)
  expect(applied).toEqual([])
  expect(t.w.stateSets).toEqual(before.sets)
  expect(t.w.storeSets).toBe(before.store)
  expect(t.w.calls).toHaveLength(before.calls)
  expect(t.w.stops).toHaveLength(before.stops)
  expect(t.w.state.get('hidden')).toEqual({ showAll: false, before: NOW })
  expect(t.w.store.has('v2:log')).toBe(false)
})

// The stub trackers above only count what is handed to `apply`. The real processes tracker is the one that stops a task (a
// `TaskStop` through `ports.tasks`), so a plan over it proves that no process is touched and no running row changes.
test('cleanPlan over the real processes tracker plans the stop of a running task and never stops it', async () => {
  const t = world([processesTracker()])
  await t.m.ensureStarted(t.w.ports)
  await t.call(
    'Bash',
    { command: 'sleep 300' },
    { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'task-bg-1' } },
    { toolUseId: 'toolu_bg_1' },
  )
  const rows = () => (t.w.state.get('processes') ?? []) as unknown as ProcessRecord[]
  expect(rows().map(r => [r.state, r.taskId])).toEqual([['running', 'task-bg-1']])
  const before = { sets: { ...t.w.stateSets }, store: t.w.storeSets, calls: t.w.calls.length, stops: t.w.stops.length }
  const first = await planOf(t.host, t.w.ports)
  const second = await planOf(t.host, t.w.ports)
  expect(first.filter(l => l.role === 'step').map(l => l.text)).toEqual(['  sleep 300: stop']) // the plan does see the task
  expect(second).toEqual(first)
  expect(t.w.stops).toHaveLength(before.stops) // no TaskStop
  expect(t.w.calls).toHaveLength(before.calls) // no process
  expect(rows().map(r => r.state)).toEqual(['running']) // the row is not killed
  expect(t.w.stateSets).toEqual(before.sets)
  expect(t.w.storeSets).toBe(before.store)
  expect(t.w.store.has('v2:log')).toBe(false)
})

// Issue #123: a plan reads a switch of its tracker, and the tick reads the file only every 30 s. The pane key must see an
// edit made just before the press, as `/track clean` does. Here the real ConfigManager reads a fake file.
test('cleanPlan checks the config file first: an edit of a switch just before the call shows in the plan', async () => {
  const file = fakeConfigFs()
  const env = { get: async (name: string) => (name === 'HOME' ? '/h' : undefined) }
  const gated: Tracker = {
    ...stub('gated', 1, () => []),
    config: {
      defaults: { enabled: true, on: false },
      normalise: (raw, defaults) => ({ ...defaults, ...(raw as object) }),
    },
    cleanup: {
      plan: ctx => [tree('wt:/x', ctx.config.slice().on === true ? {} : { skip: 'not enabled' })],
      apply: async () => [],
    },
  }
  const w = managerWorld({
    trackers: () => [gated],
    fake: { now: NOW },
    config: specs => new ConfigManager({ fs: file.fs, env: env as never, specs, log: () => {} }),
  })
  const host: PaneHost = w.m
  await w.m.ensureStarted(w.w.ports)
  const before = { sets: { ...w.w.stateSets }, store: w.w.storeSets, calls: w.w.calls.length, stops: w.w.stops.length }
  const steps = async () => (await planOf(host, w.w.ports)).filter(l => l.role === 'step').map(l => l.text)
  expect(await steps()).toEqual(['  wt:/x: skipped: not enabled'])
  file.edit(CONFIG_PATH, JSON.stringify({ trackers: { gated: { on: true } } }))
  expect(await steps()).toEqual(['  wt:/x: remove record'])
  file.edit(CONFIG_PATH, JSON.stringify({ trackers: { gated: { on: false } } }))
  expect(await steps()).toEqual(['  wt:/x: skipped: not enabled'])
  // The one path where `refreshConfig` does real work (a changed file) stays read-only too.
  expect(w.w.stateSets).toEqual(before.sets)
  expect(w.w.storeSets).toBe(before.store)
  expect(w.w.calls).toHaveLength(before.calls)
  expect(w.w.stops).toHaveLength(before.stops)
})
