// The adaptive status area as the PaneSession draws it (issue #138, PR 2): with 18 body rows or more, the summary row above the table
// and the selected-row line and the health line in the footer Box; below that, the bottom as it was. The table tests of the budget
// are in status-area.test.ts. Here the session picks the form from the engine body, reads the sections, the tools and the problems,
// and keeps the tree as tall as the body. Order and shape, not time: the draw is one read of the state and writes nothing.
import { expect, test } from 'claude-code/testing'
import { footerKeys, KeyRegistry } from '../core/infra/keys'
import type { PaneView, RowRef, SectionSpec, TreeRow } from '../core/interfaces/view'
import { type PaneHost, PaneSession } from '../hooks/pane-session'
import type { ToolStatus } from '../types'
import { resetWidths } from '../ux/tree-data-table/columns'
import { SUMMARY_ROWS } from '../ux/tree-data-table/status'
import { fakeConfig } from './fixtures/config-fs'
import { footerOf, leaves, type Node, nodes, rowBoxes, texts } from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { heightOf, widthOf } from './fixtures/height'
import { fakePorts } from './fixtures/ports'
import { row, section } from './fixtures/sections'

const web = (id: string, extra: Partial<TreeRow> = {}): TreeRow =>
  row(id, { control: '', name: id, description: `https://${id}.example/` }, { owner: 'web', ...extra })
const webs = (n: number): TreeRow[] => Array.from({ length: n }, (_, i) => web(`w${i}`))

const ready = (name: string): ToolStatus => ({ name, available: true, loggedIn: true, breaker: 'closed' })
const missing = (name: string): ToolStatus => ({ name, available: false, loggedIn: null, breaker: 'closed' })

function setup(rows: readonly TreeRow[], extra: Partial<SectionSpec> = {}) {
  resetWidths()
  const w = fakePorts()
  const reg = new KeyRegistry()
  const host = {
    sections: [section('web', rows, extra)] as SectionSpec[],
    /** The tool ids of the trackers that run, and how often the pane asked for them. */
    live: [] as string[],
    asked: 0,
    keyProblems: [] as string[],
    entry: async () => {},
    paneData: async (_p: unknown, _view: PaneView) => host.sections,
    inventory: async () => host.sections,
    footer: async (_p: unknown, ref: RowRef | undefined, help: boolean, marked?: readonly RowRef[]) =>
      footerKeys(reg, ref, owner => owner === 'web', help, undefined, marked),
    liveTools: () => {
      host.asked++
      return host.live
    },
    problems: () => host.keyProblems,
    isItemOwner: (owner: string) => owner === 'web',
    version: undefined,
    keys: reg,
    config: fakeConfig(),
  }
  const session = new PaneSession()
  const m = host as unknown as PaneHost
  const draw = (cols: number, rows?: number, o: { focused?: boolean; placement?: 'dock' | 'inline' } = {}) =>
    session.draw(w.ports, m, EL, { bodyColumns: cols, bodyRows: rows, ...o })
  return { w, host, draw }
}

const words = (tree: unknown): string[] => texts(tree).map(([, s]) => s)
const STATUS_WORDS = ['Selected:', 'Health:']
const showsStatus = (tree: unknown): boolean => STATUS_WORDS.every(s => words(tree).includes(s))
const LINKS = { band: { label: 'Links', count: 30, failing: 0, rank: 4 } }

test('below 18 body rows the pane draws no status area: the view line and the footer, as before, and no ask for the tools', async () => {
  const t = setup(webs(30), LINKS)
  t.w.state.set('selected', 'w3')
  for (const rows of [11, 17]) {
    const tree = await t.draw(96, rows)
    expect(showsStatus(tree), String(rows)).toBe(false)
    expect(words(tree)).not.toContain('Links 30')
    expect(heightOf(tree, 96), String(rows)).toBe(rows)
  }
  expect(t.host.asked).toBe(0) // the compact form reads nothing for the status area
})

test('a pane that gives no body height draws the compact bottom, the full list and no status area', async () => {
  const t = setup(webs(30), LINKS)
  const tree = await t.draw(96, undefined)
  expect(showsStatus(tree)).toBe(false)
  expect(rowBoxes(tree)).toHaveLength(30)
})

