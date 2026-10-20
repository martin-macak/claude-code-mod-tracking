// Fault injection for the lock tests. It wraps the sync functions of `node:fs`, so it widens or
// ends the windows of `acquireLock` with no hook inside `support/lock.ts`. A new fs call in the
// lock is wrapped too. The plan comes from the test as JSON in the env var LOCK_FAULTS.
//
// Only calls between `arm()` and `disarm()` count. A call that an armed call makes itself (the
// recursive `rmSync` uses other fs functions) passes through and does not count.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

export interface FaultPlan {
  // Sleep before and/or after each call of one function, once `skip` calls of it are done.
  delays?: Record<string, { before?: number; after?: number; skip?: number }>
  // Sleep this many ms before the n-th armed call (0-based, any function). Later calls do not sleep.
  sequence?: number[]
  // Kill the process with SIGKILL before the n-th armed call (1-based, any function). It leaves
  // every file as it is at that moment, like a crash.
  crashAt?: number
}

const sleeper = new Int32Array(new SharedArrayBuffer(4))
const sleep = (ms: number) => {
  if (ms > 0) Atomics.wait(sleeper, 0, 0, ms)
}

export function installFaults(plan: FaultPlan) {
  let armed = false
  let inside = false
  let calls = 0
  const perFunction = new Map<string, number>()
  const table = fs as unknown as Record<string, (...args: unknown[]) => unknown>
  for (const name of Object.keys(table)) {
    const original = table[name]
    if (!name.endsWith('Sync') || typeof original !== 'function') continue
    table[name] = (...args) => {
      if (!armed || inside) return original(...args)
      inside = true
      try {
        const n = calls++
        if (plan.crashAt === n + 1) {
          process.kill(process.pid, 'SIGKILL')
          sleep(60_000)
        }
        sleep(plan.sequence?.[n] ?? 0)
        const own = perFunction.get(name) ?? 0
        perFunction.set(name, own + 1)
        const delay = plan.delays?.[name]
        const slow = delay !== undefined && own >= (delay.skip ?? 0)
        if (slow) sleep(delay.before ?? 0)
        const result = original(...args)
        if (slow) sleep(delay.after ?? 0)
        return result
      } finally {
        inside = false
      }
    }
  }
  // The named imports of `node:fs` in other modules follow the changed functions after this.
  syncBuiltinESMExports()
  return {
    arm: () => {
      armed = true
    },
    disarm: () => {
      armed = false
    },
  }
}
