// The selection follows a row that hides (issue #49, PR 2). A row can leave the pane with no key from the person: its
// TTL passes, the process cap takes it, or its run folds. The `selected` atom keeps the id of the vanished row, and the
// pane draws and acts on the row the selection falls to: the next row of the last drawing, else the one before, and for
// a child that a closed row now holds, that row. The atom is not written: a render must not write (E9).
import { expect, test } from 'claude-code/testing'
import { footerKeys, KeyRegistry } from '../core/infra/keys'
import type { FooterKey, PaneView, RowRef, SectionSpec, TreeRow } from '../core/interfaces/view'
import { type PaneHost, PaneSession } from '../hooks/pane-session'
import { resetWidths } from '../ux/tree-data-table/columns'
import { type DrawnRow, handleOf, shownSelection } from '../ux/tree-data-table/table'
import { fakeConfig } from './fixtures/config-fs'
import { buttonOf, handlesOf, nodes, press, rowBoxes } from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { fakePorts } from './fixtures/ports'
import { COLS, row, section } from './fixtures/sections'

const LIMITS = { sectionRows: 50, maxRows: 300 }
const view = (expanded: string[] = []) => ({ expanded: new Set(expanded), shown: () => 0, limits: LIMITS })
const web = (id: string, extra: Partial<TreeRow> = {}): TreeRow =>
  row(id, { prio: '', key: id, title: `https://${id}.example/` }, { owner: 'web', ...extra })
const webs = (...ids: string[]): TreeRow[] => ids.map(id => web(id))
const drawnRow = (id: string, depth = 0): DrawnRow => ({
  id,
  owner: 'web',
  section: 'web',
  can: { dismiss: true, priority: true },
  handle: id,
  depth,
})
const drawnRows = (...ids: string[]): DrawnRow[] => ids.map(id => drawnRow(id))

// ---------------------------------------------------------------- the rule

test('a selected row that is drawn stays selected, and no selection stays none', () => {
  const sections = [section('web', COLS, webs('a', 'b', 'c'))]
  expect(shownSelection(sections, view(), 'b', drawnRows('a', 'b', 'c'))).toBe('b')
  expect(shownSelection(sections, view(), null, drawnRows('a', 'b', 'c'))).toBeNull()
})

test('a row that is gone: the row after it in the last drawing, else the row before it', () => {
  const before = drawnRows('a', 'b', 'c')
  expect(shownSelection([section('web', COLS, webs('a', 'c'))], view(), 'b', before)).toBe('c')
  expect(shownSelection([section('web', COLS, webs('a', 'b'))], view(), 'c', before)).toBe('b')
  expect(shownSelection([section('web', COLS, webs('b', 'c'))], view(), 'a', before)).toBe('b')
})

test('a row that is gone with rows around it that are gone too: the nearest row that is still drawn', () => {
  const before = drawnRows('a', 'b', 'c', 'd', 'e')
  expect(shownSelection([section('web', COLS, webs('a', 'e'))], view(), 'c', before)).toBe('e')
  expect(shownSelection([section('web', COLS, webs('a', 'b'))], view(), 'd', before)).toBe('b')
})

test('the row the last drawing fell to stays while it is drawn, so a redraw does not move the selection', () => {
  const sections = [section('web', COLS, webs('a', 'c', 'd'))]
  // `b` is gone and the last drawing no longer holds it: without the memory of `c` the selection could not be placed.
  expect(shownSelection(sections, view(), 'b', drawnRows('a', 'c', 'd'), 'c')).toBe('c')
  expect(shownSelection(sections, view(), 'b', drawnRows('a', 'c', 'd'), null)).toBe('b')
  expect(shownSelection(sections, view(), 'a', drawnRows('a', 'c', 'd'), 'c')).toBe('a') // a drawn selection wins
  // `c` went too: the search starts where `c` was in the last drawing.
  expect(shownSelection([section('web', COLS, webs('a', 'd'))], view(), 'b', drawnRows('a', 'c', 'd'), 'c')).toBe('d')
})

test('every row of the last drawing is gone too: the first row, or none when the pane has no row', () => {
  const sections = [section('web', COLS, webs('x', 'y'))]
  expect(shownSelection(sections, view(), 'a', drawnRows('a', 'b'))).toBe('x')
  expect(shownSelection([section('web', COLS, [])], view(), 'a', drawnRows('a'))).toBeNull()
  expect(shownSelection([], view(), 'a', drawnRows('a'))).toBeNull()
})

