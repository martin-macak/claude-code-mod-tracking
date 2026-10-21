import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { acquireLock, claimRun, describeHolder, LockBusyError, makeClaimer } from '../support/lock.ts'
import type { FaultPlan } from './fixtures/lock-faults.ts'

// Every folder that a test made. They go when the file is done, so a run leaves nothing behind.
const made: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-'))
  made.push(dir)
  return dir
}
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})
const child = fileURLToPath(new URL('./fixtures/lock-child.ts', import.meta.url))
const pollerPath = fileURLToPath(new URL('./fixtures/lock-poller.ts', import.meta.url))

// One lock child process. Its stdio follows the protocol in fixtures/lock-child.ts.
// A test that times out aborts its signal, and the child is killed then, not left running.
// With a fault plan (fixtures/lock-faults.ts) the child runs slower or crashes in the attempt.
function spawnLockChild(dir: string, signal: AbortSignal, faults?: FaultPlan) {
  const proc = spawn(process.execPath, [child, dir], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: faults === undefined ? process.env : { ...process.env, LOCK_FAULTS: JSON.stringify(faults) },
  })
  proc.stdin.on('error', () => {}) // A crashed child has closed its stdin.
  signal.addEventListener('abort', () => proc.kill(), { once: true })
  let stderr = ''
  proc.stderr.on('data', chunk => {
    stderr += chunk
  })
  const exited = new Promise<void>(resolve => proc.once('exit', () => resolve()))
  const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]()
  const nextLine = async () => {
    const next = await lines.next()
    if (next.done) throw new Error(`lock child ended early: ${stderr}`)
    return next.value
  }
  return {
    ready: async () => assert.equal(await nextLine(), 'ready'),
    // One attempt at the lock. With a deadline (ms since the epoch), the child waits for it first.
    attempt: async (deadline?: number) => {
      proc.stdin.write(deadline === undefined ? 'go\n' : `go ${deadline}\n`)
      return nextLine()
    },
    // The child lets go of the lock it won and lives on, so its pid stays live.
    release: async () => {
      proc.stdin.write('release\n')
      assert.equal(await nextLine(), 'released')
    },
    // Closes stdin. The child then exits. A lock it won stays in the folder with a dead pid.
    finish: () => {
      proc.stdin.end()
      return exited
    },
    kill: () => {
      proc.kill()
    },
  }
}

// One run of an attempt at the lock in a child process: the fault plan of the child and how many
// ms after the shared moment it attempts. `crashed` is the result of a child that ended with no
// result line.
interface Run {
  faults?: FaultPlan
  offset?: number
}

// Starts one child for each run and lets them attempt at the lock in `dir`. Returns the result
// of each child: "won", "lost" or "crashed". The winners keep their lock until all results are in.
async function race(dir: string, signal: AbortSignal, runs: Run[]) {
  const children = runs.map(run => spawnLockChild(dir, signal, run.faults))
  try {
    await Promise.all(children.map(c => c.ready()))
    const moment = Date.now() + 150
    const results = await Promise.all(
      children.map((c, i) => c.attempt(moment + (runs[i]!.offset ?? 0)).catch(() => 'crashed')),
    )
    await Promise.all(children.map(c => c.finish()))
    return results
  } finally {
    for (const c of children) c.kill()
  }
}

// Runs `trial` for every item, `size` at a time.
async function inBatches<T>(items: T[], size: number, trial: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(trial))
}

