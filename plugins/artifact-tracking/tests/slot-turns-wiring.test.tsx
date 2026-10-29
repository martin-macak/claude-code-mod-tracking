// Kit tests of the turn lineage of slot rows (issue #133, P1b of #69), through the real hooks. This is the kit spike of the
// issue: how does a row of the processes, repos or auto tracker learn the turn it belongs to? The engine raises the events in
// the order of a live run (design study of #69, comment 2). The row's tracker runs after the capture, on the same event, so
// the ledger has fixed the turn of that event by then: the answer is in these cases, and the rules are in tests/slot-turns.test.ts.
// The kit's `$.tool.call` drops `agentId`, so a subagent's own call cannot come in here: that case runs on fakePorts through
// the LifecycleManager (tests/slot-turns.test.ts). A repo's lookup runs in a queue after the hook returned, so its turn is
// read when the visit is queued, not when the row is written.

import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock } from 'claude-code/testing'
import { test } from './fixtures/kit'
import { BG_START_MAIN, taskStopped } from './fixtures/notices'
import { prompt, quiet, res, START, track, world } from './fixtures/world'

const start = ($: Engine, turnId: string, text = 'go') => $.turn.start({ turnId, text } as never)
const end = ($: Engine, turnId: string) =>
  $.turn.complete({ turnId, reason: 'answer', isAborted: false, durationMs: 5, answer: '' } as never)
const turnText = async ($: Engine, n: number) => (await track($, `turn ${n}`)).text ?? ''

/** One whole turn with no tool call in it. */
async function empty($: Engine, n: number): Promise<void> {
  await $.session.append(prompt(`question ${n}`))
  await start($, `turn-${n}`, `question ${n}`)
  await end($, `turn-${n}`)
}

type Stamped = { id?: string; key?: string; path?: string; firstTurn?: number; lastTurn?: number }
/** The rows of a tracker slot as the isolated kit state holds them. */
const rowsOf = (states: Map<string, { value: unknown }>, id: string): Stamped[] =>
  (states.get(`sess-1|artifact-tracking|trackers|${id}`)?.value as Stamped[] | undefined) ?? []

test('spike: a process that a Bash call started in turn 3 carries firstTurn 3 and is listed by /track turn 3', async ($, on) => {
  const w = world(on, { isolateState: true })
  await $.session.start(START)
  await empty($, 1)
  await empty($, 2)
  await $.session.append(prompt('run the server'))
  await start($, 'turn-3', 'run the server')
  w.fake.tools.Bash = { ...BG_START_MAIN.result } // the engine wraps it as { ref, result, text } for the hook
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', tool_use_id: 'tu_bg3' } as never)
  await end($, 'turn-3')
  await empty($, 4)
  await quiet(w.calls)
  const [row] = rowsOf(w.states, 'processes')
  expect(row).toMatchObject({ id: 'task:butoa45ib', firstTurn: 3, lastTurn: 3 })
  const text = await turnText($, 3)
  expect(text.split('\n')[0]).toMatch(/^Turn 3 · answer · \d\d:\d\d · "run the server" · 1 new$/)
  expect(text).toMatch(/\n {2}new {4}.*npm run dev.* {2}created$/)
  expect(await turnText($, 4)).toMatch(/^Turn 4 · answer · \d\d:\d\d · "question 4" · nothing tracked$/)
})

test('spike: a repo that a Bash call names again in turn 5 shows lastTurn 5 and is listed as seen again by /track turn 5', async ($, on) => {
  const w = world(on, { isolateState: true })
  await $.session.start(START) // pins the root (/work), so the tracker knows which repo is its own
  w.fake.run = argv => {
    if (argv[0] !== 'git' || argv[1] !== '-C' || argv[2] !== '/x/sdk') return undefined
    if (argv[3] === 'rev-parse') return res('/x/sdk\n/x/sdk/.git\n')
    if (argv[3] === 'remote') return res('git@github.com:acme/sdk.git\n')
    return res('main\n')
  }
  w.fake.tools.Bash = { stdout: '', stderr: '', interrupted: false }
  await empty($, 1)
  await empty($, 2)
  await $.session.append(prompt('look at the sdk'))
  await start($, 'turn-3', 'look at the sdk')
  await $.tool.call({ tool: 'Bash', command: 'cd /x/sdk && ls' } as never)
  await quiet(w.calls)
  await end($, 'turn-3')
  await empty($, 4)
  await $.session.append(prompt('and the sdk again'))
  await start($, 'turn-5', 'and the sdk again')
  await $.tool.call({ tool: 'Bash', command: 'cd /x/sdk && ls' } as never) // within tickMs of the first visit
  await quiet(w.calls)
  await end($, 'turn-5')
  expect(rowsOf(w.states, 'repos')[0]).toMatchObject({ key: 'remote:github.com/acme/sdk', firstTurn: 3, lastTurn: 5 })
  expect(await turnText($, 3)).toMatch(/\n {2}new {4}.*acme\/sdk.* {2}read$/)
  const text = await turnText($, 5)
  expect(text.split('\n')[0]).toMatch(/ · 1 seen again$/)
  expect(text).toMatch(/\n {2}again {2}.*acme\/sdk.* {2}read$/)
})

