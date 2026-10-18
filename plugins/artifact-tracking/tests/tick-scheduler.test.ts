// Scheduler: one interval for the tick, a watchdog that re-arms it, and per-owner periods.
// A refused period ends a `clock.every` for good (E18), so the watchdog is the only way back.
// Spec 5.6 (Tick). Plan: L3 Task 6.
import { expect, test } from 'claude-code/testing'
import { Scheduler } from '../core/infra/scheduler'
import { fakePorts } from './fixtures/ports'

const TICK = 30000

function setup(o: { period?: number; beat?: () => Promise<void> } = {}) {
  const w = fakePorts()
  const box = { beats: 0, period: o.period ?? TICK, armed: [] as number[] }
  const s = new Scheduler({
    now: () => w.ports.clock.now(),
    every: (ms, fn) => {
      box.armed.push(ms)
      return w.ports.clock.every(ms, fn)
    },
    periodMs: () => box.period,
    beat: o.beat ?? (async () => void box.beats++),
    log: w.ports.log,
  })
  return { w, s, box }
}

test('ensure arms one interval of 30000 ms', async () => {
  const { s, box } = setup()
  await s.ensure()
  expect(box.armed).toEqual([TICK])
})

test('a second ensure within two periods does nothing', async () => {
  const { w, s, box } = setup()
  await s.ensure()
  await w.clock.advance(TICK * 2) // two beats ran, so the last one is fresh
  await s.ensure()
  expect(box.armed).toEqual([TICK])
  expect(box.beats).toBe(2)
})

test('ensure re-arms when the last beat is older than 60000 ms', async () => {
  const { w, s, box } = setup()
  w.clock.refuse('every', TICK) // the first period is refused: the interval ends and never beats
  await s.ensure()
  await w.clock.advance(60000)
  await s.ensure() // exactly two periods: still within the window
  expect(box.armed).toEqual([TICK])
  await w.clock.advance(1)
  await s.ensure()
  expect(box.armed).toEqual([TICK, TICK])
  await w.clock.advance(TICK)
  expect(box.beats).toBe(1) // the new interval beats
})

test('a beat stores its time and runs beat()', async () => {
  const { w, s, box } = setup()
  await s.ensure()
  await w.clock.advance(TICK * 3) // beats at 30000, 60000 and 90000
  expect(box.beats).toBe(3)
  await w.clock.advance(10000)
  await s.ensure() // 100000 - 90000 is fresh; against the arm time (0) it would be stale
  expect(box.armed).toEqual([TICK])
})

test('a changed periodMs re-arms at the new period', async () => {
  const { w, s, box } = setup()
  await s.ensure()
  box.period = 10000
  await s.ensure()
  expect(box.armed).toEqual([TICK, 10000])
  await w.clock.advance(10000)
  expect(box.beats).toBe(1) // the old interval was cancelled: one beat, not two
})

test('due is true once per period per owner; the default period is the tick', async () => {
  const { s } = setup()
  expect(s.due('auto', TICK, 0)).toBe(true)
  expect(s.due('auto', TICK, 10000)).toBe(false)
  expect(s.due('auto', TICK, TICK)).toBe(true) // the next beat
  expect(s.due('jira', 60000, TICK)).toBe(true) // owners do not share a clock
  expect(s.due('jira', 60000, TICK * 2)).toBe(false)
  expect(s.due('jira', 60000, TICK * 3)).toBe(true)
})

test('due allows a beat that comes a few ms early', async () => {
  const { s } = setup()
  expect(s.due('auto', TICK, 0)).toBe(true)
  expect(s.due('auto', TICK, TICK - 5)).toBe(true) // timers fire early by a ms now and then
  expect(s.due('auto', TICK, TICK - 5 + 20000)).toBe(false)
})

test('a beat that throws logs one line and the interval goes on', async () => {
  let n = 0
  const { w, s } = setup({
    beat: async () => {
      n++
      if (n === 1) throw new Error('boom')
    },
  })
  await s.ensure()
  await w.clock.advance(TICK * 2)
  expect(n).toBe(2)
  expect(w.logs).toEqual(['scheduler: beat failed: boom'])
})

test('a beat that throws a non-Error is logged by its text', async () => {
  const { w, s } = setup({
    beat: async () => {
      throw 'plain'
    },
  })
  await s.ensure()
  await w.clock.advance(TICK)
  expect(w.logs).toEqual(['scheduler: beat failed: plain'])
})

test('a beat whose clock read fails still runs, and the watchdog sees the old beat', async () => {
  const w = fakePorts()
  let failNow = false
  let beats = 0
  const s = new Scheduler({
    now: async () => {
      if (failNow) throw new Error('no clock')
      return w.clock.now
    },
    every: w.ports.clock.every,
    periodMs: () => TICK,
    beat: async () => void beats++,
    log: w.ports.log,
  })
  await s.ensure()
  failNow = true
  await w.clock.advance(TICK)
  expect(beats).toBe(1)
})

test('ensure never rejects, even when the clock does', async () => {
  const w = fakePorts()
  const s = new Scheduler({
    now: async () => Promise.reject(new Error('no clock')),
    every: w.ports.clock.every,
    periodMs: () => TICK,
    beat: async () => {},
    log: w.ports.log,
  })
  await s.ensure()
})

test('a refused every leaves the next ensure free to arm again', async () => {
  const w = fakePorts()
  let denied = true
  const armed: number[] = []
  const s = new Scheduler({
    now: () => w.ports.clock.now(),
    every: (ms, fn) => {
      if (denied) throw new Error('refused')
      armed.push(ms)
      return w.ports.clock.every(ms, fn)
    },
    periodMs: () => TICK,
    beat: async () => {},
    log: w.ports.log,
  })
  await s.ensure()
  denied = false
  await s.ensure()
  expect(armed).toEqual([TICK])
})

test('stop cancels the interval', async () => {
  const { w, s, box } = setup()
  await s.ensure()
  s.stop()
  await w.clock.advance(TICK * 2)
  expect(box.beats).toBe(0)
  await s.ensure() // a stopped scheduler arms again on the next ensure
  expect(box.armed).toEqual([TICK, TICK])
})

test('stop with no interval does nothing', async () => {
  const { s } = setup()
  s.stop()
})
