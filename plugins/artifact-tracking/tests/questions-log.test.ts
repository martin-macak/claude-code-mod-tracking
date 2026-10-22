// The log of calls that the questions tracker keeps in its slot (issue #71): the merge without duplicates, the numbers, and
// the caps of 100 calls and 256 KiB with the oldest dropped first. Pure.
import { expect, test } from 'claude-code/testing'
import type { Json } from '../core/interfaces/items'
import { addCall, asCalls, capCalls, joinCall, mergeCalls, nextNumber, sizeOf } from '../trackers/questions/log'
import type { QuestionCall } from '../trackers/questions/types'

const call = (id: string, n: number, over: Partial<QuestionCall> = {}): QuestionCall => ({
  id,
  n,
  kind: 'ask',
  state: 'answered',
  at: n * 1000,
  items: [{ question: `Question ${n}?`, header: `H${n}`, multiSelect: false, options: [{ label: 'A' }], answer: 'A' }],
  ...over,
})
const ids = (calls: readonly QuestionCall[]) => calls.map(c => c.id)
const CAPS = { maxCalls: 100, maxBytes: 262_144 }

// ---------------------------------------------------------------- reading the slot

test('asCalls reads a list of records and nothing else', () => {
  expect(asCalls(undefined)).toEqual([])
  expect(asCalls({} as Json)).toEqual([])
  expect(asCalls('x')).toEqual([])
  const one = call('a', 1)
  expect(asCalls([one as unknown as Json, null, 'x', { n: 1 }, { id: 'b' }] as unknown as Json)).toEqual([one])
})

// ---------------------------------------------------------------- the merge

test('mergeCalls puts the older list first and the newer after it, and a call that both hold is one record', () => {
  const merged = mergeCalls([call('a', 1), call('b', 2)], [call('b', 2), call('c', 3)])
  expect(ids(merged)).toEqual(['a', 'b', 'c'])
})

test('mergeCalls gives the same set whichever list comes first', () => {
  const [x, y] = [
    [call('a', 1), call('b', 2)],
    [call('b', 2), call('c', 3)],
  ]
  expect(new Set(ids(mergeCalls(x!, y!)))).toEqual(new Set(ids(mergeCalls(y!, x!))))
})

test('a call that was seen live beats the same call read back from the transcript, and a missing turn is filled in', () => {
  const live = call('a', 1, { turn: 7 })
  const back = call('a', 4, { replayed: true, at: 99_999 })
  expect(mergeCalls([back], [live])).toEqual([live])
  const kept = joinCall(call('a', 1, { at: 1 }), call('a', 1, { turn: 3, at: 2 }))
  expect(kept).toEqual(call('a', 1, { at: 1, turn: 3 }))
  expect(joinCall(call('a', 1, { turn: 2 }), call('a', 1, { turn: 3 })).turn).toBe(2)
})

test('mergeCalls numbers a call anew when its number is taken by another call', () => {
  const merged = mergeCalls([call('a', 1), call('b', 2)], [call('x', 1), call('y', 2), call('z', 5)])
  expect(merged.map(c => [c.id, c.n])).toEqual([
    ['a', 1],
    ['b', 2],
    ['x', 3],
    ['y', 4],
    ['z', 5],
  ])
})

test('mergeCalls never gives two calls one number, also when a live copy joins a replayed one', () => {
  const merged = mergeCalls(
    [call('x', 1, { replayed: true, at: 50 }), call('y', 2)],
    [call('w', 2), call('x', 3, { turn: 4 })],
  )
  expect(merged.map(c => [c.id, c.n])).toEqual([
    ['x', 1], // the live copy has number 3, which w took: the joined call keeps the number it had
    ['y', 2],
    ['w', 3],
  ])
  expect(merged[0]).toMatchObject({ turn: 4 }) // the live copy still wins
  expect(mergeCalls([call('x', 1, { replayed: true })], [call('x', 3, { turn: 4 })]).map(c => c.n)).toEqual([3]) // a free number is taken
})

test('mergeCalls of a list with an empty one is that list', () => {
  const list = [call('a', 1)]
  expect(mergeCalls(list, [])).toBe(list)
  expect(mergeCalls([], list)).toEqual(list)
})

// ---------------------------------------------------------------- adding and finding