test('a selection that no drawing held and no row holds is no row that hid: it stays, so its keys stay off', () => {
  const sections = [section('web', COLS, webs('a', 'b'))]
  expect(shownSelection(sections, view(), 'zzz', [])).toBe('zzz')
  expect(shownSelection(sections, view(), 'zzz', drawnRows('x', 'y'))).toBe('zzz')
  expect(shownSelection(sections, view(), 'zzz', drawnRows('x', 'y'), 'gone')).toBe('zzz')
})

test('a child of a closed row is not drawn: the selection falls to the closest row above it that is', () => {
  const tree = [
    section('web', COLS, [web('p', { children: [web('c1', { children: [web('g1')] }), web('c2')] }), web('q')]),
  ]
  expect(shownSelection(tree, view(), 'c1', drawnRows('p', 'q'))).toBe('p')
  expect(shownSelection(tree, view(), 'g1', drawnRows('p', 'q'))).toBe('p')
  // With `p` open, `c1` is drawn and `g1` is the child of a closed row.
  expect(shownSelection(tree, view(['p']), 'c1', drawnRows('p', 'q'))).toBe('c1')
  expect(shownSelection(tree, view(['p']), 'g1', drawnRows('p', 'q'))).toBe('c1')
  expect(shownSelection(tree, view(['p', 'c1']), 'g1', drawnRows('p', 'q'))).toBe('g1')
})

test('a row over the cap of its section is not drawn either: the selection moves to a row that is', () => {
  const sections = [section('web', COLS, webs('a', 'b', 'c', 'd'))]
  const capped = { expanded: new Set<string>(), shown: () => 0, limits: { sectionRows: 2, maxRows: 300 } }
  expect(shownSelection(sections, capped, 'd', drawnRows('a', 'b', 'c', 'd'))).toBe('b') // the row before it that is drawn
  expect(shownSelection(sections, capped, 'a', drawnRows('a', 'b', 'c', 'd'))).toBe('a')
})

test('the rows are the ones of a full drawing: an "N more" row is not a row', () => {
  const sections = [section('web', COLS, webs('a', 'b', 'c'))]
  const capped = { expanded: new Set<string>(), shown: () => 0, limits: { sectionRows: 1, maxRows: 300 } }
  expect(handleOf(sections, capped, 'a')).toBe('r0')
  expect(shownSelection(sections, capped, 'c', drawnRows('a', 'b', 'c'))).toBe('a') // `b` and `c` are over the cap now
})

// ---------------------------------------------------------------- the pane

function setup(rows: readonly TreeRow[]) {
  resetWidths()
  const w = fakePorts()
  const reg = new KeyRegistry()
  const host = {
    sections: [section('web', COLS, rows)] as SectionSpec[],
    calls: [] as string[],
    setRows: (next: readonly TreeRow[]): void => {
      host.sections = [section('web', COLS, next)]
    },
    entry: async () => void host.calls.push('entry'),
    paneData: async (_p: unknown, _view: PaneView) => host.sections,
    footer: async (_p: unknown, rowRef: RowRef | undefined, help: boolean): Promise<readonly FooterKey[]> => {
      host.calls.push(`footer ${rowRef?.id}`)
      return footerKeys(reg, rowRef, owner => owner === 'web', help)
    },
    dismiss: async (_p: unknown, ids: readonly string[]) => void host.calls.push(`dismiss ${ids.join(',')}`),
    setPriority: async (_p: unknown, id: string, level: string | undefined) =>
      void host.calls.push(`setPriority ${id} ${level}`),
    refreshManual: async () => void host.calls.push('refreshManual'),
    runAction: async () => {},
    problems: () => [] as string[],
    isItemOwner: (owner: string) => owner === 'web',
    keys: reg,
    config: fakeConfig({}),
  }
  const session = new PaneSession()
  const m = host as unknown as PaneHost
  const draw = () => session.draw(w.ports, m, EL, { bodyColumns: 80 })
  return { w, host, session, draw }
}

/** The handle of the row that the `>` marks, and the handle that holds the ring. */
const marked = (tree: unknown): string | undefined => {
  const box = rowBoxes(tree).find(b => (b.children[0] as { children: unknown[] }).children[0] === '>')
  return nodes(box, 'Button').find(b => /^r\d+$/.test(String(b.props.key)))?.props.key as string | undefined
}
const ringed = (tree: unknown): string[] =>
  nodes(tree, 'Button')
    .filter(b => b.props.autoFocus === true)
    .map(b => String(b.props.key))

