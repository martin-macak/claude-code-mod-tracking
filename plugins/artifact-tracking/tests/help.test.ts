// The help view: the model, the plain text for `/track help` and the drawn elements. Pure.
// Plan: L6 Task 7 (G14, G15, G16).
import { expect, test } from 'claude-code/testing'
import { CORE_KEYS } from '../core/infra/keys'
import type { PaneKey } from '../core/interfaces/view'
import { compactHelp, helpModel, helpRows, helpText, renderHelp } from '../ux/tree-data-table/help'
import { leaves } from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { COLS, row, section } from './fixtures/sections'

const PATH = '/h/.config/claude-code/mods/tracker/config.json'
const open: PaneKey = { id: 'open', key: 'o', label: 'open', scope: 'row', owner: 'github' }

/** A drawn node of the plain-data element table. */
interface Node {
  type: string
  props: Record<string, unknown>
  children: unknown[]
}
const nodes = (list: readonly unknown[]) => list as Node[]

test('helpModel groups core keys into pane and row keys, then tracker keys under their section titles', () => {
  const sections = [
    section('prs', COLS, [row('p1', {}, { owner: 'github' })], { title: 'Pull requests' }),
    section('github', COLS, [row('g1', {}, { owner: 'github' })], { title: 'GitHub' }),
    section('web', COLS, [row('w1', {}, { owner: 'web' })], { title: 'Web links' }),
  ]
  const m = helpModel([...CORE_KEYS, open], sections, PATH, [])
  expect(m.groups.map(g => g.title)).toEqual([
    'Pane keys',
    'Row keys (act on the selected row)',
    'Pull requests, GitHub',
  ])
  expect(m.groups[0]?.keys.map(k => k.key)).toEqual(['r', 'h'])
  expect(m.groups[1]?.keys.map(k => k.key)).toEqual(['x', '1', '2', '3', '0'])
  expect(m.groups[2]?.keys).toEqual([open])
  expect(m.configPath).toBe(PATH)
  expect(m.problems).toEqual([])
})

test('helpModel titles a tracker group by its owner id when the owner draws no section', () => {
  const m = helpModel(
    [...CORE_KEYS, { ...open, owner: 'quiet' }],
    [section('web', COLS, [row('w1', {})])],
    undefined,
    [],
  )
  expect(m.groups.at(-1)?.title).toBe('quiet')
})

test('helpModel finds the owner of a nested row and groups one owner once', () => {
  const nested = row('top', {}, { owner: 'jira', children: [row('kid', {}, { owner: 'github' })] })
  const second: PaneKey = { ...open, id: 'copy', key: 'c' }
  const m = helpModel(
    [...CORE_KEYS, open, second],
    [section('jira', COLS, [nested], { title: 'Jira work items' })],
    PATH,
    [],
  )
  expect(m.groups.map(g => g.title)).toEqual(['Pane keys', 'Row keys (act on the selected row)', 'Jira work items'])
  expect(m.groups[2]?.keys.map(k => k.id)).toEqual(['open', 'copy'])
})

test('helpModel leaves out a group with no keys', () => {
  const m = helpModel(
    CORE_KEYS.filter(k => k.scope === 'pane'),
    [],
    PATH,
    [],
  )
  expect(m.groups.map(g => g.title)).toEqual(['Pane keys'])
})

test('helpText prints the groups, the config path and the problems', () => {
  const m = helpModel(CORE_KEYS, [], PATH, ['A.'])
  expect(helpText(m)).toBe(
    'Pane keys\n  r  refresh\n  h  help\nRow keys (act on the selected row)\n  x  dismiss\n  1  high\n  2  normal\n  3  low\n  0  auto\nConfig file: /h/.config/claude-code/mods/tracker/config.json\nProblems\n  A.',
  )
})

test('helpText with no path and no problem', () => {
  const text = helpText(helpModel(CORE_KEYS, [], undefined, []))
  expect(text.endsWith('Config file: none, the defaults apply')).toBe(true)
  expect(text).not.toContain('Problems')
})

