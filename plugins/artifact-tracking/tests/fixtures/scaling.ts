// A load-tolerant check that work grows about linearly with its input. It replaces the wall-clock budget (a test that
// reads the clock before and after the work and expects the difference under a fixed number of ms), which fails on a busy
// machine and says nothing about the cost of the work (issue #104).
//
// The check times the work on a small input and on one 4 times as big, best of three runs each. It fails when the big
// input takes more than 12 times as long as the small one, plus a small noise floor. Linear work takes about 4 times as
// long, n log n a little more, quadratic work 16 times, exponential work far more. A busy machine slows both inputs
// alike, so the ratio holds where an absolute time does not, and the best of three runs drops a slice that the scheduler
// took. The runs alternate (small, big, small, big, small, big), so one slice of the scheduler hits both sizes and the
// best of three still gives each its true time. The cost of a slice does not scale with the input, which is what the
// floor is for.
//
// A run that is longer than a slice is hit by one more often than a short run. When the first three pairs would fail the
// check, it measures more pairs (at most 12) while the runs are cheap, and stops at the first pair that passes. Slow work
// that fails gets no more pairs, so a real regression does not make the test slow.
//
// The clock is CPU time where the runtime has it, which is node (`process.cpuUsage`, the pure tests under `make
// coverage`). A wall clock cannot tell a slow run from a starved one. On a machine with a long run queue a run longer than
// a slice of the scheduler takes a multiple of its CPU time, while a short run can still land in one quiet slice, so the
// big input looks far more than 4 times as slow, whatever the number of runs. The kit has no CPU clock: its sandbox has
// no `process`, only `performance.now()`. In the kit the check runs the work once, on the big input, and reads no time, so
// the kit still fails on an error, and the node run holds the ratio. A kit-only test whose runs are short (a few ms, so
// under a slice) passes `wallClock: true` and is measured on the wall clock.
//
// Pick a base size where the cost you fear shows. A quadratic part must be bigger than twice the linear part at the small
// size, or the ratio stays under 12. A scan that caps its input (`MAX_TEXT`) shows nothing above the cap, so keep the big
// input at or under it. The cap itself gets a second check with both inputs above it: a scan that cuts at the cap has a flat
// cost there, and a pass over the full text before the cut grows with the input.
//
// A ratio is blind to work that grows slower than quadratic (n^1.5 gives 8) and to a linear scan with a large constant,
// because both sizes slow alike. So the CPU clock also has a ceiling for the big input (`CPU_CEILING_MS`). CPU time does not
// grow with load, so the ceiling is as load-tolerant as the ratio. Rule: docs/AGENTS.md, "Tests".

declare const performance: { now(): number } | undefined
declare const process: { cpuUsage?: () => { user: number; system: number } } | undefined

/** The big input is this many times the small one. */
export const SCALE = 4
/** The big input may take this many times the time of the small one. Linear work needs 4, quadratic work 16. */
export const LINEAR_FACTOR = 12
/** Each size runs this many times. The fastest run counts. */
export const LINEAR_RUNS = 3
/** Added to the limit, in ms: what one slice of a busy machine costs. It is noise, not a budget. */
export const NOISE_FLOOR_MS = 10
/**
 * The big input may not take more CPU time than this, in ms. A ratio cannot see work that grows slower than quadratic
 * (n^1.5 gives a ratio of 8) or a linear scan with a large constant, because both sizes slow alike. CPU time does not grow
 * with load, so a ceiling is as load-tolerant as the ratio. It applies to the CPU clock only: a wall clock does not
 * tolerate load. The scans under test take 70 ms or less at the cap, so the ceiling leaves 15 times of room.
 */
export const CPU_CEILING_MS = 1000
/** A check that fails is measured again, up to this many pairs of runs in all. */
export const MAX_RUNS = 12
/** ... but only while the timed runs add up to less than this, in ms. Slow work that fails is not measured again. */
export const RETRY_BUDGET_MS = 2000

/** What the check read the time from: the CPU clock, the wall clock, a clock that the test passed, or no clock. */
export type ClockKind = 'cpu' | 'wall' | 'custom' | 'none'

/** The clocks of the runtime. A test of this check passes its own. */
export type Env = {
  /** Node's `process.cpuUsage`: user and system CPU time of the process, in microseconds. */
  cpuUsage?: () => { user: number; system: number }
  /** The wall clock in ms. */
  wallNow?: () => number
}

/** The clocks of this runtime: node has both, the kit only the wall clock. */
export function realEnv(): Env {
  const env: Env = {}
  if (typeof process !== 'undefined' && typeof process.cpuUsage === 'function')
    env.cpuUsage = process.cpuUsage.bind(process)
  env.wallNow = typeof performance === 'undefined' ? () => Date.now() : () => performance.now()
  return env
}

/**
 * The clock to read, in ms. The CPU clock when there is one. Else the wall clock, when the test asks for it. Else none:
 * the check then reads no time.
 */
