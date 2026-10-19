// The help view: the model, the plain text for `/track help` and the drawn elements. Pure.
// Plan: L6 Task 7 (G14, G15, G16).
import { expect, test } from 'claude-code/testing'
import { CORE_KEYS } from '../core/infra/keys'
import type { PaneKey } from '../core/interfaces/view'
import { helpModel, helpText, renderHelp } from '../ux/tree-data-table/help'
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
