// `ProcessRecord.containerId` and `containerIdExact` (issue #231). A new sighting of a row replaces both fields, also with
// none: the merge `{ ...old, ...row }` used to keep the old id when the new sighting had none, so a row could hold the id
// of a container that its latest run did not print. The delta study of #123 trusts only a row with `containerIdExact`.
import { expect, test } from 'claude-code/testing'
import { mergeProcessRows, withContainerGone } from '../trackers/processes/rows'
import type { ProcessRecord } from '../trackers/processes/types'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

const row = (f: Partial<ProcessRecord> = {}): ProcessRecord => ({
  id: 'docker:ctr:api',
  kind: 'docker-container',
  name: 'api',
  state: 'running',
  firstSeen: 10,
  lastSeen: 10,
  ...f,
})
const only = (rows: ProcessRecord[]): ProcessRecord => rows[0] as ProcessRecord

test('a new sighting with another exact id replaces the id and keeps the mark', () => {
  const merged = mergeProcessRows(
    [row({ containerId: A, containerIdExact: true })],
    [row({ containerId: B, containerIdExact: true })],
  )
  expect(merged).toHaveLength(1)
  expect(only(merged)).toMatchObject({ containerId: B, containerIdExact: true })
})

test('a new sighting with no id removes the id and the mark of the old row', () => {
  const merged = mergeProcessRows([row({ containerId: A, containerIdExact: true })], [row()])
  expect(merged).toHaveLength(1)
  expect('containerId' in only(merged)).toBe(false)
  expect('containerIdExact' in only(merged)).toBe(false)
})

test('a new sighting with an id and no mark removes the mark of the old row', () => {
  // Only the parser sets the mark. A sighting without it says that the id is not proven.
  const merged = mergeProcessRows([row({ containerId: A, containerIdExact: true })], [row({ containerId: A })])
  expect(only(merged).containerId).toBe(A)
  expect('containerIdExact' in only(merged)).toBe(false)
})

test('a new exact sighting marks a row from an older build that had the id and no mark', () => {
  const merged = mergeProcessRows([row({ containerId: A })], [row({ containerId: A, containerIdExact: true })])
  expect(only(merged)).toMatchObject({ containerId: A, containerIdExact: true })
})

test('a new sighting with an exact id gives an old row with no id its id', () => {
  const merged = mergeProcessRows([row()], [row({ containerId: A, containerIdExact: true })])
  expect(only(merged)).toMatchObject({ containerId: A, containerIdExact: true })
})

// `containerRunAlone` goes with the id and `containerIdExact` (issue #123, review of PR 285): the new sighting says whether the run of
// its call was alone, and a sighting that does not say it removes the old row's mark. A mark of an old call must not vouch for
// the id that a later call printed.
test('a new sighting with another id and no containerRunAlone removes the alone mark of the old row', () => {
  const merged = mergeProcessRows(
    [row({ containerId: A, containerIdExact: true, containerRunAlone: true })],
    [row({ containerId: B, containerIdExact: true })],
  )
  expect(only(merged)).toMatchObject({ containerId: B, containerIdExact: true })
  expect('containerRunAlone' in only(merged)).toBe(false)
})

test('a new sighting with no id removes the alone mark too, and one that has it keeps it', () => {
  const old = row({ containerId: A, containerIdExact: true, containerRunAlone: true })
  expect('containerRunAlone' in only(mergeProcessRows([old], [row()]))).toBe(false)
  const again = mergeProcessRows([old], [row({ containerId: B, containerIdExact: true, containerRunAlone: true })])
  expect(only(again)).toMatchObject({ containerId: B, containerIdExact: true, containerRunAlone: true })
  // A row of an older build has no mark, and a new sighting that has it gives it.
  const older = mergeProcessRows([row({ containerId: A, containerIdExact: true })], [again[0] as ProcessRecord])
  expect(only(older).containerRunAlone).toBe(true)
})

test('a merge keeps the id and the mark of rows that no new sighting names', () => {
  const kept = row({ id: 'docker:ctr:db', name: 'db', containerId: A, containerIdExact: true })
  const merged = mergeProcessRows([kept, row()], [row({ containerId: B, containerIdExact: true })])
  expect(merged.map(r => [r.id, r.containerId, r.containerIdExact])).toEqual([
    ['docker:ctr:api', B, true],
    ['docker:ctr:db', A, true],
  ])
})

