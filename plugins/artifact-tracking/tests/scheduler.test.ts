// AutoScheduler: fixed window, immediate tick and manual, busy guard, errors, refused timers. Pure, fake clock.
import { expect, test } from 'claude-code/testing'
import { AutoScheduler } from '../hooks/auto/scheduler'
import type { AutoReason } from '../hooks/contracts'
import { LIMITS } from '../hooks/contracts'

type FakeTimer = { at: number; fn: () => void | Promise<void>; cancelled: boolean; refused: boolean; fired: boolean }

function rig(opts: { refuseFirst?: boolean; holdFirst?: boolean; throwOnce?: boolean } = {}) {
  let now = 0
  const timers: FakeTimer[] = []
  const runs: AutoReason[][] = []
  const errors: unknown[] = []
  const gates: (() => void)[] = []
  let refuse = opts.refuseFirst ?? false
  let hold = opts.holdFirst ?? false
  let boom = opts.throwOnce ?? false
  const scheduler = new AutoScheduler({
    now: () => now,
    after: (ms, fn) => {
      const t: FakeTimer = { at: now + ms, fn, cancelled: false, refused: refuse, fired: false }
      refuse = false
      timers.push(t)
      return {
        cancel: () => {
          t.cancelled = true
        },
      }
    },
    run: async reasons => {
      runs.push([...reasons].sort())
      if (boom) {
        boom = false
        throw new Error('round broke')
      }
      if (hold) {
        hold = false
        await new Promise<void>(resolve => gates.push(resolve))
      }
    },
    onError: err => errors.push(err),
  })
  /** Moves the clock; fires due timers in order. A refused timer never fires. */
  async function advance(ms: number): Promise<void> {
    const target = now + ms
    for (;;) {
      const due = timers
        .filter(t => !t.cancelled && !t.refused && !t.fired && t.at <= target)
        .sort((a, b) => a.at - b.at)[0]
      if (!due) break
      now = Math.max(now, due.at)
      due.fired = true
      await due.fn()
    }
    now = target
  }
  return { scheduler, advance, runs, errors, gates, at: () => now }
}

test('events join a fixed window: one run with the merged reasons at the end of the window', async () => {
  const t = rig()
  t.scheduler.kick('worktree')
  await t.advance(300)
  t.scheduler.kick('agent')
  await t.advance(440)
  expect(t.runs).toHaveLength(0)
  await t.advance(10)
  expect(t.runs).toEqual([['agent', 'worktree']])
})

test('a kick inside the window does not move its end', async () => {
  const t = rig()
  t.scheduler.kick('git')
  await t.advance(700)
  t.scheduler.kick('git')
  await t.advance(50)
  expect(t.runs).toHaveLength(1)
  expect(LIMITS.autoDebounceMs).toBe(750)
})

test('a steady kick stream every 100 ms still runs once per window', async () => {
  const t = rig()
  for (let i = 0; i < 22; i++) {
    t.scheduler.kick('git')
    await t.advance(100)
  }
  expect(t.runs).toEqual([['git'], ['git']])
})

test('tick and manual run at once, without waiting for the window', async () => {
  const t = rig()
  t.scheduler.kick('tick')
  expect(t.runs).toEqual([['tick']])
  await t.scheduler.idle()
  t.scheduler.kick('manual')
  expect(t.runs).toEqual([['tick'], ['manual']])
})

test('the busy guard queues one merged request while a round runs', async () => {
  const t = rig({ holdFirst: true })
  t.scheduler.kick('tick')
  expect(t.scheduler.busy).toBe(true)
  t.scheduler.kick('manual')
  t.scheduler.kick('tick')
  expect(t.runs).toEqual([['tick']])
  t.gates[0]?.()
  await t.scheduler.idle()
  expect(t.runs).toEqual([['tick'], ['manual', 'tick']])
  expect(t.scheduler.busy).toBe(false)
})

test('a round that throws goes to onError; the scheduler runs again and idle settles', async () => {
  const t = rig({ throwOnce: true })
  t.scheduler.kick('tick')
  await t.scheduler.idle()
  expect(t.errors).toHaveLength(1)
  t.scheduler.kick('tick')
  await t.scheduler.idle()
  expect(t.runs).toHaveLength(2)
})

test('a timer the engine refused is replaced once it is long overdue', async () => {
  const t = rig({ refuseFirst: true })
  t.scheduler.kick('git')
  await t.advance(2000)
  expect(t.runs).toHaveLength(0)
  t.scheduler.kick('agent')
  await t.advance(LIMITS.autoDebounceMs)
  expect(t.runs).toEqual([['agent', 'git']])
})

test('idle settles at once when nothing runs', async () => {
  const t = rig()
  await t.scheduler.idle()
  expect(t.scheduler.busy).toBe(false)
})
