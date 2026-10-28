// Kit test of `/track clean --yes tasks` through the real hooks (issue #122): the engine's TaskStop is raised from the
// `command.run` hook with the task id of the row, the answers of the engine (a record, `Error: ...` with `isError`, `{ deny }`,
// a throw) become `done` or `skipped: <text>`, the row reads `killed` only after a real stop, and the audit log `v2:log`
// holds one entry for each try. The rules of the plan and of the log run in tests/clean.test.ts over fake ports.

import type { On } from 'claude-code'
import { type Engine, expect, mock } from 'claude-code/testing'
import { test } from './fixtures/kit'
import { taskStopped } from './fixtures/notices'
import { quiet, START, track, world } from './fixtures/world'

/** A session with one background task running: `sleep 300 --token=abc`, task id `task-bg-1`. */
async function started($: Engine, on: On) {
  const w = world(on, { isolateState: true })
  mock.env(on, { HOME: '/home/u' })
  await $.session.start(START)
  w.fake.tools.Bash = { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'task-bg-1' }
  await $.tool.call({ tool: 'Bash', command: 'sleep 300 --token=abc', tool_use_id: 'toolu_bg_1' } as never)
  await quiet(w.calls)
  return w
}

test('a dry run raises no TaskStop and writes no log; --yes tasks raises one with the task id, and the row reads killed', async ($, on) => {
  const w = await started($, on)
  w.fake.toolAnswers.TaskStop = taskStopped('task-bg-1')
  const plan = (await track($, 'clean')).text ?? ''
  expect(plan).toContain('sleep 300 --token=abc: stop')
  expect(w.fake.toolRuns.TaskStop).toBeUndefined()
  expect(w.store.has('v2:log')).toBe(false)

  const out = (await track($, 'clean --yes tasks')).text ?? ''
  expect(w.fake.toolRuns.TaskStop).toBe(1)
  expect(w.fake.toolInputs.TaskStop).toHaveLength(1)
  expect(w.fake.toolInputs.TaskStop?.[0]).toMatchObject({ tool: 'TaskStop', task_id: 'task-bg-1' })
  expect(out).toContain('sleep 300 --token=abc: done')
  expect(out).toMatch(/Processes\s+1 tracked/)
  expect(out).toContain('killed') // the list that follows draws the row as killed
  const log = w.store.get('v2:log') as { kind: string; id: string; action: string; outcome: string; by: string }[]
  expect(log).toHaveLength(1)
  expect(log[0]).toMatchObject({ by: 'manual', kind: 'tasks', id: 'task:task-bg-1', action: 'stop', outcome: 'done' })
  expect(JSON.stringify(log)).not.toContain('--token') // no command line in the log
})

test('a TaskStop answer Error: ... with isError is skipped: <text>, the row keeps running, and the log holds the try', async ($, on) => {
  const w = await started($, on)
  w.fake.toolAnswers.TaskStop = {
    result: 'Error: No task found with ID: task-bg-1',
    text: '<tool_use_error>No task found with ID: task-bg-1</tool_use_error>',
    isError: true,
  }
  const out = (await track($, 'clean --yes tasks')).text ?? ''
  expect(w.fake.toolRuns.TaskStop).toBe(1)
  expect(out).toContain('sleep 300 --token=abc: skipped: No task found with ID: task-bg-1')
  expect(out).toContain('running')
  expect(out).not.toContain('killed')
  const log = w.store.get('v2:log') as { outcome: string }[]
  expect(log.map(e => e.outcome)).toEqual(['skipped: No task found with ID: task-bg-1'])
})

test('a TaskStop answer that names another task is skipped, and the row of the requested task keeps running', async ($, on) => {
  const w = await started($, on)
  w.fake.toolAnswers.TaskStop = { result: { message: 'Successfully stopped task: other', task_id: 'other' } }
  const out = (await track($, 'clean --yes tasks')).text ?? ''
  expect(w.fake.toolRuns.TaskStop).toBe(1)
  expect(out).toContain('sleep 300 --token=abc: skipped: TaskStop named another task')
  expect(out).not.toContain('killed')
  const log = w.store.get('v2:log') as { outcome: string }[]
  expect(log.map(e => e.outcome)).toEqual(['skipped: TaskStop named another task'])
})

test('a hook that refuses TaskStop and a call that rejects are both skipped: <text>, and the row keeps running', async ($, on) => {
  const w = await started($, on)
  w.fake.toolReplies.TaskStop = { deny: 'a hook refused TaskStop' }
  expect((await track($, 'clean --yes tasks')).text).toContain('skipped: a hook refused TaskStop')
  delete w.fake.toolReplies.TaskStop
  w.fake.toolThrows.TaskStop = 'the engine is shutting down' // the kit then rejects the call with its own words
  const out = (await track($, 'clean --yes tasks')).text ?? ''
  expect(out).toMatch(/sleep 300 --token=abc: skipped: \S/)
  expect(out).not.toContain('killed')
  expect(w.fake.toolRuns.TaskStop).toBe(2)
})

test('/track clean --log prints the entries, newest first', async ($, on) => {
  const w = await started($, on)
  w.fake.toolAnswers.TaskStop = { result: 'Error: Task task-bg-1 is not running (status: killed)', isError: true }
  await track($, 'clean --yes tasks')
  w.fake.toolAnswers.TaskStop = taskStopped('task-bg-1')
  await track($, 'clean --yes tasks')
  const text = (await track($, 'clean --log')).text ?? ''
  expect(text).toContain('Clean log, newest first (2 entries):')
  const rows = text.split('\n').filter(r => r.includes('task:task-bg-1'))
  expect(rows[0]).toMatch(/manual {2}tasks {2}task:task-bg-1 {2}stop {2}done$/)
  expect(rows[1]).toMatch(/stop {2}skipped: Task task-bg-1 is not running \(status: killed\)$/)
})
