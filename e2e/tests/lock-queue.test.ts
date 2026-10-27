// Issue #177: runs that wait for the e2e lock get it in the order they came. The queue (support/lock-queue.ts) sits above
// `acquireLock`, which tests/lock.test.ts covers and which this change does not touch.
//
// Every test checks order or causality, never wall time (docs/AGENTS.md, "Tests"). The in-process tests use a fake clock, a
// fake sleep and fake runs that the test starts and ends. The tests with processes wait for a line that a child prints or
// for a count of its polls. Each test makes its own lock folder with `mkdtemp`: no test touches `$TMPDIR/cc-demo-lock`.
import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { code } from '../support/errno.ts'
import { claimRun, LockBusyError, makeClaimer } from '../support/lock.ts'
import { RunQueue } from '../support/lock-queue.ts'

// Every folder that a test made. They go when the file is done, so a run leaves nothing behind.
const made: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-queue-'))
  made.push(dir)
  return dir
}
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

const HALF_HOUR = 30 * 60_000
const lockFile = (dir: string) => join(dir, '.lock')
const queueFolder = (dir: string) => join(dir, '.lock.queue')

// The tickets in the queue folder, sorted by name. None when the folder is not there.
function tickets(dir: string): string[] {
  try {
    return readdirSync(queueFolder(dir)).sort()
  } catch (err) {
    if (code(err) === 'ENOENT') return []
    throw err
  }
}
const ticketPids = (dir: string) => tickets(dir).map(name => Number(name.split('-')[1]))

// The pid in the lock file, or undefined when the lock is free.
function lockOwner(dir: string): number | undefined {
  try {
    return Number(readFileSync(lockFile(dir), 'utf8'))
  } catch (err) {
    if (code(err) === 'ENOENT') return undefined
    throw err
  }
}

// A fake clock and a fake sleep. A sleep advances the clock and then runs `onSleep(n)`, so a test says what happens during
// the n-th wait. No real time passes.
function fakeWait(onSleep?: (n: number) => void) {
  let clock = 0
  const sleeps: number[] = []
  return {
    sleeps,
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      clock += ms
      onSleep?.(sleeps.length)
    },
  }
}

// Fake runs. Each has a pid that is live until `end`. A fake run holds the lock by writing its pid. It has a ticket, as a run
// of this change has, unless it is `ticketless`: an older checkout holds the lock and has no ticket.
function fakeRuns(dir: string) {
  const live = new Set<number>()
  const start = (pid: number, { ticketless = false } = {}) => {
    live.add(pid)
    const queue = new RunQueue(dir, { pid, exitHook: false })
    if (!ticketless) queue.join()
    return {
      pid,
      take: () => {
        assert.equal(existsSync(lockFile(dir)), false, `fake run ${pid} found the lock taken`)
        writeFileSync(lockFile(dir), String(pid))
      },
      letGo: () => rmSync(lockFile(dir)),
      end: () => {
        if (lockOwner(dir) === pid) rmSync(lockFile(dir))
        queue.leave()
        live.delete(pid)
      },
    }
  }
  return { start, isLive: (pid: number) => live.has(pid) || pid === process.pid }
}

const describeHolder = (pid: number) => `fake run ${pid}`
const demoDir = () => join(tempDir(), 'demo')

// Options of a claim of this process, with the queue as `makeClaimer` makes it.
function claimOptions(
  dir: string,
  wait: ReturnType<typeof fakeWait>,
  isLive: (pid: number) => boolean,
  notes?: string[],
) {
  return {
    waitMs: HALF_HOUR,
    pollMs: 5000,
    now: wait.now,
    sleep: wait.sleep,
    isLive,
    describeHolder,
    onWait: (note: string) => void notes?.push(note),
    queue: new RunQueue(dir, { exitHook: false }),
  }
}

// ---- The queue, in this process, with fake runs ----

// Issue #177, criterion 1. Run A holds the lock and has the first ticket, run B waits behind it. A lets go after a scenario and
// lives on: the instant between two scenarios. Run C starts in that instant. Without the queue C takes the lock there.
test('a run that starts between two scenarios of A waits behind B, which waited first', async () => {
  const dir = tempDir()
  const runs = fakeRuns(dir)
  const a = runs.start(process.ppid)
  a.take()
  const b = runs.start(1) // B waits: a ticket behind A's, and no lock.
  a.letGo() // The gap. C starts now.
  const owners: string[] = []
  const notes: string[] = []
  const wait = fakeWait(n => {
    if (n === 1) {
      assert.equal(existsSync(lockFile(dir)), false, 'C took the lock in the gap')
      a.take() // The next scenario of A takes the lock again, first: A has the first ticket.
      owners.push('A')
    }
    if (n === 3) a.end() // The run of A ends.
    if (n === 4) {
      assert.equal(existsSync(lockFile(dir)), false, 'C took the lock that B waited for')
      b.take() // B is first now, and the lock is free.
      owners.push('B')
    }
    if (n === 5) b.end() // The run of B ends: C is next.
  })
  const release = await claimRun(dir, demoDir(), claimOptions(dir, wait, runs.isLive, notes))
  owners.push('C')
  assert.deepEqual(owners, ['A', 'B', 'C'])
  assert.equal(lockOwner(dir), process.pid)
  // The notes name the run ahead, with the queue wording, and name it again when the first run changes.
  assert.equal(notes.length, 2)
  assert.match(
    notes[0]!,
    /another demo run is ahead of this run in the queue for .*\.lock: fake run \d+\. Waiting for its turn/,
  )
  assert.match(notes[0]!, new RegExp(`fake run ${process.ppid}\\b`))
  assert.match(notes[1]!, /fake run 1\./)
  release()
})

