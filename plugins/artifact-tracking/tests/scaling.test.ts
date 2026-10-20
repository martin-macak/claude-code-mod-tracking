// expectLinear (fixtures/scaling.ts) is the load-tolerant form of a wall-clock budget (issue #104). It times the work on a
// small and on a large input (4 times as big), best of three runs each, and fails when the large input takes more than
// 12 times as long plus a noise floor. Linear work takes 4 times as long, quadratic work 16 times, exponential work more.
// A busy machine slows both runs alike, so the ratio holds. These tests use a fake clock: the work advances it by a cost
// the test chooses, so no case here depends on real time.
import { expect, test } from 'claude-code/testing'
import {
  CPU_CEILING_MS,
  type Env,
  expectLinear,
  LINEAR_FACTOR,
  LINEAR_RUNS,
  MAX_RUNS,
  NOISE_FLOOR_MS,
  pickClock,
  RETRY_BUDGET_MS,
  SCALE,
  type Timing,
} from './fixtures/scaling'

/** A clock the work advances: `spend(ms)` is the time the work takes. */
function fakeClock() {
  let t = 0
  return {
    now: () => t,
    spend: (ms: number) => {
      t += ms
    },
  }
}

/** The error that `expectLinear` throws, or undefined when it passes. */
async function failure(run: Promise<Timing>): Promise<Error | undefined> {
  return run.then(
    () => undefined,
    e => e as Error,
  )
}

test('the constants say what the check means: 4 times the input, 12 times the time, three runs', () => {
  expect(SCALE).toBe(4)
  expect(LINEAR_FACTOR).toBe(12)
  expect(LINEAR_RUNS).toBe(3)
  expect(NOISE_FLOOR_MS).toBeGreaterThan(0)
  expect(NOISE_FLOOR_MS).toBeLessThanOrEqual(25) // small: it is only noise, not a budget
})

test('linear work passes, and the result names both times', async () => {
  const c = fakeClock()
  const timing = await expectLinear({ now: c.now, make: k => 1000 * k, run: n => c.spend(n) })
  expect(timing.smallMs).toBe(1000)
  expect(timing.largeMs).toBe(4000)
  expect(timing.limitMs).toBe(LINEAR_FACTOR * 1000 + NOISE_FLOOR_MS)
})

test('n log n work passes', async () => {
  const c = fakeClock()
  await expectLinear({ now: c.now, make: k => 1000 * k, run: n => c.spend((n * Math.log2(n)) / 10) })
})

test('quadratic work fails, and the message gives the sizes, the times and the ratio', async () => {
  const c = fakeClock()
  const error = await failure(expectLinear({ now: c.now, make: k => 1000 * k, run: n => c.spend((n * n) / 1000) }))
  expect(error).toBeDefined()
  expect(error!.message).toContain('4 times the input')
  expect(error!.message).toContain('small 1000.0 ms')
  expect(error!.message).toContain('large 16000.0 ms')
  expect(error!.message).toContain('ratio 16.0')
  expect(error!.message).toContain(`limit ${(LINEAR_FACTOR * 1000 + NOISE_FLOOR_MS).toFixed(1)} ms`)
})

// A run that is longer than a slice of the scheduler is hit by one with a likelihood that grows with its length. On a busy
// machine that makes the big input look slower than 4 times, three times in a row. More pairs find a quiet one.
test('a would-be failure is measured again, and passes when a later pair is quiet', async () => {
  const c = fakeClock()
  let calls = 0
  // Linear work: small 10 ms, big 40 ms. The big runs of the first three pairs (calls 2, 4, 6) take 10 times as long.
  const run = (n: number) => {
    calls++
    c.spend((n / 100) * (n > 1000 && calls <= 2 * LINEAR_RUNS ? 10 : 1))
  }
  const timing = await expectLinear({ now: c.now, make: k => 1000 * k, run })
  expect(timing.largeMs).toBe(40)
  expect(calls).toBe(2 * (LINEAR_RUNS + 1)) // it stopped at the first pair that passed
})

