import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { acquireLock, claimRun } from '../support/lock.ts'

const tempDir = () => mkdtempSync(join(tmpdir(), 'lock-'))

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

test('only one of two runs that start at once takes over a stale lock', async () => {
  const child = fileURLToPath(new URL('./fixtures/lock-child.ts', import.meta.url))
  const run = (dir: string, startAt: number) =>
    new Promise<string>(resolve => {
      execFile(process.execPath, [child, dir, String(startAt)], (_err, stdout) => resolve(stdout))
    })
  for (let i = 0; i < 15; i++) {
    const dir = tempDir()
    writeFileSync(join(dir, '.lock'), '999999')
    const startAt = Date.now() + 400
    const results = await Promise.all([run(dir, startAt), run(dir, startAt)])
    assert.equal(results.filter(r => r === 'won').length, 1, `trial ${i}: ${results.join(', ')}`)
    assert.deepEqual(readdirSync(dir), ['.lock'], `trial ${i} left extra files`)
  }
})

test('acquireLock creates a missing folder', () => {
  const dir = join(tempDir(), 'a', 'b')
  acquireLock(dir)()
})
