import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { debugLogHolds, debugLogTail } from '../support/debug-log.ts'

const logIn = () => join(mkdtempSync(join(tmpdir(), 'debug-log-')), 'debug.log')

test('debugLogHolds is false while the file is missing or empty, and true once a line holds the text', () => {
  const log = logIn()
  assert.equal(debugLogHolds(log, 'pane ring pause'), false)
  writeFileSync(log, '')
  assert.equal(debugLogHolds(log, 'pane ring pause'), false)
  writeFileSync(
    log,
    '[DEBUG] [artifact-tracking] $.ui.log (to debug): pane ring pause: the engine timer of 10 ms did not fire\n',
  )
  assert.equal(debugLogHolds(log, 'pane ring pause: the engine timer of 10 ms'), true)
  assert.equal(debugLogHolds(log, 'pane frame bound'), false)
})

test('debugLogHolds reads the text as it is: no pattern, so a dot or a bracket in it is a plain character', () => {
  const log = logIn()
  writeFileSync(log, 'a (late or refused); b.c [x]\n')
  assert.equal(debugLogHolds(log, '(late or refused); b.c [x]'), true)
  assert.equal(debugLogHolds(log, 'b?c'), false)
})

test('debugLogTail gives the last lines for a failure message, and says so when the file is missing or empty', () => {
  const log = logIn()
  assert.equal(debugLogTail(log, 2), 'no debug log')
  writeFileSync(log, '')
  assert.equal(debugLogTail(log, 2), 'an empty debug log')
  writeFileSync(log, 'one\ntwo\nthree\n')
  assert.equal(debugLogTail(log, 2), 'two\nthree')
})
