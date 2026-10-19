// TreeDataTable caps, the "N more" row, the budget guard and the handle helpers (layout, handleOf, findRow). Pure.
// Plan: L6 Task 8, decisions G4, G18; Review Focus 2 and 4.
import { expect, test } from 'claude-code/testing'
import type { SectionSpec, TreeRow } from '../core/interfaces/view'
import { BUDGET, fits, measure } from '../ux/tree-data-table/budget'
import { resetWidths } from '../ux/tree-data-table/columns'
import { findRow, handleOf, layout, TOO_LARGE, TreeDataTable } from '../ux/tree-data-table/table'
import {
  buttonOf,
  footerOf,
  handlesOf,
  isNode,
  leaves,
  type Node,
  nodes,
  press,
  recorder,
  rowBoxes,
  texts,
  view,
} from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { COLS, row, section, webRows } from './fixtures/sections'

const draw = (sections: readonly SectionSpec[], over: Parameters<typeof view>[0] = {}) => {
  resetWidths()
  const rec = recorder()
  return { ...rec, drawn: TreeDataTable.render(sections, view(over), EL, rec.actions) }
}

/** `count` sections `s0`, `s1`, … of `rows` rows each, with ids that are unique across the sections. */
const many = (count: number, rows: number): SectionSpec[] =>
  Array.from({ length: count }, (_, i) =>
    section(
      `s${i}`,
      COLS,
      webRows(rows).map(r => ({ ...r, id: `s${i}-${r.id}` })),
    ),
  )

/** The section Boxes: every child of the root but the footer. */
const sectionBoxes = (tree: unknown): Node[] => (tree as Node).children.slice(0, -1) as Node[]

const longTitle = (i: number) => 't'.repeat(60 + (i % 3))

test('caps: 50 per section, 300 in all, in pane order; N more counts the top-level rows left (G4)', () => {
  const { drawn } = draw(many(7, 60))
  const boxes = sectionBoxes(drawn.tree)
  expect(boxes).toHaveLength(7)
  expect(boxes.map(b => rowBoxes(b).length)).toEqual([50, 50, 50, 50, 50, 50, 0])
  for (const i of [0, 1, 2, 3, 4, 5])
    expect(buttonOf(boxes[i], `m${i}`).props).toMatchObject({ label: '10 more', plain: true })
  const last = boxes[6] as Node
  expect(nodes(last, 'Button').map(b => b.props.key)).toEqual(['m6'])
  expect(buttonOf(last, 'm6').props.label).toBe('60 more')
  expect(leaves(last)).toEqual(['s6'])
  expect(drawn.handles.size).toBe(300)
})

test('shown adds a chunk and raises the total by the same', () => {
  const { drawn } = draw(many(7, 60), { shown: id => (id === 's0' ? 50 : 0) })
  const boxes = sectionBoxes(drawn.tree)
  expect(boxes.map(b => rowBoxes(b).length)).toEqual([60, 50, 50, 50, 50, 50, 40])
  expect(nodes(boxes[0], 'Button').some(b => String(b.props.key).startsWith('m'))).toBe(false)
  expect(buttonOf(boxes[6], 'm6').props.label).toBe('20 more')
  expect(drawn.handles.size).toBe(350)
})

test('the N more Button calls more with the section id', () => {
  const { drawn, calls } = draw(many(2, 60))
  press(buttonOf(drawn.tree, 'm1'))
  expect(calls).toEqual(['more:s1'])
})

test('the N more row is indented under the tree column', () => {
  const { drawn } = draw(many(1, 60))
  const more = nodes(drawn.tree, 'Box').find(b => b.children.some(c => isNode(c) && c.props.key === 'm0')) as Node
  // The gutter, the prio column (1 cell) and one gap: the tree column starts at 4.
  expect(more.props.paddingLeft).toBe(4)
})

test('a capped section with no row drawn does not show its empty text', () => {
  const sections = [...many(1, 300), section('late', COLS, webRows(2), { empty: 'Nothing.' })]
  const { drawn } = draw(sections, { limits: { sectionRows: 300, maxRows: 300 } })
  const late = sectionBoxes(drawn.tree)[1] as Node
  expect(leaves(late)).toEqual(['late'])
  expect(buttonOf(late, 'm1').props.label).toBe('2 more')
})

