// `ProcessRecord.containerId` and `containerIdExact` (issue #231). A new sighting of a row replaces both fields, also with
// none: the merge `{ ...old, ...row }` used to keep the old id when the new sighting had none, so a row could hold the id
// of a container that its latest run did not print. The delta study of #123 trusts only a row with `containerIdExact`.
import { expect, test } from 'claude-code/testing'
import { mergeProcessRows } from '../trackers/processes/rows'
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

test('a merge keeps the id and the mark of rows that no new sighting names', () => {
  const kept = row({ id: 'docker:ctr:db', name: 'db', containerId: A, containerIdExact: true })
  const merged = mergeProcessRows([kept, row()], [row({ containerId: B, containerIdExact: true })])
  expect(merged.map(r => [r.id, r.containerId, r.containerIdExact])).toEqual([
    ['docker:ctr:api', B, true],
    ['docker:ctr:db', A, true],
  ])
})

test('a new sighting keeps the first sighting time and the other fields of the old row', () => {
  const old = row({ containerId: A, containerIdExact: true, firstSeen: 5, state: 'up' })
  const merged = mergeProcessRows([old], [row({ firstSeen: 99 })], 1234)
  expect(only(merged)).toMatchObject({ firstSeen: 5, lastSeen: 1234, state: 'running' })
})
