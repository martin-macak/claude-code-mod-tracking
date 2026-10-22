// The turn span of a row (issue #133, P1b of #69): the first and the last turn that named it, how a visit of a turn changes
// the stamps, and what the visit tells the ledger. The rows of the processes, repos and auto trackers use these helpers; the
// items use the same rules in `records.ts`.
import { expect, test } from 'claude-code/testing'
import { rowSightings, sightOf, stampedTurn, type TurnStamps, turnSpan, withSpan } from '../core/lib/turn-span'

/** A record with an id and the stamps `o` gives. */
const rec = (id: string, o: TurnStamps = {}): { id: string } & TurnStamps => ({ id, ...o })

test('turnSpan: the smallest first turn and the largest last turn; a record with none leaves the other', () => {
  expect(turnSpan({ firstTurn: 3, lastTurn: 5 }, { firstTurn: 2, lastTurn: 4 })).toEqual({ first: 2, last: 5 })
  expect(turnSpan({}, { firstTurn: 3, lastTurn: 3 })).toEqual({ first: 3, last: 3 })
  expect(turnSpan({ lastTurn: 6 })).toEqual({ first: 6, last: 6 }) // a half stamp reads as both
  expect(turnSpan({ firstTurn: 4 })).toEqual({ first: 4, last: 4 })
})

test('turnSpan: each record with one stamp counts it for both ends first, so the span is never inverted', () => {
  expect(turnSpan({ firstTurn: 5 }, { lastTurn: 3 })).toEqual({ first: 3, last: 5 })
  expect(turnSpan({ lastTurn: 3 }, { firstTurn: 5 })).toEqual({ first: 3, last: 5 })
  expect(turnSpan({ firstTurn: 5 }, { lastTurn: 7 })).toEqual({ first: 5, last: 7 })
  expect(turnSpan({ firstTurn: 2, lastTurn: 4 }, { lastTurn: 9 }, { firstTurn: 1 })).toEqual({ first: 1, last: 9 })
  expect(withSpan(rec('a'), { firstTurn: 5 }, { lastTurn: 3 })).toEqual({ id: 'a', firstTurn: 3, lastTurn: 5 })
})

test('turnSpan: no record with a stamp, or a stamp that is no number, gives nothing', () => {
  expect(turnSpan()).toBeUndefined()
  expect(turnSpan({}, {})).toBeUndefined()
  expect(turnSpan({ firstTurn: 'x' as unknown as number, lastTurn: null as unknown as number })).toBeUndefined()
})

test('withSpan: the record takes the span of its copies, and the same object comes back when the stamps are right', () => {
  const merged = withSpan(rec('a'), { firstTurn: 3, lastTurn: 3 }, { firstTurn: 5, lastTurn: 5 })
  expect(merged).toEqual({ id: 'a', firstTurn: 3, lastTurn: 5 })
  expect(withSpan(merged, merged)).toBe(merged)
  const bare = rec('b')
  expect(withSpan(bare, {}, {})).toBe(bare) // no copy has a turn: nothing to stamp
})

test('withSpan: a stale stamp on the record is replaced by the span of the copies', () => {
  expect(withSpan(rec('a', { firstTurn: 9, lastTurn: 9 }), { firstTurn: 3, lastTurn: 4 })).toEqual({
    id: 'a',
    firstTurn: 3,
    lastTurn: 4,
  })
})

test('stampedTurn: a record with no turn gets both; a later turn moves lastTurn only; an earlier one moves firstTurn only', () => {
  const first = stampedTurn(rec('a'), 3)
  expect(first).toEqual({ id: 'a', firstTurn: 3, lastTurn: 3 })
  expect(stampedTurn(first, 5)).toEqual({ id: 'a', firstTurn: 3, lastTurn: 5 })
  expect(stampedTurn(first, 1)).toEqual({ id: 'a', firstTurn: 1, lastTurn: 3 }) // late work of an older turn
})

test('stampedTurn: the same object comes back when the turn changes nothing', () => {
  const row = rec('a', { firstTurn: 3, lastTurn: 5 })
  expect(stampedTurn(row, 4)).toBe(row)
  expect(stampedTurn(row, 5)).toBe(row)
})

test('sightOf: no row held is an add; a row that the same turn stamped is a repeat; any other known row is seen again', () => {
  expect(sightOf(undefined, 3)).toBe('added')
  expect(sightOf({ firstTurn: 3, lastTurn: 3 }, 3)).toBe('repeat')
  expect(sightOf({ firstTurn: 3, lastTurn: 5 }, 5)).toBe('repeat')
  expect(sightOf({ firstTurn: 3, lastTurn: 3 }, 5)).toBe('seen')
  expect(sightOf({}, 5)).toBe('seen') // a row from before the lineage: known, no turn
})

test('rowSightings: each row goes to the list its visit makes; the entry holds the row id, the category and the reason', () => {
  const held = { firstTurn: 3, lastTurn: 3 }
  const s = rowSightings(5, [
    { id: 'rp:new', category: 'repo', reason: 'read', held: undefined },
    { id: 'rp:old', category: 'repo', reason: 'updated', held },
    { id: 'rp:again', category: 'repo', reason: 'read', held: { firstTurn: 3, lastTurn: 5 } },
  ])
  expect(s).toEqual({
    added: [{ k: 'rp:new', c: 'repo', r: 'read' }],
    seen: [{ k: 'rp:old', c: 'repo', r: 'updated' }],
    repeat: [{ k: 'rp:again', c: 'repo', r: 'read' }],
  })
})

test('rowSightings: no repeat list when no row repeats', () => {
  expect(rowSightings(2, [{ id: 'ag:a', category: 'agent', reason: 'created', held: undefined }])).toEqual({
    added: [{ k: 'ag:a', c: 'agent', r: 'created' }],
    seen: [],
  })
})