export function pickClock(env: Env, allowWall: boolean): { kind: 'cpu' | 'wall' | 'none'; now?: () => number } {
  const cpuUsage = env.cpuUsage
  if (cpuUsage !== undefined) {
    return {
      kind: 'cpu',
      now: () => {
        const u = cpuUsage()
        return (u.user + u.system) / 1000
      },
    }
  }
  if (allowWall && env.wallNow !== undefined) return { kind: 'wall', now: env.wallNow }
  return { kind: 'none' }
}

export type Timing = {
  /** The clock that gave the times. With `none` the times are NaN: the work ran once on each input and nothing was timed. */
  clock: ClockKind
  /** The best of the runs on the small input, in ms. */
  smallMs: number
  /** The best of the runs on the big input, in ms. */
  largeMs: number
  /** What `largeMs` may be: `LINEAR_FACTOR * smallMs + NOISE_FLOOR_MS`. */
  limitMs: number
}

export type Scaling<T> = {
  /** Names the work in the failure message, for a test that checks several inputs. */
  label?: string
  /**
   * The input at `scale` times the base size: `make(1)` is the small input, `make(4)` the big one. Not timed. Both are
   * built before the first run, and the runs alternate between them, so `run` must take what it works on from its input
   * and not from a state that `make` left behind.
   */
  make: (scale: number) => T
  /** The work under test, on an input from `make`. Timed. It may return a promise. */
  run: (input: T) => unknown
  /** Read the wall clock when the runtime has no CPU clock (the kit). Only for work whose runs are short, a few ms. */
  wallClock?: boolean
  /** The clock in ms. Absent: see `pickClock`. A test of this check passes one. */
  now?: () => number
  /** The clocks of the runtime. Absent: `realEnv()`. A test of this check passes its own. */
  env?: Env
}

/** The time of one run of the work on `input`. */
async function timed<T>(input: T, run: (input: T) => unknown, now: () => number): Promise<number> {
  const t0 = now()
  await run(input)
  return now() - t0
}

/**
 * Throws when 4 times the input takes more than 12 times the time plus the noise floor. Returns the times when it passes.
 * Both inputs are built once, before any run, so building is not timed. Then the runs alternate between the sizes.
 */
export async function expectLinear<T>(o: Scaling<T>): Promise<Timing> {
  const picked =
    o.now === undefined ? pickClock(o.env ?? realEnv(), o.wallClock ?? false) : { kind: 'custom' as const, now: o.now }
  const now = picked.now
  if (now === undefined) {
    // No clock: the work still runs once, on the big input, so an error in it fails the test.
    await o.run(o.make(SCALE))
    return { clock: 'none', smallMs: Number.NaN, largeMs: Number.NaN, limitMs: Number.NaN }
  }
  const small = o.make(1)
  const large = o.make(SCALE)
  let smallMs = Number.POSITIVE_INFINITY
  let largeMs = Number.POSITIVE_INFINITY
  let spentMs = 0
  let runs = 0
  const limit = () => LINEAR_FACTOR * smallMs + NOISE_FLOOR_MS
  while (true) {
    const s = await timed(small, o.run, now)
    const l = await timed(large, o.run, now)
    runs++
    smallMs = Math.min(smallMs, s)
    largeMs = Math.min(largeMs, l)
    spentMs += s + l
    if (runs < LINEAR_RUNS) continue
    if (largeMs <= limit() || runs >= MAX_RUNS || spentMs >= RETRY_BUDGET_MS) break
  }
  const limitMs = limit()
  if (largeMs > limitMs) {
    const ratio = smallMs > 0 ? (largeMs / smallMs).toFixed(1) : 'n/a'
    throw new Error(
      `${o.label === undefined ? '' : `${o.label}: `}the work grows faster than linear: ${SCALE} times the input took more than ${LINEAR_FACTOR} times the time ` +
        `(small ${smallMs.toFixed(1)} ms, large ${largeMs.toFixed(1)} ms, ratio ${ratio}, limit ${limitMs.toFixed(1)} ms; ` +
        `best of ${runs} runs each). Linear work takes about ${SCALE} times, quadratic work ${SCALE * SCALE}.`,
    )
  }
  if (picked.kind === 'cpu' && largeMs > CPU_CEILING_MS) {
    throw new Error(
      `${o.label === undefined ? '' : `${o.label}: `}the big input took ${largeMs.toFixed(0)} ms of CPU, more than ${CPU_CEILING_MS} ms ` +
        `(small ${smallMs.toFixed(1)} ms, ratio ${smallMs > 0 ? (largeMs / smallMs).toFixed(1) : 'n/a'}). ` +
        `A ratio cannot see work that grows slower than quadratic or a large constant, so the big input has a ceiling.`,
    )
  }
  return { clock: picked.kind, smallMs, largeMs, limitMs }
}