test('quadratic work that is cheap fails only after the most pairs', async () => {
  const c = fakeClock()
  let calls = 0
  // small 5 ms, big 80 ms, limit 70 ms. A pair costs 85 ms, and MAX_RUNS pairs cost less than the retry budget.
  const run = (k: number) => {
    calls++
    c.spend(5 * k * k)
  }
  const error = await failure(expectLinear({ now: c.now, make: k => k, run }))
  expect(error).toBeDefined()
  expect(calls).toBe(2 * MAX_RUNS)
  expect(MAX_RUNS * 85).toBeLessThan(RETRY_BUDGET_MS)
})

test('slow work that fails is not measured again: the first three pairs spent the budget', async () => {
  const c = fakeClock()
  let calls = 0
  const run = (n: number) => {
    calls++
    c.spend((n * n) / 1000) // small 1000 ms, big 16 000 ms
  }
  const error = await failure(expectLinear({ now: c.now, make: k => 1000 * k, run }))
  expect(error).toBeDefined()
  expect(calls).toBe(2 * LINEAR_RUNS)
})

test('the limits of the retry are what the message says: three pairs at least, more while the runs are cheap', () => {
  expect(MAX_RUNS).toBeGreaterThan(LINEAR_RUNS)
  expect(RETRY_BUDGET_MS).toBeGreaterThanOrEqual(1000)
  expect(RETRY_BUDGET_MS).toBeLessThanOrEqual(3000) // the kit stops a test that names no limit after 5 s
})

test('a label names the work in the message', async () => {
  const c = fakeClock()
  const error = await failure(
    expectLinear({ label: 'backtick runs', now: c.now, make: k => 1000 * k, run: n => c.spend((n * n) / 1000) }),
  )
  expect(error!.message.startsWith('backtick runs: the work grows faster than linear')).toBe(true)
})

test('without a label the message starts with the finding', async () => {
  const c = fakeClock()
  const error = await failure(expectLinear({ now: c.now, make: k => 1000 * k, run: n => c.spend((n * n) / 1000) }))
  expect(error!.message.startsWith('the work grows faster than linear')).toBe(true)
})

test('exponential work fails', async () => {
  const c = fakeClock()
  const error = await failure(expectLinear({ now: c.now, make: k => 100 * k, run: n => c.spend(1.1 ** n) }))
  expect(error).toBeDefined()
})

test('a slow run among the three does not fail linear work: the best run counts', async () => {
  const c = fakeClock()
  let calls = 0
  // The runs alternate, so the large runs are calls 2, 4 and 6. The second of them meets a busy moment and takes ten
  // times as long.
  const run = (n: number) => {
    calls++
    c.spend(calls === 4 ? 10 * n : n)
  }
  const timing = await expectLinear({ now: c.now, make: k => 1000 * k, run })
  expect(timing.largeMs).toBe(4000)
})

test('the small time is the best run too, so one lucky or slow small run moves the limit the right way', async () => {
  const c = fakeClock()
  let calls = 0
  // Small runs (calls 1, 3 and 5): 1000, 9000, 9000 ms. The best is 1000, so the limit stays 12 010 ms and 20 000 ms fails.
  const run = (n: number) => {
    calls++
    c.spend(n === 1000 ? (calls === 1 ? 1000 : 9000) : 20_000)
  }
  const error = await failure(expectLinear({ now: c.now, make: k => 1000 * k, run }))
  expect(error).toBeDefined()
  expect(error!.message).toContain('small 1000.0 ms')
})

test('a work that takes no time passes: the noise floor covers it', async () => {
  const c = fakeClock()
  // 0.1 ms and 3 ms is a ratio of 30, and still under 12 * 0.1 + the floor.
  await expectLinear({ now: c.now, make: k => k, run: k => c.spend(k === 1 ? 0.1 : 3) })
})

test('a large time over the floor fails when the small time is zero', async () => {
  const c = fakeClock()
  const error = await failure(
    expectLinear({ now: c.now, make: k => k, run: k => c.spend(k === 1 ? 0 : NOISE_FLOOR_MS + 1) }),
  )
  expect(error).toBeDefined()
  expect(error!.message).toContain('small 0.0 ms')
  expect(error!.message).toContain('ratio n/a')
})

