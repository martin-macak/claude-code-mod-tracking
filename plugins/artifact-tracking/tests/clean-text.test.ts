// The words and the arguments of `/track clean` (issue #122): the parser, the plan by kind with its `skipped:` lines, the
// result text, and the log text. The plan is one list of typed lines (issue #199): `planLines` makes it, `planLinesText` joins
// it for the reply of `/track clean`, and `planText` is the same join made from the steps.
// Pure: no ports, no trackers.
import { expect, test } from 'claude-code/testing'
import type { CleanStep, LogEntry } from '../core/interfaces/clean'
import {
  CLEAN_USAGE,
  type Line,
  logText,
  type PlanLine,
  parseClean,
  planLines,
  planLinesText,
  planText,
  resultText,
} from '../core/lib/clean-text'

const stop = (id: string, label = id, f: Partial<CleanStep> = {}): CleanStep => ({
  kind: 'tasks',
  id,
  label,
  action: 'stop',
  ...f,
})
const rm = (id: string, label = id, f: Partial<CleanStep> = {}): CleanStep => ({
  kind: 'worktrees',
  id,
  label,
  action: 'remove-record',
  ...f,
})
const lines = (...steps: CleanStep[]): Line[] => steps.map(step => ({ step }))

// ---------------------------------------------------------------- the arguments

test('no argument is the plan; --hide and --log are modes of their own', () => {
  expect(parseClean('')).toEqual({ mode: 'plan' })
  expect(parseClean('--hide')).toEqual({ mode: 'hide' })
  expect(parseClean('--log')).toEqual({ mode: 'log' })
})

test('--yes needs one kind or more, each named once, and nothing else', () => {
  expect(parseClean('--yes tasks')).toEqual({ mode: 'yes', kinds: ['tasks'] })
  expect(parseClean('--yes worktrees tasks')).toEqual({ mode: 'yes', kinds: ['worktrees', 'tasks'] })
  expect(parseClean('  --yes   tasks   tasks ')).toEqual({ mode: 'yes', kinds: ['tasks'] })
})

test('anything else is no mode: a bare --yes, an unknown kind or flag, a mix of modes', () => {
  for (const rest of [
    '--yes',
    '--yes all',
    '--yes tasks nope',
    'tasks',
    '--now',
    '--hide --log',
    '--hide tasks',
    '--log --yes tasks',
    '--yes --hide',
    '--yes tasks --hide',
  ])
    expect(parseClean(rest), rest).toBeUndefined()
  expect(CLEAN_USAGE).toBe('Usage: /track clean [--hide|--log|--yes <tasks|worktrees>...]')
})

// ---------------------------------------------------------------- the plan

test('a plan lists the steps by kind, with the action, and says nothing changed', () => {
  const text = planText(lines(rm('wt:/a', 'a'), stop('task:1', 'sleep 300')), [])
  expect(text.split('\n')).toEqual([
    'Clean plan. Nothing changed.',
    '',
    'Tasks (apply with /track clean --yes tasks)',
    '  sleep 300: stop',
    'Worktrees (apply with /track clean --yes worktrees)',
    '  a: remove record',
    '',
    'Hide: /track clean --hide hides every ended row now, and /track show-all shows them again.',
    'Log: /track clean --log',
  ])
})

// Owner decision Q2 of #123: git deletes the ignored files of a worktree with it, so the plan line says so.
test('a remove-worktree step reads: remove worktree, if clean and merged, and it deletes ignored files', () => {
  const step: CleanStep = { kind: 'worktrees', id: 'wt:/w/a', label: '/w/a', action: 'remove-worktree' }
  expect(planText(lines(step), [])).toContain(
    'Worktrees (apply with /track clean --yes worktrees)\n  /w/a: remove worktree (if clean and merged; deletes ignored files)\n',
  )
  expect(planText(lines({ ...step, skip: 'not enabled' }), [])).toContain('  /w/a: skipped: not enabled\n')
})