test('with 18 body rows the pane draws the summary, the selected row and the health, and the tree is as tall as the body', async () => {
  const t = setup(webs(30), LINKS)
  t.w.state.set('selected', 'w3')
  const tree = await t.draw(96, 18)
  expect(showsStatus(tree)).toBe(true)
  expect(words(tree)[0]).toBe('Links 30') // the summary row is the first line of the pane
  expect(words(tree).slice(words(tree).indexOf('Selected:'))).toContain('w3') // the name cell in the selected-row line, not the table row
  expect(heightOf(tree, 96)).toBe(18)
  expect(footerOf(tree).length).toBeGreaterThan(0) // the footer keys stay in view
})

test('the summary row says the words of the band: the sections with a count, in band order, from the sections the draw read', async () => {
  const t = setup(webs(3))
  t.host.sections = [
    section('prs', [web('p')], { band: { label: 'PRs', count: 3, failing: 1, rank: 9 } }),
    section('jira', [web('j')], { band: { label: 'Jira', count: 6, failing: 0, rank: 1 } }),
    section('web', webs(3), { band: { label: 'Links', count: 0, failing: 0, rank: 4 } }),
  ]
  const tree = await t.draw(96, 31, { placement: 'dock' })
  expect(words(tree)[0]).toBe('Jira 6 · PRs 3 (1 ✗)')
})

test('with no count in any section the summary row stays, as a dim line, so the rows of the form do not jump', async () => {
  const t = setup(webs(3))
  const tree = await t.draw(96, 31, { placement: 'dock' })
  const [props, line] = texts(tree)[0] as [Node['props'], string]
  expect(line).toBe('No counts yet')
  expect(props.dimColor).toBe(true)
  expect(heightOf(tree, 96)).toBe(31)
})

test('the selected-row line names the selected row, and says No row selected when none is', async () => {
  const t = setup(webs(5))
  expect(words(await t.draw(96, 31, { placement: 'dock' }))).toContain('No row selected')
  t.w.state.set('selected', 'w2')
  const tree = await t.draw(96, 31, { placement: 'dock' })
  expect(words(tree)).not.toContain('No row selected')
  expect(words(tree).slice(words(tree).indexOf('Selected:'))).toContain('w2')
})

test('the selected-row line follows the row the selection falls to when the selected row hides', async () => {
  const t = setup(webs(3))
  t.w.state.set('selected', 'w1')
  await t.draw(96, 31, { placement: 'dock' })
  t.host.sections = [section('web', [web('w0'), web('w2')])] // `w1` hid: no key from the person
  const tree = await t.draw(96, 31, { placement: 'dock' })
  expect(words(tree).slice(words(tree).indexOf('Selected:'))).toContain('w2')
  expect(t.w.state.get('selected')).toBe('w1') // a render writes nothing (E9): the atom stays
})

test('the selected-row line shows the status in its color, the badges and the strongest reason of the row', async () => {
  const pr = web('pr', {
    cells: {
      control: { text: '' },
      name: { text: '#142' },
      description: { text: 'Fix the login' },
      status: { text: 'open', fg: 'success' },
    },
    extras: [
      { text: '✓ 3/3', fg: 'success' },
      { text: 'conflict', fg: 'error' },
    ],
    reasons: { first: 'created', all: ['created'], strongest: 'created' },
  })
  const t = setup([pr])
  t.w.state.set('selected', 'pr')
  const tree = await t.draw(96, 31, { placement: 'dock' })
  // The words of the first line: the cells of the row, joined by dim dots, the reason last. The quick view (issue #276) is shown by
  // default in the full form, and its first line is this one: the lines below it begin with their labels (`reasons:`).
  const after = words(tree).slice(words(tree).indexOf('Selected:'))
  const line = after.slice(0, after.indexOf('reasons:'))
  expect(line.filter(s => s !== '·')).toEqual(['Selected:', '#142', 'open', '✓ 3/3', 'conflict', 'created'])
  // The table draws the same row, with the same status cell, above the footer: look in the part of the tree after the label.
  const inLine = texts(tree).slice(texts(tree).findIndex(([, s]) => s === 'Selected:'))
  expect(inLine.find(([, s]) => s === 'open')?.[0].color).toBeDefined() // the status keeps the color of its token
  expect(inLine.find(([, s]) => s === 'created')?.[0].dimColor).toBe(true)
})