// The note names the run ahead with the queue wording. The same run then holds the lock for real: the note says so.
test('the note says "holds" when the run it names stays the same but leaves the queue while it holds the lock', async () => {
  const dir = tempDir()
  const runs = fakeRuns(dir)
  const a = runs.start(process.ppid)
  a.take()
  const notes: string[] = []
  const wait = fakeWait(n => {
    // A lives and still holds the lock, but its ticket is gone: this run is first now and finds the lock busy.
    if (n === 1) rmSync(join(queueFolder(dir), tickets(dir)[0]!))
    if (n === 2) a.end()
  })
  const release = await claimRun(dir, demoDir(), claimOptions(dir, wait, runs.isLive, notes))
  assert.equal(notes.length, 2)
  assert.match(notes[0]!, /is ahead of this run in the queue/)
  assert.match(notes[1]!, new RegExp(`another demo run holds .*\\.lock: fake run ${process.ppid}\\.`))
  release()
})

// Two runs that start at once share the number 1. The holder has the higher pid, so it sorts behind this run (issue #177 review).
// Before the fix, this run waited for the process of the holder, and the holder waited behind this run: the lock stayed free.
test('the first run takes the gap of a holder whose ticket shares its number and sorts behind it', async () => {
  const dir = tempDir()
  const mine = new RunQueue(dir, { pid: 2, exitHook: false })
  mine.join() // 00000001-2
  // fakeRuns.start always takes the highest number plus one, so the tie ticket is written by hand.
  writeFileSync(join(queueFolder(dir), `00000001-${process.ppid}`), '')
  writeFileSync(lockFile(dir), String(process.ppid))
  const isLive = (pid: number) => pid === process.ppid || pid === process.pid
  // The holder lets go at the first sleep: its gap. Its real next claim would wait behind this run.
  const wait = fakeWait(n => {
    if (n === 1) rmSync(lockFile(dir))
  })
  const release = await claimRun(dir, demoDir(), { ...claimOptions(dir, wait, isLive), queue: mine })
  assert.deepEqual(wait.sleeps, [5000])
  assert.equal(lockOwner(dir), process.pid)
  release()
})

// The same tie, but the holder leaves the queue while its process lingers (the `AfterAll` hook calls `leave()`). The claim saw a
// holder with a ticket when the busy answer named it, so it must not wait for the process of that holder: the holder has no
// next scenario, and its process may live on for ever (issue #177 review).
test('the first run takes the lock of a holder that had a ticket when seen and left the queue while its process lives on', async () => {
  const dir = tempDir()
  const mine = new RunQueue(dir, { pid: 2, exitHook: false })
  mine.join() // 00000001-2
  const holderTicket = join(queueFolder(dir), `00000001-${process.ppid}`)
  writeFileSync(holderTicket, '')
  writeFileSync(lockFile(dir), String(process.ppid))
  const isLive = (pid: number) => pid === process.ppid || pid === process.pid
  // At the first sleep the holder lets go of the lock and leaves the queue. Its process stays live (`isLive`).
  const wait = fakeWait(n => {
    if (n === 1) {
      rmSync(lockFile(dir))
      rmSync(holderTicket)
    }
  })
  const release = await claimRun(dir, demoDir(), { ...claimOptions(dir, wait, isLive), queue: mine })
  assert.deepEqual(wait.sleeps, [5000])
  assert.equal(lockOwner(dir), process.pid)
  release()
})

// Criterion 2.
test('a ticket of a dead process is skipped and removed by its name', async () => {
  const dir = tempDir()
  const runs = fakeRuns(dir)
  new RunQueue(dir, { pid: 999999, exitHook: false }).join() // Number 1, a dead pid.
  const b = runs.start(1)
  b.take()
  const wait = fakeWait(n => {
    if (n === 2) b.end()
  })
  const release = await claimRun(dir, demoDir(), claimOptions(dir, wait, runs.isLive))
  assert.deepEqual(wait.sleeps, [5000, 5000])
  assert.equal(
    tickets(dir).some(name => name.endsWith('-999999')),
    false,
  )
  release()
})

test('with only dead tickets ahead the claim takes a free lock at once, with no sleep', async () => {
  const dir = tempDir()
  const runs = fakeRuns(dir)
  new RunQueue(dir, { pid: 999999, exitHook: false }).join()
  new RunQueue(dir, { pid: 999998, exitHook: false }).join()
  const wait = fakeWait()
  const release = await claimRun(dir, demoDir(), claimOptions(dir, wait, runs.isLive))
  assert.deepEqual(wait.sleeps, [])
  assert.deepEqual(ticketPids(dir), [process.pid])
  release()
})

// A crashed run of this very pid left a ticket. The pid is live (it is ours), so only the name tells that the ticket is not ours.
test('a leftover ticket with our own pid that is not ours goes', async () => {
  const dir = tempDir()
  const runs = fakeRuns(dir)
  mkdirSync(queueFolder(dir))
  writeFileSync(join(queueFolder(dir), `00000001-${process.pid}`), '')
  const wait = fakeWait()
  const release = await claimRun(dir, demoDir(), claimOptions(dir, wait, runs.isLive))
  assert.deepEqual(wait.sleeps, [])
  assert.deepEqual(tickets(dir), [`00000002-${process.pid}`])
  release()
})