test('a step with a reason is a skipped: line', () => {
  const text = planText(lines(stop('task:1', 'sleep 300'), stop('task:2', 'npm run dev', { skip: 'no task id' })), [])
  expect(text).toContain('  sleep 300: stop\n  npm run dev: skipped: no task id\n')
})

test('with no step the plan says there is nothing to stop or remove, and the hide line stays', () => {
  const text = planText([], [])
  expect(text).toContain('Nothing to stop or remove.')
  expect(text).not.toContain('Tasks')
  expect(text).toContain('Hide: /track clean --hide')
})

test('each kind shows 10 lines and a count of the rest', () => {
  const many = Array.from({ length: 13 }, (_, i) => stop(`task:${i}`, `job ${i}`))
  const text = planText(lines(...many), [])
  expect(text).toContain('  job 9: stop')
  expect(text).not.toContain('job 10')
  expect(text).toContain('  and 3 more.')
  expect(planText(lines(...many.slice(0, 11)), [])).toContain('  and 1 more.')
  expect(planText(lines(...many.slice(0, 10)), [])).not.toContain('more')
})

test('a tracker whose plan failed is named under Problems', () => {
  const text = planText(lines(stop('task:1')), ['auto: plan failed: boom'])
  expect(text).toContain('Problems:\n  auto: plan failed: boom')
})

// ---------------------------------------------------------------- the plan as typed lines (issue #199)

const HIDE = 'Hide: /track clean --hide hides every ended row now, and /track show-all shows them again.'
const LOG = 'Log: /track clean --log'
const line = (role: PlanLine['role'], text: string): PlanLine => ({ role, text })

test('planLines types each line of a plan: title, blank, kind head, step, problem head, problem and hints', () => {
  const plan = planLines(
    // The worktree comes first in the input: the plan still lists the kinds in the order of CLEAN_KINDS.
    lines(rm('wt:/a', 'a'), stop('task:1', 'sleep 300'), stop('task:2', 'npm run dev', { skip: 'no task id' })),
    ['auto: plan failed: boom', 'processes: plan failed: bang'],
  )
  expect(plan).toEqual([
    line('title', 'Clean plan. Nothing changed.'),
    line('blank', ''),
    line('head', 'Tasks (apply with /track clean --yes tasks)'),
    line('step', '  sleep 300: stop'),
    line('step', '  npm run dev: skipped: no task id'),
    line('head', 'Worktrees (apply with /track clean --yes worktrees)'),
    line('step', '  a: remove record'),
    line('blank', ''),
    line('head', 'Problems:'),
    line('problem', '  auto: plan failed: boom'),
    line('problem', '  processes: plan failed: bang'),
    line('blank', ''),
    line('hint', HIDE),
    line('hint', LOG),
  ])
})

test('planLines of an empty plan holds one head that says there is nothing to do, and the hints', () => {
  expect(planLines([], [])).toEqual([
    line('title', 'Clean plan. Nothing changed.'),
    line('blank', ''),
    line('head', 'Nothing to stop or remove.'),
    line('blank', ''),
    line('hint', HIDE),
    line('hint', LOG),
  ])
})

test('planLines of a plan with no step and a failed tracker keeps the empty head and the problems', () => {
  const plan = planLines([], ['processes: plan failed: boom'])
  expect(plan.map(l => l.role)).toEqual(['title', 'blank', 'head', 'blank', 'head', 'problem', 'blank', 'hint', 'hint'])
  expect(plan[2]?.text).toBe('Nothing to stop or remove.')
  expect(plan[4]?.text).toBe('Problems:')
  expect(plan[5]?.text).toBe('  processes: plan failed: boom')
})

