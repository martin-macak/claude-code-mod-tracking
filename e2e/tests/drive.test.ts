import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseDriveArgs } from '../support/drive.ts'

test('parseDriveArgs reads each command', () => {
  assert.deepEqual(parseDriveArgs(['start']), { cmd: 'start' })
  assert.deepEqual(parseDriveArgs(['start', 'hi there']), { cmd: 'start', prompt: 'hi there' })
  assert.deepEqual(parseDriveArgs(['type', 'a', 'b']), { cmd: 'type', text: 'a b' })
  assert.deepEqual(parseDriveArgs(['key', 'Escape']), { cmd: 'key', text: 'Escape' })
  assert.deepEqual(parseDriveArgs(['caption', 'Hello']), { cmd: 'caption', text: 'Hello' })
  assert.deepEqual(parseDriveArgs(['wait-turn']), { cmd: 'wait-turn' })
  assert.deepEqual(parseDriveArgs(['screen']), { cmd: 'screen' })
  assert.deepEqual(parseDriveArgs(['stop']), { cmd: 'stop' })
})

test('parseDriveArgs rejects a missing text and an unknown command with the usage', () => {
  assert.throws(() => parseDriveArgs(['type']), /usage: node bin\/drive.ts/)
  assert.throws(() => parseDriveArgs(['dance']), /usage: node bin\/drive.ts/)
  assert.throws(() => parseDriveArgs([]), /usage: node bin\/drive.ts/)
})
