// Child process for the lock race test. It speaks one line per message on stdio:
//   child -> parent: "ready" once the module is loaded
//   parent -> child: "go" to make one attempt at the lock, or "go <ms>" to wait first until the
//                    time <ms> (ms since the epoch) so that two children attempt together
//   child -> parent: "won" or "lost"
// A winner keeps its live pid, and so the lock, until the parent closes stdin. So a second
// attempt always overlaps the first one.
// With the env var LOCK_FAULTS (a fault plan, see lock-faults.ts) the attempt runs slower or ends
// in a crash at a chosen fs call. A crashed child writes no result line.
import { createInterface } from 'node:readline'
import { acquireLock } from '../../support/lock.ts'
import { type FaultPlan, installFaults } from './lock-faults.ts'

const dir = process.argv[2]!
const plan = process.env.LOCK_FAULTS
const faults = plan === undefined ? undefined : installFaults(JSON.parse(plan) as FaultPlan)
const input = createInterface({ input: process.stdin })
let attempted = false

input.on('line', line => {
  const [word, at] = line.split(' ')
  if (word !== 'go' || attempted) return
  attempted = true
  // Spin, not sleep: a timer wakes up late and by a different amount in each child.
  while (at !== undefined && Date.now() < Number(at)) {}
  faults?.arm()
  let result = 'won'
  try {
    acquireLock(dir)
  } catch {
    result = 'lost'
  }
  faults?.disarm()
  process.stdout.write(`${result}\n`)
})
input.on('close', () => process.exit(0))
process.stdout.write('ready\n')
