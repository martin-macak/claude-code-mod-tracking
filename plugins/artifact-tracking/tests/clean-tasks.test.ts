// `/track clean` for background tasks (issue #122): the processes tracker plans a TaskStop for each running background task
// and, after `--yes tasks`, stops it through the narrow `tasks.stop` port, marks the row `killed` and leaves one log entry.
// The world is the pane world: the real trackers over fake ports, where `stop` answers like the engine's TaskStop.
import { expect, test } from 'claude-code/testing'
import type { CleanStep } from '../core/interfaces/clean'
import { processesCleanup } from '../trackers/processes/clean'
import type { ProcessRecord } from '../trackers/processes/types'
import { noDockerIssue, proc, setProcesses } from './fixtures/hide-world'
import { logKeys, storedLog } from './fixtures/log'
import { NOW, paneWorld } from './fixtures/pane-world'

const sleeper = (id: string, f: Partial<ProcessRecord> = {}): ProcessRecord =>
  proc(`task:${id}`, 'running', { name: `sleep ${id} --token=abc`, taskId: id, ...f })

async function taskWorld(rows: ProcessRecord[]) {
  const t = await paneWorld()
  noDockerIssue(t)
  setProcesses(t, rows)
  const run = (args: string) => t.m.track(t.w.ports, args)
  const row = (id: string) => (t.w.state.get('processes') as unknown as ProcessRecord[]).find(r => r.id === id)
  const log = () => storedLog(t.w.store)
  return { ...t, run, row, log }
}

test('the plan stops a running background task and names it by its command', async () => {
  const t = await taskWorld([sleeper('t1')])
  const text = (await t.run('clean')).text
  expect(text).toContain('Tasks (apply with /track clean --yes tasks)\n  sleep t1 --token=abc: stop\n')
  expect(t.w.stops).toEqual([]) // a plan stops nothing
})

test('the plan lists only a running background task: not an ended row, Docker, tmux or a detached process', async () => {
  const t = await taskWorld([
    proc('task:done', 'completed', { name: 'done job', taskId: 'done' }),
    proc('docker:ctr:db', 'up', { kind: 'docker-container', name: 'db', containerId: 'abc' }),
    proc('tmux:dev', 'running', { kind: 'tmux', name: 'dev' }),
    proc('pid:7', 'running', { kind: 'detached-process', name: 'worker', pid: 7 }),
    proc('docker:compose:p', 'up', { kind: 'docker-compose', name: 'p', project: 'p' }),
  ])
  const text = (await t.run('clean')).text
  expect(text).not.toContain('Tasks (')
  expect(text).toContain('Nothing to stop or remove.')
})

test('a running task with no task id is skipped: no task id', async () => {
  const t = await taskWorld([sleeper('t1'), proc('bg:x:1', 'running', { name: 'make watch' })])
  const text = (await t.run('clean')).text
  expect(text).toContain('  sleep t1 --token=abc: stop\n')
  expect(text).toContain('  make watch: skipped: no task id\n')
  await t.run('clean --yes tasks')
  expect(t.w.stops).toEqual(['t1']) // the row with no id is never sent
})

test('a Monitor task is skipped: its stop is not tested yet', async () => {
  const t = await taskWorld([proc('monitor:m1', 'running', { kind: 'monitor', name: 'tail -f log', taskId: 'm1' })])
  expect((await t.run('clean')).text).toContain('  tail -f log: skipped: a Monitor task is not stopped yet')
  await t.run('clean --yes tasks')
  expect(t.w.stops).toEqual([])
  expect(t.row('monitor:m1')?.state).toBe('running')
})

test('--yes tasks sends one TaskStop with the task id, the row reads killed, and the log gains one entry', async () => {
  const t = await taskWorld([sleeper('t1'), proc('pid:7', 'running', { kind: 'detached-process', name: 'w', pid: 7 })])
  const text = (await t.run('clean --yes tasks')).text
  expect(t.w.stops).toEqual(['t1'])
  expect(t.row('task:t1')).toMatchObject({ state: 'killed', endedAt: NOW })
  expect(t.row('pid:7')?.state).toBe('running') // nothing else changes
  expect(text).toContain('  sleep t1 --token=abc: done')
  expect(t.log()).toEqual([{ at: NOW, by: 'manual', kind: 'tasks', id: 'task:t1', action: 'stop', outcome: 'done' }])
  expect(JSON.stringify(t.log())).not.toContain('--token') // the command line is not in the log
})