// Criterion 3. An older checkout takes the lock and has no ticket. The lock file is a bare pid, so the new code reads it.
test('a lock of a run with no ticket is waited for, and the lock file stays a bare pid', async () => {
  const dir = tempDir()
  const runs = fakeRuns(dir)
  const old = runs.start(process.ppid, { ticketless: true })
  old.take()
  const notes: string[] = []
  const wait = fakeWait(n => {
    if (n === 1) old.letGo() // The gap of the older run: it lives on and takes the lock again.
    if (n === 3) old.end()
  })
  const release = await claimRun(dir, demoDir(), claimOptions(dir, wait, runs.isLive, notes))
  assert.deepEqual(wait.sleeps, [5000, 5000, 5000])
  assert.equal(readFileSync(lockFile(dir), 'utf8'), String(process.pid))
  // The run holds the lock for real, so the note says "holds", not the queue wording.
  assert.equal(notes.length, 1)
  assert.match(notes[0]!, new RegExp(`another demo run holds .*\\.lock: fake run ${process.ppid}\\.`))
  release()
})

test('with no wait a claim fails at once while a live run is ahead in the queue, and leaves no ticket', async () => {
  const dir = tempDir()
  const runs = fakeRuns(dir)
  runs.start(1) // A live ticket and no lock: a run that waits.
  const wait = fakeWait()
  const claim = makeClaimer({ waitMs: 0, now: wait.now, sleep: wait.sleep, isLive: runs.isLive, onWait: () => {} })
  await assert.rejects(claim(dir, demoDir()), (err: unknown) => {
    assert.ok(err instanceof LockBusyError)
    assert.equal(err.pid, 1)
    assert.equal(err.kind, 'lock')
    assert.match(err.message, /another demo run \(pid 1\) is ahead of this run in the queue for /)
    return true
  })
  assert.deepEqual(wait.sleeps, [])
  assert.deepEqual(tickets(dir), ['00000001-1'], 'the claim joined and left: only the live run is there')
})

test('with no wait a claim takes a free lock when the queue is empty', async () => {
  const dir = tempDir()
  const wait = fakeWait()
  const claim = makeClaimer({ waitMs: 0, now: wait.now, sleep: wait.sleep, onWait: () => {} })
  const release = await claim(dir, demoDir())
  assert.equal(lockOwner(dir), process.pid)
  assert.deepEqual(wait.sleeps, [])
  release()
  claim.leave()
})

// Probe P6 of the design study. A run with no wait takes the lock first. A run that waits comes. The first run lets go and takes
// the lock again for its next scenario. A claim with no wait that took no ticket would have the waiting run ahead of it.
test('a run with no wait that took the lock first keeps its place for its next scenario', async () => {
  const dir = tempDir()
  const runs = fakeRuns(dir)
  const wait = fakeWait()
  const claim = makeClaimer({ waitMs: 0, now: wait.now, sleep: wait.sleep, isLive: runs.isLive, onWait: () => {} })
  const first = await claim(dir, demoDir()) // Scenario 1: the queue is empty, so this run is first.
  runs.start(1) // Run B comes and waits: its ticket is behind ours.
  first() // The gap.
  const second = await claim(dir, demoDir()) // Scenario 2: still first.
  assert.equal(lockOwner(dir), process.pid)
  assert.deepEqual(wait.sleeps, [])
  second()
  claim.leave()
})

// A scenario of this process kept the lock. Waiting could not end, so the claim fails at once, also with a live run ahead.
test('a lock that this process holds fails at once, also while a live run is ahead in the queue', async () => {
  const dir = tempDir()
  const runs = fakeRuns(dir)
  runs.start(1) // A live ticket ahead of ours.
  writeFileSync(lockFile(dir), String(process.pid))
  const wait = fakeWait()
  const claim = makeClaimer({
    waitMs: HALF_HOUR,
    pollMs: 5000,
    now: wait.now,
    sleep: wait.sleep,
    isLive: runs.isLive,
    describeHolder,
    onWait: () => {},
  })
  await assert.rejects(claim(dir, demoDir()), (err: unknown) => {
    assert.ok(err instanceof LockBusyError)
    assert.equal(err.kind, 'self')
    assert.match(err.message, /this process.*did not release/)
    return true
  })
  assert.deepEqual(wait.sleeps, [])
  assert.deepEqual(tickets(dir), ['00000001-1'], 'the failed claim holds no ticket')
})

// A claimer of this process that waited the whole bound behind a live run (the run A, which holds the lock) and gave up. The
// claimer keeps what it knows of the first timeout in the instance, so each test below drives this phase again.
async function claimerThatGaveUp() {
  const dir = tempDir()
  const runs = fakeRuns(dir)
  const a = runs.start(1)
  a.take()
  const wait = fakeWait()
  const claim = makeClaimer({
    waitMs: 20_000,
    pollMs: 5000,
    now: wait.now,
    sleep: wait.sleep,
    isLive: runs.isLive,
    describeHolder,
    onWait: () => {},
  })
  const error = await claim(dir, demoDir()).then(
    () => undefined,
    (err: unknown) => err,
  )
  assert.ok(error instanceof LockBusyError && error.kind === 'timeout', 'the first claim did not give up')
  return { dir, a, wait, claim, error }
}

