// The view line (issue #63, L3): one line above the footer that says the view and the filters and holds the Buttons of `g`, `a`,
// `t`, `p` (issue #199), `m` (issue #138) and `e` (issue #276). It sits in the same Box as the footer, so the window counts its rows and a docked pane pins it with the
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

test('viewLineRows: none without a line, one row where the words and the six keys fit, more where they wrap', () => {
  expect(viewLineRows(undefined, 96)).toBe(0)
  // `View: list` and `g: view`, `a: show all`, `t: touched`, `p: clean plan`, `m: mark`, `e: quick view`:
  // 10 + 2 + 7 + 2 + 11 + 2 + 10 + 2 + 13 + 2 + 7 + 2 + 13 = 83 cells. Before issue #276 the line held five keys and needed 68 cells.
  expect(viewLineRows(LINE, 96)).toBe(1)
  expect(viewLineRows(LINE, 83)).toBe(1)
  expect(viewLineRows(LINE, 82)).toBe(2)
  expect(viewLineRows(LINE, 49)).toBe(2) // a docked pane of 49 cells: `View: list g a t` fill row one, `p m e` the second (issues #138, #199 and #276)
  expect(viewLineRows(LINE, 40)).toBe(3) // `View: list g a`, then `t p m`, then `e`: the sixth key takes the row that two rows held before
  expect(viewLineRows(LINE, 24)).toBe(4)
})

test('viewLineRows with the count of the marked rows: the words grow but the line stays at one row at 96 cells and two at 49', () => {
  const marked = { text: 'View: list · 3 marked', keys: KEYS }
  expect(viewLineRows(marked, 96)).toBe(1)
  expect(viewLineRows(marked, 49)).toBe(2)
  expect(viewLineRows(marked, 40)).toBe(3) // the words and `g`, then `a`, `t` and `p`, then `m` and `e`
})

// Issue #199: the fifth key on the line must not take a row of the 11-row inline body for the words that the line says most often at
// 96 cells. `e` (issue #276) is the sixth key: the six keys take 61 cells and the six gaps 12, so the words keep one row up to 23 cells.
// The normal words of the view, alone and with a count of the marked rows, are that short.
test('viewLineRows: the normal words of a view stay on one row at 96 cells with the six keys', () => {
  for (const text of ['View: list', 'View: list · 3 marked', 'View: list · 12 marked', 'View: status · 3 marked'])
    expect(viewLineRows({ text, keys: KEYS }, 96), text).toBe(1)
  expect(viewLineRows({ text: 'x'.repeat(23), keys: KEYS }, 96)).toBe(1)
  expect(viewLineRows({ text: 'x'.repeat(24), keys: KEYS }, 96)).toBe(2)
})

// The cost of the sixth key, said out loud: the words of the touched filter (`touched only` is 12 cells) and of a view with its ended
// rows hidden are longer than 23 cells, so they take a second row at 96 cells. The five keys left them 38 cells (`p` of issue #199
// landed first, and this PR pins what `e` adds). Nothing overflows: the window counts the line and shows one tree row less.
test('viewLineRows: the touched filter and the ended rows hidden take two rows at 96 cells with the six keys', () => {
  for (const text of [
    'View: list · touched only',
    'View: list · touched only · 3 hidden',
    'View: list · touched only · showing all',
    'View: list · touched only · 3 hidden · 1 marked',
    'View: list · touched only · 12 hidden · 3 marked',
    'View: status · 2 ended hidden',
    'View: flat · touched only · 12 hidden',
  ])
    expect(viewLineRows({ text, keys: KEYS }, 96), text).toBe(2)
})

// `e` (issue #276) is the sixth key of the line: the question of a bulk dismiss, 35 cells with a count of one digit, no longer fits one
// row with the six keys at 96 cells: the keys take 61 cells and the six gaps 12, so the line takes 108 cells, 12 over (98 and 2 over with
// the five keys of `main` before `e`). The question stands only until the next press, and the window counts the row it takes, so the tree stays as tall as the body. The owner kept the
// text of the question and accepted the second row (check-in of 2026-10-27 on PR #284): a shorter copy would change the tests of
// `marks.test.ts`, `pane.test.tsx` and the live scenario of `pane.feature`. Owner decision Q2a measured the line with its normal words
// (`View: list · 2 marked`).
test('the question replaces the words: it takes two rows at 96 cells, three at 49 and at 40', () => {
  const asking = { text: 'Dismiss 3 marked rows? x again: yes', keys: KEYS }
  expect(asking.text.length).toBe(35)
  expect(viewLineRows(asking, 108)).toBe(1) // 35 + 61 + 6 * 2
  expect(viewLineRows(asking, 107)).toBe(2)
  expect(viewLineRows(asking, 96)).toBe(2)
  expect(viewLineRows(asking, 49)).toBe(3)
  expect(viewLineRows(asking, 40)).toBe(3)
})

// The same limit holds for the other long words: the touched-only filter with a count of the rows it hid. `View: list · touched only ·
// 3 hidden` is 36 cells, `View: status · touched only · 3 hidden` 38 (issue #276, review of PR #284, m3). The README says it.
test('the touched-only filter with a count of hidden rows takes a second row at 96 cells and a third at 49', () => {
  for (const words of ['View: list · touched only · 3 hidden', 'View: status · touched only · 3 hidden']) {
    const hidden = { text: words, keys: KEYS }
    expect(viewLineRows(hidden, 96), words).toBe(2)
    expect(viewLineRows(hidden, 49), words).toBe(3)
  }
  // `touched only` alone is 25 cells, 2 over what the six keys leave the words (23): it takes the second row too, as a count of marked
  // rows after it does. `View: list` and `View: list · 3 marked` keep their row (the test above).
  expect(viewLineRows({ text: 'View: list · touched only', keys: KEYS }, 96)).toBe(2)
  expect(viewLineRows({ text: 'View: list · touched only · 3 marked', keys: KEYS }, 96)).toBe(2)
})