test('at 49 cells the selected-row line shows the badge that the docked row cut', async () => {
  const pr = web('pr', {
    cells: {
      control: { text: '' },
      name: { text: '#142' },
      description: { text: 'Fix the login of the web app for good' },
      type: { text: 'pull request' },
      status: { text: 'open', fg: 'success' },
    },
    extras: [
      { text: '✗ conflicts', fg: 'error' },
      { text: '✓ checks', fg: 'success' },
    ],
  })
  const t = setup([pr, ...webs(3)])
  t.w.state.set('selected', 'pr')
  const w = words(await t.draw(49, 31, { placement: 'dock' }))
  const at = w.indexOf('Selected:')
  expect(w.slice(0, at)).not.toContain('✓ checks') // the row cuts the second badge to its start
  expect(w.slice(at)).toContain('✓ checks') // the line has the room for it, whole
})

test('the health line names the tools of the trackers that run, with their notes, and the problem count', async () => {
  const t = setup(webs(3))
  t.host.live = ['acli', 'gh']
  t.w.state.set('tools', { gh: ready('gh'), acli: missing('acli') })
  t.host.keyProblems = ['keys: a', 'trackers.t: failed']
  const tree = await t.draw(96, 31, { placement: 'dock' })
  const health = words(tree).slice(words(tree).indexOf('Health:'))
  expect(health.filter(s => s !== '·').slice(0, 4)).toEqual([
    'Health:',
    'acli not installed',
    'gh ready',
    '2 problems: h',
  ])
})

test('the health line reads the wall clock of the ports, as the section notes do, and awaits no engine clock', async () => {
  const t = setup(webs(3))
  // `now()` is engine time and `wall()` is `Date.now`: a breaker stamps `openUntil` with the wall clock. The two answer with
  // different numbers here, so a line that took the wrong one would say a wrong span.
  const clock = t.w.ports.clock as { now: () => Promise<number>; wall: () => number }
  let engineReads = 0
  clock.now = async () => {
    engineReads++
    return 0
  }
  clock.wall = () => 5_000_000
  t.host.live = ['acli', 'gh']
  t.w.state.set('tools', {
    acli: { name: 'acli', available: true, loggedIn: true, breaker: 'open', openUntil: 5_000_000 + 120_000 },
    gh: { name: 'gh', available: true, loggedIn: false, breaker: 'closed' },
  })
  const tree = await t.draw(96, 31, { placement: 'dock' })
  expect(engineReads).toBe(0) // the draw awaits the tools atom and nothing else for the health line
  const health = texts(tree).slice(texts(tree).findIndex(([, s]) => s === 'Health:'))
  for (const word of ['acli paused 2m', 'gh not logged in']) {
    expect(
      health.map(([, s]) => s),
      word,
    ).toContain(word)
    expect(health.find(([, s]) => s === word)?.[0].color, word).toBeDefined() // a tool that needs the person is colored
  }
})

test('at 49 cells the health line keeps the problem count whole: a tool note is cut first', async () => {
  const t = setup(webs(3))
  t.host.live = ['acli', 'gh']
  t.w.state.set('tools', {
    acli: missing('acli'),
    gh: { name: 'gh', available: true, loggedIn: false, breaker: 'closed' },
  })
  t.host.keyProblems = ['keys: a', 'trackers.t: failed']
  const tree = await t.draw(49, 31, { placement: 'dock' })
  const health = words(tree).slice(words(tree).indexOf('Health:'))
  expect(health.slice(0, 6)).toEqual(['Health:', 'acli not installed', '·', 'gh …', '·', '2 problems: h'])
})

