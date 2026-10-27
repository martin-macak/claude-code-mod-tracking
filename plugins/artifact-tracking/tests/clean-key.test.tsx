// Kit test of the pane key `p` through the real hooks (issue #199): it shows the plan of `/track clean` in the pane and changes
// nothing. A background task is running; the key raises no TaskStop, runs no process, writes no store key and leaves `hidden.before`
// as it was. The screen holds the lines that `/track clean` prints (a tall body) or a cut of them (an inline body of 11 rows). The
// rules of the cut run in tests/plan-view.test.ts, the session in tests/pane-plan.test.ts, over fake ports. The kit does not show
// paint or the focus ring: the live scenario of the PR does.

import type { On } from 'claude-code'
import { type Engine, expect, mock } from 'claude-code/testing'
import { test } from './fixtures/kit'
import { mountPane, type PaneUi } from './fixtures/pane'
import { quiet, START, track, until, world } from './fixtures/world'

/** One more background task: `sleep <n>` with the task id `task-bg-<n>`. */
async function startTask($: Engine, w: ReturnType<typeof world>, n: number) {
  w.fake.tools.Bash = { stdout: '', stderr: '', interrupted: false, backgroundTaskId: `task-bg-${n}` }
  await $.tool.call({ tool: 'Bash', command: `sleep ${n}`, tool_use_id: `toolu_bg_${n}` } as never)
}

/** The tasks that run: `sleep 1`, `sleep 2`, … with the task ids `task-bg-1`, … */
async function started($: Engine, on: On, tasks = 1) {
  const w = world(on, { isolateState: true })
  mock.env(on, { HOME: '/home/u' })
  await $.session.start(START)
  for (let n = 1; n <= tasks; n++) await startTask($, w, n)
  await quiet(w.calls)
  return w
}

/** The words of every Text of the pane, in tree order. */
const wordsOf = async (ui: PaneUi): Promise<string[]> =>
  (await ui.findAll({ type: 'Text' })).map(t => String(t.text ?? '')).filter(s => s !== '')

/**
 * The words of the pane once `ok` holds of them. A press starts work that the kit does not wait for (the read of the plan), and the
 * plan view shows when that work ends in `ui.invalidate`. The kit does not draw the pane again for it (measured: with no `redraw`
 * here the plan view never showed in 20 s, with or without `isolateState`), so the test draws once more each time it looks, and
 * polls for the state it expects. The limit of `until` is a hang guard, not a speed limit.
 */
async function shows(ui: PaneUi, what: string, ok: (words: string[]) => boolean): Promise<string[]> {
  let words: string[] = []
  await until(async () => {
    await ui.redraw()
    words = await wordsOf(ui)
    return ok(words)
  }, what)
  return words
}
const PLAN_VIEW = (words: string[]): boolean => words[0] === 'Clean plan. Nothing changed.'
const ROWS = (words: string[]): boolean => words.includes('View: list')

/** The lines of the reply of `/track clean`, without the blank ones: what the plan view shows when the body is tall. */
const commandLines = async ($: Engine): Promise<string[]> =>
  ((await track($, 'clean')).text ?? '').split('\n').filter(l => l !== '')

const hiddenOf = (w: ReturnType<typeof world>) => w.states.get('sess-1|artifact-tracking|hidden|')?.value

test('p shows the plan, and the screen holds the lines that /track clean prints', async ($, on) => {
  await started($, on)
  const expected = await commandLines($)
  expect(expected).toContain('  sleep 1: stop')
  const ui = await mountPane($, { bodyColumns: 96, bodyRows: 28, placement: 'dock', isFocused: true })
  await ui.press({ key: 'clean' })
  const words = await shows(ui, 'the plan view', PLAN_VIEW)
  expect(words.slice(0, expected.length)).toEqual(expected) // the same lines, from one function
  expect(await ui.find({ text: 'View: list' })).toBeUndefined() // the rows and the view line are gone
  await ui.unmount()
})

