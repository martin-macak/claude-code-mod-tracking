// The cap of the stored process rows (issue #134). `trackers.processes.maxRows` bounds the rows a merge keeps. A row whose
// TTL has run out goes first, oldest end first. Then the oldest ended rows go, by their end time. A live row never goes.
// The view cap (issue #49) reads the same order.
import { expect, test } from 'claude-code/testing'
import { expired, mergeProcessRows, overCap } from '../trackers/processes/rows'
import type { ProcessRecord } from '../trackers/processes/types'

const NOW = 1_000_000
/** A cap of `maxRows` rows with TTLs so long that no row is expired: only the end time orders the rows. */
const cap = (maxRows: number) => ({ maxRows, endedTtlMs: 86_400_000, failedTtlMs: 86_400_000 })
const row = (id: string, state: ProcessRecord['state'], f: Partial<ProcessRecord> = {}): ProcessRecord => ({
  id,
  kind: 'background-task',
  name: id,
  state,
  firstSeen: 10,
  lastSeen: 10,
  ...f,
})
/** `n` ended rows `<prefix>0` to `<prefix>n-1`. A higher number started and ended later. */
const ended = (n: number, prefix = 'done', f: (i: number) => Partial<ProcessRecord> = () => ({})): ProcessRecord[] =>
  Array.from({ length: n }, (_, i) =>
    row(`${prefix}${i}`, 'completed', { firstSeen: 100 + i, endedAt: 5000 + i, ...f(i) }),
  )
const live = (n: number, prefix = 'run'): ProcessRecord[] =>
  Array.from({ length: n }, (_, i) => row(`${prefix}${i}`, 'running', { firstSeen: 1 + i }))
const idsOf = (rows: readonly ProcessRecord[]) => rows.map(r => r.id)
const range = (from: number, to: number, prefix = 'done') =>
  Array.from({ length: to - from }, (_, i) => `${prefix}${from + i}`)

test('250 ended rows and maxRows 200: the merge keeps the 200 newest, oldest first', () => {
  const merged = mergeProcessRows(ended(250), [], NOW, cap(200))
  expect(idsOf(merged)).toEqual(range(50, 250))
})

test('rows that arrive in the merge count too: 200 stored and 50 added leave the 200 newest', () => {
  const merged = mergeProcessRows(
    ended(200),
    ended(50, 'late', i => ({ firstSeen: 1000 + i, endedAt: 9000 + i })),
    NOW,
    cap(200),
  )
  expect(merged).toHaveLength(200)
  expect(idsOf(merged).filter(id => id.startsWith('late'))).toHaveLength(50)
  expect(idsOf(merged).filter(id => id.startsWith('done'))).toEqual(range(50, 200))
})

test('at maxRows exactly nothing goes, and with no maxRows nothing goes at all', () => {
  expect(mergeProcessRows(ended(200), [], NOW, cap(200))).toHaveLength(200)
  expect(mergeProcessRows(ended(250), [], NOW)).toHaveLength(250)
})

test('live rows over the cap all stay, and they leave no room for an ended row', () => {
  const merged = mergeProcessRows([...live(25), ...ended(5)], [], NOW, cap(20))
  expect(idsOf(merged)).toEqual(range(0, 25, 'run'))
  const unhealthy = mergeProcessRows([row('up', 'up'), row('bad', 'unhealthy'), ...ended(30)], [], NOW, cap(20))
  expect(idsOf(unhealthy)).toContain('up')
  expect(idsOf(unhealthy)).toContain('bad')
})

test('live rows count against the cap: 15 live rows leave room for the 5 newest of 30 ended rows', () => {
  const merged = mergeProcessRows([...live(15), ...ended(30)], [], NOW, cap(20))
  expect(merged).toHaveLength(20)
  expect(idsOf(merged).filter(id => id.startsWith('run'))).toHaveLength(15)
  expect(idsOf(merged).filter(id => id.startsWith('done'))).toEqual(range(25, 30))
})

test('the oldest end goes first, not the oldest start', () => {
  // `late` started first and ended last. `early` started last and ended first. One row too many: `early` goes.
  const rows = [
    row('late', 'completed', { firstSeen: 1, endedAt: 9000 }),
    ...ended(19, 'mid'),
    row('early', 'completed', { firstSeen: 99_999, endedAt: 1 }),
  ]
  const merged = mergeProcessRows(rows, [], NOW, cap(20))
  expect(idsOf(merged)).toContain('late')
  expect(idsOf(merged)).not.toContain('early')
  expect(merged).toHaveLength(20)
})

