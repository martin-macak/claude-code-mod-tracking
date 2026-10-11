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