test('viewLineRows clips the words to the width, so a long summary takes one row and never more', () => {
  const long = { text: `View: status · touched only · 12 hidden · showing all ${'x'.repeat(80)}`, keys: KEYS }
  // The clipped words fill row one. The keys take 7, 11, 10, 13, 7 and 13 cells: `g`, `a` and `t` wrap to row two (32 cells), `p`, `m`
  // and `e` to row three (37 cells).
  expect(viewLineRows(long, 40)).toBe(3)
  expect(viewLineRows({ text: '', keys: [] }, 40)).toBe(1) // the words are one item, empty or not
})

test('the view line sits between the rows and the footer, in the Box of the footer: its words, then g, a, t, p, m and e', () => {
  const { drawn } = draw(web(3), { ...INLINE, viewLine: LINE })
  const bottom = root(drawn.tree).children.at(-1) as Node
  expect(texts(bottom).map(([, s]) => s)).toContain('View: list')
  expect(hotkeys(bottom)).toEqual(['g', 'a', 't', 'p', 'm', 'e', 'r', 'h', 'x', '1', '2', '3', '0'])
  expect(hotkeys(drawn.tree)).toEqual(hotkeys(bottom)) // no other Button has a hotkey
  expect(footerOf(drawn.tree).map(b => b.props.hotkey)).toEqual(NO_ROW_FOOTER.map(k => k.key)) // the footer is its own keys
  expect(viewLineOf(drawn.tree).map(b => b.props.hotkey)).toEqual(['g', 'a', 't', 'p', 'm', 'e'])
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

test('three marks change no row of the window at 96 cells, and the question or the words of a filter that wrap take one: inline 100x40 keeps 5 of 12 rows, then 4', () => {
  const rowsWith = (text: string) => {
    const { drawn } = draw(web(12), { ...INLINE, viewLine: { text, keys: KEYS } })
    expect((root(drawn.tree).children.at(-1) as Node).props).toMatchObject({ flexDirection: 'column' })
    return rowBoxes(drawn.tree).length
  }
  expect(rowsWith('View: list')).toBe(5)
  expect(rowsWith('View: list · 3 marked')).toBe(5)
  expect(rowsWith('Dismiss 3 marked rows? x again: yes')).toBe(4) // the six keys no longer fit its row (issue #276): the window counts the second
  // The same for the words that the six keys leave no room for (23 cells at 96): the `t` filter and the ended rows of another view.
  expect(rowsWith('View: list · touched only')).toBe(4)
  expect(rowsWith('View: status · 2 ended hidden')).toBe(4)
})

test('the window counts the rows of a view line that wraps', () => {
  const narrow = { bodyColumns: 40, bodyRows: 14, placement: 'dock' } as const
  const lined = draw(web(40), { ...narrow, viewLine: LINE }).drawn.tree
  const rowsOf = viewLineRows(LINE, 40)
  expect(rowsOf).toBe(3)
  // The title, the header, the hint below, the gap, the view line and the footer, and the rows between: the body, no more.
  expect(rowBoxes(lined).length + 2 + 1 + 1 + rowsOf + footerRows(NO_ROW_FOOTER, 40, false)).toBe(narrow.bodyRows)
})

test('docked: the view line is pinned with the footer, at the bottom of the body', () => {
  const { drawn } = draw(web(3), { ...DOCKED, viewLine: LINE })
  const pinned = root(drawn.tree).children.at(-1) as Node
  expect(pinned.props).toMatchObject({ flexGrow: 1, flexShrink: 0, justifyContent: 'flex-end' })
  expect(hotkeys(pinned)).toEqual(['g', 'a', 't', 'p', 'm', 'e', 'r', 'h', 'x', '1', '2', '3', '0'])
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
    ['view', 'show-all', 'touched', 'clean', 'mark', 'quick'].map(k => {
      const b = buttonOf(drawn.tree, k)
      return [b.props.hotkey, b.props.label, b.props.plain]
    }),
  ).toEqual([
    ['g', 'view', true],
    ['a', 'show all', true],
    ['t', 'touched', true],
    ['p', 'clean plan', true],
    ['m', 'mark', true],
    ['e', 'quick view', true],
  ])
})

// Issue #200: the help view has no view line, so its footer holds the six keys (`p` of issue #199 and `e` of issue #276 with them) as
// dim Buttons, and each hotkey has one Button: a second one (the view line of the view, if the help view drew it) would win in
// silence and the dim one would take the press.
test('the help view draws no view line: its footer holds the six keys as dim Buttons, once, and its rows are counted for the compact form', () => {
  const reg = new KeyRegistry()
  const help = helpModel(reg.all(), [], undefined, [])
  const footer = footerKeys(reg, undefined, () => false, true)
  const { drawn } = draw(web(2), { ...INLINE, help, footer, viewLine: LINE })
  expect(hotkeys(drawn.tree)).toEqual(footer.map(k => k.key)) // the footer, in order, and no Button of the view line on top
  expect(hotkeys(drawn.tree)).toEqual(['r', 'h', 'x', '1', '2', '3', '0', 'g', 'a', 't', 'p', 'm', 'e'])
  expect(texts(drawn.tree).some(([, s]) => s.startsWith('View:'))).toBe(false)
  const footerBox = (drawn.tree as unknown as Node).children.at(-1) as Node
  expect(
    nodes(footerBox, 'Button')
      .filter(b => b.props.dimColor === true)
      .map(b => b.props.hotkey),
  ).toEqual(['x', '1', '2', '3', '0', 'g', 'a', 't', 'p', 'm', 'e'])
})
