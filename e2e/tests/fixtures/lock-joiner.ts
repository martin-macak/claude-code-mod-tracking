// Child process for the queue join test. It joins the run queue of each lock folder that argv names (one queue for each) at
// a moment that the parent chose, so that several children join together. It speaks one line per message on stdio:
//   child -> parent: "ready" once the module is loaded
//   parent -> child: "join <ms>": wait until the time <ms> (ms since the epoch), then join the queue
//   child -> parent: "joined <ticket name>" (the ticket in the first folder)
//   parent -> child: "place": say where this run stands in the first folder, with every ticket taken as a live run
//   child -> parent: "placed first|behind <pid of the first run> <number of runs ahead>"
// The child lives on after it joined, so its tickets stay live. It ends when stdin closes, and the exit hook of the
// queues then removes the tickets.
import { createInterface } from 'node:readline'
import { RunQueue } from '../../support/lock-queue.ts'

const queues = process.argv.slice(2).map(dir => new RunQueue(dir))
const input = createInterface({ input: process.stdin })
input.on('line', line => {
  const [word, at] = line.split(' ')
  if (word === 'place') {
    const place = queues[0]!.place(() => true)
    process.stdout.write(`placed ${place.first ? 'first' : 'behind'} ${place.headPid} ${place.ahead}\n`)
    return
  }
  if (word !== 'join') return
  // Spin, not sleep: a timer wakes up late and by a different amount in each child.
  while (Date.now() < Number(at)) {}
  for (const queue of queues) queue.join()
  process.stdout.write(`joined ${queues[0]!.name}\n`)
})
input.on('close', () => process.exit(0))
process.stdout.write('ready\n')
