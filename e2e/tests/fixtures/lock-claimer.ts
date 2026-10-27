// Child process for the lock queue tests: one e2e run. It claims the lock for a scenario through `makeClaimer`, as
// support/world.ts does. It speaks one line per message on stdio:
//   child -> parent: "ready" once the module is loaded
//   parent -> child: "claim" (a scenario takes the lock), "release" (the scenario ends and lets go of the lock),
//                    "leave" (the AfterAll hook: the run leaves the queue), "end" (the process ends)
//   child -> parent: "poll <n>" at each sleep of a waiting claim, "note <text>" at each note about the wait,
//                    "taken" or "error <kind> <text>" for a claim, "released", "left"
// The parent counts these lines and never reads a clock. The child sleeps 20 ms between two polls of a waiting claim.
// argv: the lock folder and the folder of the scenario. env:
//   LOCK_WAIT_MS  how long a claim waits (default 60000, 0: do not wait)
//   LOCK_END      how "end" ends the process: `natural` (default, no process.exit) or `exit` (process.exit(0))
//   LOCK_FAULTS   a fault plan (see lock-faults.ts). It is armed during each claim, so the child can crash in it.
import { createInterface } from 'node:readline'
import { LockBusyError, makeClaimer } from '../../support/lock.ts'
import { type FaultPlan, installFaults } from './lock-faults.ts'

const [lockDir, runDir] = process.argv.slice(2) as [string, string]
const say = (line: string) => process.stdout.write(`${line.replace(/\n/g, ' ')}\n`)
const plan = process.env.LOCK_FAULTS
const faults = plan === undefined ? undefined : installFaults(JSON.parse(plan) as FaultPlan)

let polls = 0
const claim = makeClaimer({
  waitMs: Number(process.env.LOCK_WAIT_MS ?? 60_000),
  pollMs: 20,
  sleep: async ms => {
    say(`poll ${++polls}`)
    await new Promise(resolve => setTimeout(resolve, ms))
  },
  onWait: note => say(`note ${note}`),
  describeHolder: pid => `run ${pid}`,
})

let release: (() => void) | undefined
let ending = false
const input = createInterface({ input: process.stdin })
input.on('line', async line => {
  if (line === 'claim') {
    faults?.arm()
    try {
      release = await claim(lockDir, runDir)
      say('taken')
    } catch (err) {
      say(`error ${err instanceof LockBusyError ? err.kind : 'other'} ${(err as Error).message}`)
    } finally {
      faults?.disarm()
    }
  } else if (line === 'release') {
    release?.()
    release = undefined
    say('released')
  } else if (line === 'leave') {
    claim.leave()
    say('left')
  } else if (line === 'end') {
    ending = true
    if (process.env.LOCK_END === 'exit') process.exit(0)
    input.close()
    process.stdin.destroy() // A paused pipe still keeps the process alive. With nothing else open, it ends by itself.
  }
})
// The parent closed stdin or ended: no one is left to talk to.
input.on('close', () => {
  if (!ending) process.exit(0)
})
say('ready')