test('a long name, many badges and many tools keep each line to one row at 96, 49 and 40 cells: the tree is the body', async () => {
  const long = web('long', {
    cells: {
      control: { text: '' },
      name: { text: 'a-very-long-branch-name/that-goes-on-and-on-and-on-and-on-and-on' },
      description: { text: 'Fix the login' },
      status: { text: 'open', fg: 'success' },
    },
    extras: Array.from({ length: 9 }, (_, i) => ({ text: `badge-number-${i}` })),
    reasons: { first: 'created', all: ['created'], strongest: 'created' },
  })
  const t = setup([long, ...webs(40)], LINKS)
  t.w.state.set('selected', 'long')
  const ids = Array.from({ length: 12 }, (_, i) => `a-tool-with-a-long-name-${i}`)
  t.host.live = ids
  t.w.state.set('tools', Object.fromEntries(ids.map(id => [id, ready(id)])))
  for (const [columns, placement] of [
    [96, 'dock'],
    [96, 'inline'],
    [49, 'dock'],
    [40, 'dock'],
  ] as const) {
    const tree = await t.draw(columns, 31, { placement })
    expect(heightOf(tree, columns), `${columns} ${placement}`).toBe(31)
    expect(showsStatus(tree), `${columns} ${placement}`).toBe(true)
    // The height oracle measures a Text against the whole body, so a line that is wider than the body still counts one row. The
    // width of each status line is checked on its own.
    const lines = nodes(tree, 'Box').filter(b =>
      b.children.some(c => ['Selected:', 'Health:'].includes(leaves(c).join(''))),
    )
    expect(lines, `${columns} ${placement}`).toHaveLength(2)
    for (const line of lines) expect(widthOf(line), `${columns} ${placement}`).toBeLessThanOrEqual(columns)
  }
})

test('the health line leaves out the tool of a tracker that is off: it would say checking… for good', async () => {
  const t = setup(webs(3))
  t.host.live = ['gh'] // acli belongs to a tracker that is off: liveTools does not name it
  t.w.state.set('tools', {
    gh: ready('gh'),
    acli: { name: 'acli', available: null, loggedIn: null, breaker: 'closed' },
  })
  const tree = await t.draw(96, 31, { placement: 'dock' })
  expect(words(tree).some(s => s.startsWith('acli'))).toBe(false)
  expect(words(tree)).not.toContain('acli checking…')
  expect(words(tree)).toContain('gh ready')
  expect(words(tree)).toContain('no problems')
  expect(t.host.asked).toBe(1)
})

test('the health line counts the config problems and the ones the config left out, as the help view does', async () => {
  const t = setup(webs(3))
  ;(t.host as { config: unknown }).config = fakeConfig({
    problems: Array.from({ length: 52 }, (_, i) => `config: p${i}`),
  })
  t.host.keyProblems = ['keys: a']
  const tree = await t.draw(96, 31, { placement: 'dock' })
  expect(words(tree)).toContain('53 problems: h')
})

test('the form follows the engine body, not the room under the keys hint: the keys in the prompt keep the full form', async () => {
  const t = setup(webs(40), LINKS)
  t.w.state.set('selected', 'w3')
  const live = await t.draw(96, 18, { focused: true })
  const hinted = await t.draw(96, 18, { focused: false })
  expect(showsStatus(live)).toBe(true)
  expect(showsStatus(hinted)).toBe(true) // the hint takes a row, and the form stays
  expect(heightOf(live, 96)).toBe(18)
  expect(heightOf(hinted, 96)).toBe(18) // the hint, the summary and the table fill the body
  expect(rowBoxes(live).length - rowBoxes(hinted).length).toBe(1) // the hint takes the row of one data row
})

test('a docked pane of 49 cells at 120x37 draws all five lines, the footer keys last, and the tree is the body', async () => {
  const t = setup(webs(40), LINKS)
  t.w.state.set('selected', 'w3')
  const tree = await t.draw(49, 31, { placement: 'dock' })
  expect(showsStatus(tree)).toBe(true)
  expect(words(tree)[0]).toBe('Links 30')
  expect(words(tree)).toContain('View: list')
  expect(heightOf(tree, 49)).toBe(31)
  const root = (tree as unknown as Node).children.at(-1) as Node
  expect(root.props.minHeight).toBe(31 - SUMMARY_ROWS) // the table takes the body less the summary row
  // The pin: the footer Box ends the body, and the keys are its last child.
  const footer = (root.children.at(-1) as Node).children[0] as Node
  const last = footer.children.at(-1) as Node
  expect(nodes(last, 'Button').map(b => String(b.props.hotkey))).toEqual(expect.arrayContaining(['r', 'h']))
  // One group, the selection near the top: the summary, the title, the header, the hint below, the gap, the selected row, the view line
  // (two rows at 49 cells), the health line and the footer (two rows) take 11 of the 31 rows.
  expect(rowBoxes(tree)).toHaveLength(20)
})

