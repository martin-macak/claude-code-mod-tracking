import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { code } from './errno.ts'

// The queue of the runs that wait for the e2e lock (issue #177). `lock.ts` asks it before each try at the lock.
//
// One ticket for each run process: an empty file `<number>-<pid>` in `.lock.queue/` next to `.lock`. A run joins at its first
// claim and leaves when its last scenario is done, so all its scenarios stay together and the runs get the lock in the order
// they came. The pid is in the name, so nothing reads file content (no empty-file window) and a ticket is removed by its exact
// name, as the takeover guard of `lock.ts` removes the file of a dead pid. The number is the highest number in the folder plus
// one, so a later ticket never sorts before an earlier one. Two runs that read the same highest number get the same number,
// and the pid orders them: they came in the same instant. The first ticket in that order is the first run. In such a tie the
// run with the higher pid can take the lock first, and it then waits behind the other run for its next scenarios.
//
// The queue only orders the waiters. It never takes the place of the lock: `acquireLock` is the one thing that excludes, and a
// fault of the queue can change the order, not give the lock to two runs.
//
// One queue for each lock folder and process. A second queue of this process on the same folder would remove the tickets of
// the first: `place` removes a ticket with its own pid that is not its own, as a leftover of a crashed run that had this pid.
const NAME = /^(\d+)-(\d+)$/

type Entry = { name: string; n: number; pid: number }

// The tickets of a queue folder in order: by number, and by pid within a number. Names of another form are not tickets, and
// neither is a name with the pid 0: `kill(0, 0)` signals the process group and succeeds, so it would be a live run for ever.
function entries(queue: string): Entry[] {
  let names: string[]
  try {
    names = readdirSync(queue)
  } catch (err) {
    if (code(err) === 'ENOENT') return []
    throw err
  }
  const out: Entry[] = []
  for (const name of names) {
    const match = NAME.exec(name)
    if (match && Number(match[2]) > 0) out.push({ name, n: Number(match[1]), pid: Number(match[2]) })
  }
  return out.sort((a, b) => a.n - b.n || a.pid - b.pid)
}

export type Place = {
  /** No live run is ahead of this one. */
  first: boolean
  /** The pid of the first live run: the one ahead of this run, or this run when it is first. */
  headPid: number
  /** How many live runs are ahead. */
  ahead: number
}

// The queues that hold a ticket and want it removed when the process ends. One listener on `exit` serves all of them: a
// listener for each queue would pass the limit of ten of an EventEmitter. The `exit` event comes on a natural end and after
// `process.exit`. It does not come after a signal (SIGINT, SIGTERM, SIGKILL), so a ticket can outlive its run: the next run
// that finds the pid dead removes it (`place`).
const holding = new Set<RunQueue>()
let exitListener = false
function leaveAll() {
  for (const queue of [...holding]) queue.leave()
}

export type QueueOptions = {
  /** The pid of the run that owns the tickets. The default is this process. A test passes the pid of a fake run. */
  pid?: number
  /** Remove the ticket when this process ends (the default). A test with fake runs passes false. */
  exitHook?: boolean
}

export class RunQueue {
  private readonly folder: string
  private readonly pid: number
  private readonly exitHook: boolean
  private ticket: string | undefined

  constructor(lockDir: string, { pid = process.pid, exitHook = true }: QueueOptions = {}) {
    this.folder = join(lockDir, '.lock.queue')
    this.pid = pid
    this.exitHook = exitHook
  }

  /** The name of the ticket of this run, or undefined when it has none. */
  get name(): string | undefined {
    return this.ticket
  }

  /** Takes a ticket at the back of the queue. Does nothing when this run has one. */
  join(): void {
    if (this.ticket !== undefined) return
    mkdirSync(this.folder, { recursive: true })
    // The number is above every ticket in the folder, also a leftover with this pid, so the name is free. The flag `wx` makes a
    // name that is taken a loud error: it would be a bug, not a case to retry.
    const n = Math.max(0, ...entries(this.folder).map(entry => entry.n)) + 1
    const name = `${String(n).padStart(8, '0')}-${this.pid}`
    writeFileSync(join(this.folder, name), '', { flag: 'wx' })
    this.ticket = name
    if (this.exitHook) {
      holding.add(this)
      if (!exitListener) {
        exitListener = true
        process.once('exit', leaveAll)
      }
    }
  }

  /** Gives the ticket back. Does nothing when this run has none, so a second call is safe. */
  leave(): void {
    holding.delete(this)
    if (this.ticket !== undefined) rmSync(join(this.folder, this.ticket), { force: true })
    this.ticket = undefined
  }

  /** Whether a run with this pid has a ticket. A holder with no ticket is an older checkout. */
  has(pid: number): boolean {
    return entries(this.folder).some(entry => entry.pid === pid)
  }

  /**
   * Where this run stands. It joins first when it has no ticket, or when its ticket went missing (a slow cleaner removed it):
   * it then stands at the back. A ticket of a dead pid, and a ticket with this pid that is not this run's own (a leftover of a
   * crashed run that had the same pid), is removed by its exact name and skipped.
   */
  place(isLive: (pid: number) => boolean): Place {
    let list = entries(this.folder)
    if (this.ticket !== undefined && !list.some(entry => entry.name === this.ticket)) this.ticket = undefined
    if (this.ticket === undefined) {
      this.join()
      list = entries(this.folder)
    }
    let ahead = 0
    let headPid: number | undefined
    for (const entry of list) {
      if (entry.name === this.ticket) break
      if (entry.pid === this.pid || !isLive(entry.pid)) {
        rmSync(join(this.folder, entry.name), { force: true })
        continue
      }
      ahead++
      headPid ??= entry.pid
    }
    return { first: ahead === 0, headPid: headPid ?? this.pid, ahead }
  }
}
