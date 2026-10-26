// A marked row draws `*` in the free cell of the control column (issue #138): the level marker keeps the other cell, and
// the column stays two cells wide. Pure: TreeDataTable.render with `view.marked`.
import { expect, test } from 'claude-code/testing'
import { COLOR } from '../ux/theme'
import { resetWidths } from '../ux/tree-data-table/columns'
import { TreeDataTable } from '../ux/tree-data-table/table'
import { leaves, type Node, nodes, recorder, rowBoxes, view } from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { group, row } from './fixtures/sections'

const draw = (rows: ReturnType<typeof row>[], marked?: ReadonlySet<string>) => {
  resetWidths()
  const rec = recorder()
  return TreeDataTable.render(
    [group('web', rows)],
    view({ ...(marked === undefined ? {} : { marked }) }),
    EL,
    rec.actions,
  )
}

/** The control Box of the n-th row: the first Box after the gutter Text. */
const controlOf = (tree: unknown, n: number): Node => (rowBoxes(tree)[n] as Node).children[1] as Node

const web = (id: string, control: string | { text: string; dim?: boolean }) =>
  row(id, { control, name: id, description: `https://${id}.example/` })

test('a marked row draws * before its level marker; an unmarked row draws the marker alone', () => {
  const { tree } = draw([web('a', '▲'), web('b', '▲'), web('c', '')], new Set(['a', 'c']))
  expect(leaves(controlOf(tree, 0))).toEqual(['*', '▲'])
  expect(leaves(controlOf(tree, 1))).toEqual(['▲'])
  expect(leaves(controlOf(tree, 2))).toEqual(['*']) // no level: the mark alone
})

test('the control column keeps its two cells and the marker keeps its dim', () => {
  const { tree } = draw([web('a', { text: '▽', dim: true }), web('b', '▲')], new Set(['a']))
  expect(controlOf(tree, 0).props.width).toBe(2)
  expect(controlOf(tree, 1).props.width).toBe(2)
  const texts = nodes(controlOf(tree, 0), 'Text')
  expect(texts.map(t => [t.children[0], t.props.dimColor])).toEqual([
    ['*', undefined],
    ['▽', true],
  ])
})

test('a row that is not marked, and a mark of a row that is not drawn, change nothing', () => {
  const plain = draw([web('a', '▲')])
  const other = draw([web('a', '▲')], new Set(['gone']))
  expect(JSON.stringify(other.tree)).toBe(JSON.stringify(plain.tree))
  expect(leaves(controlOf(other.tree, 0))).toEqual(['▲'])
})

test('the * is drawn in the accent color', () => {
  const { tree } = draw([web('a', '▲')], new Set(['a']))
  expect(nodes(controlOf(tree, 0), 'Text')[0]?.props.color).toBe(COLOR.accent)
})

test('the control Box of a marked row has the props of the unmarked one', () => {
  const marked = controlOf(draw([web('a', '▲')], new Set(['a'])).tree, 0)
  const plain = controlOf(draw([web('a', '▲')]).tree, 0)
  expect(marked.props).toEqual(plain.props)
})

test('a marked row that is dim draws a dim *', () => {
  const dimmed = row('d', { control: '', name: 'd', description: 'https://d.example/' }, { dim: true })
  const { tree } = draw([dimmed], new Set(['d']))
  expect(nodes(controlOf(tree, 0), 'Text').map(t => [t.children[0], t.props.dimColor])).toEqual([['*', true]])
})