test('open children count against the budget, not the caps', () => {
  const kids = Array.from({ length: 80 }, (_, i) => row(`c${i}`, { key: `child${i}` }))
  const parent = row('p', { key: 'parent' }, { expandedByDefault: true, children: kids })
  const { drawn } = draw([section('web', COLS, [parent])])
  expect(rowBoxes(drawn.tree)).toHaveLength(81)
  expect(nodes(drawn.tree, 'Button').some(b => b.props.key === 'm0')).toBe(false)
})

test('budget at 600 rows: nothing is cut (spec 7)', () => {
  const sections = [section('web', COLS, webRows(600, longTitle))]
  const { drawn } = draw(sections, { bodyColumns: 96, limits: { sectionRows: 2000, maxRows: 2000 } })
  expect(drawn.handles.size).toBe(600)
  expect(fits(measure(drawn.tree), BUDGET)).toBe(true)
  expect(footerOf(drawn.tree)).toHaveLength(7)
})

test('budget at 1,400 rows: the guard cuts, the footer stays, every drawn row keeps its Button (spec 7)', () => {
  const sections = [section('web', COLS, webRows(1400, longTitle))]
  const { drawn } = draw(sections, { bodyColumns: 96, limits: { sectionRows: 2000, maxRows: 2000 } })
  expect(fits(measure(drawn.tree), BUDGET)).toBe(true)
  expect(drawn.handles.size).toBeLessThan(1400)
  expect(drawn.handles.size).toBeGreaterThan(0)
  expect(nodes(drawn.tree, 'Button').filter(b => b.props.key === 'm0')).toHaveLength(1)
  expect(footerOf(drawn.tree)).toHaveLength(7)
  const rows = rowBoxes(drawn.tree)
  expect(rows).toHaveLength(drawn.handles.size)
  for (const r of rows) expect(nodes(r, 'Button')).toHaveLength(1)
  expect(drawn.rows).toHaveLength(drawn.handles.size)
  expect(handlesOf(drawn.tree)).toEqual([...drawn.handles.keys()])
})

test('budget: detail lines go first', () => {
  const rows = Array.from({ length: 200 }, (_, i) => row(`a${i}`, { key: `k${i}`, title: 'x'.repeat(2000) }))
  const open = new Set(rows.map(r => r.id))
  const { drawn } = draw([section('web', COLS, rows)], { expanded: open, limits: { sectionRows: 300, maxRows: 300 } })
  expect(rowBoxes(drawn.tree)).toHaveLength(200)
  expect(nodes(drawn.tree, 'Box').filter(b => b.children.some(c => isNode(c) && c.props.wrap === 'wrap'))).toHaveLength(
    0,
  )
  expect(fits(measure(drawn.tree), BUDGET)).toBe(true)
})

test('budget: a halved drawing keeps no detail lines either', () => {
  const rows = Array.from({ length: 400 }, (_, i) => row(`a${i}`, { key: `k${i}`, title: 'x'.repeat(2000) }))
  const budget = { values: 3000, chars: 10_000_000 }
  const limits = { sectionRows: 400, maxRows: 400 }
  const { drawn } = draw([section('web', COLS, rows)], { expanded: new Set(rows.map(r => r.id)), budget, limits })
  expect(rowBoxes(drawn.tree)).toHaveLength(200)
  expect(nodes(drawn.tree, 'Box').filter(b => b.children.some(c => isNode(c) && c.props.wrap === 'wrap'))).toHaveLength(
    0,
  )
  expect(buttonOf(drawn.tree, 'm0').props.label).toBe('200 more')
})

