// The words and the arguments of `/track clean` (issue #122): the parser, the plan by kind with its `skipped:` lines, the
// result text, and the log text. Pure: no ports, no trackers.
import { expect, test } from 'claude-code/testing'
import type { CleanStep, LogEntry } from '../core/interfaces/clean'
import { CLEAN_USAGE, type Line, logText, parseClean, planText, resultText } from '../core/lib/clean-text'

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
