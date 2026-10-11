import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCast, writeCast } from '../render/cast.ts'

const sample = '{"version":2,"width":120,"height":37}\n[0.5,"o","hi"]\n[1.25,"o","\\u001b[2J"]\n'

test('parseCast reads the header and the events', () => {
  const cast = parseCast(sample)
  assert.equal(cast.header.width, 120)
  assert.equal(cast.header.height, 37)
  assert.deepEqual(cast.events, [
    [0.5, 'o', 'hi'],
    [1.25, 'o', '\u001b[2J'],
  ])
})

test('writeCast round-trips a cast byte for byte', () => {
  assert.equal(writeCast(parseCast(sample)), sample)
})

test('parseCast ignores blank lines', () => {
  assert.equal(parseCast(sample.replace('\n[0.5', '\n\n[0.5')).events.length, 2)
})

test('parseCast rejects a v3 header', () => {
  assert.throws(() => parseCast('{"version":3,"term":{"cols":80,"rows":24}}\n'), /version 3 is not 2/)
})

test('parseCast rejects a malformed event with its line number', () => {
  assert.throws(() => parseCast('{"version":2,"width":80,"height":24}\n[1,"o"]\n'), /bad event on line 2/)
})

test('parseCast rejects an empty file', () => {
  assert.throws(() => parseCast('\n'), /empty file/)
})
