// Kit test of `/track clean --yes tasks` through the real hooks (issue #122): the engine's TaskStop is raised from the
// `command.run` hook with the task id of the row, the answers of the engine (a record, `Error: ...` with `isError`, `{ deny }`,
// a throw) become `done` or `skipped: <text>`, the row reads `killed` only after a real stop, and the audit log (issue #213:
// one `v2:log:<run>` key for each `--yes`) holds one entry for each try. The rules of the plan and of the log run in
// tests/clean.test.ts over fake ports.

import type { On } from 'claude-code'
import { type Engine, expect, mock } from 'claude-code/testing'
import { test } from './fixtures/kit'
import { logKeys, storedLog } from './fixtures/log'
import { taskStopped } from './fixtures/notices'
import { quiet, res, START, track, world } from './fixtures/world'

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
  expect(logKeys(w.store)).toEqual([])

  const out = (await track($, 'clean --yes tasks')).text ?? ''
  expect(w.fake.toolRuns.TaskStop).toBe(1)
  expect(w.fake.toolInputs.TaskStop).toHaveLength(1)
  expect(w.fake.toolInputs.TaskStop?.[0]).toMatchObject({ tool: 'TaskStop', task_id: 'task-bg-1' })
  expect(out).toContain('sleep 300 --token=abc: done')
  expect(out).toMatch(/Processes\s+1 tracked/)
  expect(out).toContain('killed') // the list that follows draws the row as killed
  const log = storedLog(w.store)
  expect(logKeys(w.store)).toHaveLength(1) // one --yes is one run key: the key a session writes is its own
  expect(logKeys(w.store)[0]).toMatch(/^v2:log:\d{13}:\d+:\S+-1$/)
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
  const log = storedLog(w.store)
  expect(log.map(e => e.outcome)).toEqual(['skipped: No task found with ID: task-bg-1'])
})