// A small seeded random generator, so a failing trial is the same in the next run.
function seeded(seed: number) {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let x = Math.imul(state ^ (state >>> 15), 1 | state)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

const winners = (results: string[]) => results.filter(r => r === 'won').length

test('acquireLock writes our pid and release removes the file', () => {
  const dir = tempDir()
  const release = acquireLock(dir)
  assert.equal(readFileSync(join(dir, '.lock'), 'utf8'), String(process.pid))
  release()
  assert.equal(existsSync(join(dir, '.lock')), false)
})

test('acquireLock refuses while a live process holds the lock', () => {
  const dir = tempDir()
  const release = acquireLock(dir)
  assert.throws(() => acquireLock(dir), new RegExp(`pid ${process.pid}`))
  release()
})

test('acquireLock takes over a stale lock of a dead process', () => {
  const dir = tempDir()
  writeFileSync(join(dir, '.lock'), '999999')
  const release = acquireLock(dir)
  assert.equal(readFileSync(join(dir, '.lock'), 'utf8'), String(process.pid))
  release()
})

test('acquireLock clears the guard that a crashed run left', () => {
  // A crashed run left a stale lock and its takeover guard. The guard holds one file, named by the
  // pid of its holder. The last case is a pid that this run has now: its crashed holder had it first.
  for (const holder of ['999998', String(process.pid)]) {
    const dir = tempDir()
    writeFileSync(join(dir, '.lock'), '999999')
    mkdirSync(join(dir, '.lock.takeover'))
    writeFileSync(join(dir, '.lock.takeover', holder), '')
    const release = acquireLock(dir)
    assert.equal(readFileSync(join(dir, '.lock'), 'utf8'), String(process.pid), `guard holder ${holder}`)
    assert.equal(existsSync(join(dir, '.lock.takeover')), false, `guard holder ${holder}`)
    release()
  }
})

test('acquireLock waits for the guard of a live run and then takes a stale lock', { timeout: 60_000 }, async t => {
  const dir = tempDir()
  writeFileSync(join(dir, '.lock'), '999999')
  // This child holds the guard for 300 ms, as a live run in the middle of a takeover does. It
  // writes the file `released` just before it frees the guard.
  const script = `
    const { mkdirSync, rmSync, writeFileSync } = require('node:fs')
    const { join } = require('node:path')
    const dir = process.argv[1]
    const guard = join(dir, '.lock.takeover')
    mkdirSync(guard)
    writeFileSync(join(guard, String(process.pid)), '')
    process.stdout.write('held\\n')
    setTimeout(() => {
      writeFileSync(join(dir, 'released'), '')
      rmSync(guard, { recursive: true })
    }, 300)`
  const holder = spawn(process.execPath, ['-e', script, dir], { stdio: ['ignore', 'pipe', 'inherit'] })
  t.signal.addEventListener('abort', () => holder.kill(), { once: true })
  try {
    const lines = createInterface({ input: holder.stdout })[Symbol.asyncIterator]()
    assert.equal((await lines.next()).value, 'held')
    const release = acquireLock(dir) // Blocks this process, not the holder.
    assert.equal(existsSync(join(dir, 'released')), true, 'took the lock before the guard was free')
    assert.equal(readFileSync(join(dir, '.lock'), 'utf8'), String(process.pid))
    release()
  } finally {
    holder.kill()
  }
})

test('acquireLock gives up while a live run holds the guard, and names it', { timeout: 60_000 }, () => {
  const dir = tempDir()
  writeFileSync(join(dir, '.lock'), '999999')
  mkdirSync(join(dir, '.lock.takeover'))
  // The parent of this process is alive and is not this run, so this guard file is a live holder.
  writeFileSync(join(dir, '.lock.takeover', String(process.ppid)), '')
  // The old text stays the prefix. The rest names the guard and its holder, so the user can act.
  assert.throws(
    () => acquireLock(dir),
    new RegExp(
      `^Error: lock: could not take .*\\.lock \\(takeover guard .*\\.lock\\.takeover held by pid ${process.ppid}\\)$`,
      'm',
    ),
  )
  // A live guard and the stale lock stay as they were.
  assert.deepEqual(readdirSync(join(dir, '.lock.takeover')), [String(process.ppid)])
  assert.equal(readFileSync(join(dir, '.lock'), 'utf8'), '999999')
})

// Some tests hold the lock as a live run that is not this one: the parent of the test process. Its pid is live while
// the test runs. Pid 1 is a second live holder.
const holdLock = (dir: string, pid = process.ppid) => writeFileSync(join(dir, '.lock'), String(pid))

// A claim that does not wait: it fails at once when a live run holds the lock.
const NO_WAIT = { waitMs: 0 }

test('claimRun leaves a running scenario folder alone when the lock is held', async () => {
  const lockDir = tempDir()
  const runDir = join(tempDir(), 'demo')
  // The parent of this process stands for the other run: a lock that this process holds fails with its own message.
  holdLock(lockDir)
  mkdirSync(runDir)
  writeFileSync(join(runDir, 'signal'), 'stop\n')
  await assert.rejects(claimRun(lockDir, runDir, NO_WAIT), /another demo run/)
  assert.equal(readFileSync(join(runDir, 'signal'), 'utf8'), 'stop\n')
})

test('claimRun wipes the scenario folder once it holds the lock', async () => {
  const lockDir = tempDir()
  const runDir = join(tempDir(), 'demo')
  ;(await claimRun(lockDir, runDir, NO_WAIT))()
  writeFileSync(join(runDir, 'old'), 'x')
  const release = await claimRun(lockDir, runDir, NO_WAIT)
  assert.equal(existsSync(join(runDir, 'old')), false)
  assert.equal(existsSync(runDir), true)
  release()
})

// A fake clock and a fake sleep. A sleep advances the clock and then runs `onSleep(n)`, so a test says
// what happens during the n-th wait. No real time passes: the tests check order and counts.
function fakeWait(onSleep?: (n: number) => void | Promise<void>) {
  let clock = 0
  const sleeps: number[] = []
  return {
    sleeps,
    now: () => clock,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      clock += ms
      await onSleep?.(sleeps.length)
    },
  }
}