test('renderHelp draws bold group titles and one row per key', () => {
  const drawn = nodes(renderHelp(EL, helpModel(CORE_KEYS, [], PATH, [])))
  expect(drawn[0]).toEqual({ type: 'Text', props: { weight: 'bold' }, children: ['Pane keys'] })
  const keyRows = drawn.filter(n => n.type === 'Box')
  expect(keyRows).toHaveLength(7)
  expect(keyRows[0]?.props).toEqual({ paddingLeft: 2, columnGap: 2 })
  expect(keyRows[0]?.children).toEqual([
    { type: 'Text', props: {}, children: ['r'] },
    { type: 'Text', props: {}, children: ['refresh'] },
  ])
})

test('renderHelp draws the config line and, only with problems, a bold title and one wrapped Text per problem', () => {
  const plain = nodes(renderHelp(EL, helpModel(CORE_KEYS, [], PATH, [])))
  expect(plain.at(-1)).toEqual({ type: 'Text', props: {}, children: [`Config file: ${PATH}`] })
  expect(JSON.stringify(plain)).not.toContain('Problems')

  const bad = nodes(renderHelp(EL, helpModel(CORE_KEYS, [], undefined, ['A.', 'B.'])))
  expect(bad.at(-4)).toEqual({ type: 'Text', props: {}, children: ['Config file: none, the defaults apply'] })
  expect(bad.at(-3)).toEqual({ type: 'Text', props: { weight: 'bold' }, children: ['Problems'] })
  expect(bad.slice(-2)).toEqual([
    { type: 'Text', props: { wrap: 'wrap' }, children: ['A.'] },
    { type: 'Text', props: { wrap: 'wrap' }, children: ['B.'] },
  ])
})

test('the drawn help and the printed help list the same lines', () => {
  const m = helpModel(
    [...CORE_KEYS, open],
    [section('github', COLS, [row('g', {}, { owner: 'github' })], { title: 'GitHub' })],
    PATH,
    ['P.'],
  )
  const drawn = nodes(renderHelp(EL, m)).map(n =>
    n.type === 'Box' ? `  ${n.children.map(c => (c as Node).children[0]).join('  ')}` : String(n.children[0]),
  )
  const printed = helpText(m)
    .split('\n')
    .map(line => (line === '  P.' ? 'P.' : line))
  expect(drawn).toEqual(printed)
})

// ---------------------------------------------------------------- the compact form (issue #92)

/** One string per drawn line: a Text is one line, a Box is one line of its cells. */
const linesOf = (list: readonly unknown[]) => nodes(list).map(n => leaves(n).join('  '))

test('renderHelp draws the full form unless the caller asks for the compact one', () => {
  const m = helpModel(CORE_KEYS, [], PATH, [])
  expect(renderHelp(EL, m, false)).toEqual(renderHelp(EL, m))
  expect(renderHelp(EL, m)).toHaveLength(10) // 2 titles, 7 keys, the config line. #65 adds a version line: 11
})

test('renderHelp compact puts two keys on a line and keeps every title and the config line', () => {
  const lines = linesOf(renderHelp(EL, helpModel(CORE_KEYS, [], PATH, []), true))
  expect(lines).toEqual([
    'Pane keys',
    'r  refresh  h  help',
    'Row keys (act on the selected row)',
    'x  dismiss  1  high',
    '2  normal  3  low',
    '0  auto',
    `Config file: ${PATH}`,
  ])
})

test('renderHelp compact lines up the second key of every line on one column', () => {
  const drawn = nodes(
    renderHelp(EL, helpModel([...CORE_KEYS, { ...open, label: 'open in the browser' }], [], PATH, []), true),
  )
  const pairs = drawn.filter(n => n.type === 'Box')
  expect(pairs[0]?.props).toEqual({ paddingLeft: 2, columnGap: 2 })
  const firsts = pairs.map(p => (p.children[0] as Node).props.width)
  expect(new Set(firsts)).toEqual(new Set(['o  open in the browser'.length]))
  expect(pairs.every(p => (p.children[0] as Node).type === 'Box')).toBe(true)
})