test('it builds both inputs once, in the order 1 then 4, before any run, and times only the work', async () => {
  const c = fakeClock()
  const events: string[] = []
  const timing = await expectLinear({
    now: c.now,
    make: k => {
      events.push(`make ${k}`)
      c.spend(1_000_000) // building is slow, and is not in the time
      return k
    },
    run: k => {
      events.push(`run ${k}`)
      c.spend(k)
    },
  })
  expect(events.slice(0, 2)).toEqual(['make 1', `make ${SCALE}`])
  expect(events.filter(e => e.startsWith('make'))).toHaveLength(2)
  expect(timing.smallMs).toBe(1)
  expect(timing.largeMs).toBe(4)
})

test('the runs alternate between the sizes, three on each, and the work gets the input it made', async () => {
  // A busy slice of the machine hits one run. With the runs in a row it could take all three runs of one size, and the
  // ratio would be wrong. Alternating, it takes one of each size at worst, and the best of three recovers both times.
  const c = fakeClock()
  const seen: unknown[] = []
  const input = { tag: 'big' }
  await expectLinear({
    now: c.now,
    make: k => (k === 1 ? { tag: 'small' } : input),
    run: x => {
      seen.push(x)
    },
  })
  expect(seen.map(x => (x as { tag: string }).tag)).toEqual(['small', 'big', 'small', 'big', 'small', 'big'])
  expect(seen[1]).toBe(input)
  expect(seen[5]).toBe(input)
})

test('a busy slice over the first three runs cannot hide quadratic work', async () => {
  const c = fakeClock()
  let calls = 0
  // The machine is busy for calls 1 to 3: they take 20 times as long. In a row, that is all three small runs, the small
  // time would be 20 times too big, and the limit with it. Alternating, the slice takes two small runs and one large
  // run, and calls 4 to 6 give the true best of both: small 1000 ms, large 16 000 ms.
  const run = (n: number) => {
    calls++
    c.spend(((n * n) / 1000) * (calls <= 3 ? 20 : 1))
  }
  const error = await failure(expectLinear({ now: c.now, make: k => 1000 * k, run }))
  expect(error).toBeDefined()
  expect(error!.message).toContain('small 1000.0 ms')
  expect(error!.message).toContain('large 16000.0 ms')
})

test('work that returns a promise is awaited and timed', async () => {
  const c = fakeClock()
  const timing = await expectLinear({
    now: c.now,
    make: k => 1000 * k,
    run: async n => {
      await Promise.resolve()
      c.spend(n)
    },
  })
  expect(timing.smallMs).toBe(1000)
  expect(timing.largeMs).toBe(4000)
})

test('work that throws fails the check with its own error', async () => {
  const c = fakeClock()
  const error = await failure(
    expectLinear({
      now: c.now,
      make: k => k,
      run: () => {
        throw new Error('boom')
      },
    }),
  )
  expect(error!.message).toBe('boom')
})

// Which clock the check reads. A wall clock cannot tell a slow run from a starved one: on a machine with a long run queue,
// a run longer than a slice of the scheduler takes a multiple of its CPU time, and a short run can still land in one
// quiet slice, so the big input looks far more than 4 times as slow. Only a CPU clock is exact. Node has one
// (`process.cpuUsage`), and the kit does not: its sandbox has no `process`, only `performance.now()`.
test('pickClock: a CPU clock wins, in ms, whatever the wall option says', () => {
  const env: Env = { cpuUsage: () => ({ user: 1500, system: 500 }), wallNow: () => 99 }
  for (const wall of [false, true]) {
    const clock = pickClock(env, wall)
    expect(clock.kind).toBe('cpu')
    expect(clock.now!()).toBe(2) // 2000 microseconds
  }
})

test('pickClock: with no CPU clock the wall clock is used only when the test asks for it', () => {
  const env: Env = { wallNow: () => 99 }
  const asked = pickClock(env, true)
  expect(asked.kind).toBe('wall')
  expect(asked.now!()).toBe(99)
  const not = pickClock(env, false)
  expect(not.kind).toBe('none')
  expect(not.now).toBeUndefined()
})

test('with no clock the check runs the work once, on the big input, and the result says so', async () => {
  const seen: unknown[] = []
  const timing = await expectLinear({
    env: {},
    make: k => ({ k }),
    run: x => {
      seen.push(x)
    },
  })
  expect(seen).toEqual([{ k: SCALE }])
  expect(timing.clock).toBe('none')
  expect(Number.isNaN(timing.smallMs) && Number.isNaN(timing.largeMs) && Number.isNaN(timing.limitMs)).toBe(true)
})