test('a failed row goes like any ended row, by its end time', () => {
  const rows = [
    row('bad', 'failed', { firstSeen: 1, endedAt: 1 }),
    row('gone', 'killed', { firstSeen: 2, endedAt: 2 }),
    ...ended(20),
  ]
  expect(idsOf(mergeProcessRows(rows, [], NOW, cap(20)))).toEqual(range(0, 20))
})

test('rows that ended at the same time go by first sighting, then by id, whatever the order they came in', () => {
  // firstSeen 100: r0 r2 r4. firstSeen 101: r1 r3 r5. Over the cap by 2: r0 and r2 go first.
  const same = Array.from({ length: 6 }, (_, i) =>
    row(`r${i}`, 'completed', { firstSeen: 100 + (i % 2), endedAt: 5000 }),
  )
  const kept = ['r4', 'r1', 'r3', 'r5']
  expect(idsOf(mergeProcessRows(same, [], NOW, cap(4)))).toEqual(kept)
  expect(idsOf(mergeProcessRows([...same].reverse(), [], NOW, cap(4)))).toEqual(kept)
  expect(idsOf(mergeProcessRows([], [...same].reverse(), NOW, cap(4)))).toEqual(kept)
})

test('an ended row stored with no end time gets the time of the merge, so the first sighting orders the tie', () => {
  const undated = Array.from({ length: 250 }, (_, i) => row(`old${i}`, 'exited', { firstSeen: 100 + i }))
  const merged = mergeProcessRows(undated, [], NOW, cap(200))
  expect(idsOf(merged)).toEqual(range(50, 250, 'old'))
  expect(merged.every(r => r.endedAt === NOW)).toBe(true)
})

test('overCap names the ids over the cap: ended rows only, by end time, else by first sighting', () => {
  const rows = [
    row('undated', 'completed', { firstSeen: 1 }),
    row('dated', 'completed', { firstSeen: 2, endedAt: 50 }),
    row('newer', 'completed', { firstSeen: 3, endedAt: 60 }),
    row('live', 'running', { firstSeen: 0 }),
  ]
  expect([...overCap(rows, cap(4), NOW)]).toEqual([])
  expect([...overCap(rows, cap(3), NOW)]).toEqual(['undated'])
  expect([...overCap(rows, cap(2), NOW)]).toEqual(['undated', 'dated'])
  expect([...overCap(rows, cap(0), NOW)].sort()).toEqual(['dated', 'newer', 'undated'])
})

test('overCap breaks a tie by first sighting, then by id, whatever the order of the rows', () => {
  const same = Array.from({ length: 6 }, (_, i) =>
    row(`r${i}`, 'completed', { firstSeen: 100 + (i % 2), endedAt: 5000 }),
  )
  expect([...overCap(same, cap(4), NOW)].sort()).toEqual(['r0', 'r2'])
  expect([...overCap([...same].reverse(), cap(4), NOW)].sort()).toEqual(['r0', 'r2'])
})

// ---------------------------------------------------------------- expired rows go first (owner decision, issue #134)

const MIN = 60_000
const LATE = 10_000_000 // far enough from 0 that a row can have ended 50 minutes ago
/** The default TTLs: 30 minutes for a completed row, 60 minutes for a failed one. */
const ttlCap = (maxRows: number) => ({ maxRows, endedTtlMs: 30 * MIN, failedTtlMs: 60 * MIN })

test('a failed row inside its TTL stays, and the newer completed rows past their TTL go before it', () => {
  // `bad` ended 50 minutes ago and has 60 minutes. Each `old` row ended 40 minutes ago, after `bad`, and has 30 minutes:
  // all 24 are expired. By end time alone `bad` would go first. 25 rows over a cap of 20: the 5 oldest expired rows go.
  const rows = [
    row('bad', 'failed', { firstSeen: 1, endedAt: LATE - 50 * MIN }),
    ...Array.from({ length: 24 }, (_, i) =>
      row(`old${i}`, 'completed', { firstSeen: 100 + i, endedAt: LATE - 40 * MIN + i }),
    ),
  ]
  const merged = mergeProcessRows(rows, [], LATE, ttlCap(20))
  expect(idsOf(merged)).toEqual(['bad', ...range(5, 24, 'old')])
})