const HALF_HOUR = 30 * 60_000

// The run that holds the lock in the tests below, as the claim sees it: it is live until `end` lets go of the lock
// and ends. A claim waits for the process of the holder, not only for the file (see the test of the gap).
function fakeRun(dir: string, pid = process.ppid) {
  const run = {
    live: true,
    isLive: () => run.live,
    end: () => {
      rmSync(join(dir, '.lock'))
      run.live = false
    },
  }
  holdLock(dir, pid)
  return run
}

test('claimRun polls while a live run holds the lock, names it once, and takes the lock when it is free', async () => {
  const dir = tempDir()
  const run = fakeRun(dir)
  const wait = fakeWait(n => {
    if (n === 3) run.end()
  })
  const notes: string[] = []
  const release = await claimRun(dir, join(tempDir(), 'demo'), {
    waitMs: HALF_HOUR,
    pollMs: 5000,
    now: wait.now,
    sleep: wait.sleep,
    isLive: run.isLive,
    describeHolder: pid => `fake run ${pid}`,
    onWait: note => notes.push(note),
  })
  assert.deepEqual(wait.sleeps, [5000, 5000, 5000])
  assert.equal(readFileSync(join(dir, '.lock'), 'utf8'), String(process.pid))
  assert.equal(notes.length, 1)
  assert.match(notes[0]!, new RegExp(`fake run ${process.ppid}`))
  assert.match(notes[0]!, /\.lock/)
  release()
})

// An older checkout does not wait. It lets go of the lock after each scenario and takes it again a moment later.
// A claim that took the lock in that moment would fail the next scenario of that run at once, as in issue #143.
// So a claim waits for the process of the holder it named, and tries again only when that process has ended or
// another run holds the lock.
test('claimRun does not take the lock in the instant between two scenarios of a run that still lives', async () => {
  const dir = tempDir()
  const run = fakeRun(dir)
  const lock = join(dir, '.lock')
  const notes: string[] = []
  const wait = fakeWait(n => {
    if (n === 1) rmSync(lock) // The run lets go after a scenario: the file is gone, the run lives.
    if (n === 2 || n === 3) assert.equal(existsSync(lock), false, `the claim took the lock in the gap, at wait ${n}`)
    if (n === 4) holdLock(dir) // The run takes the lock again for its next scenario.
    if (n === 6) run.end() // The run ends.
  })
  const release = await claimRun(dir, join(tempDir(), 'demo'), {
    waitMs: HALF_HOUR,
    pollMs: 5000,
    now: wait.now,
    sleep: wait.sleep,
    isLive: run.isLive,
    describeHolder: pid => `fake run ${pid}`,
    onWait: note => notes.push(note),
  })
  // It waited through the gap (waits 2 and 3), and the lock it holds now is its own.
  assert.deepEqual(wait.sleeps, Array(6).fill(5000))
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid))
  assert.equal(notes.length, 1, 'the same run is named once, in the gap as well')
  release()
})

