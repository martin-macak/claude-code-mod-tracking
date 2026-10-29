// The view line of the pane (issue #63, L3): one line above the footer. It says the view and the filters, and holds the Buttons
// of `g`, `a`, `t`, `p`, `m` and `e`. Those keys sit here, not in the footer, so the footer keeps the rows it has. The words are clipped to the
// width and the Buttons wrap whole, as the footer's do, so the rows it takes are a count. Pure.
import type { RenderElement } from 'claude-code'
import { cellWidth, clipTo } from '../text/cell-width'
import { box, type TableElements, text } from './el'
import { fillRows, ITEM_GAP, keyButton, keyWidth } from './footer'
import type { TableActions, ViewLine } from './shape'

/** The words of the line, cut to the cells the body has: a long summary takes one row, never two. */
const wordsOf = (line: ViewLine, columns: number): string => clipTo(line.text, columns)

/** The Box of the line: the words, then one Button for each key. */
export function viewLineBox(el: TableElements, line: ViewLine, columns: number, actions: TableActions): RenderElement {
  return box(
    el,
    { columnGap: ITEM_GAP, flexWrap: 'wrap' },
    text(el, {}, wordsOf(line, columns)),
    ...line.keys.map(k => keyButton(el, k, actions)),
  )
}

/** How many rows the line takes in a body `columns` wide. None without a line. */
export function viewLineRows(line: ViewLine | undefined, columns: number): number {
  if (line === undefined) return 0
  return fillRows([cellWidth(wordsOf(line, columns)), ...line.keys.map(keyWidth)], columns)
}
