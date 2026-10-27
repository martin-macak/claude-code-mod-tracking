// The height oracle of the status-area tests (issue #138, review m6). `heightOf` is layout logic of its own: the budget tests say
// "the window counts what the oracle counts", so the oracle needs trees whose answer is known by hand. Pure.
import { expect, test } from 'claude-code/testing'
import { wrapRows } from '../ux/text/wrap'
import type { Node } from './fixtures/drawn'
import { heightOf, widthOf } from './fixtures/height'

const box = (props: Node['props'], ...children: unknown[]): Node => ({ type: 'Box', props, children })
const text = (words: string, props: Node['props'] = {}): Node => ({ type: 'Text', props, children: [words] })
const button = (hotkey: string, label: string): Node => ({ type: 'Button', props: { hotkey, label }, children: [] })
const COLUMN = { flexDirection: 'column' }

test('heightOf: a column of three Texts is three rows, and a rowGap of 1 adds one row between each two', () => {
  const texts = [text('a'), text('b'), text('c')]
  expect(heightOf(box(COLUMN, ...texts), 40)).toBe(3)
  expect(heightOf(box({ ...COLUMN, rowGap: 1 }, ...texts), 40)).toBe(5)
})

test('heightOf: a row Box is as tall as its tallest child, and an empty Box takes no row', () => {
  expect(heightOf(box({}, text('a'), text('b')), 40)).toBe(1)
  expect(heightOf(box({}, text('a'), box(COLUMN, text('b'), text('c'))), 40)).toBe(2)
  expect(heightOf(box({}), 40)).toBe(0)
})

test('heightOf: a wrapping Box of Buttons fills rows as the footer does', () => {
  // `r: refresh` is 10 cells and the gap is 2: two Buttons take 22 cells, so the third wraps in a body of 30.
  const keys = ['r', 'h', 'x'].map(k => button(k, 'refresh'))
  expect(heightOf(box({ flexWrap: 'wrap', columnGap: 2 }, ...keys), 30)).toBe(2)
  expect(heightOf(box({ flexWrap: 'wrap', columnGap: 2 }, ...keys), 40)).toBe(1)
})

test('heightOf: minHeight is the floor of a Box, and height 0 takes no row at all', () => {
  expect(heightOf(box({ ...COLUMN, minHeight: 5 }), 40)).toBe(5)
  expect(heightOf(box({ ...COLUMN, minHeight: 2 }, text('a'), text('b'), text('c')), 40)).toBe(3)
  expect(heightOf(box({ height: 0 }, text('a')), 40)).toBe(0)
})

test('heightOf: a truncating Text takes one row, a plain Text wraps and a null child counts nowhere', () => {
  const long = 'word '.repeat(40).trim()
  expect(heightOf(text(long, { wrap: 'truncate-end' }), 40)).toBe(1)
  expect(heightOf(text(long), 40)).toBe(wrapRows(long, 40))
  expect(wrapRows(long, 40)).toBeGreaterThan(1)
  expect(heightOf(box(COLUMN, text('a'), null, undefined), 40)).toBe(1)
})

test('widthOf: a Text is its words, a row Box adds its children and the columnGap, a column Box takes the widest', () => {
  expect(widthOf(text('日本'))).toBe(4) // two wide characters take four cells
  expect(widthOf(box({ columnGap: 1 }, text('ab'), text('cd'), text('ef')))).toBe(8)
  expect(widthOf(box(COLUMN, text('ab'), text('cdef')))).toBe(4)
  expect(widthOf(box({ width: 12 }, text('ab')))).toBe(12)
  expect(widthOf(button('r', 'refresh'))).toBe(10)
  expect(widthOf(null)).toBe(0)
})