test('a docked pane of a short terminal (12 body rows) keeps the compact form', async () => {
  const t = setup(webs(40), LINKS)
  const tree = await t.draw(49, 12, { placement: 'dock' })
  expect(showsStatus(tree)).toBe(false)
  expect(heightOf(tree, 49)).toBeLessThanOrEqual(12)
})

test('the help view draws no status area and asks for no tool, whatever the body', async () => {
  const t = setup(webs(3), LINKS)
  t.w.state.set('help', true)
  const tree = await t.draw(96, 31, { placement: 'dock' })
  expect(leaves(tree)).not.toContain('Selected:')
  expect(leaves(tree)).not.toContain('Health:')
  expect(leaves(tree)).not.toContain('Links 30')
  expect(t.host.asked).toBe(0)
})

test('a drawing of the full form writes nothing: the status area only reads (E9)', async () => {
  const t = setup(webs(10), LINKS)
  t.w.state.set('selected', 'w1')
  t.host.live = ['gh']
  t.w.state.set('tools', { gh: ready('gh') })
  t.w.stateSets = {}
  await t.draw(96, 31, { placement: 'dock' })
  await t.draw(96, 18)
  expect(t.w.stateSets).toEqual({})
})

test('marked rows keep the view line words and the status area together', async () => {
  const t = setup(webs(10), LINKS)
  t.w.state.set('selected', 'w1')
  t.w.state.set('marks', ['w1', 'w4'])
  const tree = await t.draw(96, 31, { placement: 'dock' })
  expect(words(tree)).toContain('View: list · 2 marked')
  expect(showsStatus(tree)).toBe(true)
  expect(heightOf(tree, 96)).toBe(31)
})

// ---- the quick view (issue #276, L1 of #275) ---------------------------------------------------------------------------------------
//
// The quick view shows the detail of the selected row in the footer Box, below the `Selected:` line. The full form shows it by default,
// the compact form hides it, and `e` flips the flag of the form that the pane draws (the atom `quick`). The rows that it takes in a body
// are in status-area.test.ts; the lines of a row are in quick-view.test.ts. Here the session reads the atom and the selected row.

const PULL = 'https://github.com/martin-macak/claude-code-mod-tracking/pull/262'
const TITLE = 'feat(track): Track every file Claude reads or writes, with its type'
/** A PR row that a docked pane of 49 cells cuts: the description, the type and the link have lines in the quick view. */
const pull = (extra: Partial<TreeRow> = {}): TreeRow =>
  web('pr', {
    cells: {
      control: { text: '' },
      name: { text: '#262', href: PULL },
      description: { text: TITLE },
      type: { text: 'feat/track-all-files' },
      status: { text: 'open', fg: 'success' },
    },
    extras: [{ text: '✓ checks', fg: 'success' }, { text: 'mergeable' }],
    reasons: { first: 'created', all: ['created', 'updated'], strongest: 'created' },
    turns: { first: 3, last: 9 },
    ...extra,
  })
const LABELS = ['description:', 'type:', 'link:', 'reasons:', 'turns:']
/** The words from the `Selected:` label to the view line. */
const quickPart = (tree: unknown): string[] => {
  const all = words(tree)
  return all.slice(all.indexOf('Selected:'), all.indexOf('View: list'))
}

test('in the full form the quick view shows by default: the Selected: line, then the lines the row cannot show, above the view line', async () => {
  const t = setup([pull(), ...webs(3)], LINKS)
  t.w.state.set('selected', 'pr')
  const tree = await t.draw(49, 31, { placement: 'dock' })
  const part = quickPart(tree)
  expect(part.filter(s => LABELS.includes(s))).toEqual(LABELS)
  expect(part.some(s => s.startsWith('feat(track): Track every') && s.endsWith('…'))).toBe(true) // a line is cut to the width
  expect(part.some(s => s.startsWith('https://github.com/') && s.includes('…') && s.endsWith('/pull/262'))).toBe(true) // a link, in the middle
  expect(part).toContain('created, updated')
  expect(part).toContain('first 3 · last 9')
  // A badge line is not there: the first line has the badges, whole.
  expect(part.filter(s => s === '✓ checks')).toHaveLength(1)
  expect(heightOf(tree, 49)).toBe(31)
})

