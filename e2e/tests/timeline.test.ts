import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseTimeline, readTimeline, Timeline } from '../support/timeline.ts'

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'timeline-')), 'timeline.ndjson')

test('Timeline writes sync and phase events with clock times', () => {
  const file = tempFile()
  let t = 1000
  const timeline = new Timeline(file, () => t)
  timeline.sync('SYNC-a')
  t = 1500
  timeline.phase('cut')
  t = 2000
  timeline.phase('normal')
  assert.deepEqual(readTimeline(file), [
    { t: 1000, kind: 'sync', nonce: 'SYNC-a' },
    { t: 1500, kind: 'phase', phase: 'cut' },
    { t: 2000, kind: 'phase', phase: 'normal' },
  ])
})

test('Timeline writes an end mark that parses back', () => {
  const file = tempFile()
  new Timeline(file, () => 7).end()
  assert.deepEqual(readTimeline(file), [{ t: 7, kind: 'end' }])
})

test('Timeline skips a phase that does not change', () => {
  const file = tempFile()
  const timeline = new Timeline(file, () => 1)
  timeline.phase('fast')
  timeline.phase('fast')
  assert.equal(readTimeline(file).length, 1)
})

test('parseTimeline rejects an unknown phase with its line number', () => {
  assert.throws(() => parseTimeline('{"t":1,"kind":"phase","phase":"slow"}\n'), /line 1/)
})

test('parseTimeline rejects an event without a numeric t', () => {
  assert.throws(() => parseTimeline('{"kind":"sync","nonce":"x"}\n'), /numeric t/)
})
