import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectedLine } from '../support/pane.ts'

test('selectedLine finds the row with the > gutter', () => {
  const line = 'abc │> ▲ ▸ two.example/b  two.example/b'
  assert.equal(selectedLine(`header\n${line}\nx`), line)
})

test('selectedLine returns the first such line', () => {
  assert.equal(selectedLine('│> one\n│> two'), '│> one')
})

test('selectedLine returns undefined without one', () => {
  assert.equal(selectedLine('│  ▸ one.example/a\n│  ▸ two.example/b'), undefined)
})

test('a > inside the transcript is not a selection', () => {
  assert.equal(selectedLine('see a > b │  ▸ one.example/a'), undefined)
})