test('the first line of the quick view is the Selected: line of the status area, as it was', async () => {
  const t = setup([pull(), ...webs(3)], LINKS)
  t.w.state.set('selected', 'pr')
  t.w.state.set('quick', { full: false, compact: false })
  const hidden = quickPart(await t.draw(96, 31, { placement: 'dock' }))
  t.w.state.set('quick', { full: true, compact: false })
  const shown = quickPart(await t.draw(96, 31, { placement: 'dock' }))
  // The name is a Link (the cell has an href), so it is no Text of its own: the words are the status, the badges and the reason.
  expect(hidden).toEqual(['Selected:', '·', 'open', '·', '✓ checks', '·', 'mergeable', '·', 'created'])
  expect(shown.slice(0, hidden.length)).toEqual(hidden)
  expect(shown.length).toBeGreaterThan(hidden.length)
})

test('e hides the quick view in the full form: the Selected: line stays, and the rows come back to the list', async () => {
  const t = setup([pull(), ...webs(30)], LINKS)
  t.w.state.set('selected', 'pr')
  const shown = await t.draw(49, 31, { placement: 'dock' })
  t.w.state.set('quick', { full: false, compact: false })
  const hidden = await t.draw(49, 31, { placement: 'dock' })
  expect(quickPart(shown).some(s => LABELS.includes(s))).toBe(true)
  expect(quickPart(hidden).some(s => LABELS.includes(s))).toBe(false)
  expect(quickPart(hidden)[0]).toBe('Selected:')
  expect(words(hidden)).toContain('Health:')
  expect(rowBoxes(hidden).length).toBeGreaterThan(rowBoxes(shown).length)
  expect(heightOf(shown, 49)).toBe(31)
  expect(heightOf(hidden, 49)).toBe(31)
})

test('in the compact form the quick view is hidden by default, and e shows it with no health line and no summary row', async () => {
  const t = setup([pull(), ...webs(30)], LINKS)
  t.w.state.set('selected', 'pr')
  const plain = await t.draw(96, 11)
  expect(words(plain)).not.toContain('Selected:')
  t.w.state.set('quick', { full: true, compact: true })
  const tree = await t.draw(96, 11)
  expect(words(tree)).toContain('Selected:')
  expect(words(tree)).not.toContain('Health:')
  expect(words(tree)).not.toContain('Links 30') // the summary row belongs to the full form
  expect(quickPart(tree).filter(s => s.endsWith(':')).length).toBeGreaterThan(1) // the label of the first line and one more at least
  expect(heightOf(tree, 96)).toBe(11)
  expect(rowBoxes(tree).length).toBeGreaterThanOrEqual(2) // the list keeps its floor
  expect(t.host.asked).toBe(0) // the compact form reads no tool state, with the quick view too
})

// A known limit (review of PR #284): with one row of room the quick view is its first line and the tail `+N more`. `wholeCellsOf` asks
// `fitLine` without the tail, so a name that fits whole has no line of its own, and the tail then takes room from it. The lines that
// would show it are cut with the rest, so the full text shows nowhere until the room is more than one row (L2 of #275 adds the view).
test('a quick view cut to its first line has its tail on that line: the tail takes room from a long name, and no line shows the name', async () => {
  const NAME = 'n'.repeat(80) // 10 cells of label and gap, so 90 of the 96: whole alone, and cut once the tail of 10 cells takes its room
  const long = row(
    'long',
    { control: '', name: NAME, description: 'https://long.example/' },
    { owner: 'web', turns: { first: 3, last: 9 } }, // a line of its own below the first, so the room can be too short for it
  )
  const t = setup([long, ...webs(5)], LINKS)
  t.w.state.set('selected', 'long')
  t.w.state.set('quick', { full: true, compact: true })
  const roomy = quickPart(await t.draw(96, 11)) // room for two rows: the first line has no tail and shows the name whole
  expect(roomy).toContain(NAME)
  expect(roomy).toContain('turns:')
  const tree = await t.draw(96, 11, { focused: false }) // the keys hint line takes a row, so the room is one row
  const part = quickPart(tree)
  expect(part[0]).toBe('Selected:')
  expect(part.some(s => s.startsWith('nnn') && s.endsWith('…'))).toBe(true) // the name, cut
  expect(part.at(-1)).toMatch(/^\+\d+ more$/) // the tail ends the first line
  expect(part.filter(s => s.endsWith(':'))).toEqual(['Selected:']) // no other line: the name has none, nor has anything else
  expect(part).not.toContain(NAME)
  expect(part).not.toContain('turns:') // the line that the room has no row for
  expect(heightOf(tree, 96)).toBe(11)
})

