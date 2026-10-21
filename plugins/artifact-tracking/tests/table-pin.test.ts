// The footer of a docked pane sits at the bottom of the body, also when the rows are fewer than the body holds (issue #109,
// the owner's wish: "the status line is always in the bottom"). A docked body has a fixed height, so the tree takes all of
// it and the footer grows to the end of the column. An inline pane is as tall as its tree: padding it would stretch every
// pane to its full height, so the footer stays under the last row. Pure.
import { expect, test } from 'claude-code/testing'
import { KeyRegistry } from '../core/infra/keys'
import type { GroupSpec } from '../core/interfaces/view'
import { resetWidths } from '../ux/tree-data-table/columns'
import { helpModel } from '../ux/tree-data-table/help'
import { TreeDataTable } from '../ux/tree-data-table/table'
import { footerOf, NO_ROW_FOOTER, type Node, recorder, rowBoxes, view } from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { group, webRows } from './fixtures/sections'

// The docked pane at 120x37 has a body of 31 rows, drawn here 95 cells wide as in #109 (the live check of issue #63 measured
// 49 cells: tests/one-table.test.ts holds that width). The inline pane at 100x40 has 11 rows, 96 cells wide.
const DOCKED = { bodyColumns: 95, bodyRows: 31, placement: 'dock' } as const
const INLINE = { bodyColumns: 96, bodyRows: 11, placement: 'inline' } as const

const web = (n: number): GroupSpec[] => [group('web', webRows(n))]
const draw = (sections: readonly GroupSpec[], over: Parameters<typeof view>[0]) => {
  resetWidths()
  return TreeDataTable.render(sections, view(over), EL, recorder().actions)
}
const root = (tree: unknown): Node => tree as Node
/** The last child of the root: the footer, or the Box that holds it. */
const last = (tree: unknown): Node => root(tree).children.at(-1) as Node

test('docked, 3 rows: the root takes the whole body and the footer sits in a Box that grows to the end of the column', () => {
  const { tree } = draw(web(3), DOCKED)
  expect(root(tree).props.minHeight).toBe(DOCKED.bodyRows)
  expect(last(tree).props).toMatchObject({ flexGrow: 1, flexShrink: 0, justifyContent: 'flex-end' })
  expect(footerOf(last(tree))).toHaveLength(NO_ROW_FOOTER.length)
  expect(footerOf(tree)).toHaveLength(NO_ROW_FOOTER.length) // one footer, not a copy
})

test('docked, 3 rows: the pin adds no child to the root, so it adds no gap row', () => {
  const pinned = draw(web(3), DOCKED).tree
  const plain = draw(web(3), { ...DOCKED, placement: 'inline' }).tree
  expect(root(pinned).children).toHaveLength(root(plain).children.length)
})

test('docked and windowed: the pin leaves the window exact, the tree is as tall as the body and no taller', () => {
  const { tree } = draw(web(40), DOCKED)
  expect(root(tree).props.minHeight).toBe(DOCKED.bodyRows)
  // The title, the header, the rows, the hint below, the gap and the footer: 31 rows, so nothing for the engine to scroll.
  expect(rowBoxes(tree).length + 2 + 1 + 1 + 1).toBe(DOCKED.bodyRows)
})

test('inline, 3 rows: nothing is pinned, the footer is the last child under the last row', () => {
  const { tree } = draw(web(3), INLINE)
  expect(root(tree).props.minHeight).toBeUndefined()
  expect(last(tree).props.flexGrow).toBeUndefined()
  expect(footerOf(last(tree))).toHaveLength(NO_ROW_FOOTER.length)
})

test('a pane that does not say where it sits is not pinned, and neither is a docked one with no body height', () => {
  for (const over of [{ bodyRows: 31 }, { placement: 'dock' as const, bodyRows: undefined }]) {
    const { tree } = draw(web(3), over)
    expect(root(tree).props.minHeight, JSON.stringify(over)).toBeUndefined()
    expect(last(tree).props.flexGrow, JSON.stringify(over)).toBeUndefined()
  }
})

test('the help view and the empty pane of a docked pane are pinned too: the footer ends the body', () => {
  const help = helpModel(new KeyRegistry().all(), [], undefined, [])
  for (const over of [{ help }, {}]) {
    const { tree } = draw([], { ...DOCKED, ...over })
    expect(root(tree).props.minHeight, JSON.stringify(Object.keys(over))).toBe(DOCKED.bodyRows)
    expect(last(tree).props.flexGrow).toBe(1)
    expect(footerOf(last(tree)).length).toBeGreaterThan(0)
  }
})