test('claimRun in the gap says again every minute and gives up after the bound', async () => {
  const dir = tempDir()
  const run = fakeRun(dir)
  const lock = join(dir, '.lock')
  const notes: string[] = []
  const wait = fakeWait(n => {
    if (n === 1) rmSync(lock)
  })
  await assert.rejects(
    claimRun(dir, join(tempDir(), 'demo'), {
      waitMs: 150_000,
      pollMs: 5000,
      now: wait.now,
      sleep: wait.sleep,
      isLive: run.isLive,
      describeHolder: pid => `fake run ${pid}`,
      onWait: note => notes.push(note),
    }),
    (err: unknown) => {
      assert.ok(err instanceof LockBusyError)
      assert.equal(err.kind, 'timeout')
      assert.equal(err.pid, process.ppid)
      assert.match(err.message, /Waited 2 min 30 s/)
      assert.match(err.message, new RegExp(`fake run ${process.ppid}`))
      return true
    },
  )
  assert.equal(wait.now(), 150_000)
  assert.equal(existsSync(lock), false, 'the claim never took the lock of a run that lives')
  // 150 s of waiting: the first note, then one each minute (at 60 s and at 120 s).
  assert.equal(notes.length, 3)
  assert.match(notes[1]!, /still waiting after 1 min/)
  assert.match(notes[2]!, /still waiting after 2 min/)
})

test('claimRun says again every minute that it still waits, and when the holder changes', async () => {
  const dir = tempDir()
  const runDir = join(tempDir(), 'demo')
  const notes: string[] = []
  const options = {
    waitMs: HALF_HOUR,
    pollMs: 5000,
    describeHolder: (pid: number) => `fake run ${pid}`,
    onWait: (note: string) => notes.push(note),
  }
  // 13 sleeps are 65 s: the first note, and one more after the 12th sleep (60 s).
  const first = fakeRun(dir)
  const long = fakeWait(n => {
    if (n === 13) first.end()
  })
  ;(await claimRun(dir, runDir, { ...options, now: long.now, sleep: long.sleep, isLive: first.isLive }))()
  assert.equal(notes.length, 2)
  assert.match(notes[0]!, /Waiting for it/)
  assert.match(notes[1]!, /still waiting after 1 min/)
  assert.match(notes[1]!, new RegExp(`fake run ${process.ppid}`))

  // Another run takes the lock after the first holder: the claim names the new holder at once.
  notes.length = 0
  const second = fakeRun(dir)
  const handOver = fakeWait(n => {
    if (n === 2) holdLock(dir, 1)
    if (n === 4) second.end()
  })
  ;(await claimRun(dir, runDir, { ...options, now: handOver.now, sleep: handOver.sleep, isLive: second.isLive }))()
  assert.equal(notes.length, 2)
  assert.match(notes[0]!, new RegExp(`fake run ${process.ppid}`))
  assert.match(notes[1]!, /fake run 1\b/)
})

test('claimRun gives up after the bound with a clear error, and never removes the lock of a live run', async () => {
  const dir = tempDir()
  const runDir = join(tempDir(), 'demo')
  mkdirSync(runDir)
  writeFileSync(join(runDir, 'signal'), 'stop\n')
  holdLock(dir)
  const wait = fakeWait()
  await assert.rejects(
    claimRun(dir, runDir, {
      waitMs: HALF_HOUR,
      pollMs: 5000,
      now: wait.now,
      sleep: wait.sleep,
      describeHolder: pid => `fake run ${pid}`,
      onWait: () => {},
    }),
    (err: unknown) => {
      assert.ok(err instanceof LockBusyError)
      assert.equal(err.pid, process.ppid)
      // The old text stays the prefix. The rest says how long it waited, who still holds the lock and what to do.
      assert.match(err.message, new RegExp(`^lock: another demo run \\(pid ${process.ppid}\\) holds .*\\.lock\\. `))
      assert.match(err.message, /Waited 30 min/)
      assert.match(err.message, new RegExp(`fake run ${process.ppid}`))
      assert.match(err.message, /DEMO_LOCK_WAIT_S/)
      return true
    },
  )
  assert.equal(wait.now(), HALF_HOUR)
  assert.equal(readFileSync(join(dir, '.lock'), 'utf8'), String(process.ppid))
  assert.equal(readFileSync(join(runDir, 'signal'), 'utf8'), 'stop\n')
})

test('claimRun with no wait fails at once and does not sleep', async () => {
  const dir = tempDir()
  holdLock(dir)
  const wait = fakeWait()
  await assert.rejects(
    claimRun(dir, join(tempDir(), 'demo'), { waitMs: 0, now: wait.now, sleep: wait.sleep }),
    new RegExp(`another demo run \\(pid ${process.ppid}\\)`),
  )
  assert.deepEqual(wait.sleeps, [])
})