// The wiring of M1 (review of PR #284): `draw` hands the width of the body to `quickLines`, and that width tells it which cells the first
// line draws whole. The pure tests of quick-view.test.ts pass a width of their own, so they cannot see a draw that hands a wider one.
test('a name that the first line cuts at the width of a docked pane has its own line: draw hands the body width to quickLines', async () => {
  const NAME = 'n'.repeat(70) // whole in a body of 96 cells, cut by the first line in one of 49
  const long = row(
    'long',
    { control: '', name: NAME, description: 'https://long.example/' },
    { owner: 'web', turns: { first: 3, last: 9 } },
  )
  const t = setup([long, ...webs(5)], LINKS)
  t.w.state.set('selected', 'long')
  const part = quickPart(await t.draw(49, 31, { placement: 'dock' }))
  expect(part.slice(0, 2)).toEqual(['Selected:', expect.stringMatching(/^nnn.*…$/)]) // the first line cuts the name
  expect(part).toContain('name:') // so the name has a line of its own below it
  expect(part[part.indexOf('name:') + 1]).toMatch(/^nnn/)
  const wide = quickPart(await t.draw(96, 31, { placement: 'inline' })) // a body of 96 cells shows it whole on the first line
  expect(wide).toContain(NAME)
  expect(wide).not.toContain('name:')
})

test('one flag for each form: the same atom hides the quick view of the full form and shows that of the compact form', async () => {
  const t = setup([pull(), ...webs(30)], LINKS)
  t.w.state.set('selected', 'pr')
  t.w.state.set('quick', { full: false, compact: true })
  expect(quickPart(await t.draw(96, 31, { placement: 'dock' })).some(s => LABELS.includes(s))).toBe(false)
  expect(quickPart(await t.draw(96, 11)).some(s => s.endsWith(':') && s !== 'Selected:')).toBe(true)
  t.w.state.set('quick', { full: true, compact: false })
  expect(quickPart(await t.draw(96, 31, { placement: 'dock' })).some(s => LABELS.includes(s))).toBe(true)
  expect(words(await t.draw(96, 11))).not.toContain('Selected:')
})

test('the tree is as tall as the body with the quick view on, in both forms and for the selection at the top, the middle and the end', async () => {
  const t = setup([pull(), ...webs(40)], LINKS)
  t.w.state.set('quick', { full: true, compact: true })
  for (const [cols, rows, placement] of [
    [96, 11, 'inline'],
    [96, 17, 'inline'],
    [96, 18, 'inline'],
    [49, 30, 'dock'],
    [49, 31, 'dock'],
  ] as const) {
    for (const id of ['pr', 'w10', 'w39']) {
      t.w.state.set('selected', id)
      const tree = await t.draw(cols, rows, { placement })
      expect(heightOf(tree, cols), `${cols}x${rows} ${id}`).toBe(rows)
    }
  }
})

