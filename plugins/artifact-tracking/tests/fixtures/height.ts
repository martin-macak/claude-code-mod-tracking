// The rows a drawing takes in a body `columns` wide, counted from the plain-data tree that the node tests read (issue #138, the
// status area). A test of the row budget needs the height of the whole tree: the window counts the title, the header, the hints,
// the gap, the status lines, the view line and the footer, and the sum must be the body, no more. Pure.

import { cellWidth } from '../../ux/text/cell-width'
import { wrapRows } from '../../ux/text/wrap'
import { fillRows } from '../../ux/tree-data-table/footer'
import { isNode, leaves, type Node } from './drawn'

/**
 * The cells a node takes in a row of its parent: a Box with a `width`, a Button as its label, a Text as its words. A row Box adds
 * its children and the `columnGap` between them; a column Box is as wide as its widest child.
 */
export function widthOf(node: unknown): number {
  if (typeof node === 'string') return cellWidth(node)
  if (!isNode(node)) return 0
  if (node.type === 'Button') {
    const { hotkey, label } = node.props
    return cellWidth(hotkey === undefined ? String(label) : `${String(hotkey)}: ${String(label)}`)
  }
  if (typeof node.props.width === 'number') return node.props.width
  const parts = node.children.filter(c => c !== null && c !== undefined).map(widthOf)
  if (node.props.flexDirection === 'column') return parts.reduce((max, w) => Math.max(max, w), 0)
  const gap = typeof node.props.columnGap === 'number' ? node.props.columnGap : 0
  return parts.reduce((sum, w) => sum + w, 0) + gap * Math.max(0, parts.length - 1)
}

/**
 * The rows of `node` in a body `columns` wide. A column Box adds its children and the `rowGap` between them. A row Box that
 * wraps fills rows as the footer does (`fillRows`). Any other row Box is as tall as its tallest child. A Box with a `height`
 * takes that many rows, children and `minHeight` aside (a focus stop 0, a blank line of the plan view 1: the paint of that Box was not
 * seen live, so the 1 is an inference). Any other Box has `minHeight` as its floor. A Text with `wrap: 'truncate-end'` takes one row.
 */
export function heightOf(node: unknown, columns: number): number {
  if (typeof node === 'string') return 1
  if (!isNode(node)) return 0
  if (node.type === 'Button') return 1
  if (node.type === 'Text') {
    return node.props.wrap === 'truncate-end' ? 1 : wrapRows(leaves(node).join(''), columns)
  }
  if (typeof node.props.height === 'number') return node.props.height // a fixed height: 0 for a focus stop, 1 for a blank line
  const kids = (node as Node).children.filter(c => c !== null && c !== undefined)
  const gap = typeof node.props.rowGap === 'number' ? node.props.rowGap : 0
  let rows: number
  if (node.props.flexDirection === 'column') {
    rows = kids.reduce<number>((sum, c) => sum + heightOf(c, columns), 0) + gap * Math.max(0, kids.length - 1)
  } else if (node.props.flexWrap === 'wrap') {
    rows = fillRows(kids.map(widthOf), columns)
  } else {
    rows = kids.reduce<number>((max, c) => Math.max(max, heightOf(c, columns)), kids.length > 0 ? 1 : 0)
  }
  return typeof node.props.minHeight === 'number' ? Math.max(rows, node.props.minHeight) : rows
}
