import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { idleMs, waitForExit, waitUntil } from '../support/wait.ts'

test('waitUntil resolves with the first defined probe value', async () => {
  let calls = 0
  const value = await waitUntil(() => (++calls === 3 ? 'ok' : undefined), { timeoutMs: 1000, intervalMs: 1, what: 'x' })
  assert.equal(value, 'ok')
  assert.equal(calls, 3)
})

test('waitUntil fails with what it waited for and the last screen', async () => {
  await assert.rejects(
    waitUntil(() => undefined, { timeoutMs: 20, intervalMs: 5, what: 'the band', last: () => 'SCREEN' }),
    /timed out after 20 ms waiting for the band\n--- last screen ---\nSCREEN/,
  )
})

// Issue #165. A scenario that needs a log to be quiet asks how long ago the file last changed, and waits until that is long
// enough. The wait starts at the last change, so a machine that is slow to write it only makes the wait longer.
test('idleMs says how long ago the file last changed, and nothing for a missing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idle-'))
  try {
    const file = join(dir, 'log')
    assert.equal(idleMs(file), undefined)
    writeFileSync(file, 'x')
    utimesSync(file, new Date(10_000), new Date(10_000))
    assert.equal(idleMs(file, 12_500), 2500)
    assert.equal(idleMs(file, 9_000), 0) // a clock that is a little behind never gives a negative age
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// A step that must not delete state while an old process may still write it waits for the process group to be gone, not for a
// fixed time. The child is a group leader, as the process of a tmux pane is.
test('waitForExit waits for the process group of a pid to end, and fails while it lives', async () => {
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
  const pid = child.pid!
  try {
    await assert.rejects(waitForExit(pid, { timeoutMs: 100, intervalMs: 10 }), /waiting for process \d+ to exit/)
    const done = waitForExit(pid, { timeoutMs: 5000, intervalMs: 10 })
    process.kill(-pid, 'SIGKILL')
    await done
    assert.throws(() => process.kill(pid, 0))
  } finally {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {}
  }
})

test('waitForExit returns at once for a pid that is already gone', async () => {
  const child = spawn('true', [], { detached: true, stdio: 'ignore' })
  await new Promise(resolve => child.on('exit', resolve))
  await waitForExit(child.pid!, { timeoutMs: 1000, intervalMs: 10 })
})