// Review of PR #284 (Codex P2): an open selected row keeps its detail lines in the list, so the quick view leaves them. The pane with
// the quick view on is never taller than the pane with the Selected: line alone, and the footer stays in view.
test('an open selected row with a long detail: the tree is as tall as with the quick view hidden, the footer in view, in both forms', async () => {
  const note = (n: number) => ({ label: `note ${n}`, cell: { text: `text of note ${n}` } })
  const open = web('open', { detail: () => [1, 2, 3, 4, 5, 6, 7, 8].map(note) })
  const t = setup([open, ...webs(10)], LINKS)
  t.w.state.set('selected', 'open')
  t.w.state.set('expanded', ['open'])
  for (const [cols, rows, placement, form] of [
    [96, 18, 'inline', 'full'],
    [49, 30, 'dock', 'full'],
    [96, 11, 'inline', 'compact'],
  ] as const) {
    t.w.state.set('quick', { full: false, compact: false })
    const hidden = heightOf(await t.draw(cols, rows, { placement }), cols)
    t.w.state.set('quick', { full: true, compact: true })
    const tree = await t.draw(cols, rows, { placement })
    const at = `${cols}x${rows} ${form}`
    // With the quick view hidden the tree is the body (or taller, where the open row alone is taller than the body: the window limit).
    // The compact form has no `Selected:` line while the quick view is hidden: `e` adds that one row, which it cannot give back.
    expect(heightOf(tree, cols), at).toBeLessThanOrEqual(Math.max(rows, hidden + (form === 'compact' ? 1 : 0)))
    expect(footerOf(tree).length, at).toBeGreaterThan(0)
    expect(words(tree), at).toContain('text of note 1') // the open row shows its own detail lines
  }
})

test('with no row selected the quick view is the one dim line, No row selected, as the status area was', async () => {
  const t = setup(webs(5), LINKS)
  const tree = await t.draw(96, 31, { placement: 'dock' })
  const [props] = texts(tree).find(([, s]) => s === 'No row selected') as [Node['props'], string]
  expect(props.dimColor).toBe(true)
  expect(words(tree).filter(s => s === 'No row selected')).toHaveLength(1)
  expect(words(tree).some(s => LABELS.includes(s))).toBe(false) // one line, no more
  expect(heightOf(tree, 96)).toBe(31)
})

test('the help view draws no quick view, in either form, and asks for no detail() that nobody would see', async () => {
  const seen: string[] = []
  const spy = pull({
    detail: () => {
      seen.push('pr')
      return [{ label: 'note', cell: { text: 'note of pr' } }]
    },
  })
  const t = setup([spy, ...webs(3)], LINKS)
  t.w.state.set('selected', 'pr')
  t.w.state.set('help', true)
  t.w.state.set('quick', { full: true, compact: true })
  for (const rows of [31, 11]) {
    const tree = await t.draw(96, rows, { placement: 'dock' })
    expect(
      words(tree).some(s => LABELS.includes(s)),
      String(rows),
    ).toBe(false)
    expect(words(tree), String(rows)).not.toContain('Selected:')
    expect(words(tree), String(rows)).not.toContain('note of pr')
  }
  // The help view lays no row and builds no quick view: the `detail()` of the selected row is not called, though both flags are on.
  expect(seen).toEqual([])
})

// A9: the draw calls `detail()` of the selected row and no other, and writes nothing.
test('a draw calls detail() of the selected row only, once, and writes nothing', async () => {
  const seen: string[] = []
  const spy = (id: string): TreeRow =>
    web(id, {
      detail: () => {
        seen.push(id)
        return [{ label: 'note', cell: { text: `note of ${id}` } }]
      },
    })
  const t = setup([spy('a'), spy('b'), spy('c')], LINKS)
  t.w.state.set('selected', 'b')
  t.w.stateSets = {}
  const tree = await t.draw(96, 31, { placement: 'dock' })
  expect(seen).toEqual(['b'])
  expect(quickPart(tree)).toContain('note of b')
  expect(t.w.stateSets).toEqual({})
  seen.length = 0
  t.w.state.set('quick', { full: false, compact: false })
  await t.draw(96, 31, { placement: 'dock' })
  expect(seen).toEqual([]) // hidden: the draw asks for no detail at all
})

test('the quick view follows the row the selection falls to when the selected row hides', async () => {
  const t = setup([pull(), ...webs(3)], LINKS)
  t.w.state.set('selected', 'pr')
  await t.draw(96, 31, { placement: 'dock' })
  t.host.sections = [section('web', webs(3))] // `pr` hid: no key from the person
  const tree = await t.draw(96, 31, { placement: 'dock' })
  expect(quickPart(tree)[1]).toBe('w0')
  expect(quickPart(tree).includes('turns:')).toBe(false)
})