test('claimRun fails at once when this very process holds the lock: waiting could not end', async () => {
  const dir = tempDir()
  const release = acquireLock(dir)
  const wait = fakeWait()
  await assert.rejects(
    claimRun(dir, join(tempDir(), 'demo'), { waitMs: HALF_HOUR, now: wait.now, sleep: wait.sleep }),
    /this process.*did not release/,
  )
  assert.deepEqual(wait.sleeps, [])
  release()
})

test('claimRun with no wait says that this very process holds the lock, when it does', async () => {
  const dir = tempDir()
  const release = acquireLock(dir)
  await assert.rejects(claimRun(dir, join(tempDir(), 'demo'), NO_WAIT), /this process.*did not release/)
  release()
})

test('a claimer says that an earlier scenario waited only after a scenario that did wait', async () => {
  const dir = tempDir()
  const runDir = join(tempDir(), 'demo')
  const release = acquireLock(dir) // A scenario of this process did not release the lock.
  const wait = fakeWait()
  const claim = makeClaimer({ waitMs: HALF_HOUR, now: wait.now, sleep: wait.sleep, onWait: () => {} })
  await assert.rejects(claim(dir, runDir), /this process.*did not release/)
  // Nothing waited, so the next scenario names the same cause and no wait.
  await assert.rejects(claim(dir, runDir), (err: unknown) => {
    assert.ok(err instanceof LockBusyError)
    assert.match(err.message, /this process.*did not release/)
    assert.doesNotMatch(err.message, /already waited/)
    return true
  })
  assert.deepEqual(wait.sleeps, [])
  release()
})

test('claimRun does not treat another error as a busy lock', async () => {
  const file = join(tempDir(), 'file')
  writeFileSync(file, 'a file where the lock folder should be')
  const wait = fakeWait()
  await assert.rejects(
    claimRun(file, join(tempDir(), 'demo'), { waitMs: HALF_HOUR, now: wait.now, sleep: wait.sleep }),
    {
      code: 'EEXIST',
    },
  )
  assert.deepEqual(wait.sleeps, [])
})

// A stale lock and the takeover guard of a live run: the parent of this process stands for that run.
function liveGuard(dir: string) {
  writeFileSync(join(dir, '.lock'), '999999')
  mkdirSync(join(dir, '.lock.takeover'))
  writeFileSync(join(dir, '.lock.takeover', String(process.ppid)), '')
}

// A fake guard pause. A try waits for a live guard in 5 ms pauses (synchronous), and the test reads how many it made.
function fakePause() {
  const pauses: number[] = []
  return { pauses, pause: (ms: number) => void pauses.push(ms), total: () => pauses.reduce((a, b) => a + b, 0) }
}

test('claimRun waits out a live takeover guard and then takes the stale lock', async () => {
  const dir = tempDir()
  liveGuard(dir)
  const guard = fakePause()
  const wait = fakeWait(n => {
    if (n === 1) rmSync(join(dir, '.lock.takeover'), { recursive: true })
  })
  const release = await claimRun(dir, join(tempDir(), 'demo'), {
    waitMs: HALF_HOUR,
    pollMs: 5000,
    now: wait.now,
    sleep: wait.sleep,
    onWait: () => {},
    guardPause: guard.pause,
  })
  assert.deepEqual(wait.sleeps, [5000])
  // A try waits 5 s at most for the guard of a live run, as `acquireLock` does by itself.
  assert.equal(guard.total(), 5000)
  assert.equal(readFileSync(join(dir, '.lock'), 'utf8'), String(process.pid))
  release()
})

// Issue #168 review. A try waits for the guard of a live run in 5 ms pauses, and it does not return before they are
// over. So it may not spend more than the claim has left: with no wait it does not pause at all, and with a bound of a
// few ms it pauses for that long at most.
test('a claim with no wait does not wait for a live takeover guard: it fails at once and names the guard', async () => {
  const dir = tempDir()
  liveGuard(dir)
  const guard = fakePause()
  await assert.rejects(
    claimRun(dir, join(tempDir(), 'demo'), { waitMs: 0, guardPause: guard.pause }),
    (err: unknown) => {
      assert.ok(err instanceof LockBusyError)
      assert.equal(err.kind, 'guard')
      assert.match(err.message, new RegExp(`takeover guard .* held by pid ${process.ppid}`))
      return true
    },
  )
  assert.deepEqual(guard.pauses, [])
  // The live guard and the stale lock stay as they were.
  assert.deepEqual(readdirSync(join(dir, '.lock.takeover')), [String(process.ppid)])
  assert.equal(readFileSync(join(dir, '.lock'), 'utf8'), '999999')
})