test('a claim that gave up names the queue in its error and leaves the queue', async () => {
  const { dir, wait, error } = await claimerThatGaveUp()
  assert.ok(error instanceof LockBusyError)
  assert.equal(error.pid, 1)
  // The queue wording says that the run is ahead, not that it holds the lock. The advice stays.
  assert.match(error.message, /^lock: another demo run \(pid 1\) is ahead of this run in the queue for .*\.lock\. /)
  assert.match(error.message, /Waited 20 s for its turn and gave up/)
  assert.match(error.message, /It still runs \(fake run 1\)/)
  assert.match(error.message, /set DEMO_LOCK_WAIT_S above 20/)
  assert.equal(wait.sleeps.length, 4)
  assert.deepEqual(tickets(dir), ['00000001-1'], 'a claim that gave up holds nobody back')
})

test('after a timeout the later scenarios fail at once, with the earlier wait in the text, and leave the queue again', async () => {
  const { dir, wait, claim } = await claimerThatGaveUp()
  await assert.rejects(claim(dir, demoDir()), (err: unknown) => {
    assert.ok(err instanceof LockBusyError)
    assert.equal(err.kind, 'lock')
    assert.match(err.message, /ahead of this run in the queue.*an earlier scenario of this run already waited 20 s/s)
    return true
  })
  assert.equal(wait.sleeps.length, 4, 'the later scenario did not sleep')
  assert.deepEqual(tickets(dir), ['00000001-1'])
})

test('after a timeout the next scenario takes the lock once the run ahead has ended', async () => {
  const { dir, a, wait, claim } = await claimerThatGaveUp()
  a.end()
  const release = await claim(dir, demoDir())
  assert.equal(lockOwner(dir), process.pid)
  assert.equal(wait.sleeps.length, 4, 'the next scenario did not sleep')
  release()
  claim.leave()
})

test('a refusal of acquireLock with no wait leaves no ticket', async () => {
  const dir = tempDir()
  const runs = fakeRuns(dir)
  runs.start(1, { ticketless: true }).take() // An older checkout holds the lock. It has no ticket.
  const claim = makeClaimer({ waitMs: 0, isLive: runs.isLive, onWait: () => {} })
  await assert.rejects(claim(dir, demoDir()), (err: unknown) => {
    assert.ok(err instanceof LockBusyError)
    assert.equal(err.kind, 'lock')
    assert.equal(err.pid, 1)
    return true
  })
  assert.deepEqual(tickets(dir), [])
})

// The claim took the lock and then failed to make the scenario folder. The lock goes back, and so does the ticket.
test('a claim that fails after it took the lock lets go of the lock and leaves the queue', async () => {
  const dir = tempDir()
  const notAFolder = join(tempDir(), 'file')
  writeFileSync(notAFolder, 'a file where the scenario folder should be')
  const claim = makeClaimer({ waitMs: 0, onWait: () => {} })
  await assert.rejects(claim(dir, join(notAFolder, 'demo')), { code: 'ENOTDIR' })
  assert.equal(lockOwner(dir), undefined)
  assert.deepEqual(tickets(dir), [])
})

test('a claimer leaves the queue on leave(), keeps the lock it holds, and the next claim joins again', async () => {
  const dir = tempDir()
  const wait = fakeWait()
  const claim = makeClaimer({ waitMs: HALF_HOUR, now: wait.now, sleep: wait.sleep, onWait: () => {} })
  const release = await claim(dir, demoDir())
  assert.deepEqual(ticketPids(dir), [process.pid])
  claim.leave()
  assert.deepEqual(tickets(dir), [])
  assert.equal(lockOwner(dir), process.pid, 'leaving the queue does not let go of the lock')
  claim.leave() // Twice is safe.
  release()
  const again = await claim(dir, demoDir())
  assert.deepEqual(tickets(dir), [`00000001-${process.pid}`])
  again()
  claim.leave()
})

test('a claimer keeps one queue for each lock folder, and leave() leaves them all', async () => {
  const [one, two] = [tempDir(), tempDir()]
  const claim = makeClaimer({ waitMs: 0, onWait: () => {} })
  const releases = [await claim(one, demoDir()), await claim(two, demoDir())]
  assert.deepEqual([ticketPids(one), ticketPids(two)], [[process.pid], [process.pid]])
  claim.leave()
  assert.deepEqual([tickets(one), tickets(two)], [[], []])
  for (const release of releases) release()
})

// ---- RunQueue ----

test('a ticket number is the highest number plus one, also after a dead ticket is removed', () => {
  const dir = tempDir()
  const live = new Set([11, 13, 14])
  const isLive = (pid: number) => live.has(pid)
  new RunQueue(dir, { pid: 11, exitHook: false }).join() // 1-11
  new RunQueue(dir, { pid: 12, exitHook: false }).join() // 2-12, dead
  const third = new RunQueue(dir, { pid: 13, exitHook: false })
  third.join()
  assert.equal(third.name, '00000003-13')
  assert.deepEqual(third.place(isLive), { first: false, headPid: 11, ahead: 1 }) // Removes 2-12.
  assert.deepEqual(tickets(dir), ['00000001-11', '00000003-13'])
  // The number 2 is free again, but a later run does not take it: it would sort before the run that waits.
  const fourth = new RunQueue(dir, { pid: 14, exitHook: false })
  fourth.join()
  assert.equal(fourth.name, '00000004-14')
  assert.deepEqual(fourth.place(isLive), { first: false, headPid: 11, ahead: 2 })
})

