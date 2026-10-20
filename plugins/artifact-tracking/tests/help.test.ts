// The help view: the model, the plain text for `/track help` and the drawn elements. Pure.
// Plan: L6 Task 7 (G14, G15, G16).
import { expect, test } from 'claude-code/testing'
import { CORE_KEYS } from '../core/infra/keys'
import type { PaneKey } from '../core/interfaces/view'
import { KEYS as GITHUB_ROW_KEYS } from '../trackers/github/actions'
import { compactHelp, helpModel, helpRows, helpText, renderHelp } from '../ux/tree-data-table/help'
import { leaves } from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { COLS, row, section } from './fixtures/sections'

const PATH = '/h/.config/claude-code/mods/tracker/config.json'
// The first title names the keys that move between rows. They are no footer keys (issue #108).
const PANE_KEYS = 'Pane keys (Tab, Shift+Tab, Up, Down move between rows)'
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
  expect(m.groups.map(g => g.title)).toEqual([PANE_KEYS, 'Row keys (act on the selected row)', 'Pull requests, GitHub'])
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
  expect(m.groups.map(g => g.title)).toEqual([PANE_KEYS, 'Row keys (act on the selected row)', 'Jira work items'])
  expect(m.groups[2]?.keys.map(k => k.id)).toEqual(['open', 'copy'])
})

test('helpModel leaves out a group with no keys', () => {
  const m = helpModel(
    CORE_KEYS.filter(k => k.scope === 'pane'),
    [],
    PATH,
    [],
  )
  expect(m.groups.map(g => g.title)).toEqual([PANE_KEYS])
})

test('helpText prints the groups, the config path and the problems', () => {
  const m = helpModel(CORE_KEYS, [], PATH, ['A.'])
  expect(helpText(m)).toBe(
    `${PANE_KEYS}\n  r  refresh\n  h  help\nRow keys (act on the selected row)\n  x  dismiss\n  1  high\n  2  normal\n  3  low\n  0  auto\nConfig file: /h/.config/claude-code/mods/tracker/config.json\nProblems\n  A.`,
  )
})

// Issue #108, option 1: Tab, Shift+Tab and the arrows are no footer keys, so the title of the pane keys names them. The
// title is a line the help view had already, and it must not wrap in the 96-cell body of an inline pane.
test('the first title names Tab, Shift+Tab and the arrows, on one row of an inline body', () => {
  const m = helpModel(CORE_KEYS, [], PATH, [])
  expect(m.groups[0]?.title).toBe(PANE_KEYS)
  for (const key of ['Tab', 'Shift+Tab', 'Up', 'Down']) expect(PANE_KEYS).toContain(key)
  expect(helpText(m).split('\n')[0]).toBe(PANE_KEYS)
  expect(helpRows(m, 96)).toBe(helpText(m).split('\n').length) // nothing wraps at 96 cells
})

test('helpText with no path and no problem', () => {
  const text = helpText(helpModel(CORE_KEYS, [], undefined, []))
  expect(text.endsWith('Config file: none, the defaults apply')).toBe(true)
  expect(text).not.toContain('Problems')
})

test('renderHelp draws bold group titles and one row per key', () => {
  const drawn = nodes(renderHelp(EL, helpModel(CORE_KEYS, [], PATH, [])))
  expect(drawn[0]).toEqual({ type: 'Text', props: { weight: 'bold' }, children: [PANE_KEYS] })
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
  const m = helpModel(CORE_KEYS, [], PATH, [], '1.2.3')
  expect(renderHelp(EL, m, false)).toEqual(renderHelp(EL, m))
  expect(renderHelp(EL, m)).toHaveLength(11) // 2 titles, 7 keys, the config line, the version line
  expect(renderHelp(EL, helpModel(CORE_KEYS, [], PATH, []))).toHaveLength(10) // no version yet: no line
})

test('renderHelp compact puts three keys on a line and keeps every title and the config line', () => {
  const lines = linesOf(renderHelp(EL, helpModel(CORE_KEYS, [], PATH, []), true))
  expect(lines).toEqual([
    PANE_KEYS,
    'r  refresh  h  help',
    'Row keys (act on the selected row)',
    'x  dismiss  1  high  2  normal',
    '3  low  0  auto',
    `Config file: ${PATH}`,
  ])
})