test('budget: one too-large line when even one row per section does not fit', () => {
  const { drawn } = draw(many(3, 20), { budget: { values: 60, chars: 80000 } })
  expect(rowBoxes(drawn.tree)).toHaveLength(0)
  expect(drawn.handles.size).toBe(0)
  expect(drawn.rows).toEqual([])
  expect(texts(drawn.tree).filter(([p, s]) => s === TOO_LARGE && p.dimColor === true)).toHaveLength(1)
  expect(footerOf(drawn.tree)).toHaveLength(7)
  expect(TOO_LARGE).toBe('The pane is too large to draw. /track prints the list.')
})

test('budget: the caps halve step by step until the pane fits', () => {
  const sections = many(2, 40)
  const full = draw(sections, { budget: { values: 100000, chars: 800000 } })
  expect(full.drawn.handles.size).toBe(80)
  const tight = draw(sections, { budget: { values: 400, chars: 800000 } })
  expect(tight.drawn.handles.size).toBeGreaterThan(0)
  expect(tight.drawn.handles.size).toBeLessThan(80)
  expect(fits(measure(tight.drawn.tree), { values: 400, chars: 800000 })).toBe(true)
  const sectionsDrawn = sectionBoxes(tight.drawn.tree).map(b => rowBoxes(b).length)
  expect(sectionsDrawn[0]).toBe(sectionsDrawn[1])
  expect(buttonOf(tight.drawn.tree, 'm0').props.label).toBe(`${40 - (sectionsDrawn[0] ?? 0)} more`)
})

test('layout: handles run on across sections, open rows add their children, halve cuts the wants', () => {
  const kid = row('c', { key: 'kid' })
  const sections = [
    section('a', COLS, [row('p', { key: 'p' }, { expandedByDefault: true, children: [kid] }), row('q', { key: 'q' })]),
    section('b', COLS, webRows(5)),
  ]
  const laid = layout(sections, view())
  expect(laid.map(s => s.rows.map(r => `${r.handle}:${r.row.id}:${r.depth}`))).toEqual([
    ['r0:p:0', 'r1:c:1', 'r2:q:0'],
    ['r3:w0:0', 'r4:w1:0', 'r5:w2:0', 'r6:w3:0', 'r7:w4:0'],
  ])
  expect(laid.map(s => s.index)).toEqual([0, 1])
  const halved = layout(sections, view({ limits: { sectionRows: 4, maxRows: 300 } }), 1)
  expect(halved.map(s => s.rows.filter(r => r.depth === 0).length)).toEqual([2, 2])
  expect(halved.map(s => s.more)).toEqual([0, 3])
  const floor = layout(sections, view({ limits: { sectionRows: 4, maxRows: 300 } }), 5)
  expect(floor.map(s => s.rows.filter(r => r.depth === 0).length)).toEqual([1, 1])
})

test('handleOf gives the handle a row gets in the next drawing (Review Focus 4)', () => {
  const rows = [row('a', { key: 'a' }), row('b', { key: 'b' }), row('c', { key: 'c' })]
  const v = view()
  expect(handleOf([section('web', COLS, rows)], v, 'c')).toBe('r2')
  const next = [section('web', COLS, [rows[2] as TreeRow, rows[0] as TreeRow, rows[1] as TreeRow])]
  expect(handleOf(next, v, 'c')).toBe('r0')
  expect(handleOf(next, v, 'gone')).toBeUndefined()
  expect(handleOf(next, view({ limits: { sectionRows: 1, maxRows: 1 } }), 'a')).toBeUndefined()
})

test('findRow finds a hidden child of a closed row, with its section id and can', () => {
  const kid = row('c1', { key: 'kid' }, { can: { dismiss: true } })
  const sections = [
    section('web', COLS, [row('p', { key: 'p' }, { owner: 'web', children: [kid] })]),
    section('file', COLS, [row('f', { key: 'f' }, { owner: 'file', can: {} })]),
  ]
  expect(findRow(sections, 'c1')).toEqual({ id: 'c1', owner: 't', section: 'web', can: { dismiss: true } })
  expect(findRow(sections, 'f')).toEqual({ id: 'f', owner: 'file', section: 'file', can: {} })
  expect(findRow(sections, 'p')?.owner).toBe('web')
  expect(findRow(sections, 'gone')).toBeUndefined()
  expect(findRow(sections, null)).toBeUndefined()
})