test('the cut takes every expired row first, oldest end first, and then the oldest row inside its TTL', () => {
  const rows = [
    row('stale1', 'completed', { firstSeen: 1, endedAt: LATE - 45 * MIN }),
    row('stale2', 'exited', { firstSeen: 2, endedAt: LATE - 44 * MIN }),
    row('stale3', 'unknown', { firstSeen: 3, endedAt: LATE - 43 * MIN }),
    row('bad', 'failed', { firstSeen: 4, endedAt: LATE - 50 * MIN }), // inside 60 minutes: the oldest of the fresh rows
    row('fresh20', 'completed', { firstSeen: 5, endedAt: LATE - 20 * MIN }),
    row('fresh10', 'completed', { firstSeen: 6, endedAt: LATE - 10 * MIN }),
    row('fresh5', 'completed', { firstSeen: 7, endedAt: LATE - 5 * MIN }),
  ]
  // 7 rows over a cap of 2: 5 go. The 3 stale rows, then `bad`, then `fresh20`.
  expect(idsOf(mergeProcessRows(rows, [], LATE, ttlCap(2)))).toEqual(['fresh10', 'fresh5'])
  // Over a cap of 5: 2 go, and both are stale.
  expect(idsOf(mergeProcessRows(rows, [], LATE, ttlCap(5)))).toEqual(['stale3', 'bad', 'fresh20', 'fresh10', 'fresh5'])
})

test('the TTL orders the cut and never starts one: an expired row stays while the slot is not over the cap', () => {
  const rows = [
    row('stale', 'completed', { firstSeen: 1, endedAt: LATE - 45 * MIN }),
    row('fresh', 'completed', { firstSeen: 2, endedAt: LATE - 5 * MIN }),
  ]
  expect(idsOf(mergeProcessRows(rows, [], LATE, ttlCap(2)))).toEqual(['stale', 'fresh'])
})

test('a live row never goes, and it does not count as expired: expired rows go around it', () => {
  const rows = [
    ...live(3),
    ...ended(3, 'stale', () => ({ endedAt: LATE - 45 * MIN })),
    row('bad', 'failed', { firstSeen: 50, endedAt: LATE - 50 * MIN }),
  ]
  // 7 rows over a cap of 4: 3 go, the 3 expired rows. The failed row inside its TTL and the live rows stay.
  expect(idsOf(mergeProcessRows(rows, [], LATE, ttlCap(4)))).toEqual(['run0', 'run1', 'run2', 'bad'])
})

test('overCap puts the expired rows before the others, and the TTL of a failure is its own', () => {
  const rows = [
    row('bad', 'failed', { firstSeen: 1, endedAt: LATE - 50 * MIN }), // inside 60 minutes
    row('worse', 'killed', { firstSeen: 2, endedAt: LATE - 70 * MIN }), // past 60 minutes
    row('old', 'completed', { firstSeen: 3, endedAt: LATE - 40 * MIN }), // past 30 minutes
    row('new', 'completed', { firstSeen: 4, endedAt: LATE - 10 * MIN }),
  ]
  expect([...overCap(rows, ttlCap(3), LATE)]).toEqual(['worse'])
  expect([...overCap(rows, ttlCap(2), LATE)]).toEqual(['worse', 'old'])
  expect([...overCap(rows, ttlCap(1), LATE)]).toEqual(['worse', 'old', 'bad'])
})

test('expired: a live row and an ended row with no end time never are, and a failure has its own TTL', () => {
  const c = ttlCap(20)
  expect(expired(row('a', 'running', { endedAt: 1 }), c, LATE)).toBe(false)
  expect(expired(row('b', 'completed'), c, LATE)).toBe(false)
  expect(expired(row('c', 'completed', { endedAt: LATE - 30 * MIN }), c, LATE)).toBe(true)
  expect(expired(row('d', 'completed', { endedAt: LATE - 30 * MIN + 1 }), c, LATE)).toBe(false)
  expect(expired(row('e', 'failed', { endedAt: LATE - 30 * MIN }), c, LATE)).toBe(false)
  expect(expired(row('f', 'killed', { endedAt: LATE - 60 * MIN }), c, LATE)).toBe(true)
})