// The pane view counts rows for each PlanLine (issue #199), so a line holds one row. A text from outside the module, a failure
// message or a step label, can hold a newline: it becomes one line for each row, and the joined text stays as it was.
test('a failed line that holds a newline is one problem line for each row, and the text stays the same', () => {
  const plan = planLines([], ['auto: plan failed: line one\nline two'])
  expect(plan.filter(l => l.text.includes('\n'))).toEqual([])
  expect(plan.filter(l => l.role === 'problem').map(l => l.text)).toEqual(['  auto: plan failed: line one', 'line two'])
  expect(planLinesText(plan)).toContain('Problems:\n  auto: plan failed: line one\nline two\n')
  // The result of `--yes` writes the same failure with the same bytes.
  expect(resultText(['tasks'], [], ['auto: plan failed: line one\nline two'])).toContain(
    'Problems:\n  auto: plan failed: line one\nline two\n',
  )
})

test('a step label that holds a newline is one step line for each row, and the text stays the same', () => {
  const plan = planLines(lines(stop('task:1', 'echo one\necho two'), rm('wt:/a', 'a')), [])
  expect(plan.filter(l => l.text.includes('\n'))).toEqual([])
  expect(plan.filter(l => l.role === 'step').map(l => l.text)).toEqual([
    '  echo one',
    'echo two: stop',
    '  a: remove record',
  ])
  expect(planLinesText(plan)).toContain('  echo one\necho two: stop\n')
  // The cap counts steps, not rows: 10 steps of two rows are not over the cap.
  const two = Array.from({ length: 10 }, (_, i) => stop(`task:${i}`, `a${i}\nb${i}`))
  expect(planLines(lines(...two), []).some(l => l.role === 'more')).toBe(false)
  // All 10 steps show, 2 rows each. A cap on rows would keep 5 steps and drop the rest with no count.
  expect(planLines(lines(...two), []).filter(l => l.role === 'step')).toHaveLength(20)
  // Over the cap: the first 10 steps show with their rows, and the count names the 1 left out.
  const eleven = [...two, stop('task:10', 'a10\nb10')]
  const over = planLines(lines(...eleven), [])
  expect(over.filter(l => l.role === 'step')).toHaveLength(20)
  expect(over.filter(l => l.role === 'more').map(l => l.text)).toEqual(['  and 1 more.'])
})

test('planLines closes a kind of more than 10 steps with one more line, and the kinds after it follow', () => {
  const many = Array.from({ length: 13 }, (_, i) => stop(`task:${i}`, `job ${i}`))
  const plan = planLines(lines(...many, rm('wt:/a', 'a')), [])
  expect(plan.slice(2, 14).map(l => l.role)).toEqual(['head', ...Array(10).fill('step'), 'more'])
  expect(plan[13]).toEqual({ ...line('more', '  and 3 more.'), count: 3 })
  expect(plan[14]).toEqual(line('head', 'Worktrees (apply with /track clean --yes worktrees)'))
  expect(plan.filter(l => l.role === 'step')).toHaveLength(11) // 10 tasks and 1 worktree
  // Exactly 10 is not over: no more line.
  expect(planLines(lines(...many.slice(0, 10)), []).some(l => l.role === 'more')).toBe(false)
})

// The pane view cuts a plan by steps (issue #199), so a line says what it is a part of, and a view needs no parse of its words.
test('a more line says how many steps it stands for', () => {
  const count = (n: number) =>
    planLines(lines(...Array.from({ length: n }, (_, i) => stop(`task:${i}`))), [])
      .filter(l => l.role === 'more')
      .map(l => l.count)
  expect(count(10)).toEqual([])
  expect(count(11)).toEqual([1])
  expect(count(40)).toEqual([30])
})

test('a row after the first of a step or a problem that holds a newline continues the line above it', () => {
  const plan = planLines(lines(stop('task:1', 'echo one\necho two\necho three'), stop('task:2', 'sleep 1')), [
    'auto: plan failed: a\nb',
  ])
  expect(plan.filter(l => l.role === 'step').map(l => [l.text, l.cont === true])).toEqual([
    ['  echo one', false],
    ['echo two', true],
    ['echo three: stop', true],
    ['  sleep 1: stop', false],
  ])
  expect(plan.filter(l => l.role === 'problem').map(l => [l.text, l.cont === true])).toEqual([
    ['  auto: plan failed: a', false],
    ['b', true],
  ])
  // Only the lines of a text that held a newline carry the mark: a plan of one-row texts has none.
  expect(planLines(lines(stop('task:1'), rm('wt:/a')), ['x: plan failed: y']).some(l => 'cont' in l)).toBe(false)
})