test('the row a person selected hides: the > and the ring go to the next row, and its keys are on', async () => {
  const t = setup(webs('a', 'b', 'c'))
  t.w.state.set('selected', 'b')
  const first = await t.draw()
  expect(marked(first)).toBe('r1')
  t.host.setRows(webs('a', 'c')) // `b` leaves with no key pressed
  const after = await t.draw()
  expect(handlesOf(after)).toEqual(['r0', 'r1'])
  expect(marked(after)).toBe('r1') // `c` is the second row now
  expect(ringed(after)).toEqual(['r1'])
  expect(t.host.calls).toContain('footer c') // the footer is the footer of `c`
  expect(buttonOf(after, 'dismiss').props.dimColor).toBeUndefined()
  expect(buttonOf(after, 'prio-1').props.dimColor).toBeUndefined()
})

test('the last row hides: the selection goes to the row before it', async () => {
  const t = setup(webs('a', 'b', 'c'))
  t.w.state.set('selected', 'c')
  await t.draw()
  t.host.setRows(webs('a', 'b'))
  const after = await t.draw()
  expect(marked(after)).toBe('r1')
  expect(ringed(after)).toEqual(['r1'])
})

test('x acts on the row the selection fell to, not on the row that went', async () => {
  const t = setup(webs('a', 'b', 'c'))
  t.w.state.set('selected', 'b')
  await t.draw()
  t.host.setRows(webs('a', 'c'))
  press(buttonOf(await t.draw(), 'dismiss'))
  await t.session.idle()
  expect(t.host.calls.filter(c => c.startsWith('dismiss'))).toEqual(['dismiss c'])
})

test('a digit key acts on the row the selection fell to', async () => {
  const t = setup(webs('a', 'b', 'c'))
  t.w.state.set('selected', 'b')
  await t.draw()
  t.host.setRows(webs('a', 'c'))
  press(buttonOf(await t.draw(), 'prio-1'))
  await t.session.idle()
  expect(t.host.calls.filter(c => c.startsWith('setPriority'))).toEqual(['setPriority c high'])
})

test('a render writes nothing when the selection falls: the atom keeps the id of the vanished row', async () => {
  const t = setup(webs('a', 'b', 'c'))
  t.w.state.set('selected', 'b')
  await t.draw()
  t.w.stateSets = {}
  t.host.setRows(webs('a', 'c'))
  await t.draw()
  expect(t.w.stateSets).toEqual({})
  expect(t.w.state.get('selected')).toBe('b')
})

test('the selection stays on the row it fell to over the redraws that follow', async () => {
  const t = setup(webs('a', 'b', 'c', 'd'))
  t.w.state.set('selected', 'b')
  await t.draw()
  t.host.setRows(webs('a', 'c', 'd'))
  for (let i = 0; i < 3; i++) {
    const tree = await t.draw()
    expect(marked(tree)).toBe('r1') // `c`, every time: the last drawing no longer holds `b`
    expect(ringed(tree)).toEqual(['r1'])
  }
  t.host.setRows(webs('a', 'd')) // then `c` goes too: the row after it in the last drawing
  expect(marked(await t.draw())).toBe('r1') // `d`
})

test('a row that comes back is selected again: the atom still names it', async () => {
  const t = setup(webs('a', 'b', 'c'))
  t.w.state.set('selected', 'b')
  await t.draw()
  t.host.setRows(webs('a', 'c'))
  await t.draw()
  t.host.setRows(webs('a', 'b', 'c')) // `/track show-all`, say
  expect(marked(await t.draw())).toBe('r1')
})

test('a selection that the person writes after a drawing wins over the row that drawing fell to', async () => {
  const t = setup(webs('a', 'b', 'c'))
  t.w.state.set('selected', 'b')
  await t.draw()
  t.host.setRows(webs('a', 'c'))
  const tree = await t.draw() // the selection fell to `c`
  t.w.state.set('selected', 'a') // a click on `a` comes before the next drawing
  press(buttonOf(tree, 'dismiss'))
  await t.session.idle()
  expect(t.host.calls.filter(c => c.startsWith('dismiss'))).toEqual(['dismiss a'])
})

