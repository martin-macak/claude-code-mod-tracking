// The help view: the model, the plain text for `/track help` and the drawn elements. Pure.
// Plan: L6 Task 7 (G14, G15, G16).
import { expect, test } from 'claude-code/testing'
import { CORE_KEYS } from '../core/infra/keys'
import type { HelpModel, PaneKey } from '../core/interfaces/view'
import { KEYS as GITHUB_ROW_KEYS } from '../trackers/github/actions'
import { wrapRows } from '../ux/text/wrap'
import {
  type CompactForm,
  compactForm,
  compactHelp,
  compactRows,
  helpModel,
  helpRows,
  helpText,
  renderHelp,
} from '../ux/tree-data-table/help'
import { ROW_GAP } from '../ux/tree-data-table/shape'
import { leaves } from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { row, section } from './fixtures/sections'

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
    section('prs', [row('p1', {}, { owner: 'github' })], { title: 'Pull requests' }),
    section('github', [row('g1', {}, { owner: 'github' })], { title: 'GitHub' }),
    section('web', [row('w1', {}, { owner: 'web' })], { title: 'Web links' }),
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
  const m = helpModel([...CORE_KEYS, { ...open, owner: 'quiet' }], [section('web', [row('w1', {})])], undefined, [])
  expect(m.groups.at(-1)?.title).toBe('quiet')
})