test('a TaskStop that answers Error with isError is skipped: <text>, and the row keeps its state', async () => {
  const t = await taskWorld([sleeper('t1')])
  t.w.stop = async () => ({ stopped: false, reason: 'No task found with ID: t1' })
  const text = (await t.run('clean --yes tasks')).text
  expect(t.w.stops).toEqual(['t1'])
  expect(text).toContain('  sleep t1 --token=abc: skipped: No task found with ID: t1')
  expect(t.row('task:t1')).toMatchObject({ state: 'running' })
  expect(t.row('task:t1')?.endedAt).toBeUndefined()
  expect(t.log().map(e => e.outcome)).toEqual(['skipped: No task found with ID: t1'])
})

test('one failed stop never stops the others', async () => {
  const t = await taskWorld([sleeper('t1'), sleeper('t2'), sleeper('t3')])
  t.w.stop = async id => (id === 't2' ? { stopped: false, reason: 'not running' } : { stopped: true })
  await t.run('clean --yes tasks')
  expect(t.w.stops).toEqual(['t1', 't2', 't3'])
  expect(['t1', 't2', 't3'].map(id => t.row(`task:${id}`)?.state)).toEqual(['killed', 'running', 'killed'])
  expect(t.log().map(e => [e.id, e.outcome])).toEqual([
    ['task:t3', 'done'],
    ['task:t2', 'skipped: not running'],
    ['task:t1', 'done'],
  ])
})

test('a port that throws is a skipped step, not a failed command', async () => {
  const t = await taskWorld([sleeper('t1')])
  t.w.stop = async () => {
    throw new Error('engine gone')
  }
  expect((await t.run('clean --yes tasks')).text).toContain('skipped: engine gone')
  expect(t.row('task:t1')?.state).toBe('running')
})

test('a stop that worked but whose row write failed still counts as done', async () => {
  const t = await taskWorld([sleeper('t1')])
  const slot = t.w.ports.state.slot.update
  t.w.ports.state.slot.update = async (id, fn) => {
    if (id === 'processes') throw new Error('state refused')
    return slot(id, fn)
  }
  expect((await t.run('clean --yes tasks')).text).toContain('  sleep t1 --token=abc: done')
  expect(t.log().map(e => e.outcome)).toEqual(['done'])
})

test('the apply judges the rows of now: a task that ended since the last plan is not stopped', async () => {
  const t = await taskWorld([sleeper('t1')])
  expect((await t.run('clean')).text).toContain('sleep t1')
  setProcesses(t, [sleeper('t1', { state: 'completed', endedAt: NOW })])
  await t.run('clean --yes tasks')
  expect(t.w.stops).toEqual([])
  expect(logKeys(t.w.store)).toEqual([])
})

test('a clean that stops a task leaves the other kinds alone, and a dry run runs no process', async () => {
  const t = await taskWorld([sleeper('t1')])
  await t.run('clean')
  await t.run('clean --yes tasks')
  expect(t.w.calls.filter(c => c[0] === 'git' && c[1] === 'worktree')).toEqual([])
})

// ---------------------------------------------------------------- the apply on its own: the guards that do not rely on the plan

const stepOf = (id: string): CleanStep => ({ kind: 'tasks', id, label: id, action: 'stop' })

/** The apply over a hand-made context: the rows it reads, and the port it may have. */
function applyOf(rows: ProcessRecord[], tasks?: { stop(taskId: string): Promise<{ stopped: true }> }) {
  const ctx = {
    data: { get: async () => rows, update: async () => rows },
    clock: { wall: () => NOW },
    log: () => {},
    ...(tasks ? { tasks } : {}),
  } as unknown as Parameters<typeof processesCleanup.apply>[0]
  return (...ids: string[]) => processesCleanup.apply(ctx, ids.map(stepOf))
}

test('apply: a step whose row is gone, or has no task id, sends nothing', async () => {
  const sent: string[] = []
  const apply = applyOf([proc('task:x', 'running', { name: 'x' })], {
    stop: async id => {
      sent.push(id)
      return { stopped: true as const }
    },
  })
  expect(await apply('task:nope', 'task:x')).toEqual([
    { id: 'task:nope', outcome: 'skipped: the row is gone' },
    { id: 'task:x', outcome: 'skipped: the row is gone' },
  ])
  expect(sent).toEqual([])
})

test('apply: a tracker with no tasks port skips the step and stops nothing', async () => {
  const apply = applyOf([sleeper('t1')])
  expect(await apply('task:t1')).toEqual([{ id: 'task:t1', outcome: 'skipped: no task port' }])
})