// The engine's own take of the ring (origin plugin, `autoFocus`) lands on a handle of a frame that can be older than the
// selection (issue #115). It never replaces a selected row that is drawn. The row the pane treats as selected counts as
// that row also when it is not the atom's: the atom names a row that hid, and the drawing fell to another one.
test('a landing of the engine does not replace the row the selection fell to, and the atom keeps the vanished row', async () => {
  const t = setup(webs('a', 'b', 'c'))
  t.w.state.set('selected', 'b')
  await t.draw()
  t.host.setRows(webs('a', 'c')) // `b` hides: the selection falls to `c`
  await t.draw()
  await t.session.focused(t.w.ports, 'r0', 'plugin') // a handle of an older frame: `a` sits there now
  expect(t.w.state.get('selected')).toBe('b')
  t.host.setRows(webs('a', 'b', 'c')) // `b` comes back and is the selection again
  const tree = await t.draw()
  expect(marked(tree)).toBe('r1')
  press(buttonOf(tree, 'dismiss'))
  await t.session.idle()
  expect(t.host.calls.filter(c => c.startsWith('dismiss'))).toEqual(['dismiss b'])
})

test('a move of the person selects the row under the ring, also when the selection fell to another row', async () => {
  const t = setup(webs('a', 'b', 'c'))
  t.w.state.set('selected', 'b')
  await t.draw()
  t.host.setRows(webs('a', 'c'))
  await t.draw()
  await t.session.focused(t.w.ports, 'r0', 'person') // Tab or a click on `a`
  expect(t.w.state.get('selected')).toBe('a')
})

test('nothing selected stays nothing selected: no row is marked and the keys are off', async () => {
  const t = setup(webs('a', 'b'))
  const tree = await t.draw()
  expect(marked(tree)).toBeUndefined()
  expect(buttonOf(tree, 'dismiss').props.dimColor).toBe(true)
})

test('a selection that no row holds, before any drawing, is left as it is: nothing is marked and the keys are off', async () => {
  const t = setup(webs('a', 'b'))
  t.w.state.set('selected', 'zzz')
  const tree = await t.draw()
  expect(marked(tree)).toBeUndefined()
  expect(ringed(tree)).toEqual(['r0']) // the ring starts on the first row, as it always did
  expect(buttonOf(tree, 'dismiss').props.dimColor).toBe(true)
})

test('every row hidden: no row is marked, the keys are off and the drawing does not throw', async () => {
  const t = setup(webs('a'))
  t.w.state.set('selected', 'a')
  await t.draw()
  t.host.setRows([])
  const tree = await t.draw()
  expect(marked(tree)).toBeUndefined()
  expect(buttonOf(tree, 'dismiss').props.dimColor).toBe(true)
})

test('the selected row hides while the help view is open: after it closes the selection is on the row it fell to', async () => {
  const t = setup(webs('a', 'b', 'c'))
  t.w.state.set('selected', 'b')
  await t.draw()
  t.w.state.set('help', true)
  await t.draw() // the help view holds no row: the last drawing has none
  t.host.setRows(webs('a', 'c')) // `b` hides while the person reads the help
  await t.draw()
  t.w.state.set('help', false)
  const tree = await t.draw()
  expect(marked(tree)).toBe('r1') // `c`
  expect(ringed(tree)).toEqual(['r1'])
  expect(buttonOf(tree, 'dismiss').props.dimColor).toBeUndefined() // the keys are on
})

test('every row hides and rows come back: the first row is selected', async () => {
  const t = setup(webs('a'))
  t.w.state.set('selected', 'a')
  await t.draw()
  t.host.setRows([]) // the last drawing holds no row now
  await t.draw()
  t.host.setRows(webs('x', 'y'))
  const tree = await t.draw()
  expect(marked(tree)).toBe('r0') // `x`
  expect(buttonOf(tree, 'dismiss').props.dimColor).toBeUndefined()
})

test('the row a run folds into: the selection of a child that a closed fold row now holds is the fold row', async () => {
  const kids = [web('k1'), web('k2')]
  const t = setup([web('fold', { children: kids, can: { dismiss: false, priority: false } }), web('z')])
  t.w.state.set('selected', 'k2')
  const tree = await t.draw()
  expect(marked(tree)).toBe('r0') // `fold`, the closest row above `k2` that is drawn
  expect(buttonOf(tree, 'dismiss').props.dimColor).toBe(true) // and x is dim on a fold row
})
