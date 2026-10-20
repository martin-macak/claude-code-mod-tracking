import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { acquireLock, claimRun } from '../support/lock.ts'
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

test('claimRun leaves a running scenario folder alone when the lock is held', () => {
  const lockDir = tempDir()
  const runDir = join(tempDir(), 'demo')
  const releaseFirst = claimRun(lockDir, runDir)
  writeFileSync(join(runDir, 'signal'), 'stop\n')
  assert.throws(() => claimRun(lockDir, runDir), /another demo run/)
  assert.equal(readFileSync(join(runDir, 'signal'), 'utf8'), 'stop\n')
  releaseFirst()
})

test('claimRun wipes the scenario folder once it holds the lock', () => {
  const lockDir = tempDir()
  const runDir = join(tempDir(), 'demo')
  claimRun(lockDir, runDir)()
  writeFileSync(join(runDir, 'old'), 'x')
  const release = claimRun(lockDir, runDir)
  assert.equal(existsSync(join(runDir, 'old')), false)
  assert.equal(existsSync(runDir), true)
  release()
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
