// The generic helpers of core/lib that the trackers share: level order and markers, text spans, ages, tool notes.
// Plan: L5 Task 2.
import { expect, test } from 'claude-code/testing'
import { byLevel, type Level, markerOf, mergePriority, rankOf, withPriority } from '../core/lib/levels'
import { maskSpans } from '../core/lib/mask'
import { ago, compactIds, firstLine, message, toolNote } from '../core/lib/text'
import { expectLinear } from './fixtures/scaling'

test('maskSpans blanks each span and keeps the length', () => {
  const text = 'see https://a.b/c now'
  const out = maskSpans(text, [{ start: 4, end: 17 }])
  expect(out).toBe(`see ${' '.repeat(13)} now`)
  expect(out.length).toBe(text.length)
  expect(maskSpans('abc', [])).toBe('abc')
})

test('maskSpans blanks several spans and ignores one outside the text', () => {
  expect(
    maskSpans('abcdef', [
      { start: 0, end: 2 },
      { start: 4, end: 6 },
    ]),
  ).toBe('  cd  ')
  expect(maskSpans('abc', [{ start: 5, end: 9 }])).toBe('abc')
})

test('maskSpans takes spans in any order, overlapping or touching, in one pass', async () => {
  expect(
    maskSpans('abcdefgh', [
      { start: 5, end: 7 },
      { start: 1, end: 4 },
      { start: 3, end: 6 },
      { start: -3, end: 1 },
    ]),
  ).toBe('       h')
  expect(maskSpans('abc', [{ start: 2, end: 2 }])).toBe('abc')
  // One pass: the cost grows with the length of the text plus the number of spans, not with their product. A text of
  // 200 000 characters and 50 000 spans is the big input, a fourth of both the small one.
  const big = (k: number) => ({
    text: 'x'.repeat(50_000 * k),
    spans: Array.from({ length: 12_500 * k }, (_, i) => ({ start: i * 4, end: i * 4 + 2 })),
  })
  await expectLinear({ make: big, run: ({ text, spans }) => maskSpans(text, spans) })
  const { text, spans } = big(4)
  expect(maskSpans(text, spans).length).toBe(text.length)
})

test('levels: the order is top, high, normal, low; no level reads as normal', () => {
  const levels: Level[] = ['low', 'top', 'normal', 'high']
  expect(levels.sort(byLevel)).toEqual(['top', 'high', 'normal', 'low'])
  expect(byLevel(undefined, 'normal')).toBe(0)
  expect(rankOf(undefined)).toBe(rankOf('normal'))
  const marks: (Level | undefined)[] = ['top', 'high', 'normal', 'low', undefined]
  expect(marks.map(markerOf)).toEqual(['★', '▲', '', '▽', ''])
})

test('levels: the higher of two marks wins, and a set mark beats none', () => {
  expect(mergePriority(undefined, 'low')).toBe('low')
  expect(mergePriority('high', undefined)).toBe('high')
  expect(mergePriority('low', 'high')).toBe('high')
  expect(withPriority({ priority: 'low' as const, n: 1 }, undefined)).toEqual({ n: 1 })
})

test('text: age, tool note, compact ids and first line', () => {
  expect([0, 12_000, 4 * 60_000, 2 * 3_600_000, 3 * 86_400_000].map(ago)).toEqual(['now', '12s', '4m', '2h', '3d'])
  const idle = { name: 'tool', available: true, loggedIn: true, breaker: 'closed' } as const
  expect(toolNote({ ...idle, available: null }, 0)).toBe('checking…')
  expect(toolNote(idle, 100_000, 40_000)).toBe('refreshed 1m ago')
  expect(compactIds('agent-0123456789abcdef')).toBe('agent-01234567')
  expect(firstLine('  one\ntwo')).toBe('one')
  expect(message(new Error('boom'))).toBe('boom')
})