test('a TaskStop answer that names another task is skipped, and the row of the requested task keeps running', async ($, on) => {
  const w = await started($, on)
  w.fake.toolAnswers.TaskStop = { result: { message: 'Successfully stopped task: other', task_id: 'other' } }
  const out = (await track($, 'clean --yes tasks')).text ?? ''
  expect(w.fake.toolRuns.TaskStop).toBe(1)
  expect(out).toContain('sleep 300 --token=abc: skipped: TaskStop named another task')
  expect(out).not.toContain('killed')
  const log = storedLog(w.store)
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

// ---------------------------------------------------------------- containers (issue #123, PR 2)

const CID = 'c'.repeat(12) + '0123456789abcdef'.repeat(3) + 'abcd'
/** The config file under `HOME = /home/u`, on the stub disk. */
const CONFIG = '/home/u/.config/claude-code/mods/tracker/config.json'
const argvIs = (argv: string[], ...head: string[]) => head.every((x, i) => argv[i] === x)

/**
 * A session with one container that `docker run -d --name api` started and the probe saw exit, and a Docker that answers like
 * the real one: `ps -a`, `container inspect` and `rm`. The switch is on in the config file of the stub disk. `run` is the Bash
 * call whose output is the id, and the name that Docker gives the container.
 */
async function withContainer(
  $: Engine,
  on: On,
  enabled = true,
  run = { command: 'docker run -d --name api nginx', name: 'api' },
) {
  const file = JSON.stringify({ version: 1, trackers: { processes: { destroyContainers: enabled } } })
  const w = world(on, { isolateState: true, disk: { [CONFIG]: file } })
  mock.env(on, { HOME: '/home/u' })
  await $.session.start(START)
  w.fake.run = argv => {
    if (argvIs(argv, 'docker', 'ps', '-a', '--no-trunc')) return res(`${CID}\t${run.name}\tExited (0) 2 seconds ago\n`)
    if (argvIs(argv, 'docker', 'container', 'inspect'))
      return res(`${[CID, 'exited', new Date().toISOString(), `/${run.name}`, '{}'].join('\t')}\n`)
    if (argvIs(argv, 'docker', 'rm')) return res(`${CID}\n`)
    return undefined
  }
  w.fake.tools.Bash = { stdout: `${CID}\n`, stderr: '', interrupted: false }
  await $.tool.call({ tool: 'Bash', command: run.command } as never)
  await track($) // the probe: the container reads exited
  await quiet(w.calls)
  return w
}

/** The Docker calls that change or ask about one container, by what they do, in order. */
const dockerVerbs = (calls: string[][]) =>
  calls
    .filter(c => c[0] === 'docker' && (c[1] === 'container' || c[1] === 'rm'))
    .map(c => (c[1] === 'rm' ? 'rm' : 'inspect'))

test('--yes containers asks Docker before it removes: inspect, then rm, one of each, and a dry run runs neither', async ($, on) => {
  const w = await withContainer($, on)
  const plan = (await track($, 'clean')).text ?? ''
  expect(plan).toContain('Containers (apply with /track clean --yes containers)\n  api: remove\n')
  expect(dockerVerbs(w.calls)).toEqual([]) // a plan removes nothing and asks nothing
  expect(logKeys(w.store)).toEqual([])

  const out = (await track($, 'clean --yes containers')).text ?? ''
  expect(dockerVerbs(w.calls)).toEqual(['inspect', 'rm'])
  const rm = w.calls.find(c => c[0] === 'docker' && c[1] === 'rm')
  expect(rm).toEqual(['docker', 'rm', CID]) // by argument vector: no -f, no -v
  expect(out).toContain('Cleaned: containers.')
  expect(out).toContain('api: done')
  expect(out).toMatch(/Processes\s+1 tracked/) // the list follows the result
  const log = storedLog(w.store)
  expect(log).toHaveLength(1)
  expect(log[0]).toMatchObject({
    by: 'manual',
    kind: 'containers',
    id: 'docker:ctr:api',
    action: 'remove-container',
    outcome: 'done',
  })
  // The row stays exited until its TTL, and a second --yes has no step: no more Docker call, no more entry.
  const again = (await track($, 'clean --yes containers')).text ?? ''
  expect(again).toContain('Nothing to do.')
  expect(dockerVerbs(w.calls)).toEqual(['inspect', 'rm'])
  expect(storedLog(w.store)).toHaveLength(1)
})

test('with destroyContainers off --yes containers says skipped: not enabled and runs no Docker call', async ($, on) => {
  const w = await withContainer($, on, false)
  expect((await track($, 'clean')).text ?? '').toContain('  api: skipped: not enabled')
  const out = (await track($, 'clean --yes containers')).text ?? ''
  expect(out).toContain('api: skipped: not enabled')
  expect(dockerVerbs(w.calls)).toEqual([])
  expect(logKeys(w.store)).toEqual([])
})

// Study live check 7 (issue #123): an edit of the switch just before --yes counts. The plan said `not enabled`. The config file
// is edited on the stub disk, and `clean` reads it again before it applies.
test('an edit of destroyContainers just before --yes counts: the plan said not enabled, the apply removes', async ($, on) => {
  const w = await withContainer($, on, false)
  expect((await track($, 'clean')).text ?? '').toContain('  api: skipped: not enabled')
  expect(dockerVerbs(w.calls)).toEqual([])
  w.fake.editDisk(CONFIG, JSON.stringify({ version: 1, trackers: { processes: { destroyContainers: true } } }))
  const out = (await track($, 'clean --yes containers')).text ?? ''
  expect(out).toContain('api: done')
  expect(dockerVerbs(w.calls)).toEqual(['inspect', 'rm'])
})

// Study live check 6: a `docker run -d --rm` container leaves no `ps -a` line. The probe marks the row `containerGone`, and the
// plan, which comes after the probe, has no container step: nothing is asked of Docker, and nothing is logged.
test('a --rm container is never planned: the probe marks it gone, and the plan has no container step', async ($, on) => {
  const w = await withContainer($, on)
  w.fake.run = argv => (argvIs(argv, 'docker', 'ps', '-a', '--no-trunc') ? res('') : undefined) // no line holds the id
  await track($) // the probe
  expect((await track($, 'clean')).text ?? '').not.toContain('Containers (')
  await track($, 'clean --yes containers')
  expect(dockerVerbs(w.calls)).toEqual([])
  expect(logKeys(w.store)).toEqual([])
})

// Review of PR 285, P1. The run never ran, and the one id line is the output of another command: the parser pairs it with the
// run (its known limits), the row has no `--name`, and the container is an exited one that someone else made. Through the real
// hooks and the real probe, the plan says why it is no step, and `--yes containers` asks Docker nothing.
test('a run that never ran, paired with the id of another command, is never removed: no --name, no docker call', async ($, on) => {
  const w = await withContainer($, on, true, {
    command: `false && docker run -d nginx; printf '%s\\n' ${CID}`,
    name: 'gallant_curie',
  })
  const plan = (await track($, 'clean')).text ?? ''
  expect(plan).toContain(`${CID.slice(0, 12)}: skipped: no --name, so nothing proves that this run made the container`)
  const out = (await track($, 'clean --yes containers')).text ?? ''
  expect(out).toContain('skipped: no --name')
  expect(dockerVerbs(w.calls)).toEqual([])
  expect(logKeys(w.store)).toEqual([])
})

// Review of PR 285, P1 again. The same call with a `--name`: the run never ran, and `printf` printed the id of an exited container
// that already has the name `api` (Docker keeps names unique, so the run could not have made it). The name and the age of the
// container fit, but another command of the call prints, so the row is no step. Through the real hooks and the real probe.
test('a named run that never ran, paired with the id of another command, is never removed: not alone, no docker call', async ($, on) => {
  const w = await withContainer($, on, true, {
    command: `false && docker run -d --name api nginx; printf '%s\\n' ${CID}`,
    name: 'api',
  })
  const plan = (await track($, 'clean')).text ?? ''
  expect(plan).toContain(
    'api: skipped: the run was not the whole Bash call, so nothing proves that this run made the container',
  )
  const out = (await track($, 'clean --yes containers')).text ?? ''
  expect(out).toContain('skipped: the run was not the whole Bash call')
  expect(dockerVerbs(w.calls)).toEqual([])
  expect(logKeys(w.store)).toEqual([])
})

// Third review of PR 285, P1. The command of the review: a command substitution in double quotes, in the argument of `:` under a
// group with `3>&1`, prints the id of the exited container that has the name `api`, and the run never ran. The splitter leaves
// the substitution in its word, so the call looked like one with no other command that prints. Through the real hooks and the
// real probe, the plan says why it is no step, and `--yes containers` asks Docker nothing.
test('a quoted command substitution that prints the id of another container is never removed: not alone, no docker call', async ($, on) => {
  const w = await withContainer($, on, true, {
    command: `false && docker run -d --name api nginx; { : "$(printf '%s\\n' ${CID} >&3)"; } 3>&1`,
    name: 'api',
  })
  const plan = (await track($, 'clean')).text ?? ''
  expect(plan).toContain(
    'api: skipped: the run was not the whole Bash call, so nothing proves that this run made the container',
  )
  const out = (await track($, 'clean --yes containers')).text ?? ''
  expect(out).toContain('skipped: the run was not the whole Bash call')
  expect(dockerVerbs(w.calls)).toEqual([])
  expect(logKeys(w.store)).toEqual([])
})