test('a new sighting keeps the first sighting time and the old-only fields, and takes the new state', () => {
  // `pid` and `agentId` stand only on the old row: `sighted` must keep them while it drops the old id.
  const old = row({ containerId: A, containerIdExact: true, firstSeen: 5, state: 'up', pid: 7, agentId: 'a1' })
  const merged = mergeProcessRows([old], [row({ firstSeen: 99 })], 1234)
  expect(only(merged)).toMatchObject({ firstSeen: 5, lastSeen: 1234, state: 'running', pid: 7, agentId: 'a1' })
  expect('containerId' in only(merged)).toBe(false)
  expect('containerIdExact' in only(merged)).toBe(false)
})

// The three callers of the merge pass a different row as the new side (`index.ts`): `settle` the live rows, `restore('carry')`
// the current rows and `restore('load')` the stored copy. The new side alone gives the id and the mark. So a stored copy with
// no id, or an older build with no mark, wins over a live exact row on a load, as the stored copy wins for `state`.
test('a stored copy that has no id removes the id of the live row on load, as it does for state', () => {
  const live = row({ containerId: A, containerIdExact: true })
  const stored = row() // an older build: no id, no mark
  const loaded = mergeProcessRows([live], [stored]) // restore('load'): the current rows first, the stored copy as the new side
  expect('containerId' in only(loaded)).toBe(false)
  expect('containerIdExact' in only(loaded)).toBe(false)
})

test('a stored copy with an id and no mark removes the mark of the live row on load', () => {
  const live = row({ containerId: A, containerIdExact: true })
  const stored = row({ containerId: A }) // an older build: the id, no mark
  const loaded = mergeProcessRows([live], [stored])
  expect(only(loaded).containerId).toBe(A)
  expect('containerIdExact' in only(loaded)).toBe(false)
})

test('a carry keeps the id and the mark of the live row that the stored copy names, and gives the stored one none', () => {
  const live = row({ containerId: A, containerIdExact: true })
  const stored = row({ containerId: B, containerIdExact: true })
  // restore('carry'): the stored rows first, the current rows as the new side.
  expect(only(mergeProcessRows([stored], [live]))).toMatchObject({ containerId: A, containerIdExact: true })
})

// `containerGone` (issue #123, R8): the container of the id no longer exists. A live sighting is a new `docker run -d` of the
// same row id, so it makes a new container and drops the mark. An ended copy says nothing new about the container.
test('a live sighting of a gone row drops containerGone, and takes its own id', () => {
  const gone = row({ containerId: A, containerIdExact: true, state: 'exited', endedAt: 5, containerGone: true })
  const merged = mergeProcessRows([gone], [row({ containerId: B, containerIdExact: true })], 100)
  expect(only(merged)).toMatchObject({ containerId: B, state: 'running' })
  expect('containerGone' in only(merged)).toBe(false)
})

test('an ended copy keeps containerGone of the old row, and an old row without it takes the mark of the new side', () => {
  const base = { containerId: A, containerIdExact: true as const, state: 'exited' as const, endedAt: 5 }
  const kept = mergeProcessRows([row({ ...base, containerGone: true })], [row(base)], 100)
  expect(only(kept).containerGone).toBe(true)
  const taken = mergeProcessRows([row(base)], [row({ ...base, containerGone: true })], 100)
  expect(only(taken).containerGone).toBe(true)
})

test('a live copy that carries containerGone keeps it: the new side says what it says (a stored copy, as the probe wrote it)', () => {
  // The probe can mark a row that is live by name and gone by id (`up`, no line of its id). A load puts the stored copy on the
  // new side, and the merge must not undo what the copy says.
  const stored = row({ containerId: A, containerIdExact: true, state: 'up', containerGone: true })
  const loaded = mergeProcessRows([row({ containerId: A, containerIdExact: true })], [stored])
  expect(only(loaded)).toMatchObject({ state: 'up', containerGone: true })
})

test('a row that no sighting names keeps containerGone through a merge', () => {
  const kept = row({ id: 'docker:ctr:db', name: 'db', containerId: A, containerIdExact: true, containerGone: true })
  const merged = mergeProcessRows([kept], [row({ containerId: B, containerIdExact: true })], 100)
  expect(merged.map(r => [r.id, r.containerGone])).toEqual([
    ['docker:ctr:api', undefined],
    ['docker:ctr:db', true],
  ])
})

test('withContainerGone sets the mark to true or drops it, and gives back the same object when nothing changes', () => {
  const live = row({ containerId: A })
  const gone = withContainerGone(live, true)
  expect(gone).not.toBe(live)
  expect(gone.containerGone).toBe(true)
  expect(withContainerGone(gone, true)).toBe(gone)
  expect(withContainerGone(live, false)).toBe(live)
  const back = withContainerGone(gone, false)
  expect('containerGone' in back).toBe(false) // the mark is true or absent, never false
  expect(gone.containerGone).toBe(true) // the input is not changed
})
