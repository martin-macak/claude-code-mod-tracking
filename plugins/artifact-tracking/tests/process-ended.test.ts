// `ProcessRecord.endedAt` (issue #49, PR 1): the time a row entered an end state. `mergeProcessRows` keeps it by rule: a
// live copy clears it, two ended copies keep the first, and a row that ended with no time gets one. `lastSeen` cannot
// serve, because every merge moves it.
import { expect, test } from 'claude-code/testing'
import { mergeProcessRows } from '../trackers/processes/rows'
import { ENDED_STATES } from '../trackers/processes/states'
import type { ProcessRecord } from '../trackers/processes/types'

const row = (id: string, state: ProcessRecord['state'], f: Partial<ProcessRecord> = {}): ProcessRecord => ({
  id,
  kind: 'background-task',
  name: id,
  state,
  firstSeen: 10,
  lastSeen: 10,
  ...f,
})
const only = (rows: ProcessRecord[]): ProcessRecord => rows[0] as ProcessRecord

test('a stored ended row and a live copy of the same id merge to a row with no endedAt', () => {
  const merged = mergeProcessRows([row('a', 'completed', { endedAt: 100 })], [row('a', 'running')])
  expect(only(merged).state).toBe('running')
  expect('endedAt' in only(merged)).toBe(false)
})

test('a live copy clears endedAt also when it comes with an old one of its own', () => {
  const merged = mergeProcessRows([row('a', 'exited', { endedAt: 100 })], [row('a', 'up', { endedAt: 50 })])
  expect('endedAt' in only(merged)).toBe(false)
})

test('two ended copies keep the first endedAt, whichever side holds it', () => {
  const stored = mergeProcessRows([row('a', 'completed', { endedAt: 100 })], [row('a', 'killed', { endedAt: 300 })])
  expect(only(stored).endedAt).toBe(100)
  expect(only(stored).state).toBe('killed') // the newer copy still decides the state
  const live = mergeProcessRows([row('a', 'completed', { endedAt: 300 })], [row('a', 'completed', { endedAt: 100 })])
  expect(only(live).endedAt).toBe(100)
})

test('an ended copy with no time keeps the time of the other copy', () => {
  expect(only(mergeProcessRows([row('a', 'failed', { endedAt: 100 })], [row('a', 'failed')])).endedAt).toBe(100)
  expect(only(mergeProcessRows([row('a', 'failed')], [row('a', 'failed', { endedAt: 100 })])).endedAt).toBe(100)
})

test('a row that is ended and has no endedAt gets the time of the merge, so it can expire', () => {
  const added = mergeProcessRows([], [row('new', 'unknown')], 777)
  expect(only(added)).toMatchObject({ endedAt: 777 })
  const turned = mergeProcessRows([row('a', 'running')], [row('a', 'exited')], 777)
  expect(only(turned)).toMatchObject({ endedAt: 777, lastSeen: 777 })
  const legacy = mergeProcessRows([row('b', 'completed')], [row('b', 'completed')], 777)
  expect(only(legacy)).toMatchObject({ endedAt: 777, lastSeen: 777 })
})

test('with no time given, the merge takes the wall clock', () => {
  const before = Date.now()
  expect(only(mergeProcessRows([], [row('new', 'unknown')])).endedAt).toBeGreaterThanOrEqual(before)
})

test('a live row never gets an endedAt, and every end state counts as ended', () => {
  expect('endedAt' in only(mergeProcessRows([], [row('a', 'running')]))).toBe(false)
  expect('endedAt' in only(mergeProcessRows([], [row('a', 'unhealthy')]))).toBe(false)
  for (const state of ENDED_STATES) expect(only(mergeProcessRows([], [row('a', state)])).endedAt).toBeDefined()
})

test('rows that are not in the added list keep their fields, and the order stays oldest first', () => {
  const merged = mergeProcessRows(
    [row('old', 'completed', { endedAt: 5, firstSeen: 1 }), row('b', 'running', { firstSeen: 2 })],
    [row('c', 'running', { firstSeen: 3 })],
  )
  expect(merged.map(r => r.id)).toEqual(['old', 'b', 'c'])
  expect(merged[0]?.endedAt).toBe(5)
})
