import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sizeRefusal } from '../support/size.ts'

test('a scenario may set its terminal size before the session starts', () => {
  assert.equal(sizeRefusal({ record: false, launched: false }), undefined)
})

test('a scenario may not set its terminal size after the session started', () => {
  assert.match(sizeRefusal({ record: false, launched: true }) ?? '', /before the step that starts the session/)
})

test('a recorded scenario may not set its terminal size: the recording has the size of its cast header', () => {
  assert.match(sizeRefusal({ record: true, launched: false }) ?? '', /DEMO_RECORD=1.*DEMO_COLS x DEMO_ROWS/)
})