test('a claim with a short bound waits for a live takeover guard no longer than that bound', async () => {
  const dir = tempDir()
  liveGuard(dir)
  const guard = fakePause()
  const wait = fakeWait()
  await assert.rejects(
    claimRun(dir, join(tempDir(), 'demo'), {
      waitMs: 12,
      pollMs: 5000,
      now: wait.now,
      sleep: wait.sleep,
      onWait: () => {},
      guardPause: guard.pause,
    }),
    /Waited .* for it and gave up/,
  )
  // 12 ms hold two pauses of 5 ms. The poll after that has no time left and does not pause.
  assert.equal(guard.total(), 10)
  assert.deepEqual(wait.sleeps, [12])
})

test('after one timeout the claimer does not wait for a live takeover guard either', async () => {
  const dir = tempDir()
  const runDir = join(tempDir(), 'demo')
  holdLock(dir)
  const guard = fakePause()
  const wait = fakeWait()
  const claim = makeClaimer({
    waitMs: 20_000,
    pollMs: 5000,
    now: wait.now,
    sleep: wait.sleep,
    onWait: () => {},
    guardPause: guard.pause,
  })
  await assert.rejects(claim(dir, runDir), /Waited 20 s/)
  // The lock is stale now and a live run holds its guard. The next scenario fails at once.
  rmSync(join(dir, '.lock'))
  liveGuard(dir)
  await assert.rejects(claim(dir, runDir), /could not take .*takeover guard/)
  assert.deepEqual(guard.pauses, [])
})

test('after one timeout the claimer does not wait again for the later scenarios of the run', async () => {
  const dir = tempDir()
  const runDir = join(tempDir(), 'demo')
  holdLock(dir)
  const wait = fakeWait()
  const claim = makeClaimer({ waitMs: 20_000, pollMs: 5000, now: wait.now, sleep: wait.sleep, onWait: () => {} })
  await assert.rejects(claim(dir, runDir), /Waited 20 s/)
  assert.equal(wait.sleeps.length, 4)
  // Later scenarios try once and fail at once, and say why.
  await assert.rejects(claim(dir, runDir), /another demo run.*earlier scenario of this run already waited 20 s/s)
  assert.equal(wait.sleeps.length, 4)
  // A lock that is free by now is taken.
  rmSync(join(dir, '.lock'))
  ;(await claim(dir, runDir))()
})

// `describeHolder` asks `ps`. A slim container has none, and then it names the pid alone by design.
const hasPs = spawnSync('ps', ['-p', String(process.pid)], { stdio: 'ignore' }).status === 0

test('describeHolder names the pid and, for a live process, its command line', {
  skip: hasPs ? false : 'ps is not installed',
}, () => {
  const own = describeHolder(process.pid)
  assert.match(own, new RegExp(`^pid ${process.pid}\\b`))
  assert.match(own, /node/)
})

test('describeHolder names only the pid of a process that is gone', () => {
  assert.equal(describeHolder(999999), 'pid 999999')
})

test('a second run waits for a live first run and takes the lock when that run has ended', {
  timeout: 60_000,
}, async t => {
  const lockDir = tempDir()
  const runDir = join(tempDir(), 'demo')
  const first = spawnLockChild(lockDir, t.signal)
  try {
    await first.ready()
    assert.equal(await first.attempt(), 'won')
    const firstPid = readFileSync(join(lockDir, '.lock'), 'utf8')
    let settled = false
    let sawHolder!: () => void
    const noted = new Promise<void>(resolve => {
      sawHolder = resolve
    })
    const notes: string[] = []
    // The poll is a few ms of real time. The test counts the polls, and never reads a clock.
    let polls = 0
    let pollsWanted = Number.POSITIVE_INFINITY
    let enough!: () => void
    const polled = new Promise<void>(resolve => {
      enough = resolve
    })
    const claim = claimRun(lockDir, runDir, {
      waitMs: 60_000,
      pollMs: 5,
      sleep: async ms => {
        if (++polls >= pollsWanted) enough()
        await new Promise(resolve => setTimeout(resolve, ms))
      },
      onWait: note => {
        notes.push(note)
        sawHolder()
      },
    }).then(release => {
      settled = true
      return release
    })
    // The claim has seen the live first run and waits. The first run lets go only now, so the claim cannot
    // have taken the lock before.
    await noted
    assert.equal(settled, false)
    assert.match(notes[0]!, new RegExp(`pid ${firstPid}\\b`))
    // The first run lets go of the lock and lives on: the instant between two scenarios of a run. The claim
    // polls on and takes nothing, because that run still lives.
    await first.release()
    pollsWanted = polls + 3
    await polled
    assert.equal(settled, false)
    assert.equal(existsSync(join(lockDir, '.lock')), false)
    // The first run ends. The claim takes the lock now.
    await first.finish()
    const release = await claim
    assert.equal(readFileSync(join(lockDir, '.lock'), 'utf8'), String(process.pid))
    release()
  } finally {
    first.kill()
  }
})

