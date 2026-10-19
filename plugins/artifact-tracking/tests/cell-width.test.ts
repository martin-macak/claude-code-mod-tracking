// Cell width, one-line cells and clipping by cell. Pure.
import { expect, test } from 'claude-code/testing'
import { cellWidth, clipMiddle, clipTo, normaliseCell } from '../ux/text/cell-width'
import { VECTORS } from './fixtures/width-vectors'

test('cellWidth matches Bun.stringWidth on the vectors', () => {
  const mismatches = VECTORS.filter(([s, w]) => cellWidth(s) !== w).map(
    ([s, w]) => `"${s}" want ${w} got ${cellWidth(s)}`,
  )
  expect(mismatches).toEqual([])
  expect(VECTORS.length).toBeGreaterThanOrEqual(43)
})

test('ASCII is its length', () => {
  expect(cellWidth('PROJ-123 Fix')).toBe(12)
})

test('decomposed Hangul is a known miss: L+V counts 3 and L+V+T counts 4, Bun counts 2 for each', () => {
  expect(cellWidth('\u1112\u1161')).toBe(3)
  expect(cellWidth('\u1112\u1161\u11ab')).toBe(4)
  expect(cellWidth('\uD55C')).toBe(2)
})

test('normaliseCell turns tabs, newlines, controls and ANSI escapes into spaces', () => {
  expect(normaliseCell('a\tb\nc\u0007d\u001b[31me\u001b[0m')).toBe('a b c d e ')
  expect(normaliseCell('plain')).toBe('plain')
})

test('clipTo keeps a text that fits', () => {
  expect(clipTo('abc', 3)).toBe('abc')
})

test('clipTo cuts by grapheme and ends in …', () => {
  // The engine draws the same in 8 cells (tree-table section 3.1).
  expect(clipTo('ABCDEFGHIJ', 8)).toBe('ABCDEFG…')
})

test('clipTo never splits a wide character or an emoji', () => {
  expect(clipTo('日本語', 4)).toBe('日…')
  expect(clipTo('😀😀😀', 5)).toBe('😀😀…')
  expect(clipTo('👩‍🍳x', 2)).toBe('…')
})

test('clipTo to 1 is …, to 0 or below is empty', () => {
  expect(clipTo('abc', 1)).toBe('…')
  expect(clipTo('abc', 0)).toBe('')
  expect(clipTo('abc', -3)).toBe('')
})

test('clipMiddle keeps a text that fits', () => {
  expect(clipMiddle('feat/x', 6)).toBe('feat/x')
  expect(clipMiddle('', 3)).toBe('')
})

test('clipMiddle keeps both ends and puts … in the middle', () => {
  expect(clipMiddle('feat/band-auto-tracking', 12)).toBe('feat/b…cking')
  expect(clipMiddle('ABCDEFGHIJ', 8)).toBe('ABCD…HIJ')
  expect(cellWidth(clipMiddle('feat/band-auto-tracking', 12))).toBe(12)
  expect(clipMiddle('abcdef', 2)).toBe('a…')
})

test('clipMiddle never splits a wide character or an emoji', () => {
  const cook = '👩\u200D🍳' // one grapheme, 2 cells
  expect(clipMiddle('日本語日本語', 5)).toBe('日…語')
  expect(clipMiddle('😀😀😀😀😀', 6)).toBe('😀…😀')
  expect(clipMiddle(`a${cook}bc${cook}d`, 5)).toBe(`a…${cook}d`)
  for (const cells of [2, 3, 4, 5, 6, 7]) {
    expect(cellWidth(clipMiddle('日本語日本語', cells))).toBeLessThanOrEqual(cells)
    expect(cellWidth(clipMiddle(`x${cook}y${cook}z`, cells))).toBeLessThanOrEqual(cells)
  }
})

test('clipMiddle to 1 is …, to 0 or below is empty', () => {
  expect(clipMiddle('abc', 1)).toBe('…')
  expect(clipMiddle('abc', 0)).toBe('')
  expect(clipMiddle('abc', -3)).toBe('')
})
