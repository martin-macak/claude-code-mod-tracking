// `wrapRowsIndented` (issue #199): the rule for a line that starts with spaces sits next to the model of the wrap, so a
// caller does not repeat it. `wrapRows` skips empty words, so it loses a leading indent. Pure.
import { expect, test } from 'claude-code/testing'
import { wrapRows, wrapRowsIndented } from '../ux/text/wrap'

test('wrapRowsIndented counts the indent as cells of the first row: a step that fills the row takes one row, one cell more takes two', () => {
  expect(wrapRowsIndented(`  ${'x'.repeat(94)}`, 96)).toBe(1)
  expect(wrapRowsIndented(`  ${'x'.repeat(95)}`, 96)).toBe(2)
})

test('wrapRowsIndented sees the words that the indent pushes to the next row, where wrapRows does not', () => {
  // The indent of 2 and `abc` take 5 cells, and ` def` makes 9: more than 8, so the engine wraps it.
  expect(wrapRows('  abc def', 8)).toBe(1) // the model drops the indent
  expect(wrapRowsIndented('  abc def', 8)).toBe(2)
})

test('wrapRowsIndented is wrapRows for a line with no indent and for an empty line, and a line of spaces is one row', () => {
  for (const line of ['abc def', 'a long line of several words that wraps in a short body', ''])
    expect(wrapRowsIndented(line, 10), line).toBe(wrapRows(line, 10))
  expect(wrapRowsIndented('   ', 10)).toBe(1)
})
