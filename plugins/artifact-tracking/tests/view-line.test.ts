// The view line (issue #63, L3): one line above the footer that says the view and the filters and holds the Buttons of `g`, `a`,
// `t`, `p` (issue #199) and `m` (issue #138). It sits in the same Box as the footer, so the window counts its rows and a docked pane pins it with the
// footer. Pure.
import { expect, test } from 'claude-code/testing'
import { footerKeys, KeyRegistry } from '../core/infra/keys'
import type { GroupSpec, RowRef } from '../core/interfaces/view'
import { KEYS as GITHUB_ROW_KEYS } from '../trackers/github/actions'
import { QUESTION_KEYS } from '../trackers/questions/actions'
import { resetWidths } from '../ux/tree-data-table/columns'
import { footerRows } from '../ux/tree-data-table/footer'
import { helpModel } from '../ux/tree-data-table/help'
import { TreeDataTable } from '../ux/tree-data-table/table'
import { viewLineRows } from '../ux/tree-data-table/viewline'
import {
  buttonOf,
  footerOf,
  handlesOf,
  LIVE_VIEW_KEYS,
  NO_ROW_FOOTER,
  type Node,
  nodes,
  press,
  recorder,
  rowBoxes,
  texts,
  view,
  viewLineOf,
} from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { group, webRows } from './fixtures/sections'

const KEYS = LIVE_VIEW_KEYS
const LINE = { text: 'View: list', keys: KEYS }
const INLINE = { bodyColumns: 96, bodyRows: 11, placement: 'inline' } as const
const DOCKED = { bodyColumns: 95, bodyRows: 31, placement: 'dock' } as const

const web = (n: number): GroupSpec[] => [group('web', webRows(n))]
const draw = (sections: readonly GroupSpec[], over: Parameters<typeof view>[0], recording = recorder()) => {
  resetWidths()
  return { ...recording, drawn: TreeDataTable.render(sections, view(over), EL, recording.actions) }
}
const root = (tree: unknown): Node => tree as Node
/** The hotkeys of every Button that has one, in tree order: the view line, then the footer. */
const hotkeys = (tree: unknown): string[] =>
  nodes(tree, 'Button')
    .filter(b => b.props.hotkey !== undefined)
    .map(b => String(b.props.hotkey))

test('viewLineRows: none without a line, one row where the words and the five keys fit, more where they wrap', () => {
  expect(viewLineRows(undefined, 96)).toBe(0)
  // `View: list` and `g: view`, `a: show all`, `t: touched`, `p: clean plan`, `m: mark`: 10 + 2 + 7 + 2 + 11 + 2 + 10 + 2 + 13 + 2 + 7 = 68
  // cells. Before issue #199 the line held four keys, `t` read `touched only` and it needed 58 cells.
  expect(viewLineRows(LINE, 96)).toBe(1)
  expect(viewLineRows(LINE, 68)).toBe(1)
  expect(viewLineRows(LINE, 67)).toBe(2)
  expect(viewLineRows(LINE, 58)).toBe(2) // a docked pane of 58 cells: `p: clean plan` takes the row that the line held at 58 before
  expect(viewLineRows(LINE, 49)).toBe(2) // a docked pane of 49 cells: `m` took the row that `g a t` still fitted in (issue #138)
  expect(viewLineRows(LINE, 40)).toBe(2)
  expect(viewLineRows(LINE, 24)).toBe(3)
})

test('viewLineRows with the count of the marked rows: the words grow but the line stays at one row at 96 cells', () => {
  const marked = { text: 'View: list · 3 marked', keys: KEYS }
  expect(viewLineRows(marked, 96)).toBe(1)
  expect(viewLineRows(marked, 49)).toBe(2)
  expect(viewLineRows(marked, 40)).toBe(3) // `p: clean plan` (issue #199) takes the row that the line held at 40 cells before
})

// Issue #199: the fifth key on the line must not take a row of the 11-row inline body for the words that the line says most often
// at 96 cells. `t` reads `touched` (owner decision Q5) for that reason: the words of the filtered view stay on one row.
test('viewLineRows: the words of a filtered view stay on one row at 96 cells with the five keys', () => {
  for (const text of [
    'View: list',
    'View: list · touched only · 3 hidden',
    'View: list · 3 marked',
    'View: status · 2 ended hidden',
    'View: flat · touched only · 12 hidden',
  ])
    expect(viewLineRows({ text, keys: KEYS }, 96), text).toBe(1)
})