test('nextNumber goes on from the highest number, which stays when older calls drop', () => {
  expect(nextNumber([])).toBe(1)
  expect(nextNumber([call('c', 7), call('d', 9)])).toBe(10)
})

test('addCall numbers the call and stamps the time, the turn and the replay mark', () => {
  const body = { id: 'a', kind: 'ask' as const, state: 'answered' as const }
  const [first] = addCall([], body, { at: 5, turn: 2 })
  expect(first).toEqual({ ...body, n: 1, at: 5, turn: 2 })
  const list = addCall([first!], { ...body, id: 'b' }, { at: 6, replayed: true })
  expect(list.map(c => [c.id, c.n, c.replayed])).toEqual([
    ['a', 1, undefined],
    ['b', 2, true],
  ])
})

test('addCall with a known id changes nothing but a missing turn', () => {
  const list = [call('a', 1)]
  const body = { id: 'a', kind: 'ask' as const, state: 'answered' as const }
  expect(addCall(list, body, { at: 9 })).toBe(list)
  expect(addCall(list, body, { at: 9, turn: 4 })).toEqual([{ ...list[0]!, turn: 4 }])
})

// ---------------------------------------------------------------- the caps

test('a session keeps at most 100 calls, and the oldest drop first', () => {
  const list = Array.from({ length: 130 }, (_, i) => call(`c${i + 1}`, i + 1))
  const kept = capCalls(list, CAPS)
  expect(kept).toHaveLength(100)
  expect(kept[0]?.id).toBe('c31')
  expect(kept.at(-1)?.id).toBe('c130')
  expect(kept[0]?.n).toBe(31) // the number stays
})

test('a call is about 1.6 KB, so 100 of them fit in 256 KiB', () => {
  const big = (i: number) => call(`c${i}`, i, { items: [{ ...call('x', 1).items![0]!, notes: 'n'.repeat(1400) }] })
  const list = Array.from({ length: 100 }, (_, i) => big(i + 1))
  expect(sizeOf(list[0]!)).toBeGreaterThan(1500)
  expect(capCalls(list, CAPS)).toHaveLength(100)
})

test('a session keeps at most 256 KiB, and the oldest drop first', () => {
  const big = (i: number) => call(`c${i}`, i, { items: [{ ...call('x', 1).items![0]!, notes: 'n'.repeat(20_000) }] })
  const list = Array.from({ length: 30 }, (_, i) => big(i + 1))
  const kept = capCalls(list, CAPS)
  expect(JSON.stringify(kept).length).toBeLessThanOrEqual(262_144)
  expect(kept.length).toBeLessThan(30)
  expect(kept.at(-1)?.id).toBe('c30')
  expect(ids(kept)).toEqual(ids(list).slice(30 - kept.length))
})

test('the caps change nothing, and return the same list, when the list fits', () => {
  const list = [call('a', 1), call('b', 2)]
  expect(capCalls(list, CAPS)).toBe(list)
})

test('a call that passes the byte cap alone is cut: its longest texts shrink, it stays, and it says so', () => {
  const long = call('huge', 3, {
    state: 'declined',
    items: [
      {
        question: 'Which one?',
        header: 'Pick',
        multiSelect: false,
        options: [{ label: 'A', description: 'd', preview: 'p'.repeat(200_000) }],
        answer: 'A',
        notes: 'short note',
      },
    ],
    refusal: 'r'.repeat(100_000),
  })
  const [kept] = capCalls([call('old', 1), long], { maxCalls: 100, maxBytes: 20_000 })
  expect(kept?.id).toBe('huge')
  expect(kept?.cut).toBe(true)
  expect(sizeOf(kept!)).toBeLessThanOrEqual(20_000)
  expect(kept?.n).toBe(3)
  expect(kept?.state).toBe('declined')
  // What was short stays word for word.
  expect(kept?.items?.[0]).toMatchObject({ question: 'Which one?', header: 'Pick', answer: 'A', notes: 'short note' })
  expect(kept?.items?.[0]?.options[0]?.preview?.endsWith('…')).toBe(true)
})

test('a call that fits is not marked as cut', () => {
  const [kept] = capCalls([call('a', 1)], { maxCalls: 10, maxBytes: 20_000 })
  expect(kept).not.toHaveProperty('cut')
})
