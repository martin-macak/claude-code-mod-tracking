import { expect, test } from 'claude-code/testing'
import { cellWidth } from '../hooks/cell-width'
import { VECTORS } from './vectors'

test('cellWidth matches Bun.stringWidth (ambiguousIsNarrow) on the vectors, in the hooks env', () => {
  const bad = VECTORS.filter(([s, w]) => cellWidth(s) !== w).map(([s, w]) => `${JSON.stringify(s)} want ${w} got ${cellWidth(s)}`)
  expect(bad).toEqual([])
  expect(VECTORS.length).toBeGreaterThan(20)
})