// The cost of the fifth key, said out loud: the words of the touched filter with marked rows, or with `showing all`, are longer than
// the five samples above, and they take a second row at 96 cells. Nothing overflows: the window counts the line and shows one tree
// row less (issue #199).
test('viewLineRows: the touched filter with marks or with showing all takes two rows at 96 cells with the five keys', () => {
  for (const text of [
    'View: list · touched only · 3 hidden · 1 marked',
    'View: list · touched only · showing all',
    'View: list · touched only · 12 hidden · 3 marked',
  ])
    expect(viewLineRows({ text, keys: KEYS }, 96), text).toBe(2)
})

test('the question replaces the words: it takes one row at 96 cells, two at 49 and three at 40', () => {
  const asking = { text: 'Dismiss 3 marked rows? x again: yes', keys: KEYS }
  expect(viewLineRows(asking, 96)).toBe(1)
  expect(viewLineRows(asking, 49)).toBe(2)
  expect(viewLineRows(asking, 40)).toBe(3)
})

test('viewLineRows clips the words to the width, so a long summary takes one row and never more', () => {
  const long = { text: `View: status · touched only · 12 hidden · showing all ${'x'.repeat(80)}`, keys: KEYS }
  // The clipped words fill row one. The keys take 7, 11, 15 and 7 cells: `g`, `a` and `t` wrap to row two, and `m` to row three.
  expect(viewLineRows(long, 40)).toBe(3)
  expect(viewLineRows({ text: '', keys: [] }, 40)).toBe(1) // the words are one item, empty or not
})

test('the view line sits between the rows and the footer, in the Box of the footer: its words, then g, a, t, p and m', () => {
  const { drawn } = draw(web(3), { ...INLINE, viewLine: LINE })
  const bottom = root(drawn.tree).children.at(-1) as Node
  expect(texts(bottom).map(([, s]) => s)).toContain('View: list')
  expect(hotkeys(bottom)).toEqual(['g', 'a', 't', 'p', 'm', 'r', 'h', 'x', '1', '2', '3', '0'])
  expect(hotkeys(drawn.tree)).toEqual(hotkeys(bottom)) // no other Button has a hotkey
  expect(footerOf(drawn.tree).map(b => b.props.hotkey)).toEqual(NO_ROW_FOOTER.map(k => k.key)) // the footer is its own keys
  expect(viewLineOf(drawn.tree).map(b => b.props.hotkey)).toEqual(['g', 'a', 't', 'p', 'm'])
  // The rows come before it in tab order: the line is a stop after the last row and before the footer.
  const order = nodes(drawn.tree, 'Button').map(b => String(b.props.key))
  expect(order.indexOf('view')).toBeGreaterThan(order.indexOf(handlesOf(drawn.tree).at(-1) as string))
  expect(order.indexOf('view')).toBeLessThan(order.indexOf('refresh'))
})

test('a pane with no view line draws the footer as it did', () => {
  const { drawn } = draw(web(3), INLINE)
  expect(hotkeys(drawn.tree)).toEqual(NO_ROW_FOOTER.map(k => k.key))
  expect(root(drawn.tree).children.at(-1)).toMatchObject({ props: { columnGap: 2, flexWrap: 'wrap' } })
})

test('the window counts the view line: inline 100x40 shows one row less, and the tree is as tall as the body', () => {
  const plain = draw(web(12), INLINE).drawn.tree
  const lined = draw(web(12), { ...INLINE, viewLine: LINE }).drawn.tree
  expect(rowBoxes(plain)).toHaveLength(6)
  expect(rowBoxes(lined)).toHaveLength(5)
  // The title, the header, the rows, the hint below, the gap, the view line and the footer: 11 rows.
  expect(rowBoxes(lined).length + 2 + 1 + 1 + 1 + 1).toBe(INLINE.bodyRows)
})

test('m on the view line adds no footer row at 96 cells: an item, a question and a GitHub row keep the rows they had (issue #138)', () => {
  const reg = new KeyRegistry()
  reg.add('github', GITHUB_ROW_KEYS)
  reg.add('questions', QUESTION_KEYS)
  const rowOf = (owner: string): RowRef => ({ id: 'r', owner, group: 'g', can: { dismiss: true, priority: true } })
  const rows = (owner: string) =>
    footerRows(
      footerKeys(reg, rowOf(owner), o => o === 'web', false),
      96,
      false,
    )
  expect([rows('web'), rows('questions'), rows('github')]).toEqual([1, 1, 2])
  expect(footerKeys(reg, rowOf('web'), o => o === 'web', false).some(k => k.key === 'm')).toBe(false)
})

