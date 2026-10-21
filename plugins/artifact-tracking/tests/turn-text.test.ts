// The words of the turn ledger (issue #69): the reply of `/track turn [n]` and the counts of the band. Pure.
import { expect, test } from 'claude-code/testing'
import type { TurnEntry, TurnLedger, TurnRecord } from '../core/interfaces/turns'
import { bandCounts, clockOf, TURN_USAGE, turnText } from '../core/lib/turn-text'
import { emptyLedger, MAX_TURNS } from '../core/lib/turns'

const entry = (k: string, r: TurnEntry['r'] = 'mentioned', late = false): TurnEntry => ({
  k,
  c: 'github',
  r,
  ...(late ? { late: true as const } : {}),
})
const record = (ord: number, over: Partial<TurnRecord> = {}): TurnRecord => ({
  ord,
  turnId: `t${ord}`,
  session: 's1',
  startedAt: 0,
  end: 'answer',
  new: [],
  seen: [],
  ...over,
})
const ledger = (...turns: TurnRecord[]): TurnLedger => ({ ...emptyLedger(), next: (turns.at(-1)?.ord ?? 0) + 1, turns })
const env = { session: 's1', label: (e: TurnEntry) => `label of ${e.k}`, time: () => '12:31' }

test('bandCounts reads +n new and n seen again, and leaves a part out when it is 0', () => {
  expect(bandCounts(record(1, { new: [entry('a'), entry('b'), entry('c')], seen: [entry('d')] }))).toBe(
    '+3 new · 1 seen again',
  )
  expect(bandCounts(record(1, { new: [entry('a')] }))).toBe('+1 new')
  expect(bandCounts(record(1, { seen: [entry('a'), entry('b')] }))).toBe('2 seen again')
  expect(bandCounts(record(1))).toBe('')
  // The entries that did not fit the cap count too.
  expect(bandCounts(record(1, { new: [entry('a')], moreNew: 9, seen: [entry('b')], moreSeen: 4 }))).toBe(
    '+10 new · 5 seen again',
  )
})

test('turnText with no turn says so', () => {
  expect(turnText(emptyLedger(), undefined, env)).toBe('No turn tracked yet.')
  expect(turnText(emptyLedger(), 3, env)).toBe('No turn tracked yet.')
})

test('turnText prints the newest turn: the head, then each item, new first, with its reason', () => {
  const l = ledger(
    record(6, { new: [entry('old')] }),
    record(7, {
      startedAt: 1,
      prompt: 'fix the flaky test in the runner',
      new: [entry('gh:o/r#12', 'created'), entry('gh:o/r#13')],
      seen: [entry('gh:o/r#5')],
    }),
  )
  expect(turnText(l, undefined, env)).toBe(
    [
      'Turn 7 · answer · 12:31 · "fix the flaky test in the runner" · 2 new, 1 seen again',
      '  new    label of gh:o/r#12  created',
      '  new    label of gh:o/r#13  mentioned',
      '  again  label of gh:o/r#5   mentioned',
    ].join('\n'),
  )
  expect(turnText(l, 7, env)).toBe(turnText(l, undefined, env))
  expect(turnText(l, 6, env).split('\n')[0]).toBe('Turn 6 · answer · 12:31 · 1 new')
})

test('turnText marks an earlier session, a running turn, a late item, a wake and a turn with nothing', () => {
  const l = ledger(
    record(1, { session: 'other', end: undefined, endedAt: undefined }),
    record(2, { end: 'aborted', wakes: 2, new: [entry('a', 'read', true)] }),
    record(3, { end: undefined }),
  )
  const open = { ...l, open: { ord: 3, turnId: 't3' } }
  expect(turnText(open, 1, env)).toBe('Turn 1 (earlier session) · 12:31 · nothing tracked') // lost: no end, not running
  expect(turnText(open, 2, env)).toBe(
    ['Turn 2 · aborted · 12:31 · 1 new · 2 wakes', '  new    label of a  read · late (subagent)'].join('\n'),
  )
  expect(turnText(open, 3, env)).toBe('Turn 3 · running · 12:31 · nothing tracked')
  expect(turnText(ledger(record(4, { wakes: 1 })), 4, env)).toBe('Turn 4 · answer · 12:31 · nothing tracked · 1 wake')
})

test('turnText adds an ellipsis to a prompt that filled the 60 characters, and none to a shorter one', () => {
  const full = 'x'.repeat(60)
  expect(turnText(ledger(record(1, { prompt: full })), 1, env).split('\n')[0]).toContain(`"${full}…"`)
  expect(turnText(ledger(record(1, { prompt: 'short' })), 1, env).split('\n')[0]).toContain('"short"')
})

test('turnText counts the entries that did not fit and cuts a long label', () => {
  const long = (e: TurnEntry) => `${e.k} ${'y'.repeat(80)}`
  const l = ledger(record(1, { new: [entry('a')], moreNew: 12, seen: [entry('b')], moreSeen: 1 }))
  const lines = turnText(l, 1, { ...env, label: long }).split('\n')
  expect(lines[0]).toContain('13 new, 2 seen again')
  expect(lines[1]!.startsWith('  new    a y')).toBe(true)
  expect(lines[1]).toContain('…  mentioned')
  expect(lines[2]).toBe('  new    and 12 more not listed')
  expect(lines[4]).toBe('  again  and 1 more not listed')
})

test('turnText names a turn the cap dropped and a turn it has not reached', () => {
  const turns = Array.from({ length: MAX_TURNS }, (_, i) => record(i + 3))
  const l = ledger(...turns)
  expect(turnText(l, 2, env)).toBe(`Turn 2 is no longer kept (the last ${MAX_TURNS} turns are, from turn 3).`)
  expect(turnText(l, 60, env)).toBe(`No turn 60 yet. The last is turn ${MAX_TURNS + 2}.`)
})

test('turnText uses the local clock by default, and the usage line is fixed', () => {
  const at = new Date(2026, 9, 21, 9, 5).getTime()
  expect(clockOf(at)).toBe('09:05')
  expect(turnText(ledger(record(1, { startedAt: at })), 1, { session: 's1', label: e => e.k })).toContain(' · 09:05 · ')
  expect(TURN_USAGE).toBe('Usage: /track turn [n]')
})