test('spike: an agent that turn 2 spawned carries both turns as 2 and is listed as new in /track turn 2', async ($, on) => {
  const w = world(on, { isolateState: true })
  await $.session.start(START)
  await empty($, 1)
  await $.session.append(prompt('spawn one'))
  await start($, 'turn-2', 'spawn one')
  w.fake.spawnId = 'agent-7'
  await $.agent.spawn({
    tool_use_id: 'tu_agent2',
    subagentType: 'general-purpose',
    description: 'explore the code',
    background: true,
  } as never)
  await end($, 'turn-2')
  await quiet(w.calls)
  const agents = (states: typeof w.states) =>
    (states.get('sess-1|artifact-tracking|trackers|auto')?.value as { agents?: Stamped[] } | undefined)?.agents ?? []
  expect(agents(w.states)[0]).toMatchObject({ id: 'agent-7', firstTurn: 2, lastTurn: 2 })
  const text = await turnText($, 2)
  expect(text.split('\n')[0]).toMatch(/ · 1 new$/)
  expect(text).toMatch(/\n {2}new {4}agent ag:agent-7 {2}created$/) // the round has drawn no row yet: the ledger words it
})

// ---------------------------------------------------------------- a TaskStop (issue #204)

/** A background task that turn 3 started, and an empty turn 4. */
async function startedInTurn3($: Engine, on: On) {
  const w = world(on, { isolateState: true })
  mock.env(on, { HOME: '/home/u' })
  await $.session.start(START)
  await empty($, 1)
  await empty($, 2)
  await $.session.append(prompt('run it'))
  await start($, 'turn-3', 'run it')
  w.fake.tools.Bash = { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'task-bg-1' }
  await $.tool.call({ tool: 'Bash', command: 'sleep 300', tool_use_id: 'toolu_bg_1' } as never)
  await end($, 'turn-3')
  await empty($, 4)
  await quiet(w.calls)
  return w
}

test("the model's TaskStop in turn 5 stamps the row: lastTurn 5, and /track turn 5 lists it as seen again", async ($, on) => {
  const w = await startedInTurn3($, on)
  w.fake.toolAnswers.TaskStop = taskStopped('task-bg-1')
  await $.session.append(prompt('stop it'))
  await start($, 'turn-5', 'stop it')
  await $.tool.call({ tool: 'TaskStop', task_id: 'task-bg-1' } as never) // the kit raises it as the engine does: origin engine
  await end($, 'turn-5')
  await quiet(w.calls)
  expect(rowsOf(w.states, 'processes')[0]).toMatchObject({
    id: 'task:task-bg-1',
    state: 'killed',
    firstTurn: 3,
    lastTurn: 5,
  })
  const text = await turnText($, 5)
  expect(text.split('\n')[0]).toMatch(/ · 1 seen again$/)
  expect(text).toMatch(/\n {2}again {2}.*sleep 300.* {2}created$/)
})

test('/track clean --yes tasks run inside turn 5 kills the row but is no sighting: lastTurn stays 3 and turn 5 lists nothing', async ($, on) => {
  const w = await startedInTurn3($, on)
  w.fake.toolAnswers.TaskStop = taskStopped('task-bg-1')
  await $.session.append(prompt('clean up'))
  await start($, 'turn-5', 'clean up') // an immediate command or a pane key runs while a turn is in flight
  const out = (await track($, 'clean --yes tasks')).text ?? ''
  await end($, 'turn-5')
  await quiet(w.calls)
  expect(out).toContain('sleep 300: done')
  expect(w.fake.toolRuns.TaskStop).toBe(1) // one stop reached the engine; the byPlugin guard shows in lastTurn 3 below
  expect(rowsOf(w.states, 'processes')[0]).toMatchObject({
    id: 'task:task-bg-1',
    state: 'killed',
    firstTurn: 3,
    lastTurn: 3,
  })
  expect(await turnText($, 5)).toMatch(/nothing tracked$/)
})

test('spike: a worktree that EnterWorktree proved in turn 3 carries both turns as 3 and is listed as new in /track turn 3', async ($, on) => {
  const w = world(on, { isolateState: true })
  await $.session.start(START)
  await empty($, 1)
  await empty($, 2)
  await $.session.append(prompt('enter a worktree'))
  await start($, 'turn-3', 'enter a worktree')
  const path = '/work/.claude/worktrees/probe-wt'
  w.fake.tools.EnterWorktree = { worktreePath: path, worktreeBranch: 'worktree-probe-wt', message: 'created' }
  await $.tool.call({ tool: 'EnterWorktree', name: 'probe-wt' } as never)
  await end($, 'turn-3')
  await quiet(w.calls)
  const proofs = (states: typeof w.states) =>
    (states.get('sess-1|artifact-tracking|trackers|auto')?.value as { worktrees?: Stamped[] } | undefined)?.worktrees ??
    []
  expect(proofs(w.states)[0]).toMatchObject({ path, firstTurn: 3, lastTurn: 3 })
  const text = await turnText($, 3)
  expect(text.split('\n')[0]).toMatch(/ · 1 new$/)
  expect(text).toMatch(new RegExp(`\\n {2}new {4}.*${path}.* {2}created$`)) // no round has drawn the row: the ledger words it
})