test('helpModel finds the owner of a nested row and groups one owner once', () => {
  const nested = row('top', {}, { owner: 'jira', children: [row('kid', {}, { owner: 'github' })] })
  const second: PaneKey = { ...open, id: 'copy', key: 'c' }
  const m = helpModel([...CORE_KEYS, open, second], [section('jira', [nested], { title: 'Jira work items' })], PATH, [])
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
    [section('github', [row('g', {}, { owner: 'github' })], { title: 'GitHub' })],
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

/** The compact form the first tests draw: three keys to a line and every problem named. */
const threeKeys = (m: HelpModel): CompactForm => ({ perLine: 3, problems: m.problems.length })

/** One string per drawn line: a Text is one line, a Box is one line of its cells. */
const linesOf = (list: readonly unknown[]) => nodes(list).map(n => leaves(n).join('  '))

test('renderHelp draws the full form unless the caller asks for the compact one', () => {
  const m = helpModel(CORE_KEYS, [], PATH, [], '1.2.3')
  expect(renderHelp(EL, m, false)).toEqual(renderHelp(EL, m))
  expect(renderHelp(EL, m)).toHaveLength(11) // 2 titles, 7 keys, the config line, the version line
  expect(renderHelp(EL, helpModel(CORE_KEYS, [], PATH, []))).toHaveLength(10) // no version yet: no line
})

test('renderHelp compact puts three keys on a line and keeps every title and the config line', () => {
  const m = helpModel(CORE_KEYS, [], PATH, [])
  const lines = linesOf(renderHelp(EL, m, threeKeys(m)))
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
  const m = helpModel([...CORE_KEYS, { ...open, label: 'open in the browser' }], [], PATH, [])
  const drawn = nodes(renderHelp(EL, m, threeKeys(m)))
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
  const m = helpModel(CORE_KEYS, [], undefined, ['A.', 'B.'])
  const bad = nodes(renderHelp(EL, m, threeKeys(m)))
  expect(bad.at(-3)).toEqual({ type: 'Text', props: { weight: 'bold' }, children: ['Problems'] })
  expect(bad.slice(-2)).toEqual([
    { type: 'Text', props: { wrap: 'wrap' }, children: ['A.'] },
    { type: 'Text', props: { wrap: 'wrap' }, children: ['B.'] },
  ])
})

test('the compact form lists the same keys in the same order as the printed help', () => {
  const m = helpModel([...CORE_KEYS, open], [], PATH, [])
  const cells = nodes(renderHelp(EL, m, threeKeys(m)))
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
  const compactRows = renderHelp(EL, withVersion, threeKeys(withVersion)).length + wrapRows
  expect(compactRows).toBe(7 + 1)
  expect(compactRows + 1).toBeLessThanOrEqual(11) // with the footer row, the view fits the body
})

// The keys the help view lists once the mod started: the core keys and the row keys of the github tracker (issue #50).
const GITHUB_KEYS: readonly PaneKey[] = GITHUB_ROW_KEYS.map(k => ({ ...k, owner: 'github' }))

test('with the github keys, the version and the live config path the compact form and the footer fill the 11-row body', () => {
  const live = '/var/folders/sn/0_q8tr7x4vv44d69rbtyckwr0000gn/T/cc-tracker-config-SAq3DF/config.json' // 86 cells
  const m = helpModel([...CORE_KEYS, ...GITHUB_KEYS], [], live, [], '1.2.3')
  expect(compactHelp(m, 1, 96, 11)).toBe(true)
  const lines = linesOf(renderHelp(EL, m, threeKeys(m)))
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

// ---------------------------------------------------------------- the problems and the fit of the compact form (issue #105)

const LIVE = '/var/folders/sn/0_q8tr7x4vv44d69rbtyckwr0000gn/T/cc-tracker-config-SAq3DF/config.json' // 86 cells
const MOD_KEYS: readonly PaneKey[] = [...CORE_KEYS, ...GITHUB_KEYS]
const problems = (n: number): string[] => Array.from({ length: n }, (_, i) => `Problem ${i + 1}.`)

/** The rows a drawn compact form takes in a body `columns` wide: one per line, more for a line that wraps. */
const drawnRows = (m: Parameters<typeof renderHelp>[1], form: CompactForm, columns: number): number =>
  linesOf(renderHelp(EL, m, form)).reduce((n, line) => n + wrapRows(line, columns), 0)

test('compactForm is the full form while the full form fits, and while the body gives no height', () => {
  const m = helpModel(CORE_KEYS, [], PATH, problems(2), '1.2.3')
  expect(compactForm(m, 1, 96, undefined)).toBeUndefined()
  expect(compactForm(m, 1, 96, 100)).toBeUndefined()
  expect(compactForm(m, 1, 96, helpRows(m, 96) + 2)).toBeUndefined() // the lines, the gap and the footer
  expect(compactForm(m, 1, 96, helpRows(m, 96) + 1)).toBeDefined()
})

test('compactForm keeps three keys to a line and every problem while that fits the body', () => {
  const m = helpModel(MOD_KEYS, [], PATH, problems(2), '1.2.3')
  // 9 lines of keys, the config line and the version, the problems title and 2 problems, and the footer: 13 rows.
  expect(compactForm(m, 1, 96, 13)).toEqual({ perLine: 3, problems: 2 })
  const lines = linesOf(renderHelp(EL, m, compactForm(m, 1, 96, 13) as CompactForm))
  expect(lines.slice(-3)).toEqual(['Problems', 'Problem 1.', 'Problem 2.'])
  expect(lines.some(l => l.includes('more problem'))).toBe(false)
})

test('the compact form with 3 problems, the live 86-cell path and every key fits the 100x40 inline body', () => {
  const m = helpModel(MOD_KEYS, [], LIVE, problems(3), '1.2.3')
  const form = compactForm(m, 1, 96, 11) as CompactForm
  expect(form).toBeDefined()
  const lines = linesOf(renderHelp(EL, m, form))
  expect(lines[0]).toBe(PANE_KEYS) // the first line of the view is the title of the pane keys
  expect(drawnRows(m, form, 96) + 1).toBeLessThanOrEqual(11) // with the footer row: the whole view fits the body
  expect(compactRows(m, 96, form) + 1).toBeLessThanOrEqual(11)
  expect(lines.at(-1)).toBe('3 problems: /track help')
})

test('the compact form with many problems is capped: its line count is pinned, the count says where to read the rest', () => {
  const m = helpModel(MOD_KEYS, [], LIVE, problems(30), '1.2.3')
  const form = compactForm(m, 1, 96, 11) as CompactForm
  expect(form).toEqual({ perLine: 5, problems: 0 }) // 3 keys to a line leave no row: the body takes more keys to a line
  expect(linesOf(renderHelp(EL, m, form))).toEqual([
    PANE_KEYS,
    'r  refresh  h  help',
    'Row keys (act on the selected row)',
    'x  dismiss  1  high  2  normal  3  low  0  auto',
    'github',
    'c  resolve  f  files',
    `Config file: ${LIVE}`,
    'Version: 1.2.3',
    '30 problems: /track help',
  ])
  expect(drawnRows(m, form, 96)).toBe(10) // 9 lines and the row the long path wraps to
  expect(drawnRows(m, form, 96) + 1).toBeLessThanOrEqual(11)
})

test('a body with rows to spare lists the first problems, then counts the rest and names /track help', () => {
  const m = helpModel(MOD_KEYS, [], PATH, problems(12), '1.2.3')
  // 9 lines at three keys to a line and the footer leave 6 of 16 rows: the title, 4 problems and the count.
  const form = compactForm(m, 1, 96, 16) as CompactForm
  expect(form).toEqual({ perLine: 3, problems: 4 })
  const lines = linesOf(renderHelp(EL, m, form))
  expect(lines.slice(-6)).toEqual(['Problems', ...problems(4), '8 more problems: /track help'])
  expect(drawnRows(m, form, 96) + 1).toBe(16)
})

test('the count of hidden problems says problem or problems, and more only after a listed problem', () => {
  const m = helpModel(CORE_KEYS, [], PATH, ['A.', 'B.'])
  expect(linesOf(renderHelp(EL, m, { perLine: 3, problems: 1 })).slice(-3)).toEqual([
    'Problems',
    'A.',
    '1 more problem: /track help',
  ])
  expect(linesOf(renderHelp(EL, m, { perLine: 3, problems: 0 })).at(-1)).toBe('2 problems: /track help')
  const one = helpModel(CORE_KEYS, [], PATH, ['A.'])
  expect(linesOf(renderHelp(EL, one, { perLine: 3, problems: 0 })).at(-1)).toBe('1 problem: /track help')
  expect(linesOf(renderHelp(EL, one, { perLine: 3, problems: 1 })).slice(-2)).toEqual(['Problems', 'A.'])
})

test('the compact form with no problem draws no problems line, in any body', () => {
  const m = helpModel(MOD_KEYS, [], LIVE, [], '1.2.3')
  const form = compactForm(m, 1, 96, 11) as CompactForm
  expect(linesOf(renderHelp(EL, m, form)).join('\n')).not.toContain('problem')
  expect(form.problems).toBe(0)
})

test('a body too short for any form takes the form with the fewest rows: the widest line of keys and the count line', () => {
  const m = helpModel(MOD_KEYS, [], LIVE, problems(30), '1.2.3')
  const form = compactForm(m, 1, 96, 3) as CompactForm
  expect(form).toEqual({ perLine: 5, problems: 0 }) // the fewest keys to a line that give the fewest rows
  // More keys to a line take fewer rows, so less of the top scrolls out of the view.
  expect(compactRows(m, 96, form)).toBeLessThan(compactRows(m, 96, { perLine: 3, problems: 0 }))
  for (let perLine = 1; perLine <= 8; perLine++) {
    expect(compactRows(m, 96, form)).toBeLessThanOrEqual(compactRows(m, 96, { perLine, problems: 0 }))
  }
})

test('a footer of two rows (a tracker row selected) leaves the compact form the fewest rows when nothing fits', () => {
  const m = helpModel(MOD_KEYS, [], LIVE, problems(3), '1.2.3')
  expect(compactForm(m, 2, 96, 11)).toEqual({ perLine: 5, problems: 0 }) // 10 rows and 2 for the footer: 1 over, not 2
})

test('compactForm raises the keys to a line only as far as the body needs, and no further than the width holds', () => {
  const m = helpModel(MOD_KEYS, [], LIVE, [], '1.2.3')
  // 3 keys to a line: 9 lines and a wrapped row, and the footer fill 11 rows exactly (issue #97).
  expect(compactForm(m, 1, 96, 11)).toEqual({ perLine: 3, problems: 0 })
  // A body of 10 rows needs the row keys on one line: 5 to a line.
  expect(compactForm(m, 1, 96, 10)).toEqual({ perLine: 5, problems: 0 })
})

// The window of issue #109 never touches the help view (the table runs one attempt and no window for it), so the body
// height is the only thing that sets the room: the help view fits at every height from the 11 rows of 100x40 inline.
test('with no tracker row selected the help view fits every body height from 11 to 40 rows, with any number of problems', () => {
  const over: string[] = []
  for (const n of [0, 1, 3, 30]) {
    const m = helpModel(MOD_KEYS, [], LIVE, problems(n), '1.2.3')
    for (let bodyRows = 11; bodyRows <= 40; bodyRows++) {
      const form = compactForm(m, 1, 96, bodyRows)
      const used = form === undefined ? helpRows(m, 96) + ROW_GAP + 1 : compactRows(m, 96, form) + 1
      if (used > bodyRows) over.push(`${n} problems in ${bodyRows} rows take ${used}`)
    }
  }
  expect(over).toEqual([])
})

// A malformed config gives one problem per unknown key, with no limit, and the pane picks the form on every draw. The
// search for the cap must not rescan every named problem for each candidate: that is quadratic (Codex review of PR #137).
test('compactForm with thousands of problems stays linear: 8000 short problems pick their form in a blink', () => {
  const m = helpModel(MOD_KEYS, [], LIVE, problems(8000), '1.2.3')
  const start = performance.now()
  const form = compactForm(m, 1, 96, 40) as CompactForm
  expect(performance.now() - start).toBeLessThan(500)
  expect(form.problems).toBeGreaterThan(0)
  expect(form.problems).toBeLessThan(8000)
})

// The search takes the most problems that fit. This reference asks `compactRows` for each candidate, the slow way, so the
// fast search must give the same form for every width, body, footer and number of problems.
test('compactForm names the most problems that fit: it agrees with a plain search over compactRows', () => {
  const reference = (m: HelpModel, footerRows: number, columns: number, bodyRows: number): CompactForm | undefined => {
    if (!compactHelp(m, footerRows, columns, bodyRows)) return undefined
    const most = Math.max(
      1,
      Math.floor((columns - 2 + 2) / (Math.max(...MOD_KEYS.map(k => `${k.key}  ${k.label}`.length)) + 2)),
    )
    const first = Math.min(3, most)
    const fits = (perLine: number, n: number): boolean =>
      compactRows(m, columns, { perLine, problems: n }) + footerRows <= bodyRows
    for (let perLine = first; perLine <= most; perLine++) {
      if (!fits(perLine, 0)) continue
      let n = m.problems.length
      while (!fits(perLine, n)) n--
      return { perLine, problems: n }
    }
    return undefined
  }
  const texts = [
    'A.',
    'A problem that is long enough to wrap in a narrow body, with a key name and a limit.',
    'x'.repeat(130),
  ]
  let checked = 0
  for (const count of [0, 1, 2, 5, 12, 40]) {
    const list = Array.from({ length: count }, (_, i) => texts[i % texts.length] as string)
    const m = helpModel(MOD_KEYS, [], LIVE, list, '1.2.3')
    for (const columns of [60, 96, 130]) {
      for (const footerRows of [1, 2]) {
        for (let bodyRows = 6; bodyRows <= 45; bodyRows += 3) {
          const want = reference(m, footerRows, columns, bodyRows)
          const got = compactForm(m, footerRows, columns, bodyRows)
          if (want === undefined) {
            // Nothing fits: the fewest rows, with no problem named. Only the shape is pinned here.
            if (got !== undefined) expect(got.problems).toBe(0)
          } else {
            expect(got).toEqual(want)
          }
          checked++
        }
      }
    }
  }
  expect(checked).toBeGreaterThan(300)
})

// A key label wider than 22 cells wrapped the three columns of a narrow pane (the note of issue #105).
test('the keys to a line follow the body width, so a long label never wraps the columns', () => {
  const wide: PaneKey = { ...open, label: 'open in the browser' } // `o  open in the browser` is 22 cells
  const m = helpModel([...CORE_KEYS, wide], [], PATH, [], '1.2.3')
  const lineWidth = (box: Node): number =>
    2 +
    2 * (box.children.length - 1) +
    box.children.reduce<number>((sum, c) => {
      const cell = c as Node
      return sum + (cell.type === 'Box' ? Number(cell.props.width) : String(cell.children[0]).length)
    }, 0)
  for (const [columns, perLine] of [
    [96, 3],
    [72, 3],
    [60, 2],
    [47, 1],
    [30, 1],
  ] as const) {
    const form = compactForm(m, 1, columns, 11) as CompactForm
    expect(form.perLine).toBe(perLine)
    const keyLines = nodes(renderHelp(EL, m, form)).filter(n => n.type === 'Box')
    expect(keyLines.length).toBeGreaterThan(0)
    for (const line of keyLines) {
      expect(line.children.length).toBeLessThanOrEqual(perLine)
      expect(lineWidth(line)).toBeLessThanOrEqual(columns)
    }
  }
})

test('compactRows counts what the compact form draws when nothing wraps, so a new line counts with no edit', () => {
  const forms: CompactForm[] = [
    { perLine: 3, problems: 0 },
    { perLine: 3, problems: 2 },
    { perLine: 5, problems: 3 },
    { perLine: 1, problems: 1 },
  ]
  for (const m of [
    helpModel(MOD_KEYS, [], PATH, problems(3), '1.2.3'),
    helpModel(MOD_KEYS, [], undefined, problems(7)),
    helpModel(CORE_KEYS, [], PATH, [], '1.2.3'),
  ]) {
    for (const form of forms) expect(compactRows(m, 999, form)).toBe(renderHelp(EL, m, form).length)
  }
})

test('compactRows counts the rows a path or a problem that wraps takes, and the count line', () => {
  const m = helpModel(CORE_KEYS, [], LIVE, ['x'.repeat(100), 'y'], '1.2.3')
  // 2 titles and 3 lines of keys, the config line (`Config file:` and the 86-cell path on its own row), the version line.
  const base = 5 + 2 + 1
  expect(compactRows(m, 96, { perLine: 3, problems: 0 })).toBe(base + 1) // the count line
  expect(compactRows(m, 96, { perLine: 3, problems: 1 })).toBe(base + 4) // a title, 2 rows (100 cells wrap) and the count
  expect(compactRows(m, 96, { perLine: 3, problems: 2 })).toBe(base + 4) // a title, 2 rows and 1 row: no count
})

test('the printed help lists every problem, with no cap and no count', () => {
  const text = helpText(helpModel(MOD_KEYS, [], LIVE, problems(30), '1.2.3'))
  expect(text.split('\n').filter(l => /^ {2}Problem \d+\.$/.test(l))).toEqual(problems(30).map(p => `  ${p}`))
  expect(text).not.toContain('more problem')
  expect(text).not.toContain('/track help')
})
