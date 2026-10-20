// Child process for the lock publish test. It speaks one line per message on stdio:
//   child -> parent: "ready" once the module is loaded
//   parent -> child: a deadline (ms since the epoch). The child then reads the lock file in a
//                    tight loop until that time.
//   child -> parent: one JSON line, how often it read the file and how often the file was there
//                    with no pid in it
// A lock that is never empty leaves no window in which a second run could read pid 0 and take a
// live lock.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const file = join(process.argv[2]!, '.lock')

const input = createInterface({ input: process.stdin })
input.once('line', line => {
  input.close() // Nothing else to read, so the process ends once the result is written.
  const until = Number(line)
  let reads = 0
  let empty = 0
  while (Date.now() < until) {
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
