import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { acquireLock, claimRun } from '../support/lock.ts'

const tempDir = () => mkdtempSync(join(tmpdir(), 'lock-'))
const child = fileURLToPath(new URL('./fixtures/lock-child.ts', import.meta.url))

// One lock child process. Its stdio follows the protocol in fixtures/lock-child.ts.
// A test that times out aborts its signal, and the child is killed then, not left running.
function spawnLockChild(dir: string, signal: AbortSignal) {
  const proc = spawn(process.execPath, [child, dir], { stdio: ['pipe', 'pipe', 'pipe'] })
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

test('acquireLock creates a missing folder', () => {
  const dir = join(tempDir(), 'a', 'b')
  acquireLock(dir)()
})
