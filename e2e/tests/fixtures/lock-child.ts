// Child process for the lock race test: waits for a shared start time, tries the lock, holds it.
import { acquireLock } from '../../support/lock.ts'

const [dir, startAt] = process.argv.slice(2)
while (Date.now() < Number(startAt)) {
  // Busy-wait, so both children try at the same moment.
}
try {
  acquireLock(dir!)
  process.stdout.write('won')
} catch {
  process.stdout.write('lost')
}
setTimeout(() => process.exit(0), 300)
