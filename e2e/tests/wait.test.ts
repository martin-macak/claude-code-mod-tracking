import assert from 'node:assert/strict'
import { test } from 'node:test'
import { waitUntil } from '../support/wait.ts'

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
