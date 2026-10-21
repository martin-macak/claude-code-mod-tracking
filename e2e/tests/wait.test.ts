import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { idleMs, waitUntil } from '../support/wait.ts'

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
