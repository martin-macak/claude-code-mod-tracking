// How many rows a line of text takes when the engine wraps it. The help view and the window of the pane count rows
// before they draw, so they must wrap the way the engine does. Pure.
import { cellWidth } from './cell-width'

/**
 * The rows a line takes in a body `columns` wide. The engine wraps a Text at spaces and breaks a word longer than a
 * row. A long path moves to its own row after a short word, so the count must see words.
 */
export function wrapRows(line: string, columns: number): number {
  const width = Math.max(1, columns)
  let rows = 1
  let used = 0
  for (const word of line.split(' ')) {
    const cells = cellWidth(word)
    if (used === 0 || used + 1 + cells > width) {
      if (used > 0) rows++
      used = cells
    } else {
      used += 1 + cells
    }
    while (used > width) {
      rows++
      used -= width
    }
  }
  return rows
}