// The one function of the plan: the reply of `/track clean` and the pane read the same lines, so they cannot differ.
test('planText is the lines joined with a newline, and planLinesText joins any list of lines the same way', () => {
  const cases: [Line[], string[]][] = [
    [[], []],
    [lines(stop('task:1', 'sleep 300')), []],
    [lines(rm('wt:/a', 'a'), stop('task:1')), ['auto: plan failed: boom']],
    [lines(...Array.from({ length: 12 }, (_, i) => stop(`task:${i}`))), ['x: plan failed: y']],
  ]
  for (const [steps, failed] of cases) {
    const plan = planLines(steps, failed)
    expect(planText(steps, failed)).toBe(plan.map(l => l.text).join('\n'))
    expect(planLinesText(plan)).toBe(planText(steps, failed))
  }
  // The text of an empty plan, byte for byte (6 rows).
  expect(planText([], [])).toBe(
    ['Clean plan. Nothing changed.', '', 'Nothing to stop or remove.', '', HIDE, LOG].join('\n'),
  )
})

// ---------------------------------------------------------------- the result

test('a result lists each step with done or skipped: <reason>, by the kinds that ran', () => {
  const text = resultText(
    ['tasks'],
    [
      { step: stop('task:1', 'sleep 300'), outcome: 'done' },
      { step: stop('task:2', 'make test'), outcome: 'skipped: No task found with ID: 2' },
      { step: stop('task:3', 'npm run dev', { skip: 'no task id' }), outcome: 'skipped: no task id' },
    ],
    [],
  )
  expect(text.split('\n')).toEqual([
    'Cleaned: tasks.',
    '',
    'Tasks',
    '  sleep 300: done',
    '  make test: skipped: No task found with ID: 2',
    '  npm run dev: skipped: no task id',
    '',
    'Log: /track clean --log',
  ])
})

test('a result for kinds with no step says there was nothing to do; a failed plan is named', () => {
  const text = resultText(['tasks', 'worktrees'], [], ['processes: plan failed: boom'])
  expect(text).toContain('Cleaned: tasks, worktrees.')
  expect(text).toContain('Nothing to do.')
  expect(text).toContain('Problems:\n  processes: plan failed: boom')
})

// ---------------------------------------------------------------- the log

const entry = (n: number, f: Partial<LogEntry> = {}): LogEntry => ({
  at: Date.UTC(2026, 9, 21, 12, 0, n),
  by: 'manual',
  kind: 'tasks',
  id: `task:t${n}`,
  action: 'stop',
  outcome: 'done',
  ...f,
})

test('the log text lists the entries in the order given, one line each: time, manual, kind, id, action, outcome', () => {
  const text = logText([
    entry(2),
    entry(1, { kind: 'worktrees', id: 'wt:/a', action: 'remove-record', outcome: 'skipped: locked' }),
  ])
  expect(text.split('\n')).toEqual([
    'Clean log, newest first (2 entries):',
    '  2026-10-21T12:00:02.000Z  manual  tasks  task:t2  stop  done',
    '  2026-10-21T12:00:01.000Z  manual  worktrees  wt:/a  remove-record  skipped: locked',
  ])
})

test('an empty log says so, and a long log shows 50 lines and a count', () => {
  expect(logText([])).toBe('The clean log is empty.')
  expect(logText([entry(1)]).split('\n')[0]).toBe('Clean log, newest first (1 entry):')
  const text = logText(Array.from({ length: 120 }, (_, i) => entry(i % 60, { id: `task:${i}` })))
  const rows = text.split('\n')
  expect(rows[0]).toBe('Clean log, newest first (120 entries):')
  expect(rows).toHaveLength(1 + 50 + 1)
  expect(rows.at(-1)).toBe('  and 70 more entries.')
})