test('three marks and the question change no row of the window at 96 cells: inline 100x40 keeps 5 of 12 rows and the footer last', () => {
  const rowsWith = (text: string) => {
    const { drawn } = draw(web(12), { ...INLINE, viewLine: { text, keys: KEYS } })
    expect((root(drawn.tree).children.at(-1) as Node).props).toMatchObject({ flexDirection: 'column' })
    return rowBoxes(drawn.tree).length
  }
  expect(rowsWith('View: list')).toBe(5)
  expect(rowsWith('View: list · 3 marked')).toBe(5)
  expect(rowsWith('Dismiss 3 marked rows? x again: yes')).toBe(5)
})

test('the window counts the rows of a view line that wraps', () => {
  const narrow = { bodyColumns: 40, bodyRows: 14, placement: 'dock' } as const
  const lined = draw(web(40), { ...narrow, viewLine: LINE }).drawn.tree
  const rowsOf = viewLineRows(LINE, 40)
  expect(rowsOf).toBe(2)
  // The title, the header, the hint below, the gap, the view line and the footer, and the rows between: the body, no more.
  expect(rowBoxes(lined).length + 2 + 1 + 1 + rowsOf + footerRows(NO_ROW_FOOTER, 40, false)).toBe(narrow.bodyRows)
})

test('docked: the view line is pinned with the footer, at the bottom of the body', () => {
  const { drawn } = draw(web(3), { ...DOCKED, viewLine: LINE })
  const pinned = root(drawn.tree).children.at(-1) as Node
  expect(pinned.props).toMatchObject({ flexGrow: 1, flexShrink: 0, justifyContent: 'flex-end' })
  expect(hotkeys(pinned)).toEqual(['g', 'a', 't', 'p', 'm', 'r', 'h', 'x', '1', '2', '3', '0'])
  expect(root(drawn.tree).props.minHeight).toBe(DOCKED.bodyRows)
})

test('a press on a view line Button is a press of its key; a dim one only asks for the keys', () => {
  const live = draw(web(2), { ...INLINE, viewLine: LINE })
  press(buttonOf(live.drawn.tree, 'view'))
  press(buttonOf(live.drawn.tree, 'show-all'))
  press(buttonOf(live.drawn.tree, 'touched'))
  press(buttonOf(live.drawn.tree, 'mark'))
  expect(live.calls).toEqual(['press:view', 'press:show-all', 'press:touched', 'press:mark'])
  const dim = draw(web(2), { ...INLINE, viewLine: { ...LINE, keys: KEYS.map(k => ({ ...k, enabled: false })) } })
  const g = buttonOf(dim.drawn.tree, 'view')
  expect(g.props.dimColor).toBe(true)
  press(g)
  expect(dim.calls).toEqual([])
  expect(dim.asks.count).toBe(1)
})

test('the Buttons carry the key, the label and the hotkey of the registry', () => {
  const { drawn } = draw(web(2), { ...INLINE, viewLine: LINE })
  expect(
    ['view', 'show-all', 'touched', 'clean', 'mark'].map(k => {
      const b = buttonOf(drawn.tree, k)
      return [b.props.hotkey, b.props.label, b.props.plain]
    }),
  ).toEqual([
    ['g', 'view', true],
    ['a', 'show all', true],
    ['t', 'touched', true],
    ['p', 'clean plan', true],
    ['m', 'mark', true],
  ])
})

// Issue #200: the help view has no view line, so its footer holds the five keys as dim Buttons, and each hotkey has one Button:
// a second one (the view line of the view, if the help view drew it) would win in silence and the dim one would take the press.
test('the help view draws no view line: its footer holds the five keys as dim Buttons, once, and its rows are counted for the compact form', () => {
  const reg = new KeyRegistry()
  const help = helpModel(reg.all(), [], undefined, [])
  const footer = footerKeys(reg, undefined, () => false, true)
  const { drawn } = draw(web(2), { ...INLINE, help, footer, viewLine: LINE })
  expect(hotkeys(drawn.tree)).toEqual(footer.map(k => k.key)) // the footer, in order, and no Button of the view line on top
  expect(hotkeys(drawn.tree)).toEqual(['r', 'h', 'x', '1', '2', '3', '0', 'g', 'a', 't', 'p', 'm'])
  expect(texts(drawn.tree).some(([, s]) => s.startsWith('View:'))).toBe(false)
  const footerBox = (drawn.tree as unknown as Node).children.at(-1) as Node
  expect(
    nodes(footerBox, 'Button')
      .filter(b => b.props.dimColor === true)
      .map(b => b.props.hotkey),
  ).toEqual(['x', '1', '2', '3', '0', 'g', 'a', 't', 'p', 'm'])
})
