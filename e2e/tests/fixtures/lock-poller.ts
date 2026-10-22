// Child process for the lock publish test. It speaks one line per message on stdio:
//   child -> parent: "ready" once the module is loaded
//   parent -> child: how many reads to make. The child then reads the lock file in a tight loop until it has read the
//                    file that many times. A try that finds no file does not count. The child has no clock: a poller
//                    that a loaded machine starves still reads as often as it was asked to, only later.
//   child -> parent: one JSON line, how often it read the file and how often the file was there with no pid in it
// A lock that is never empty leaves no window in which a second run could read pid 0 and take a live lock.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const file = join(process.argv[2]!, '.lock')
const parent = process.ppid
const CHECK_EVERY = 1024 // tries between two looks at the parent

const input = createInterface({ input: process.stdin })
input.once('line', line => {
  input.close() // Nothing else to read, so the process ends once the result is written.
  const wanted = Number(line)
  let reads = 0
  let empty = 0
  for (let tries = 0; reads < wanted; tries++) {
    // The parent ended: no one is left to take the lock or to read the result, so do not spin on.
    if (tries % CHECK_EVERY === 0 && process.ppid !== parent) process.exit(1)
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    reads++
    if (text === '') empty++
  }
  process.stdout.write(`${JSON.stringify({ reads, empty })}\n`)
})
process.stdout.write('ready\n')