test('only one of two runs that attempt at once takes over a stale lock', { timeout: 60_000 }, async t => {
  for (let i = 0; i < 15; i++) {
    const dir = tempDir()
    writeFileSync(join(dir, '.lock'), '999999')
    const children = [spawnLockChild(dir, t.signal), spawnLockChild(dir, t.signal)]
    try {
      await Promise.all(children.map(c => c.ready()))
      // Both children wait for one shared moment, so their attempts line up. The winner keeps its
      // lock until both results are in.
      const deadline = Date.now() + 25
      const results = await Promise.all(children.map(c => c.attempt(deadline)))
      assert.equal(results.filter(r => r === 'won').length, 1, `trial ${i}: ${results.join(', ')}`)
      await Promise.all(children.map(c => c.finish()))
      assert.deepEqual(readdirSync(dir), ['.lock'], `trial ${i} left extra files`)
    } finally {
      for (const c of children) c.kill()
    }
  }
})

// The race of issue #103. Run B reads the stale lock and waits. Run A takes the lock over in that
// time. B then acts on its old read. While B is slow, run C attempts. C attempts at another
// moment in each trial, so some trial lands in each window of B.
test('only one of three runs takes over a stale lock when one run is slow', { timeout: 180_000 }, async t => {
  const slow: FaultPlan = { delays: { readFileSync: { after: 40 }, renameSync: { before: 40 } } }
  const offsets = Array.from({ length: 26 }, (_, i) => i * 10)
  await inBatches(offsets, 6, async offset => {
    const dir = tempDir()
    writeFileSync(join(dir, '.lock'), '999999')
    const results = await race(dir, t.signal, [{}, { faults: slow }, { offset }])
    assert.equal(winners(results), 1, `C attempts at +${offset} ms: ${results.join(', ')}`)
    assert.deepEqual(readdirSync(dir), ['.lock'], `C attempts at +${offset} ms: extra files`)
  })
})

// The guard of a crashed run is stale. Two runs find it at once, and both clear it. Run A is slow
// inside its takeover, after it cleared the guard and published its own. Run B read the stale guard
// first and is slow too, so it clears the guard when A is in the middle of its takeover. A rule that
// removes the whole guard folder then removes the live guard of A, and both runs take the stale lock.
test('only one of two runs wins while both clear a stale guard', { timeout: 180_000 }, async t => {
  const insideTakeover: FaultPlan = { delays: { readFileSync: { after: 150 } } }
  const wakeUps = Array.from({ length: 9 }, (_, i) => 100 + i * 50)
  await inBatches(wakeUps, 5, async wakeUp => {
    const dir = tempDir()
    writeFileSync(join(dir, '.lock'), '999999')
    mkdirSync(join(dir, '.lock.takeover'))
    writeFileSync(join(dir, '.lock.takeover', '999998'), '')
    const afterGuardRead: FaultPlan = { delays: { readdirSync: { after: wakeUp } } }
    const results = await race(dir, t.signal, [{ faults: insideTakeover }, { faults: afterGuardRead }])
    assert.equal(winners(results), 1, `B clears the guard at +${wakeUp} ms: ${results.join(', ')}`)
  })
})

test('only one of three runs wins with random delays at every fs call', { timeout: 180_000 }, async t => {
  const random = seeded(103)
  const pick = <T>(items: T[]) => items[Math.floor(random() * items.length)]!
  const trials = Array.from({ length: 40 }, (_, i) => ({
    stale: i % 4 !== 3, // Three of four trials start with a stale lock, one with no lock.
    runs: [0, 1, 2].map(
      (): Run => ({
        faults: { sequence: Array.from({ length: 16 }, () => pick([0, 0, 0, 10, 30, 50])) },
        offset: pick([0, 0, 5, 20, 60]),
      }),
    ),
  }))
  await inBatches(
    trials.map((trial, i) => ({ trial, i })),
    8,
    async ({ trial, i }) => {
      const dir = tempDir()
      if (trial.stale) writeFileSync(join(dir, '.lock'), '999999')
      const results = await race(dir, t.signal, trial.runs)
      const note = `trial ${i}: ${results.join(', ')} for ${JSON.stringify(trial.runs)}`
      assert.equal(winners(results), 1, note)
      assert.deepEqual(readdirSync(dir), ['.lock'], `${note}: extra files`)
    },
  )
})