test('renderHelp compact lines up the first two keys of every line on their columns', () => {
  const drawn = nodes(
    renderHelp(EL, helpModel([...CORE_KEYS, { ...open, label: 'open in the browser' }], [], PATH, []), true),
  )
  const lines = drawn.filter(n => n.type === 'Box')
  expect(lines[0]?.props).toEqual({ paddingLeft: 2, columnGap: 2 })
  const widest = 'o  open in the browser'.length
  // The keys of the first two columns sit in a Box of the widest key text, so the second and the third key start in
  // the same cell on every line. The third key is the last of its line and needs no width.
  for (const line of lines) {
    for (const cell of line.children.slice(0, 2)) {
      expect((cell as Node).type).toBe('Box')
      expect((cell as Node).props.width).toBe(widest)
    }
    for (const cell of line.children.slice(2)) expect((cell as Node).type).toBe('Text')
  }
  expect(Math.max(...lines.map(l => l.children.length))).toBe(3)
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
  // The group titles are 54 cells (`Pane keys (Tab, ...)`) and 34 cells (`Row keys (act ...)`), so at 30 columns each takes
  // two rows.
  expect(helpRows(m, 30)).toBe(10 + 3 + 1 + 3 + 1)
  expect(helpRows(m, 96)).toBe(9 + 1 + 1 + 1)
})

test('helpRows wraps at spaces: a path that fills a row takes its own row, and a long one breaks after that', () => {
  const live = '/var/folders/sn/0_q8tr7x4vv44d69rbtyckwr0000gn/T/cc-tracker-config-SAq3DF/config.json' // 86 cells
  expect(helpRows(helpModel(CORE_KEYS, [], live, []), 96)).toBe(9 + 2) // the live 100x40 screen: 13 rows with the gap and the footer
  expect(helpRows(helpModel(CORE_KEYS, [], 'p'.repeat(100), []), 96)).toBe(9 + 3) // `Config file:`, 96 cells, 4 cells
  // `Config file: c` is 14 cells. At 14 columns the 34-cell group title takes three rows: `Row keys (act`, `on the`, `selected row)`.
  // The 54-cell title of the pane keys takes five: `Pane keys`, `(Tab,`, `Shift+Tab, Up,`, `Down move`, `between rows)`.
  expect(helpRows(helpModel(CORE_KEYS, [], 'c', ['aaa bbb ccc ddd']), 14)).toBe(11 + 1 + 1 + 2 + 4)
})

test('compactHelp: the full form needs its lines, the gap and the footer; a body that gives no height keeps it', () => {
  const m = helpModel(CORE_KEYS, [], PATH, [])
  expect(compactHelp(m, 1, 96, undefined)).toBe(false)
  expect(compactHelp(m, 1, 96, 12)).toBe(false) // 10 + 1 + 1
  expect(compactHelp(m, 1, 96, 11)).toBe(true)
  expect(compactHelp(m, 2, 96, 12)).toBe(true) // a footer that wraps takes one more
})

// ---------------------------------------------------------------- the version line (issue #65)

test('helpModel carries the version it is given and none by default', () => {
  expect(helpModel(CORE_KEYS, [], PATH, [], '1.2.3').version).toBe('1.2.3')
  expect(helpModel(CORE_KEYS, [], PATH, []).version).toBeUndefined()
})

test('helpText prints the version line right after the config line, before the problems', () => {
  const lines = helpText(helpModel(CORE_KEYS, [], PATH, ['A.'], '1.2.3')).split('\n')
  const at = lines.indexOf(`Config file: ${PATH}`)
  expect(lines.slice(at, at + 4)).toEqual([`Config file: ${PATH}`, 'Version: 1.2.3', 'Problems', '  A.'])
})

