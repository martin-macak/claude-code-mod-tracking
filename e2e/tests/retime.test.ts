import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Cast, CastEvent } from '../render/cast.ts'
import { findSync, retime, segments } from '../render/retime.ts'
import type { TimelineEvent } from '../support/timeline.ts'

const cast = (events: CastEvent[]): Cast => ({ header: { version: 2, width: 80, height: 24 }, events })
const times = (c: Cast) => c.events.map(e => e[0])
const opts = { fastSeconds: 1 }

test('retime drops cut time, squeezes fast phases and keeps normal ones', () => {
  // Timeline ms 10_000 is cast second 2.0, so offset = -8 s.
  const input = cast([
    [0.1, 'o', 'boot'],
    [2.0, 'o', 'SYNC-n'],
    [3.0, 'o', 'launch'],
    [5.5, 'o', 't'],
    [6.0, 'o', 'u'],
    [8.0, 'o', 'spin'],
    [16.0, 'o', 'spin'],
    [18.0, 'o', 'done'],
  ])
  const timeline: TimelineEvent[] = [
    { t: 10_000, kind: 'sync', nonce: 'SYNC-n' },
    { t: 10_000, kind: 'phase', phase: 'cut' },
    { t: 13_000, kind: 'phase', phase: 'normal' },
    { t: 15_000, kind: 'phase', phase: 'fast' },
    { t: 25_000, kind: 'phase', phase: 'normal' },
  ]
  assert.deepEqual(times(retime(input, timeline, opts)), [0, 0, 0, 0.5, 1, 2.1, 2.9, 4])
})

test('retime keeps a normal-only cast unchanged', () => {
  const input = cast([
    [0, 'o', 'SYNC-x'],
    [1, 'o', 'a'],
    [3, 'o', 'b'],
  ])
  const timeline: TimelineEvent[] = [
    { t: 5000, kind: 'sync', nonce: 'SYNC-x' },
    { t: 5000, kind: 'phase', phase: 'normal' },
  ]
  assert.deepEqual(times(retime(input, timeline, opts)), [0, 1, 3])
})

test('retime keeps a fast phase shorter than fastSeconds as it is', () => {
  const input = cast([
    [0, 'o', 'SYNC-s'],
    [0.2, 'o', 'a'],
    [0.4, 'o', 'b'],
  ])
  const timeline: TimelineEvent[] = [
    { t: 0, kind: 'sync', nonce: 'SYNC-s' },
    { t: 0, kind: 'phase', phase: 'fast' },
  ]
  assert.deepEqual(times(retime(input, timeline, opts)), [0, 0.2, 0.4])
})

test('retime drops the events after the end mark, such as the tmux detach screen', () => {
  const input = cast([
    [0, 'o', 'SYNC-d'],
    [1, 'o', 'last frame'],
    [2.5, 'o', '[detached (from session demo)]'],
  ])
  const timeline: TimelineEvent[] = [
    { t: 0, kind: 'sync', nonce: 'SYNC-d' },
    { t: 0, kind: 'phase', phase: 'normal' },
    { t: 2000, kind: 'end' },
  ]
  assert.deepEqual(
    retime(input, timeline, opts).events.map(e => e[2]),
    ['SYNC-d', 'last frame'],
  )
})

test('retime fails when the cast lacks the nonce', () => {
  const timeline: TimelineEvent[] = [{ t: 0, kind: 'sync', nonce: 'SYNC-x' }]
  assert.throws(() => retime(cast([[0, 'o', 'nothing']]), timeline, opts), /sync nonce SYNC-x not found/)
})

test('retime fails when the timeline has no sync event', () => {
  assert.throws(() => retime(cast([[0, 'o', 'a']]), [], opts), /no sync event/)
})

test('findSync finds a nonce split over two events and wrapped in style codes', () => {
  const input = cast([
    [0.5, 'o', 'x'],
    [1.0, 'o', '\u001b[1mSYNC-'],
    [1.5, 'o', 'q7\u001b[0m'],
  ])
  assert.equal(findSync(input, 'SYNC-q7'), 1.5)
})

test('findSync ignores input events', () => {
  const input = cast([
    [0.5, 'i', 'SYNC-z'],
    [0.9, 'o', 'SYNC-z'],
  ])
  assert.equal(findSync(input, 'SYNC-z'), 0.9)
})

test('segments treat time before the first phase as cut', () => {
  const timeline: TimelineEvent[] = [{ t: 2000, kind: 'phase', phase: 'normal' }]
  assert.deepEqual(segments(timeline, 0, 5), [
    { start: 0, end: 2, phase: 'cut' },
    { start: 2, end: 5, phase: 'normal' },
  ])
})

test('retime keeps times finite and monotonic at the edges', () => {
  // A phase before the cast start (negative after offset) and one after the cast end.
  const input = cast([
    [0, 'o', 'SYNC-e'],
    [0.5, 'o', 'a'],
    [0.7, 'o', 'b'],
    [2, 'o', 'c'],
  ])
  const timeline: TimelineEvent[] = [
    { t: 1000, kind: 'phase', phase: 'fast' },
    { t: 3000, kind: 'sync', nonce: 'SYNC-e' },
    { t: 3600, kind: 'phase', phase: 'normal' },
    { t: 9000, kind: 'phase', phase: 'fast' },
  ]
  const out = times(retime(input, timeline, opts))
  assert.ok(out.every(Number.isFinite))
  for (let i = 1; i < out.length; i++) assert.ok(out[i]! >= out[i - 1]!, `time ${i} went down: ${out.join(', ')}`)
})
