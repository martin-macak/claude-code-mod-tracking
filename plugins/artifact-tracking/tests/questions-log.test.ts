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

test('mergeCalls never reuses a number of the older list, whether it is held or dropped: the numbers only grow', () => {
  // A restored list that the caps cut (Q5 to Q10) and a call that a fresh process counted from 1.
  const restored = [5, 6, 7, 8, 9, 10].map(n => call(`r${n}`, n))
  const merged = mergeCalls(restored, [call('live1', 1), call('live2', 2)])
  expect(merged.slice(6).map(c => [c.id, c.n])).toEqual([
    ['live1', 11],
    ['live2', 12],
  ])
  expect(new Set(merged.map(c => c.n)).size).toBe(merged.length)
  // A number above the older list stays, and the call after a restore goes on from the highest.
  expect(mergeCalls(restored, [call('ahead', 12)]).at(-1)?.n).toBe(12)
  expect(nextNumber(merged)).toBe(13)
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

// A cut shortens the question and the header, so the words that made a question ask for a secret (`password`, `token`) may
// be gone while the short typed answer stays whole. The cut marks the item before it cuts, and the masking reads the mark.
const longAsk = (question: string, header: string): QuestionCall =>
  call('huge', 2, {
    items: [
      {
        question,
        header,
        multiSelect: false,
        options: [{ label: 'A', preview: 'p'.repeat(200_000) }],
        answer: 'hunter2',
        notes: 'it is hunter2',
      },
    ],
  })
const TIGHT = { maxCalls: 100, maxBytes: 1000 }

test('a cut keeps the sign of a question that asked for a secret, also when the words are gone: the item says sensitive', () => {
  const [byQuestion] = capCalls([longAsk(`${'x'.repeat(400)} What is the password?`, 'Login')], TIGHT)
  expect(byQuestion?.cut).toBe(true)
  expect(byQuestion?.items?.[0]?.question).not.toMatch(/password/)
  expect(byQuestion?.items?.[0]?.sensitive).toBe(true)
  const [byHeader] = capCalls([longAsk('Which one?', `${'h'.repeat(400)} API key`)], TIGHT)
  expect(byHeader?.items?.[0]?.header).not.toMatch(/key/)
  expect(byHeader?.items?.[0]?.sensitive).toBe(true)
  expect(sizeOf(byQuestion!)).toBeLessThanOrEqual(TIGHT.maxBytes)
})

test('a cut keeps the sign of a question whose helper text asked for a secret, when the words are gone', () => {
  const ask = longAsk('Enter the value?', 'Value')
  const withHelp: QuestionCall = {
    ...ask,
    items: [{ ...ask.items![0]!, description: `${'x'.repeat(400)} Production password` }],
  }
  const [kept] = capCalls([withHelp], TIGHT)
  expect(kept?.cut).toBe(true)
  expect(kept?.items?.[0]?.description).not.toMatch(/password/)
  expect(kept?.items?.[0]?.sensitive).toBe(true)
})

test('the byte cap counts the characters of the list around a call and the cut mark: no call sits over the cap', () => {
  const body = (extra: number) =>
    call('only', 1, {
      items: [
        {
          question: 'Q?',
          header: 'H',
          multiSelect: false,
          options: [{ label: 'A' }],
          answer: 'A',
          notes: 'n'.repeat(extra),
        },
      ],
    })
  const fits = body(2000)
  const size = sizeOf(fits)
  // Around the size of the call itself: the list is two characters longer, and a cut call has the mark `"cut":true`.
  for (const maxBytes of [size - 3, size - 2, size - 1, size, size + 1, size + 2, size + 3, size + 11, size + 12]) {
    const [kept] = capCalls([fits], { maxCalls: 100, maxBytes })
    expect(sizeOf([kept!]), `maxBytes ${maxBytes}`).toBeLessThanOrEqual(maxBytes)
  }
  // A list of the call alone that fits is the same list, and the call is not marked.
  const roomy = capCalls([fits], { maxCalls: 100, maxBytes: size + 2 })
  expect(roomy[0]).toBe(fits)
  expect(roomy[0]).not.toHaveProperty('cut')
  // A call that was cut before has the mark already: it adds no more.
  const [again] = capCalls([{ ...body(5000), cut: true }], { maxCalls: 100, maxBytes: 3000 })
  expect(sizeOf([again!])).toBeLessThanOrEqual(3000)
  expect(again?.cut).toBe(true)
})

test('a plan that is cut has no questions to mark: its text is cut and the record says so', () => {
  const plan: QuestionCall = { id: 'p', n: 1, kind: 'plan', state: 'answered', at: 1, plan: 'x'.repeat(100_000) }
  const [kept] = capCalls([plan], TIGHT)
  expect(kept?.cut).toBe(true)
  expect(kept?.plan?.endsWith('…')).toBe(true)
  expect(kept).not.toHaveProperty('items')
})

test('a cut call with nothing secret in a question has no sensitive mark, and a call that fits has none either', () => {
  const [plain] = capCalls([longAsk(`${'x'.repeat(400)} Which one?`, 'Pick')], TIGHT)
  expect(plain?.cut).toBe(true)
  expect(plain?.items?.[0]).not.toHaveProperty('sensitive')
  const fits = [call('a', 1, { items: [{ ...call('x', 1).items![0]!, question: 'What is the password?' }] })]
  expect(capCalls(fits, CAPS)).toBe(fits) // the same list: no write, no mark
  expect(fits[0]?.items?.[0]).not.toHaveProperty('sensitive')
})

// ---------------------------------------------------------------- the replay watermark

const plugin = (id: string, n: number, over: Partial<QuestionCall> = {}) => call(id, n, { plugin: true, ...over })
const TWO = { maxCalls: 2, maxBytes: 262_144 }
const ONE = { maxCalls: 1, maxBytes: 262_144 }

test('the caps leave the id of the newest dropped call of the transcript on the first call that stays: the watermark', () => {
  const kept = capCalls([call('a', 1), call('b', 2), call('c', 3)], TWO)
  expect(kept.map(c => [c.id, c.watermark])).toEqual([
    ['b', 'a'],
    ['c', undefined],
  ])
  const more = capCalls(addCall(kept, { id: 'd', kind: 'ask', state: 'answered' }, { at: 9 }), TWO)
  expect(more.map(c => [c.id, c.watermark])).toEqual([
    ['c', 'b'], // the mark moves on with the calls that drop
    ['d', undefined],
  ])
})

test('a plugin call or a subagent call that drops makes no watermark: the transcript of the main loop has neither', () => {
  const list = [plugin('p', 1), call('s', 2, { agentId: 'agent-1' }), call('c', 3), call('d', 4)]
  expect(capCalls(list, ONE).map(c => [c.id, c.watermark])).toEqual([['d', 'c']])
  const none = capCalls([plugin('p', 1), call('s', 2, { agentId: 'agent-1' }), call('d', 4)], ONE)
  expect(none.map(c => [c.id, 'watermark' in c])).toEqual([['d', false]])
})

test('a dropped call that carries a watermark hands it on when no call of the transcript drops after it', () => {
  const kept = capCalls([plugin('p1', 1, { watermark: 'x' }), plugin('p2', 2), plugin('p3', 3)], TWO)
  expect(kept.map(c => [c.id, c.watermark])).toEqual([
    ['p2', 'x'],
    ['p3', undefined],
  ])
  // A call of the transcript after the carrier is newer than its mark.
  const newer = capCalls([plugin('p1', 1, { watermark: 'x' }), call('c', 2), call('d', 3)], ONE)
  expect(newer[0]?.watermark).toBe('c')
})

test('the first call that stays keeps the watermark it has: the mark of a list that was capped before is the newer one', () => {
  const kept = capCalls([call('old', 1), call('b', 2, { watermark: 'x' })], ONE)
  expect(kept.map(c => [c.id, c.watermark])).toEqual([['b', 'x']])
})

test('the byte cap leaves a watermark too, and the mark counts: a list that the mark tips over the cap loses one more call', () => {
  const [a, b, c] = [call('a', 1), call('b', 2), call('c', 3)] as [QuestionCall, QuestionCall, QuestionCall]
  // Without the mark, b and c fit exactly. With it they do not, so b drops too and its id is the mark.
  const tight = capCalls([a, b, c], { maxCalls: 100, maxBytes: sizeOf([b, c]) })
  expect(tight.map(x => [x.id, x.watermark])).toEqual([['c', 'b']])
  expect(sizeOf(tight)).toBeLessThanOrEqual(sizeOf([b, c]))
  const roomy = capCalls([a, b, c], { maxCalls: 100, maxBytes: sizeOf([b, c]) + 40 })
  expect(roomy.map(x => [x.id, x.watermark])).toEqual([
    ['b', 'a'],
    ['c', undefined],
  ])
  expect(sizeOf(roomy)).toBeLessThanOrEqual(sizeOf([b, c]) + 40)
})

test('a list within the caps comes back as it is, and carries no watermark', () => {
  const list = [call('a', 1), call('b', 2)]
  expect(capCalls(list, CAPS)).toBe(list)
  expect(list.some(c => 'watermark' in c)).toBe(false)
})

test('a call that is cut to fit keeps its watermark whole', () => {
  const huge = call('huge', 2, {
    items: [
      {
        question: 'Q?',
        header: 'H',
        multiSelect: false,
        options: [{ label: 'A', preview: 'p'.repeat(100_000) }],
        answer: 'A',
      },
    ],
  })
  const [kept] = capCalls([call('old', 1), huge], { maxCalls: 1, maxBytes: 20_000 })
  expect(kept?.cut).toBe(true)
  expect(kept?.watermark).toBe('old')
  expect(sizeOf(kept!)).toBeLessThanOrEqual(20_000)
})

test('two copies of one call join with the watermark that either has, and a new call keeps the one it carries', () => {
  expect(joinCall(call('a', 1), call('a', 1, { watermark: 'w' })).watermark).toBe('w')
  expect(joinCall(call('a', 1, { watermark: 'k' }), call('a', 1, { watermark: 'w' })).watermark).toBe('k')
  const merged = mergeCalls([call('a', 1)], [call('b', 2, { watermark: 'z' })])
  expect(merged.map(c => [c.id, c.watermark])).toEqual([
    ['a', undefined],
    ['b', 'z'],
  ])
})