test('the tickets sort by number, and the pid orders runs that share a number', () => {
  const dir = tempDir()
  mkdirSync(queueFolder(dir))
  for (const name of ['00000002-5', '00000001-30', '00000001-4']) writeFileSync(join(queueFolder(dir), name), '')
  const me = new RunQueue(dir, { pid: 99, exitHook: false })
  const place = me.place(() => true)
  assert.deepEqual(place, { first: false, headPid: 4, ahead: 3 })
  assert.equal(me.name, '00000003-99')
})

// A name that is not `<number>-<pid>` is no ticket: it is neither counted nor removed. A pid of 0 is no run either (`kill(0, 0)`
// signals the process group and succeeds), so `00000001-0` would be a live head for ever.
test('a name in the queue folder that is not a ticket is neither counted nor removed', () => {
  const dir = tempDir()
  mkdirSync(queueFolder(dir))
  for (const name of ['.DS_Store', '1-2-3', 'x1-2', '00000001-7.bak', '00000001-0']) {
    writeFileSync(join(queueFolder(dir), name), '')
  }
  const me = new RunQueue(dir, { pid: 9, exitHook: false })
  assert.deepEqual(
    me.place(() => true),
    { first: true, headPid: 9, ahead: 0 },
  )
  assert.deepEqual(tickets(dir), ['.DS_Store', '00000001-0', '00000001-7.bak', '00000001-9', '1-2-3', 'x1-2'])
})

test('leave removes the ticket and twice is safe', () => {
  const dir = tempDir()
  const queue = new RunQueue(dir, { pid: 7, exitHook: false })
  queue.join()
  queue.join() // Twice is safe too, and keeps the place.
  assert.deepEqual(tickets(dir), ['00000001-7'])
  queue.leave()
  queue.leave()
  assert.deepEqual(tickets(dir), [])
  assert.equal(queue.name, undefined)
})

test('a ticket that went missing is made again at the back', () => {
  const dir = tempDir()
  const queue = new RunQueue(dir, { pid: 7, exitHook: false })
  const other = new RunQueue(dir, { pid: 8, exitHook: false })
  queue.join()
  other.join()
  rmSync(join(queueFolder(dir), '00000001-7')) // A slow cleaner removed it.
  assert.deepEqual(
    queue.place(() => true),
    { first: false, headPid: 8, ahead: 1 },
  )
  assert.deepEqual(tickets(dir), ['00000002-8', '00000003-7'])
})

// One listener on `exit` for all queues. A listener for each queue would pass the limit of 10 of an EventEmitter.
test('all queues share one listener on the exit event', () => {
  const before = process.listenerCount('exit')
  const queues = Array.from({ length: 12 }, (_, i) => new RunQueue(tempDir(), { pid: 100 + i }))
  for (const queue of queues) queue.join()
  assert.ok(
    process.listenerCount('exit') - before <= 1,
    `${process.listenerCount('exit') - before} listeners were added`,
  )
  for (const queue of queues) queue.leave()
})

// ---- Runs in processes ----

const claimerPath = fileURLToPath(new URL('./fixtures/lock-claimer.ts', import.meta.url))
const joinerPath = fileURLToPath(new URL('./fixtures/lock-joiner.ts', import.meta.url))
const lockChildPath = fileURLToPath(new URL('./fixtures/lock-child.ts', import.meta.url))

// A child process and the lines that it printed. Every wait is for a line or for a count of polls. The child ends when the
// signal aborts: a test that times out kills its children, it does not leave them running.
class Run {
  readonly lines: string[] = []
  stderr = ''
  readonly proc: ChildProcess
  readonly exited: Promise<void>
  private ended = false
  private claimedAt = 0
  private waiters: {
    from: number
    pred: (line: string) => boolean
    what: string
    resolve: (line: string) => void
    reject: (err: Error) => void
  }[] = []

  constructor(script: string, args: string[], signal: AbortSignal, env: Record<string, string> = {}) {
    this.proc = spawn(process.execPath, [script, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })
    this.proc.stdin!.on('error', () => {}) // A child that ended has closed its stdin.
    signal.addEventListener('abort', () => this.proc.kill('SIGKILL'), { once: true }) // SIGKILL: a stopped child takes no other
    this.proc.stderr!.on('data', chunk => {
      this.stderr += chunk
    })
    this.exited = new Promise<void>(resolve => this.proc.once('exit', () => resolve()))
    createInterface({ input: this.proc.stdout! })
      .on('line', line => {
        this.lines.push(line)
        this.settle()
      })
      .on('close', () => {
        this.ended = true
        this.settle()
      })
  }

  get pid(): number {
    return this.proc.pid!
  }

  // Resolves with the first line from index `from` on that matches. A child that ended with no such line fails the wait.
  until(pred: (line: string) => boolean, what: string, from = 0): Promise<string> {
    return new Promise((resolve, reject) => {
      this.waiters.push({ from, pred, what, resolve, reject })
      this.settle()
    })
  }

  private settle() {
    for (const waiter of [...this.waiters]) {
      const hit = this.lines.slice(waiter.from).find(waiter.pred)
      if (hit === undefined && !this.ended) continue
      this.waiters.splice(this.waiters.indexOf(waiter), 1)
      if (hit !== undefined) waiter.resolve(hit)
      else
        waiter.reject(
          new Error(`${waiter.what}: the child ended first. Lines: ${this.lines.join(' | ')}. Stderr: ${this.stderr}`),
        )
    }
  }