test('helpText prints a model with no version as before and one with an unknown version as unknown', () => {
  expect(helpText(helpModel(CORE_KEYS, [], PATH, []))).not.toContain('Version')
  const text = helpText(helpModel(CORE_KEYS, [], undefined, [], 'unknown'))
  expect(text.endsWith('defaults apply\nVersion: unknown')).toBe(true)
})

test('renderHelp draws the version line after the config line, and nothing when the model has none', () => {
  const drawn = nodes(renderHelp(EL, helpModel(CORE_KEYS, [], PATH, [], '1.2.3')))
  expect(drawn.slice(-2)).toEqual([
    { type: 'Text', props: {}, children: [`Config file: ${PATH}`] },
    { type: 'Text', props: {}, children: ['Version: 1.2.3'] },
  ])
  expect(JSON.stringify(renderHelp(EL, helpModel(CORE_KEYS, [], PATH, [])))).not.toContain('Version')
})

test('the drawn help and the printed help list the same lines with a version and problems', () => {
  const m = helpModel(CORE_KEYS, [], PATH, ['P.'], '0.2.0')
  const drawn = nodes(renderHelp(EL, m)).map(n =>
    n.type === 'Box' ? `  ${n.children.map(c => (c as Node).children[0]).join('  ')}` : String(n.children[0]),
  )
  const printed = helpText(m)
    .split('\n')
    .map(line => (line === '  P.' ? 'P.' : line))
  expect(drawn).toEqual(printed)
})

test('helpRows counts the version line as one more row, and the compact form still fits the 100x40 inline body', () => {
  const live = '/var/folders/sn/0_q8tr7x4vv44d69rbtyckwr0000gn/T/cc-tracker-config-SAq3DF/config.json' // 86 cells
  const without = helpModel(CORE_KEYS, [], live, [])
  const withVersion = helpModel(CORE_KEYS, [], live, [], '1.2.3')
  expect(helpRows(withVersion, 96)).toBe(helpRows(without, 96) + 1) // helpRows reads the lines helpText prints: no edit for the line
  expect(helpRows(withVersion, 96)).toBe(11 + 1) // 2 titles, 7 keys, the config line and the version line, and the path row
  // 100 columns by 40 rows inline: a body of 96 columns and 11 rows. The full form, the gap and the footer need 14.
  expect(compactHelp(withVersion, 1, 96, 11)).toBe(true)
  // The compact form draws 7 lines. A line that wraps adds the rows it takes: the live path takes one more.
  const wrapRows = helpRows(withVersion, 96) - helpText(withVersion).split('\n').length
  const compactRows = renderHelp(EL, withVersion, true).length + wrapRows
  expect(compactRows).toBe(7 + 1)
  expect(compactRows + 1).toBeLessThanOrEqual(11) // with the footer row, the view fits the body
})

// The keys the help view lists once the mod started: the core keys and the row keys of the github tracker (issue #50).
const GITHUB_KEYS: readonly PaneKey[] = GITHUB_ROW_KEYS.map(k => ({ ...k, owner: 'github' }))

test('with the github keys, the version and the live config path the compact form and the footer fill the 11-row body', () => {
  const live = '/var/folders/sn/0_q8tr7x4vv44d69rbtyckwr0000gn/T/cc-tracker-config-SAq3DF/config.json' // 86 cells
  const m = helpModel([...CORE_KEYS, ...GITHUB_KEYS], [], live, [], '1.2.3')
  expect(compactHelp(m, 1, 96, 11)).toBe(true)
  const lines = linesOf(renderHelp(EL, m, true))
  expect(lines).toEqual([
    PANE_KEYS,
    'r  refresh  h  help',
    'Row keys (act on the selected row)',
    'x  dismiss  1  high  2  normal',
    '3  low  0  auto',
    'github',
    'c  resolve  f  files',
    `Config file: ${live}`,
    'Version: 1.2.3',
  ])
  const wrapRows = helpRows(m, 96) - helpText(m).split('\n').length
  expect(wrapRows).toBe(1) // the path takes its own row
  // 9 lines, the wrapped row and the footer: exactly the body. A tenth line or a longer path scrolls `Pane keys` away.
  expect(lines.length + wrapRows + 1).toBeLessThanOrEqual(11)
})