// A run that crashes leaves its files as they are at that moment. The child dies before its n-th fs
// call. A takeover of a stale lock makes 14 fs calls, so the points 1 to 14 cover every moment of
// it, with the guard published, the stale lock removed and so on. The last point is past the last
// call: that child finishes. A change that adds fs calls to the takeover needs a higher number.
const CRASH_POINTS = 16

test('a run that crashes at any fs call never blocks later runs', { timeout: 180_000 }, async t => {
  const slow: FaultPlan = { delays: { readFileSync: { after: 40 }, renameSync: { before: 40 } } }
  const points = Array.from({ length: CRASH_POINTS }, (_, i) => i + 1)
  await inBatches(points, 6, async crashAt => {
    const crash = async (dir: string) => {
      writeFileSync(join(dir, '.lock'), '999999')
      return (await race(dir, t.signal, [{ faults: { crashAt } }]))[0]
    }
    // One later run takes the lock.
    const single = tempDir()
    const first = await crash(single)
    if (crashAt === CRASH_POINTS) assert.equal(first, 'won', 'the last point must be past the last fs call')
    acquireLock(single)()
    // Three later runs at once, one of them slow: exactly one takes the lock, whatever the
    // crash left behind.
    const triple = tempDir()
    await crash(triple)
    const results = await race(triple, t.signal, [{}, { faults: slow }, { offset: 10 }])
    assert.equal(winners(results), 1, `crash at call ${crashAt}: ${results.join(', ')}`)
    // The winner has ended, so its lock is stale. A takeover works and leaves no guard behind.
    acquireLock(triple)()
    assert.equal(existsSync(join(triple, '.lock.takeover')), false, `crash at call ${crashAt}: a guard is left`)
  })
})

test('a child that attempts after the lock holder won still loses', { timeout: 60_000 }, async t => {
  const dir = tempDir()
  writeFileSync(join(dir, '.lock'), '999999')
  const holder = spawnLockChild(dir, t.signal)
  const late = spawnLockChild(dir, t.signal)
  try {
    await Promise.all([holder.ready(), late.ready()])
    assert.equal(await holder.attempt(), 'won')
    // The holder is still alive, so its lock is live when the late child attempts.
    assert.equal(await late.attempt(), 'lost')
    await Promise.all([holder.finish(), late.finish()])
  } finally {
    holder.kill()
    late.kill()
  }
})

test('a lock file never exists without a pid in it', { timeout: 60_000 }, async t => {
  const dir = tempDir()
  const poller = spawn(process.execPath, [pollerPath, dir], { stdio: ['pipe', 'pipe', 'pipe'] })
  t.signal.addEventListener('abort', () => poller.kill(), { once: true })
  let stderr = ''
  poller.stderr.on('data', chunk => {
    stderr += chunk
  })
  const lines = createInterface({ input: poller.stdout })[Symbol.asyncIterator]()
  const nextLine = async () => {
    const next = await lines.next()
    if (next.done) throw new Error(`lock poller ended early: ${stderr}`)
    return next.value
  }
  try {
    assert.equal(await nextLine(), 'ready')
    // Take and release the lock in a loop. The poller reads the file the whole time.
    const until = Date.now() + 400
    poller.stdin.write(`${until}\n`)
    let cycles = 0
    while (Date.now() < until) {
      acquireLock(dir)()
      cycles++
    }
    const { reads, empty } = JSON.parse(await nextLine()) as { reads: number; empty: number }
    assert.ok(reads > 0, `the poller never read the lock in ${cycles} cycles`)
    assert.equal(empty, 0, `the poller read an empty lock file ${empty} times in ${reads} reads`)
  } finally {
    poller.kill()
  }
})

test('acquireLock creates a missing folder', () => {
  const dir = join(tempDir(), 'a', 'b')
  acquireLock(dir)()
})