test('renderHelp compact keeps the problems as wrapped Texts under their bold title', () => {
  const bad = nodes(renderHelp(EL, helpModel(CORE_KEYS, [], undefined, ['A.', 'B.']), true))
  expect(bad.at(-3)).toEqual({ type: 'Text', props: { weight: 'bold' }, children: ['Problems'] })
  expect(bad.slice(-2)).toEqual([
    { type: 'Text', props: { wrap: 'wrap' }, children: ['A.'] },
    { type: 'Text', props: { wrap: 'wrap' }, children: ['B.'] },
  ])
})

test('the compact form lists the same keys in the same order as the printed help', () => {
  const m = helpModel([...CORE_KEYS, open], [], PATH, [])
  const cells = nodes(renderHelp(EL, m, true))
    .filter(n => n.type === 'Box')
    .flatMap(pair => pair.children.map(c => leaves(c).join('')))
  expect(cells).toEqual(
    helpText(m)
      .split('\n')
      .filter(l => l.startsWith('  '))
      .map(l => l.trim()),
  )
})

test('helpRows counts the lines of the full form: titles, keys, the config line and the problems', () => {
  expect(helpRows(helpModel(CORE_KEYS, [], PATH, []), 96)).toBe(10)
  expect(helpRows(helpModel(CORE_KEYS, [], undefined, ['A.', 'B.']), 96)).toBe(13) // + a title and one line each
})

test('helpRows equals the drawn full form when nothing wraps, so a new help line counts with no edit to helpRows', () => {
  const models = [
    helpModel(CORE_KEYS, [], PATH, []),
    helpModel(CORE_KEYS, [], PATH, ['A.', 'B.']),
    helpModel(CORE_KEYS, [], undefined, ['A.']),
    helpModel([...CORE_KEYS, open], [], PATH, []),
  ]
  for (const m of models) {
    expect(helpRows(m, 999)).toBe(renderHelp(EL, m).length)
    expect(helpRows(m, 999)).toBe(helpText(m).split('\n').length) // helpRows reads the lines helpText prints
  }
})

test('helpRows counts a config line or a problem that wraps at the body width', () => {
  const m = helpModel(CORE_KEYS, [], PATH, ['x'.repeat(70)])
  // `Config file: <PATH>` is 61 cells: the path moves to its own row, then breaks. The problem breaks at 30 cells.
  // The group title `Row keys (act on the selected row)` is 34 cells, so at 30 columns it takes two rows.
  expect(helpRows(m, 30)).toBe(10 + 3 + 1 + 3)
  expect(helpRows(m, 96)).toBe(9 + 1 + 1 + 1)
})

test('helpRows wraps at spaces: a path that fills a row takes its own row, and a long one breaks after that', () => {
  const live = '/var/folders/sn/0_q8tr7x4vv44d69rbtyckwr0000gn/T/cc-tracker-config-SAq3DF/config.json' // 86 cells
  expect(helpRows(helpModel(CORE_KEYS, [], live, []), 96)).toBe(9 + 2) // the live 100x40 screen: 13 rows with the gap and the footer
  expect(helpRows(helpModel(CORE_KEYS, [], 'p'.repeat(100), []), 96)).toBe(9 + 3) // `Config file:`, 96 cells, 4 cells
  // `Config file: c` is 14 cells. At 14 columns the 34-cell group title takes three rows: `Row keys (act`, `on the`, `selected row)`.
  expect(helpRows(helpModel(CORE_KEYS, [], 'c', ['aaa bbb ccc ddd']), 14)).toBe(11 + 1 + 1 + 2)
})

test('compactHelp: the full form needs its lines, the gap and the footer; a body that gives no height keeps it', () => {
  const m = helpModel(CORE_KEYS, [], PATH, [])
  expect(compactHelp(m, 1, 96, undefined)).toBe(false)
  expect(compactHelp(m, 1, 96, 12)).toBe(false) // 10 + 1 + 1
  expect(compactHelp(m, 1, 96, 11)).toBe(true)
  expect(compactHelp(m, 2, 96, 12)).toBe(true) // a footer that wraps takes one more
})