  ready() {
    return this.until(line => line === 'ready', 'ready')
  }

  send(command: string) {
    this.proc.stdin!.write(`${command}\n`)
  }

  // A scenario claims the lock. Resolves with the first answer: `taken`, a `note` that it waits, or an `error`.
  claim(): Promise<string> {
    this.claimedAt = this.lines.length
    this.send('claim')
    return this.until(
      line => line === 'taken' || line.startsWith('note ') || line.startsWith('error '),
      'a claim answer',
      this.claimedAt,
    )
  }

  // The claim that `claim()` made ends with `taken`.
  async taken() {
    await this.until(line => line === 'taken', 'taken', this.claimedAt)
  }

  // Sends a command and waits for its answer line: the line `answer`, or the first line that `match` accepts.
  async command(command: string, answer: string, match: (line: string) => boolean = line => line === answer) {
    const from = this.lines.length
    this.send(command)
    return this.until(match, answer, from)
  }

  release = () => this.command('release', 'released')
  leave = () => this.command('leave', 'left')

  async end() {
    this.send('end')
    await this.exited
  }

  polls = () => this.lines.filter(line => line.startsWith('poll ')).length

  // Waits until the child has polled `n` more times than it has now: a count of events, not a duration.
  async morePolls(n: number) {
    const target = this.polls() + n
    await this.until(line => line.startsWith('poll ') && Number(line.slice(5)) >= target, `${n} more polls`)
  }
}

// `count` runs of the claimer, each with a scenario folder of its own.
function claimers(dir: string, signal: AbortSignal, count: number, env: Record<string, string> = {}) {
  return Array.from({ length: count }, () => new Run(claimerPath, [dir, demoDir()], signal, env))
}

// Issue #177, criterion 1, with real processes. The three runs are the processes A, B and C.
test('three runs get the lock in the order they came, also when C starts between two scenarios of A', {
  timeout: 60_000,
}, async t => {
  const dir = tempDir()
  const [a, b, c] = claimers(dir, t.signal, 3) as [Run, Run, Run]
  try {
    await Promise.all([a, b, c].map(run => run.ready()))
    // A runs its first scenario. B comes while A holds the lock and waits.
    assert.equal(await a.claim(), 'taken')
    assert.match(await b.claim(), /^note .*another demo run is ahead of this run in the queue/)
    assert.deepEqual(ticketPids(dir), [a.pid, b.pid])
    // A lets go after its scenario and lives on: the gap. B polls in it and takes nothing, and C starts in it.
    await a.release()
    await b.morePolls(3)
    assert.equal(lockOwner(dir), undefined, 'the lock is free in the gap')
    assert.match(await c.claim(), /^note /, 'C took the lock in the gap') // Without the queue the answer is `taken`.
    await c.morePolls(3)
    assert.equal(lockOwner(dir), undefined, 'C or B took the lock in the gap')
    assert.equal(c.lines.includes('taken'), false)
    // The next scenario of A takes the lock first: A has the first ticket.
    assert.equal(await a.claim(), 'taken')
    assert.equal(lockOwner(dir), a.pid)
    await a.release()
    await a.end() // The run of A ends, and its ticket goes.
    // B takes the lock, not C.
    await b.taken()
    assert.equal(lockOwner(dir), b.pid)
    assert.equal(c.lines.includes('taken'), false, 'C took the lock before B')
    await b.release()
    await b.end()
    await c.taken()
    assert.equal(lockOwner(dir), c.pid)
    await c.release()
    await c.end()
    assert.deepEqual(tickets(dir), [])
  } finally {
    for (const run of [a, b, c]) run.proc.kill('SIGKILL')
  }
})

// A Ctrl+C, a SIGTERM or a kill ends a process with no `exit` event, and cucumber-js installs no handler, so the ticket stays
// and the lock stays with a dead pid. The next run removes both.
for (const signal of ['SIGKILL', 'SIGINT'] as const) {
  test(`a head run that ends by ${signal} leaves a dead ticket: the next run removes it and takes over the stale lock`, {
    timeout: 60_000,
  }, async t => {
    const dir = tempDir()
    const [a, b, c] = claimers(dir, t.signal, 3) as [Run, Run, Run]
    try {
      await Promise.all([a, b, c].map(run => run.ready()))
      assert.equal(await a.claim(), 'taken')
      assert.match(await b.claim(), /^note /)
      // B is stopped while A dies, so that no poll of B removes the dead ticket before the check below.
      b.proc.kill('SIGSTOP')
      a.proc.kill(signal)
      await a.exited
      assert.deepEqual(ticketPids(dir), [a.pid, b.pid], 'the exit hook does not run on a signal')
      assert.equal(lockOwner(dir), a.pid)
      b.proc.kill('SIGCONT')
      // C comes. B came first, so B takes the stale lock.
      assert.match(await c.claim(), /^note /)
      await b.taken()
      assert.equal(lockOwner(dir), b.pid)
      assert.equal(c.lines.includes('taken'), false, 'C took the lock before B')
      assert.deepEqual(ticketPids(dir), [b.pid, c.pid], 'the dead ticket is gone')
      await b.release()
      await b.end()
      await c.taken()
      await c.release()
      await c.end()
      assert.deepEqual(tickets(dir), [])
    } finally {
      for (const run of [a, b, c]) run.proc.kill('SIGKILL')
    }
  })
}

