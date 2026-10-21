// The strip under an answer (issue #69, P2): the words of the line and the rule for which surface shows it. Pure.
// The shapes are the ones of the probe log of the design study (comment 2): a `turn.complete` text is a notice row under
// the duration line (L33, L199), an aborted turn has no duration line (L118 to L134).
import { expect, test } from 'claude-code/testing'
import type { TurnEntry, TurnLedger, TurnRecord } from '../core/interfaces/turns'
import { durationStrip, stripLine, stripText, withLine } from '../core/lib/turn-strip'
import { emptyLedger } from '../core/lib/turns'

const entry = (k: string): TurnEntry => ({ k, c: 'github', r: 'mentioned' })
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
const ROW = '05c26614-94d4-4b09-86c3-8ea6738495b2'

test('stripLine: the counts and the command that lists them; "seen again", never "updated"', () => {
  const r = record(7, { new: [entry('a'), entry('b'), entry('c')], seen: [entry('d')] })
  expect(stripLine(r)).toBe('+3 new · 1 seen again · /track turn 7')
  expect(stripLine(record(2, { new: [entry('a')] }))).toBe('+1 new · /track turn 2')
  expect(stripLine(record(3, { seen: [entry('a'), entry('b')] }))).toBe('2 seen again · /track turn 3')
  expect(stripLine(r)).not.toContain('updated')
})

test('stripLine counts the entries that did not fit the cap, as the band does', () => {
  const r = record(9, { new: [entry('a')], moreNew: 9, seen: [entry('b')], moreSeen: 4 })
  expect(stripLine(r)).toBe('+10 new · 5 seen again · /track turn 9')
})

test('stripLine: a turn that tracked nothing has no line', () => {
  expect(stripLine(record(1))).toBeUndefined()
})

test('stripText: off gives no line for any turn', () => {
  expect(stripText(record(1, { new: [entry('a')] }), 'off')).toBeUndefined()
})

test('stripText, text: a line for every end of a turn that tracked something, and none for a turn that tracked nothing', () => {
  const some = { new: [entry('a')] }
  for (const end of ['answer', 'aborted', 'refusal', 'error'] as const)
    expect(stripText(record(4, { ...some, end }), 'text')).toBe('+1 new · /track turn 4')
  expect(stripText(record(4), 'text')).toBeUndefined()
  expect(stripText(undefined, 'text')).toBeUndefined() // a wake has no record of its own
})

test('stripText, interactive: the duration line carries the strip of an answer, so the text line stays out', () => {
  const some = { new: [entry('a')] }
  expect(stripText(record(4, { ...some, durationRow: ROW }), 'interactive')).toBeUndefined()
})

test('stripText, interactive: an aborted turn has no duration line, so it gets the text line; refusal and error are treated alike (inference)', () => {
  const some = { new: [entry('a')] }
  for (const end of ['aborted', 'refusal', 'error'] as const) {
    expect(stripText(record(5, { ...some, end }), 'interactive')).toBe('+1 new · /track turn 5') // no duration row
    // Even when an engine build drew a duration line for it, the strip shows once: the render hook skips such a record.
    expect(stripText(record(5, { ...some, end, durationRow: ROW }), 'interactive')).toBe('+1 new · /track turn 5')
  }
})

test('stripText, interactive: an answer with no duration row (the row never reached the mod) falls back to the text line', () => {
  expect(stripText(record(6, { new: [entry('a')] }), 'interactive')).toBe('+1 new · /track turn 6')
  expect(stripText(record(6), 'interactive')).toBeUndefined()
})

test('durationStrip finds the record by the id of its duration row and gives the counts and the ordinal', () => {
  const l = ledger(
    record(1, { new: [entry('a')], durationRow: 'row-1' }),
    record(2, { new: [entry('b'), entry('c')], seen: [entry('a')], durationRow: ROW }),
  )
  expect(durationStrip(l, ROW)).toEqual({ ord: 2, counts: '+2 new · 1 seen again' })
  expect(durationStrip(l, 'row-1')).toEqual({ ord: 1, counts: '+1 new' })
  expect(durationStrip(l, 'unknown')).toBeUndefined()
})

test('durationStrip: no strip for a turn that tracked nothing, nor for a turn that did not end with an answer', () => {
  expect(durationStrip(ledger(record(1, { durationRow: ROW })), ROW)).toBeUndefined()
  const some = { new: [entry('a')], durationRow: ROW }
  for (const end of ['aborted', 'refusal', 'error'] as const)
    expect(durationStrip(ledger(record(1, { ...some, end })), ROW)).toBeUndefined()
  const { end: _running, ...running } = record(1, some) // not committed yet: the text line cannot be decided either
  expect(durationStrip(ledger(running as TurnRecord), ROW)).toBeUndefined()
})

test("withLine: the answer itself is the engine's text, so the line replaces it", () => {
  expect(withLine('the answer', 'the answer', '+1 new · /track turn 1')).toBe('+1 new · /track turn 1')
  expect(withLine('', '', '+1 new · /track turn 1')).toBe('+1 new · /track turn 1')
})

test('withLine: a text of another hook stays, and the line follows it on a new line', () => {
  expect(withLine('agents-md: a note', 'the answer', '+1 new · /track turn 1')).toBe(
    'agents-md: a note\n+1 new · /track turn 1',
  )
})

test('withLine: an empty text is no text of another hook, even when the answer has words', () => {
  expect(withLine('', 'the answer', '+1 new · /track turn 1')).toBe('+1 new · /track turn 1')
})
