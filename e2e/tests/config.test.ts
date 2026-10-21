import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadConfig } from '../support/config.ts'

test('loadConfig gives the spec defaults for an empty env', () => {
  assert.deepEqual(loadConfig({}), {
    record: false,
    model: 'haiku',
    dir: '/tmp/cc-demo',
    cols: 120,
    rows: 36,
    typeDelayMs: 35,
    turnTimeoutMs: 120_000,
    screenTimeoutMs: 20_000,
    lockWaitMs: 1_800_000,
    keep: false,
  })
})

test('loadConfig reads overrides', () => {
  const config = loadConfig({
    DEMO_RECORD: '1',
    DEMO_MODEL: 'sonnet',
    DEMO_DIR: '/tmp/x y',
    DEMO_COLS: '140',
    DEMO_TURN_TIMEOUT_S: '30',
    DEMO_KEEP: '1',
  })
  assert.equal(config.record, true)
  assert.equal(config.model, 'sonnet')
  assert.equal(config.dir, '/tmp/x y')
  assert.equal(config.cols, 140)
  assert.equal(config.turnTimeoutMs, 30_000)
  assert.equal(config.keep, true)
})

test('loadConfig rejects a value that is not a positive integer', () => {
  assert.throws(() => loadConfig({ DEMO_COLS: 'wide' }), /DEMO_COLS must be a positive integer, got "wide"/)
  assert.throws(() => loadConfig({ DEMO_ROWS: '0' }), /DEMO_ROWS/)
})

test('loadConfig reads the lock wait in seconds, and 0 means do not wait', () => {
  assert.equal(loadConfig({ DEMO_LOCK_WAIT_S: '90' }).lockWaitMs, 90_000)
  assert.equal(loadConfig({ DEMO_LOCK_WAIT_S: '0' }).lockWaitMs, 0)
  assert.equal(loadConfig({ DEMO_LOCK_WAIT_S: '' }).lockWaitMs, 1_800_000)
})

test('loadConfig rejects a lock wait that is not a whole number of seconds from 0', () => {
  assert.throws(
    () => loadConfig({ DEMO_LOCK_WAIT_S: '-1' }),
    /DEMO_LOCK_WAIT_S must be a non-negative integer, got "-1"/,
  )
  assert.throws(() => loadConfig({ DEMO_LOCK_WAIT_S: '1.5' }), /DEMO_LOCK_WAIT_S/)
  assert.throws(() => loadConfig({ DEMO_LOCK_WAIT_S: 'soon' }), /DEMO_LOCK_WAIT_S/)
})