// Criterion 3 with real processes. The older checkout is the child of tests/fixtures/lock-child.ts: it calls `acquireLock`
// and nothing else, so it has no ticket.
test('runs wait for a holder with no ticket, then take the lock in order, and the lock file stays a bare pid', {
  timeout: 60_000,
}, async t => {
  const dir = tempDir()
  const old = new Run(lockChildPath, [dir], t.signal)
  const [b, c] = claimers(dir, t.signal, 2) as [Run, Run]
  try {
    await Promise.all([old.ready(), b.ready(), c.ready()])
    await old.command('go', 'won')
    assert.equal(lockOwner(dir), old.pid)
    assert.deepEqual(tickets(dir), [])
    // B is first in the queue and waits for the holder. C is behind B.
    assert.match(await b.claim(), /^note .*another demo run holds /)
    assert.match(await c.claim(), /^note .*is ahead of this run in the queue/)
    assert.deepEqual(ticketPids(dir), [b.pid, c.pid])
    // The older run lets go and lives on: its gap. B waits for the process, as before, and C does not take the gap either.
    await old.release()
    await b.morePolls(3)
    await c.morePolls(3)
    assert.equal(lockOwner(dir), undefined)
    assert.equal(b.lines.includes('taken') || c.lines.includes('taken'), false)
    old.proc.stdin!.end()
    await old.exited
    await b.taken()
    assert.equal(readFileSync(lockFile(dir), 'utf8'), String(b.pid), 'the lock file is a bare pid')
    assert.equal(c.lines.includes('taken'), false)
    await b.release()
    await b.end()
    await c.taken()
    await c.release()
    await c.end()
  } finally {
    for (const run of [old, b, c]) run.proc.kill('SIGKILL')
  }
})

// Six runs join the queue at one shared moment. They read the same highest number, so some may share a number, and the pid
// orders them. The test does not depend on that. It checks that no ticket is lost and, once all six have joined, that each run
// finds the same order: one run is first, and the other five name it as the head and count the runs ahead of them.
test('six runs that join at once all keep a ticket, and the order is the same for all', {
  timeout: 60_000,
}, async t => {
  const dir = tempDir()
  const joiners = Array.from({ length: 6 }, () => new Run(joinerPath, [dir], t.signal))
  try {
    await Promise.all(joiners.map(run => run.ready()))
    const at = Date.now() + 300
    for (const run of joiners) run.send(`join ${at}`)
    const names = await Promise.all(
      joiners.map(async run => (await run.until(line => line.startsWith('joined '), 'joined')).slice('joined '.length)),
    )
    assert.deepEqual(tickets(dir), [...names].sort(), 'a ticket was lost or made twice')
    assert.deepEqual(ticketPids(dir).sort(), joiners.map(run => run.pid).sort())
    // All six have joined. Each asks where it stands: this command is sent after every `joined` line, so no run sees a partial queue.
    const head = tickets(dir)
      .map(name => ({ n: Number(name.split('-')[0]), pid: Number(name.split('-')[1]) }))
      .sort((x, y) => x.n - y.n || x.pid - y.pid)[0]!
    const places = await Promise.all(
      joiners.map(async run => {
        const answer = await run.command('place', 'placed', line => line.startsWith('placed '))
        const [, first, headPid, ahead] = answer.split(' ')
        return { pid: run.pid, first: first === 'first', headPid: Number(headPid), ahead: Number(ahead) }
      }),
    )
    assert.deepEqual(
      places.filter(place => place.first).map(place => place.pid),
      [head.pid],
      'exactly one run is first, and it is the lowest (number, pid)',
    )
    for (const place of places) assert.equal(place.headPid, head.pid, `run ${place.pid} names another head`)
    assert.deepEqual(
      places.map(place => place.ahead).sort(),
      [0, 1, 2, 3, 4, 5],
      'the runs count a different number ahead',
    )
    // The runs end, and the exit hook of each removes its ticket.
    for (const run of joiners) run.proc.stdin!.end()
    await Promise.all(joiners.map(run => run.exited))
    assert.deepEqual(tickets(dir), [])
  } finally {
    for (const run of joiners) run.proc.kill('SIGKILL')
  }
})

// A process with twelve queues, as a listener for each queue would give an EventEmitter warning (the limit is ten).
test('one exit listener removes the tickets of twelve queues and prints no warning', { timeout: 60_000 }, async t => {
  const dirs = Array.from({ length: 12 }, () => tempDir())
  const run = new Run(joinerPath, dirs, t.signal)
  try {
    await run.ready()
    run.send('join 0')
    await run.until(line => line.startsWith('joined '), 'joined')
    for (const dir of dirs) assert.equal(tickets(dir).length, 1)
    run.proc.stdin!.end()
    await run.exited
    for (const dir of dirs) assert.deepEqual(tickets(dir), [])
    assert.doesNotMatch(run.stderr, /MaxListenersExceededWarning/)
  } finally {
    run.proc.kill('SIGKILL')
  }
})

