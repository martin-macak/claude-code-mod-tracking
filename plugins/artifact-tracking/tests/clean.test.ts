// `/track clean` through the router and the Cleaner (issue #122): the dry run, `--hide`, `--yes <kind>` and `--log`, over
// stub trackers that plan and apply, so the rules of core show without a real task or a real worktree. The real planners
// have their own tests (clean-tasks.test.ts, clean-worktrees.test.ts).
import { expect, test } from 'claude-code/testing'
import { CORE_HINT, CORE_SUBS, USAGE } from '../core/infra/command-text'
import { ConfigManager } from '../core/infra/config-manager'
import type { CleanResult, CleanStep } from '../core/interfaces/clean'
import type { Tracker } from '../core/interfaces/tracker'
import { CLEAN_USAGE } from '../core/lib/clean-text'
import { fakeConfig, fakeConfigFs } from './fixtures/config-fs'
import { logKeys, storedLog } from './fixtures/log'
import { managerWorld } from './fixtures/manager'

const NOW = 1_000_000

const task = (id: string, f: Partial<CleanStep> = {}): CleanStep => ({
  kind: 'tasks',
  id,
  label: `run ${id} --secret`,
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

type Stub = {
  plans: () => CleanStep[]
  /** The steps `apply` got, one list per call. */
  applied: CleanStep[][]
  answer?: (steps: readonly CleanStep[]) => readonly CleanResult[] | Promise<readonly CleanResult[]>
  /** The `ctx.tasks` the apply saw: present or not. */
  tasks: boolean[]
}

/** A tracker that plans `plans()` and records what it is asked to apply. By default every step is `done`. */
function stub(id: string, order: number, s: Partial<Stub> & { stops?: true } = {}): { t: Tracker; s: Stub } {
  const state: Stub = { plans: () => [], applied: [], tasks: [], ...s }
  const t: Tracker = {
    id,
    order,
    config: { defaults: { enabled: true }, normalise: (raw, defaults) => ({ ...defaults, ...(raw as object) }) },
    init: () => {},
    store: ctx => ctx.config.slice(),
    ...(s.stops ? { stopsTasks: true as const } : {}),
    cleanup: {
      plan: () => state.plans(),
      apply: async (ctx, steps) => {
        state.applied.push([...steps])
        state.tasks.push(ctx.tasks !== undefined)
        return state.answer ? state.answer(steps) : steps.map(x => ({ id: x.id, outcome: 'done' }))
      },
    },
  }
  return { t, s: state }
}

function world(trackers: Tracker[], file = {}) {
  const w = managerWorld({
    trackers: () => trackers,
    fake: { now: NOW },
    config: specs => fakeConfig({ specs, file }),
  })
  const run = (args: string) => w.m.track(w.w.ports, args)
  const log = () => storedLog(w.w.store)
  return { ...w, run, log }
}

// ---------------------------------------------------------------- the words

test('clean is a core sub-command, in the usage line and in the hint', () => {
  expect(CORE_SUBS.has('clean')).toBe(true)
  expect(USAGE).toContain('clean [--hide|--log|--yes <kind>]')
  expect(CORE_HINT).toContain('clean [--hide|--log|--yes <kind>]')
})

// ---------------------------------------------------------------- the config file

const CONFIG_PATH = '/h/.config/claude-code/mods/tracker/config.json'

// Issue #123: a plan reads a switch of its tracker (`destroyWorktrees`). The tick reads the file every 30 s, so without a
// check in `clean` an edit just before `--yes` would still say `not enabled`. Here the real ConfigManager reads a fake file.
test('clean reads the config file before it plans: an edit of a switch just before --yes takes effect', async () => {
  const applied: CleanStep[][] = []
  const gated: Tracker = {
    id: 'gated',
    order: 1,
    config: {
      defaults: { enabled: true, on: false },
      normalise: (raw, defaults) => ({ ...defaults, ...(raw as object) }),
    },
    init: () => {},
    store: ctx => ctx.config.slice(),
    cleanup: {
      plan: ctx => [tree('wt:/x', ctx.config.slice().on === true ? {} : { skip: 'not enabled' })],
      apply: async (_ctx, steps) => {
        applied.push([...steps])
        return steps.map(x => ({ id: x.id, outcome: 'done' }))
      },
    },
  }
  const file = fakeConfigFs()
  const env = { get: async (name: string) => (name === 'HOME' ? '/h' : undefined) }
  const t = managerWorld({
    trackers: () => [gated],
    fake: { now: NOW },
    config: specs => new ConfigManager({ fs: file.fs, env: env as never, specs, log: () => {} }),
  })
  await t.m.ensureStarted(t.w.ports)
  expect((await t.m.track(t.w.ports, 'clean')).text).toContain('  wt:/x: skipped: not enabled')
  file.edit(CONFIG_PATH, JSON.stringify({ trackers: { gated: { on: true } } }))
  const text = (await t.m.track(t.w.ports, 'clean --yes worktrees')).text
  expect(applied.map(steps => steps.map(s => s.id))).toEqual([['wt:/x']])
  expect(text).toContain('  wt:/x: done')
  // Switched off again before a dry run: the plan shows it, and nothing more is applied.
  file.edit(CONFIG_PATH, JSON.stringify({ trackers: { gated: { on: false } } }))
  expect((await t.m.track(t.w.ports, 'clean')).text).toContain('  wt:/x: skipped: not enabled')
  await t.m.track(t.w.ports, 'clean --yes worktrees')
  expect(applied).toHaveLength(1)
})

// ---------------------------------------------------------------- the dry run

test('clean prints the plan by kind, with a skipped: line for a step that has a reason', async () => {
  const a = stub('a', 1, { plans: () => [task('task:1'), task('task:2', { skip: 'no task id' })] })
  const b = stub('b', 2, { plans: () => [tree('wt:/x')] })
  const t = world([a.t, b.t])
  const text = (await t.run('clean')).text
  expect(text).toContain('Clean plan. Nothing changed.')
  expect(text).toContain('Tasks (apply with /track clean --yes tasks)\n  run task:1 --secret: stop\n')
  expect(text).toContain('  run task:2 --secret: skipped: no task id\n')
  expect(text).toContain('Worktrees (apply with /track clean --yes worktrees)\n  wt:/x: remove record\n')
  expect(a.s.applied).toEqual([])
  expect(b.s.applied).toEqual([])
})

test('clean makes no slot write, no store write and no process run', async () => {
  const a = stub('a', 1, { plans: () => [task('task:1'), tree('wt:/x')] })
  const t = world([a.t])
  await t.m.ensureStarted(t.w.ports)
  const before = { sets: { ...t.w.stateSets }, store: t.w.storeSets, calls: t.w.calls.length, stops: t.w.stops.length }
  await t.run('clean')
  await t.run('clean')
  expect(t.w.stateSets).toEqual(before.sets)
  expect(t.w.storeSets).toBe(before.store)
  expect(t.w.calls).toHaveLength(before.calls)
  expect(t.w.stops).toHaveLength(before.stops)
  expect(logKeys(t.w.store)).toEqual([])
})

test('a tracker whose plan throws is named in the plan, and the others still list their steps', async () => {
  const bad = stub('bad', 1)
  bad.s.plans = () => {
    throw new Error('boom')
  }
  const good = stub('good', 2, { plans: () => [task('task:1')] })
  const t = world([bad.t, good.t])
  const text = (await t.run('clean')).text
  expect(text).toContain('run task:1 --secret: stop')
  expect(text).toContain('Problems:\n  bad: plan failed: boom')
})

test('a tracker the config turned off plans nothing', async () => {
  const a = stub('a', 1, { plans: () => [task('task:1')] })
  const t = world([a.t], { trackers: { a: { enabled: false } } })
  expect((await t.run('clean')).text).toContain('Nothing to stop or remove.')
})

test('bad arguments print the clean usage and run nothing', async () => {
  const a = stub('a', 1, { plans: () => [task('task:1')] })
  const t = world([a.t])
  for (const args of ['clean --yes', 'clean --yes all', 'clean now', 'clean --hide --log', 'clean --yes tasks nope'])
    expect((await t.run(args)).text, args).toBe(CLEAN_USAGE)
  expect(a.s.applied).toEqual([])
  expect(t.w.stateSets.hidden).toBeUndefined()
})

// ---------------------------------------------------------------- --hide

test('clean --hide sets hidden.before to now, clears showAll, redraws, and runs nothing', async () => {
  const a = stub('a', 1, { plans: () => [task('task:1')] })
  const t = world([a.t])
  await t.run('show-all')
  expect(t.w.state.get('hidden')).toEqual({ showAll: true })
  const invalidated = t.w.ui.invalidated
  const text = (await t.run('clean --hide')).text
  expect(t.w.state.get('hidden')).toEqual({ showAll: false, before: NOW })
  expect(t.w.ui.invalidated).toBeGreaterThan(invalidated)
  expect(text).toContain('Ended rows hidden. /track show-all shows them again.')
  expect(a.s.applied).toEqual([])
  expect(t.w.calls.filter(c => c[0] === 'git' || c[0] === 'ps')).toEqual([])
  expect(logKeys(t.w.store)).toEqual([]) // a hide changes nothing outside the view: no log entry
})

test('show-all after --hide shows the rows, and a second show-all hides them again: before stays', async () => {
  const t = world([stub('a', 1).t])
  await t.run('clean --hide')
  await t.run('show-all')
  expect(t.w.state.get('hidden')).toEqual({ showAll: true, before: NOW })
  await t.run('show-all')
  expect(t.w.state.get('hidden')).toEqual({ showAll: false, before: NOW })
})

// ---------------------------------------------------------------- --yes

test('--yes tasks applies the steps of that kind that have no reason, and nothing else', async () => {
  const a = stub('a', 1, {
    plans: () => [task('task:1'), task('task:2', { skip: 'no task id' }), tree('wt:/x')],
  })
  const b = stub('b', 2, { plans: () => [task('task:3')] })
  const t = world([a.t, b.t])
  const text = (await t.run('clean --yes tasks')).text
  expect(a.s.applied).toEqual([[task('task:1')]])
  expect(b.s.applied).toEqual([[task('task:3')]])
  expect(text).toContain('Cleaned: tasks.')
  expect(text).toContain('  run task:1 --secret: done')
  expect(text).toContain('  run task:2 --secret: skipped: no task id')
  expect(text).not.toContain('wt:/x')
})

test('--yes with two kinds applies both; a kind with no step says nothing to do', async () => {
  const a = stub('a', 1, { plans: () => [tree('wt:/x')] })
  const t = world([a.t])
  expect((await t.run('clean --yes tasks worktrees')).text).toContain('  wt:/x: done')
  expect(a.s.applied).toEqual([[tree('wt:/x')]])
  const none = world([stub('a', 1).t])
  expect((await none.run('clean --yes tasks')).text).toContain('Nothing to do.')
})

test('one log entry for each step that was tried, newest first, with no label and no command line', async () => {
  const a = stub('a', 1, {
    plans: () => [task('task:1'), task('task:2'), task('task:3', { skip: 'no task id' })],
    answer: steps => steps.map(x => ({ id: x.id, outcome: x.id === 'task:2' ? 'skipped: No task found' : 'done' })),
  })
  const t = world([a.t])
  await t.run('clean --yes tasks')
  const entries = t.log()
  expect(entries).toEqual([
    { at: NOW, by: 'manual', kind: 'tasks', id: 'task:2', action: 'stop', outcome: 'skipped: No task found' },
    { at: NOW, by: 'manual', kind: 'tasks', id: 'task:1', action: 'stop', outcome: 'done' },
  ])
  expect(JSON.stringify(entries)).not.toContain('--secret') // the label is the command line: never logged
  expect(Object.keys(entries[0] ?? {}).sort()).toEqual(['action', 'at', 'by', 'id', 'kind', 'outcome'])
})

test('an apply that throws skips all its steps with the message, and the other trackers still apply', async () => {
  const bad = stub('bad', 1, { plans: () => [task('task:1')] })
  bad.s.answer = () => {
    throw new Error('port closed')
  }
  const good = stub('good', 2, { plans: () => [task('task:2')] })
  const t = world([bad.t, good.t])
  const text = (await t.run('clean --yes tasks')).text
  expect(text).toContain('  run task:1 --secret: skipped: port closed')
  expect(text).toContain('  run task:2 --secret: done')
  expect(t.log().map(e => [e.id, e.outcome])).toEqual([
    ['task:2', 'done'],
    ['task:1', 'skipped: port closed'],
  ])
})

test('a step the tracker gave no result for is skipped, not done', async () => {
  const a = stub('a', 1, {
    plans: () => [task('task:1'), task('task:2')],
    answer: () => [{ id: 'task:1', outcome: 'done' }],
  })
  const t = world([a.t])
  expect((await t.run('clean --yes tasks')).text).toContain('  run task:2 --secret: skipped: no result')
})

test('an id and an outcome are cut to 200 characters in the log', async () => {
  const long = 'x'.repeat(500)
  const a = stub('a', 1, {
    plans: () => [task(`task:${long}`)],
    answer: steps => steps.map(x => ({ id: x.id, outcome: `skipped: ${long}` })),
  })
  const t = world([a.t])
  await t.run('clean --yes tasks')
  const [entry] = t.log()
  expect(entry?.id.length).toBe(200)
  expect(entry?.outcome.length).toBe(200)
})

test('only a tracker that declares stopsTasks has the tasks port in its apply context', async () => {
  const plain = stub('plain', 1, { plans: () => [task('task:1')] })
  const stopper = stub('stopper', 2, { plans: () => [task('task:2')], stops: true })
  const t = world([plain.t, stopper.t])
  await t.run('clean --yes tasks')
  expect(plain.s.tasks).toEqual([false])
  expect(stopper.s.tasks).toEqual([true])
})

test('the apply asks the plan again, so a step is judged on the state of now', async () => {
  let rows = [task('task:1')]
  const a = stub('a', 1, { plans: () => rows })
  const t = world([a.t])
  expect((await t.run('clean')).text).toContain('run task:1')
  rows = []
  await t.run('clean --yes tasks')
  expect(a.s.applied).toEqual([]) // the row is gone: nothing is applied
  expect(logKeys(t.w.store)).toEqual([])
})

test('--yes saves the session copy before it replies, and redraws the pane', async () => {
  const a = stub('a', 1, { plans: () => [task('task:1')] })
  const t = world([a.t])
  const invalidated = t.w.ui.invalidated
  await t.run('clean --yes tasks')
  expect(t.w.ui.invalidated).toBeGreaterThan(invalidated)
})

// ---------------------------------------------------------------- --log

test('--log prints the newest entries first, and an empty log says so', async () => {
  const a = stub('a', 1, { plans: () => [task('task:1')] })
  const t = world([a.t])
  expect((await t.run('clean --log')).text).toBe('The clean log is empty.')
  await t.run('clean --yes tasks')
  a.s.plans = () => [task('task:2')]
  t.w.clock.now = NOW + 5000
  await t.run('clean --yes tasks')
  const text = (await t.run('clean --log')).text
  const rows = text.split('\n')
  expect(rows[0]).toBe('Clean log, newest first (2 entries):')
  expect(rows[1]).toBe(`  ${new Date(NOW + 5000).toISOString()}  manual  tasks  task:2  stop  done`)
  expect(rows[2]).toBe(`  ${new Date(NOW).toISOString()}  manual  tasks  task:1  stop  done`)
  expect(text).not.toContain('--secret')
})

test('--log prints the good entries when the store holds one with no valid time, instead of one error line', async () => {
  const t = world([stub('a', 1).t])
  const bad = { at: 'x', by: 'manual', kind: 'tasks', id: 'task:bad', action: 'stop', outcome: 'done' }
  const good = { at: NOW, by: 'manual', kind: 'tasks', id: 'task:1', action: 'stop', outcome: 'done' }
  t.w.store.set('v2:log', [bad, { ...bad, at: 1e100 }, good] as never)
  const text = (await t.run('clean --log')).text
  expect(text).toBe(
    ['Clean log, newest first (1 entry):', `  ${new Date(NOW).toISOString()}  manual  tasks  task:1  stop  done`].join(
      '\n',
    ),
  )
})
