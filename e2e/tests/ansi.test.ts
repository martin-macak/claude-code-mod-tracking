import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripAnsi } from '../support/ansi.ts'

test('stripAnsi removes CSI colour and cursor codes', () => {
  assert.equal(stripAnsi('\u001b[1;32mok\u001b[0m \u001b[2;5Hx'), 'ok x')
})

test('stripAnsi removes OSC sequences ended by BEL or ST', () => {
  assert.equal(stripAnsi('\u001b]0;title\u0007a\u001b]2;t\u001b\\b'), 'ab')
})

test('stripAnsi removes charset and keypad escapes', () => {
  assert.equal(stripAnsi('\u001b(Ba\u001b=b\u001b>c'), 'abc')
})

test('stripAnsi keeps plain text and unicode', () => {
  assert.equal(stripAnsi('tracking  GitHub 2 · Links 1 ✗'), 'tracking  GitHub 2 · Links 1 ✗')
})