test('with no clock the work still fails the test when it throws', async () => {
  const error = await failure(
    expectLinear({
      env: {},
      make: k => k,
      run: () => {
        throw new Error('boom')
      },
    }),
  )
  expect(error!.message).toBe('boom')
})

test('a CPU clock from the environment is read, and quadratic work fails on it', async () => {
  let cpuMs = 0
  const env: Env = { cpuUsage: () => ({ user: cpuMs * 1000, system: 0 }) }
  const error = await failure(
    expectLinear({
      env,
      make: k => 1000 * k,
      run: n => {
        cpuMs += (n * n) / 1000
      },
    }),
  )
  expect(error).toBeDefined()
  expect(error!.message).toContain('ratio 16.0')
})

// A ratio cannot see work that grows slower than quadratic (n^1.5 gives a ratio of 8) or a linear scan with a large constant:
// both sizes slow alike. The ceiling on the CPU time of the big input does. CPU time does not grow with load.
test('linear work that costs seconds of CPU fails on the ceiling, whatever the ratio', async () => {
  let cpuMs = 0
  const env: Env = { cpuUsage: () => ({ user: cpuMs * 1000, system: 0 }) }
  const error = await failure(
    expectLinear({
      env,
      make: k => 750 * k,
      run: n => {
        cpuMs += n // linear: the ratio is 4, and the big input takes 3000 ms
      },
    }),
  )
  expect(error).toBeDefined()
  expect(error!.message).toContain('3000 ms of CPU')
  expect(error!.message).toContain(`more than ${CPU_CEILING_MS} ms`)
  expect(error!.message).not.toContain('grows faster than linear')
})

test('work of n^1.5 passes the ratio and fails the ceiling', async () => {
  let cpuMs = 0
  const env: Env = { cpuUsage: () => ({ user: cpuMs * 1000, system: 0 }) }
  const error = await failure(
    expectLinear({
      label: 'a scan',
      env,
      make: k => 400 * k,
      run: n => {
        cpuMs += (n * Math.sqrt(n)) / 10 // 800 ms at 400, 6400 ms at 1600: a ratio of 8
      },
    }),
  )
  expect(error).toBeDefined()
  expect(error!.message).toContain('a scan: the big input took 6400 ms of CPU')
})

test('the ceiling is for the CPU clock only: a custom clock reads its own times', async () => {
  const c = fakeClock()
  const timing = await expectLinear({ now: c.now, make: k => 2000 * k, run: n => c.spend(n) })
  expect(timing.clock).toBe('custom')
  expect(timing.largeMs).toBe(8000) // far over the ceiling, and it passes
})

test('a big input just under the ceiling passes', async () => {
  let cpuMs = 0
  const env: Env = { cpuUsage: () => ({ user: cpuMs * 1000, system: 0 }) }
  const timing = await expectLinear({
    env,
    make: k => (CPU_CEILING_MS / SCALE) * k,
    run: n => {
      cpuMs += n
    },
  })
  expect(timing.clock).toBe('cpu')
  expect(timing.largeMs).toBe(CPU_CEILING_MS)
})

test('a clock that the test passes is the one that is read, and the result names it', async () => {
  const c = fakeClock()
  const timing = await expectLinear({
    now: c.now,
    env: { cpuUsage: () => ({ user: 1e12, system: 0 }) },
    make: k => k,
    run: k => c.spend(k),
  })
  expect(timing.clock).toBe('custom')
})

// Node has a CPU clock and the kit has none, so this runs on a different clock in each. In the kit the work runs once.
test('with the real clocks, work that does nothing passes', async () => {
  const timing = await expectLinear({ make: k => k, run: () => {} })
  if (timing.clock === 'none') expect(Number.isNaN(timing.largeMs)).toBe(true)
  else expect(timing.largeMs).toBeLessThanOrEqual(timing.limitMs)
})

test('with the wall clock asked for, the real clocks give a clock in both runtimes', async () => {
  const timing = await expectLinear({ wallClock: true, make: k => k, run: () => {} })
  expect(['cpu', 'wall']).toContain(timing.clock)
  expect(timing.largeMs).toBeLessThanOrEqual(timing.limitMs)
})
