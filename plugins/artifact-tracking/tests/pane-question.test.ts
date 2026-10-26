// BulkQuestion (issue #138): the question of a bulk dismiss as a small state machine, without a whole draw and press cycle.
// PaneSession tests the same rules through the pane; here each transition stands alone. Pure.
import { expect, test } from 'claude-code/testing'
import { BulkQuestion } from '../hooks/pane-question'

test('with no question asked, a press asks and a drawing shows nothing', () => {
  const q = new BulkQuestion()
  expect(q.ids).toBeUndefined()
  expect(q.read(1, ['a', 'c'], true)).toBe(false)
  expect(q.answer(1, ['a', 'c'])).toBe('ask')
  expect(q.clear()).toBe(false) // nothing stood: the pane has no drawing to redo
})

test('a question that no drawing showed is stale for every press: the press asks and never confirms', () => {
  const q = new BulkQuestion()
  q.ask(['a', 'c'])
  expect(q.ids).toEqual(['a', 'c'])
  expect(q.answer(1, ['a', 'c'])).toBe('stale')
  expect(q.answer(99, ['a', 'c'])).toBe('stale') // however late: no drawing has read the question yet
})

test('the first drawing that reads the question shows it; a press from that drawing or a later one confirms', () => {
  const q = new BulkQuestion()
  q.ask(['a', 'c'])
  expect(q.read(3, ['a', 'c'], true)).toBe(true)
  expect(q.answer(2, ['a', 'c'])).toBe('stale') // a drawing from before the question
  expect(q.answer(3, ['a', 'c'])).toBe('confirm')
  expect(q.answer(4, ['a', 'c'])).toBe('confirm')
})

test('a later drawing does not move the number of the drawing that showed the question', () => {
  const q = new BulkQuestion()
  q.ask(['a', 'c'])
  q.read(3, ['a', 'c'], true)
  expect(q.read(4, ['a', 'c'], true)).toBe(true)
  expect(q.answer(3, ['a', 'c'])).toBe('confirm') // still the first drawing that showed it
})

test('the question names rows, not their order', () => {
  const q = new BulkQuestion()
  q.ask(['a', 'c'])
  expect(q.read(1, ['c', 'a'], true)).toBe(true)
  expect(q.answer(1, ['c', 'a'])).toBe('confirm')
})

test('a press for other rows than the question names asks again', () => {
  const q = new BulkQuestion()
  q.ask(['a', 'c'])
  q.read(1, ['a', 'c'], true)
  expect(q.answer(1, ['a', 'c', 'd'])).toBe('ask')
  expect(q.answer(1, ['a'])).toBe('ask')
})

test('a drawing whose targets changed withdraws the question', () => {
  const q = new BulkQuestion()
  q.ask(['a', 'c'])
  expect(q.read(1, ['a', 'c', 'd'], true)).toBe(false)
  expect(q.ids).toBeUndefined()
  expect(q.answer(2, ['a', 'c'])).toBe('ask')
})

test('a drawing without the keys, and the help view, withdraw the question', () => {
  const q = new BulkQuestion()
  q.ask(['a', 'c'])
  q.read(1, ['a', 'c'], true)
  expect(q.read(2, ['a', 'c'], false)).toBe(false)
  expect(q.ids).toBeUndefined()
  expect(q.read(3, ['a', 'c'], true)).toBe(false) // withdrawn for good: only a press asks again
})

test('clear ends a question that stood, and says so', () => {
  const q = new BulkQuestion()
  q.ask(['a', 'c'])
  q.read(1, ['a', 'c'], true)
  expect(q.clear()).toBe(true)
  expect(q.ids).toBeUndefined()
  expect(q.answer(2, ['a', 'c'])).toBe('ask')
  expect(q.clear()).toBe(false)
})