test('p changes nothing: no TaskStop, no process run, no store write, no atom write, and hidden.before as it was', async ($, on) => {
  const w = await started($, on)
  await track($, 'clean --hide') // sets hidden.before, so a write of the key would show
  await quiet(w.calls)
  const hidden = hiddenOf(w)
  expect(hidden).toMatchObject({ showAll: false })
  const ui = await mountPane($, { bodyColumns: 96, bodyRows: 28, placement: 'dock', isFocused: true })
  const before = {
    calls: w.calls.length,
    store: w.fake.storeSets,
    sets: { ...w.fake.stateSets },
    writes: w.fake.fsWrites.length,
  }
  await ui.press({ key: 'clean' })
  await shows(ui, 'the plan view', PLAN_VIEW)
  await ui.press({ key: 'clean' }) // back
  await shows(ui, 'the rows', ROWS)
  await quiet(w.calls)
  expect(w.fake.toolRuns.TaskStop).toBeUndefined() // no TaskStop
  expect(w.calls).toHaveLength(before.calls) // no process run
  expect(w.store.has('v2:log')).toBe(false) // no audit log entry
  expect(w.fake.storeSets).toBe(before.store)
  expect(w.fake.fsWrites).toHaveLength(before.writes)
  expect(w.fake.stateSets).toEqual(before.sets) // no atom: `selected`, `hidden`, `filters`, `view`, `help`, `marks`
  expect(hiddenOf(w)).toEqual(hidden)
  await ui.unmount()
})

test('the plan is read at the press, not at each drawing: a task that starts later is not in the plan view until the next p', async ($, on) => {
  const w = await started($, on)
  const ui = await mountPane($, { bodyColumns: 96, bodyRows: 28, placement: 'dock', isFocused: true })
  await shows(ui, 'the rows', ROWS)
  await ui.press({ key: 'clean' })
  const plan = await shows(ui, 'the plan view', PLAN_VIEW)
  expect(plan).toContain('  sleep 1: stop')
  await startTask($, w, 2) // the command now plans two tasks
  await quiet(w.calls)
  expect(await commandLines($)).toContain('  sleep 2: stop')
  const calls = w.calls.length
  await ui.redraw() // real drawings, as the engine makes them
  await ui.redraw()
  const words = await wordsOf(ui)
  expect(words).toContain('  sleep 1: stop')
  expect(words).not.toContain('  sleep 2: stop') // a drawing does not read the plan again
  expect(w.calls.length).toBe(calls) // and runs no process
  expect(w.fake.toolRuns.TaskStop).toBeUndefined()
  await ui.press({ key: 'clean' }) // back to the rows ...
  await shows(ui, 'the rows', ROWS)
  await ui.press({ key: 'clean' }) // ... and the next p reads the plan again
  expect(await shows(ui, 'the plan view', PLAN_VIEW)).toContain('  sleep 2: stop')
  await ui.unmount()
})

test('p again goes back to the rows', async ($, on) => {
  await started($, on)
  const ui = await mountPane($, { bodyColumns: 96, bodyRows: 28, placement: 'dock', isFocused: true })
  await shows(ui, 'the rows', ROWS)
  await ui.press({ key: 'clean' })
  await shows(ui, 'the plan view', PLAN_VIEW)
  await ui.press({ key: 'clean' })
  const rows = await shows(ui, 'the rows', ROWS)
  expect(rows).not.toContain('Clean plan. Nothing changed.')
  await ui.unmount()
})

test('an inline pane of 11 rows shows a cut of the plan: the title, the kind head, steps, a count and the footer', async ($, on) => {
  await started($, on, 12)
  const ui = await mountPane($, { bodyColumns: 96, bodyRows: 11, placement: 'inline', isFocused: true })
  await ui.press({ key: 'clean' })
  const words = await shows(ui, 'the plan view', PLAN_VIEW)
  expect(words).toContain('Tasks (apply with /track clean --yes tasks)') // the head that names the --yes of its kind
  const steps = words.filter(w => /^ {2}sleep \d+: stop$/.test(w))
  expect(steps.length).toBeGreaterThan(0)
  expect(steps.length).toBeLessThan(12)
  expect(words.some(w => /^ {2}and \d+ more: \/track clean$/.test(w))).toBe(true) // the count says where the full list is
  expect(await ui.find({ text: 'Esc close' })).toBeDefined() // the footer is in the body
  await ui.unmount()
})