// A run that ends by itself or by `process.exit` runs the exit hook, so it leaves no ticket.
for (const end of ['natural', 'exit']) {
  test(`a run that ends with ${end === 'exit' ? 'process.exit' : 'no more work'} leaves no ticket`, {
    timeout: 60_000,
  }, async t => {
    const dir = tempDir()
    const [run] = claimers(dir, t.signal, 1, { LOCK_END: end }) as [Run]
    try {
      await run.ready()
      assert.equal(await run.claim(), 'taken')
      assert.deepEqual(ticketPids(dir), [run.pid])
      await run.release()
      await run.end()
      assert.deepEqual(tickets(dir), [])
    } finally {
      run.proc.kill('SIGKILL')
    }
  })
}

// The AfterAll hook of world.ts calls `leave()`. A run that has finished its last scenario but lives on (an open handle) would
// otherwise keep the first ticket, and the runs behind it would wait until it exits.
test('a run that finished its scenarios holds the queue until it leaves it', { timeout: 60_000 }, async t => {
  const dir = tempDir()
  const [a, b] = claimers(dir, t.signal, 2) as [Run, Run]
  try {
    await Promise.all([a.ready(), b.ready()])
    assert.equal(await a.claim(), 'taken')
    await a.release() // The last scenario of A is done. The process of A lives on.
    assert.match(await b.claim(), /^note /, 'A is first and has not left')
    await b.morePolls(3)
    assert.equal(b.lines.includes('taken'), false)
    await a.leave() // AfterAll.
    assert.equal(a.proc.exitCode, null, 'the process of A still lives')
    await b.taken()
    assert.equal(lockOwner(dir), b.pid)
    await b.release()
    await b.end()
    await a.end()
  } finally {
    for (const run of [a, b]) run.proc.kill('SIGKILL')
  }
})

// The fs calls of a claim that a crash can cut. Every point is a moment of the claim, with the files that the crash leaves at
// that moment. A claim on an empty folder makes 12 calls. A claim over a stale lock and a dead ticket makes 23: the join, the
// removal of the ticket, the takeover of the lock with its guard, and the scenario folder. The last point is past the last
// call: that child finishes (and is killed after, as a crash would end it). A change that adds fs calls to a claim needs a
// higher number, and the check of the last point says so.
const CRASH_CASES = [
  { name: 'an empty folder', stale: false, points: 13 },
  { name: 'a stale lock and a dead ticket', stale: true, points: 24 },
]

// Runs `trial` for every item, `size` at a time.
async function inBatches<T>(items: T[], size: number, trial: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(trial))
}

for (const { name, stale, points } of CRASH_CASES) {
  test(`a run that crashes at any fs call of its claim over ${name} never blocks later runs, which keep their order`, {
    timeout: 180_000,
  }, async t => {
    await inBatches(
      Array.from({ length: points }, (_, i) => i + 1),
      6,
      async crashAt => {
        const dir = tempDir()
        if (stale) {
          writeFileSync(lockFile(dir), '999999')
          mkdirSync(queueFolder(dir))
          writeFileSync(join(queueFolder(dir), '00000001-999998'), '')
        }
        const [crashed] = claimers(dir, t.signal, 1, { LOCK_FAULTS: JSON.stringify({ crashAt }) }) as [Run]
        const [x, y] = claimers(dir, t.signal, 2) as [Run, Run]
        const at = `crash at call ${crashAt}`
        try {
          await crashed.ready()
          crashed.send('claim')
          // A child that crashes ends with no line. A child that finishes its claim says `taken` and lives on.
          const outcome = await Promise.race([
            crashed.exited.then(() => 'crashed'),
            crashed
              .until(line => line === 'taken', 'taken')
              .then(
                () => 'finished',
                () => 'crashed', // It ended with no such line.
              ),
          ])
          if (crashAt === points) {
            assert.equal(outcome, 'finished', `${at} is past the last fs call of the claim: raise the number of points`)
            crashed.proc.kill('SIGKILL') // As a crash after the claim would end it: the lock and the ticket stay.
          } else {
            assert.equal(
              outcome,
              'crashed',
              `${at}: the claim made fewer fs calls than this test counts: lower the points`,
            )
          }
          await crashed.exited
          await Promise.all([x.ready(), y.ready()])
          // Whatever the crash left (a ticket, a stale lock, a guard), the next run takes the lock, and the one after it waits.
          assert.equal(await x.claim(), 'taken', at)
          assert.match(await y.claim(), /^note /, at)
          assert.deepEqual(ticketPids(dir), [x.pid, y.pid], at)
          await x.release()
          await x.end()
          await y.taken()
          assert.equal(lockOwner(dir), y.pid, at)
          await y.release()
          await y.end()
          assert.deepEqual(tickets(dir), [], at)
        } finally {
          for (const run of [crashed, x, y]) run.proc.kill('SIGKILL')
        }
      },
    )
  })
}

// ---- The wiring in world.ts ----

// The hook needs cucumber, tmux and claude, so a unit test cannot run it. This test reads the source: a hook that is gone, or
// whose call is commented out, fails here, and the live check of the PR shows that it runs.
test('support/world.ts leaves the queue in an AfterAll hook', () => {
  const source = readFileSync(fileURLToPath(new URL('../support/world.ts', import.meta.url)), 'utf8')
  // Comments go first: a hook whose call is commented out must fail here.
  const world = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const imports = /import \{([^}]*)\} from '@cucumber\/cucumber'/.exec(world)?.[1] ?? ''
  assert.match(imports, /\bAfterAll\b/)
  assert.match(world, /\bAfterAll\(\s*\(\)\s*=>\s*\{\s*claimRun\.leave\(\)\s*\}\s*\)/)
})
