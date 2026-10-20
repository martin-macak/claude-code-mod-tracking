// PaneSession: the per-load state of the pane (the last drawing, a pending refocus) and the writes behind its Buttons,
// on fakePorts and a fake host. The text helpers (listText, helpTextOf) are tested here too. Plan: L6 Task 11 (G6, G8, G22).
import { expect, test } from 'claude-code/testing'
import { buttonKeyOf, footerKeys, KeyRegistry } from '../core/infra/keys'
import type { AtomPort } from '../core/interfaces/ports'
import type { FooterKey, PaneView, RowRef, SectionSpec, TreeRow } from '../core/interfaces/view'
import { helpTextOf, listText, type PaneHost, PaneSession, TEXT_VIEW } from '../hooks/pane-session'
import { resetWidths } from '../ux/tree-data-table/columns'
import { neighbourOf } from '../ux/tree-data-table/table'
import { fakeConfig } from './fixtures/config-fs'
import { buttonOf, footerOf, handlesOf, leaves, nodes, press, rowBoxes, texts } from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { fakePorts } from './fixtures/ports'
import { COLS, row, section } from './fixtures/sections'

/** A web row of the owner `web`, the one item owner of these tests. */
const web = (id: string, extra: Partial<TreeRow> = {}, key = id): TreeRow =>
  row(id, { prio: '', key, title: `https://${id}.example/` }, { owner: 'web', ...extra })

const webs = (...ids: string[]): TreeRow[] => ids.map(id => web(id))

function setup(
  rows: readonly TreeRow[],
  o: { path?: string; problems?: string[]; file?: Record<string, unknown>; version?: string } = {},
) {
  resetWidths()
  const w = fakePorts()
  const reg = new KeyRegistry()
  const host = {
    sections: [section('web', COLS, rows)] as SectionSpec[],
    views: [] as PaneView[],
    calls: [] as string[],
    keyProblems: [] as string[],
    /** The version the manager read from the manifest. Absent: the help view has no version line. */
    version: o.version,
    /** Every footer key live: the session's own route decides, not the footer's state. */
    allLive: false,
    setRows: (rows: readonly TreeRow[]): void => {
      host.sections = [section('web', COLS, rows)]
    },
    /** What a fake write does to `sections`. */
    onDismiss: (_ids: readonly string[]): void => {},
    onPriority: (_id: string, _level: string | undefined): void => {},
    setPriorityError: undefined as Error | undefined,
    entry: async () => void host.calls.push('entry'),
    paneData: async (_p: unknown, view: PaneView) => {
      host.views.push(view)
      return host.sections
    },
    footer: async (_p: unknown, rowRef: RowRef | undefined, help: boolean): Promise<readonly FooterKey[]> =>
      host.allLive
        ? reg.all().map(k => ({ ...k, enabled: true, buttonKey: buttonKeyOf(k) }))
        : footerKeys(reg, rowRef, owner => owner === 'web', help),
    dismiss: async (_p: unknown, ids: readonly string[]) => {
      host.calls.push(`dismiss ${ids.join(',')}`)
      host.onDismiss(ids)
    },
    setPriority: async (_p: unknown, id: string, level: string | undefined) => {
      if (host.setPriorityError) throw host.setPriorityError
      host.calls.push(`setPriority ${id} ${level}`)
      host.onPriority(id, level)
    },
    refreshManual: async () => void host.calls.push('refreshManual'),
    runAction: async (_p: unknown, owner: string, id: string, rowId: string | null) =>
      void host.calls.push(`runAction ${owner}.${id} ${rowId}`),
    problems: () => host.keyProblems,
    isItemOwner: (owner: string) => owner === 'web',
    keys: reg,
    config: fakeConfig({ path: o.path, problems: o.problems, file: o.file as never }),
  }
  const session = new PaneSession()
  const m = host as unknown as PaneHost
  const draw = (cols = 80, rows?: number, focused?: boolean) =>
    session.draw(w.ports, m, EL, { bodyColumns: cols, bodyRows: rows, focused })
  /** Presses the Button of a drawing and waits for the work it started. */
  const pressKey = async (key: string) => {
    press(buttonOf(await draw(), key))
    await session.idle()
  }
  const selected = () => w.state.get('selected') ?? null
  return { w, host, session, m, draw, pressKey, selected }
}

/** The rows `a`, `b`, `c` with `b` selected: handles r0, r1, r2. */
async function abc() {
  const t = setup(webs('a', 'b', 'c'))
  t.w.state.set('selected', 'b')
  await t.draw()
  t.w.stateSets = {}
  return t
}

/** The width of the `type` cell of the first row: the gutter, then prio, key, title, type. */
const typeWidth = (tree: unknown): unknown => {
  const box = rowBoxes(tree)[0]?.children[4] as { props: { width: unknown } } | undefined
  return box?.props.width
}

/** Lets the work already started run, as far as it can: the fake ports answer in microtasks. No `idle()`: it may never end. */
const turn = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

test('draw reads expanded, selected, help and shown and writes nothing', async () => {
  const t = setup(webs('a', 'b'))
  const tree = await t.draw()
  expect(t.w.stateSets).toEqual({})
  expect(handlesOf(tree)).toEqual(['r0', 'r1'])
  expect(t.w.ui.focused).toEqual([])
  expect(t.host.calls).toEqual([]) // no entry: a render must not write
})

test('draw passes the selected row, the config caps and the footer to the table', async () => {
  const t = setup(webs('a', 'b', 'c', 'd', 'e', 'f', 'g'), { file: { global: { ui: { sectionRows: 5 } } } })
  t.w.state.set('selected', 'b')
  const tree = await t.draw()
  expect(handlesOf(tree)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4'])
  expect(buttonOf(tree, 'm0').props.label).toBe('2 more')
  expect(footerOf(tree).map(b => b.props.hotkey)).toEqual(['r', 'h', 'x', '1', '2', '3', '0'])
  expect(buttonOf(tree, 'dismiss').props.dimColor).toBeUndefined() // the selected row can be dismissed
  expect(t.host.views).toEqual([{ selected: 'b', expanded: new Set() }])
})

test('draw with the help on draws the help view in place of the rows', async () => {
  const t = setup(webs('a'), { path: '/p/config.json', problems: ['X.'] })
  t.w.state.set('help', true)
  const tree = await t.draw()
  expect(handlesOf(tree)).toEqual([])
  const lines = leaves(tree)
  expect(lines).toContain('Pane keys (Tab, Shift+Tab, Up, Down move between rows)')
  expect(lines).toContain('Config file: /p/config.json')
  expect(lines).toContain('X.')
  expect(buttonOf(tree, 'help').props.label).toBe('back')
})

test('draw hands the body height to the help view: a short body draws it compact, a body that fits draws it whole', async () => {
  const t = setup(webs('a'), { path: '/p/config.json', version: '1.2.3' })
  t.w.state.set('help', true)
  const help = async (rows?: number) => (await t.draw(96, rows)) as unknown as { children: { children: unknown[] }[] }
  // The full view is 2 titles, 7 keys, the config line and the version line. The compact view is 7 lines: three keys to a line.
  expect((await help(undefined)).children[0]?.children).toHaveLength(11)
  expect((await help(28)).children[0]?.children).toHaveLength(11)
  expect((await help(11)).children[0]?.children).toHaveLength(7)
})

test('draw with the help on draws the version line after the config line', async () => {
  const t = setup(webs('a'), { path: '/p/config.json', version: '1.2.3' })
  t.w.state.set('help', true)
  const lines = leaves(await t.draw())
  const at = lines.indexOf('Config file: /p/config.json')
  expect(at).toBeGreaterThan(-1)
  expect(lines[at + 1]).toBe('Version: 1.2.3')
})

test('focused writes selected for a row handle only', async () => {
  const t = setup(webs('a', 'b'))
  await t.draw()
  await t.session.focused(t.w.ports, 'r1')
  expect(t.selected()).toBe('b')
  expect(t.w.stateSets.selected).toBe(1)
  for (const element of ['refresh', 'm0', 'prio-1', 'r9', undefined]) await t.session.focused(t.w.ports, element)
  expect(t.w.stateSets.selected).toBe(1)
  expect(t.selected()).toBe('b')
})

test('a pending refocus wins over the last drawn map for its key, once', async () => {
  const t = setup(webs('a', 'b', 'c'))
  t.w.state.set('selected', 'c')
  await t.draw() // r0 a, r1 b, r2 c
  t.host.onPriority = () => t.host.setRows(webs('c', 'a', 'b')) // c moves first
  await t.pressKey('prio-1')
  expect(t.w.ui.focused).toEqual(['r0'])
  t.w.state.set('selected', 'zzz') // the ring has not moved the selection yet
  await t.session.focused(t.w.ports, 'r0')
  expect(t.selected()).toBe('c') // the pending id, though the drawn map still says r0 is a
  await t.session.focused(t.w.ports, 'r0')
  expect(t.selected()).toBe('a') // the pending entry is spent: the drawn map answers
})

// ---------------------------------------------------------------- the window (issue #109)

const TWELVE = webs(...Array.from({ length: 12 }, (_, i) => `w${i}`))
/** A body of 11 rows, 96 cells wide: the inline pane at 100x40. It shows 6 of 12 rows. */
const SHORT = 11
const shownIds = (tree: unknown): string[] => rowBoxes(tree).map(b => leaves(b).join(' ').match(/w\d+/)?.[0] ?? '?')

test('draw hands the window its place back: a selection inside the window does not move it', async () => {
  const t = setup(TWELVE)
  t.w.state.set('selected', 'w10')
  expect(shownIds(await t.draw(96, SHORT))).toEqual(['w6', 'w7', 'w8', 'w9', 'w10', 'w11'])
  t.w.state.set('selected', 'w6') // the last draw began at w6: it stays there
  expect(shownIds(await t.draw(96, SHORT))).toEqual(['w6', 'w7', 'w8', 'w9', 'w10', 'w11'])
  t.w.state.set('selected', 'w5') // above it: the window moves up by the least
  expect(shownIds(await t.draw(96, SHORT))).toEqual(['w5', 'w6', 'w7', 'w8', 'w9'])
})

test('draw with no body height draws every row and writes nothing', async () => {
  const t = setup(TWELVE)
  expect(shownIds(await t.draw(96, undefined))).toHaveLength(12)
  expect(t.w.stateSets).toEqual({})
  expect(t.w.ui.invalidated).toBe(0)
})

test('with nothing selected the window starts on the first rows, whatever place an earlier draw left', async () => {
  const t = setup(TWELVE)
  t.w.state.set('selected', 'w11')
  expect(shownIds(await t.draw(96, SHORT))[0]).toBe('w6')
  t.w.state.set('selected', null) // a pane that opens again: a late draw after the close had left top at 6
  expect(shownIds(await t.draw(96, SHORT))).toEqual(['w0', 'w1', 'w2', 'w3', 'w4', 'w5'])
})

test('the help view keeps the place of the window: h and h again show the same rows', async () => {
  const t = setup(TWELVE)
  t.w.state.set('selected', 'w10')
  await t.draw(96, SHORT) // the window began at w6
  t.w.state.set('selected', 'w6') // the ring walked up inside the window: it stays at w6
  const before = shownIds(await t.draw(96, SHORT))
  expect(before).toEqual(['w6', 'w7', 'w8', 'w9', 'w10', 'w11'])
  t.w.state.set('help', true) // the help view draws no window: its drawing has no place to give back
  await t.draw(96, SHORT)
  t.w.state.set('help', false)
  expect(shownIds(await t.draw(96, SHORT))).toEqual(before)
})

test('closed forgets the window: the next pane opens on the first rows', async () => {
  const t = setup(TWELVE)
  t.w.state.set('selected', 'w11')
  await t.draw(96, SHORT)
  await t.session.closed(t.w.ports)
  expect(shownIds(await t.draw(96, SHORT))).toEqual(['w0', 'w1', 'w2', 'w3', 'w4', 'w5'])
})

test('a focus on a row handle out of the window selects the row; the next draw shows it', async () => {
  const t = setup(TWELVE)
  await t.draw(96, SHORT)
  await t.session.focused(t.w.ports, 'r8') // a stop below the window: the ring walked onto it
  expect(t.selected()).toBe('w8')
  expect(shownIds(await t.draw(96, SHORT))).toContain('w8')
})

test('a focus on a "N more" stop out of the window asks for a redraw and the next draw shows the row', async () => {
  const t = setup(TWELVE, { file: { global: { ui: { sectionRows: 8 } } } })
  const first = await t.draw(96, SHORT)
  expect(
    nodes(first, 'Box').filter(b => b.props.height === 0 && nodes(b, 'Button').some(x => x.props.key === 'm0')),
  ).toHaveLength(1)
  await t.session.focused(t.w.ports, 'm0')
  expect(t.w.ui.invalidated).toBe(1)
  const next = await t.draw(96, SHORT)
  expect(
    nodes(next, 'Box').filter(b => b.props.height === 0 && nodes(b, 'Button').some(x => x.props.key === 'm0')),
  ).toHaveLength(0)
  expect(buttonOf(next, 'm0').props.label).toBe('4 more')
  await t.session.focused(t.w.ports, 'r3') // the ring walked back onto a row: the row leads again
  expect(t.selected()).toBe('w3')
})

test('Enter on an "N more" Button puts the ring on the selected row, and the window follows that row again', async () => {
  // The ring sits on a position among the Buttons. The new rows come in before the N more Button, so its position holds the
  // stop of the first new row, a row out of the window: no row would show the ring, and the next Tab would skip a row.
  const t = setup(TWELVE, { file: { global: { ui: { sectionRows: 5 } } } })
  t.w.state.set('selected', 'w4')
  const first = await t.draw(96, SHORT) // 5 rows and the N more row fit the body: no window yet
  await t.session.focused(t.w.ports, 'm0') // Tab put the ring on the N more Button
  press(buttonOf(first, 'm0'))
  await t.session.idle()
  expect(await t.w.ports.state.shown.get('web')).toBe(5)
  expect(t.w.ui.focused).toEqual(['r4']) // the ring goes back onto the selected row
  expect(t.selected()).toBe('w4')
  // Ten rows and "2 more" now overflow the body. The ring is off the N more Button, so the window shows the selected row
  // and not the end of the list where the N more row is.
  expect(shownIds(await t.draw(96, SHORT))).toContain('w4')
})

test('Enter on an "N more" Button with no row selected asks for no ring', async () => {
  const t = setup(TWELVE, { file: { global: { ui: { sectionRows: 5 } } } })
  press(buttonOf(await t.draw(96, SHORT), 'm0'))
  await t.session.idle()
  expect(await t.w.ports.state.shown.get('web')).toBe(5)
  expect(t.w.ui.focused).toEqual([])
})

test('a focus on a "N more" Button asks for no redraw when every row shows', async () => {
  const t = setup(TWELVE, { file: { global: { ui: { sectionRows: 8 } } } })
  await t.draw(96, 40)
  await t.session.focused(t.w.ports, 'm0')
  expect(t.w.ui.invalidated).toBe(0)
})

test('the engine takes the ring off a "N more" Button onto the selected row: the window follows that row, not the Button', async () => {
  // The engine's own take of the ring (origin plugin, `autoFocus`) lands on a row that is drawn and selected. The selection
  // stays (issue #115), but the ring has left the N more Button, so its row no longer has to show.
  const t = setup(TWELVE, { file: { global: { ui: { sectionRows: 8 } } } })
  t.w.state.set('selected', 'w1')
  await t.draw(96, SHORT, true)
  await t.session.focused(t.w.ports, 'm0') // Tab put the ring on the N more Button: the window goes to the end of the list
  expect(shownIds(await t.draw(96, SHORT, true))).not.toContain('w1')
  await t.session.focused(t.w.ports, 'r1', 'plugin') // w1 is drawn and selected: the selection stays
  expect(t.selected()).toBe('w1')
  expect(shownIds(await t.draw(96, SHORT, true))).toContain('w1')
})

test('scrolled: a page key moves the selection by a page less one row and the ring after it', async () => {
  const t = setup(TWELVE)
  t.w.state.set('selected', 'w0')
  await t.draw(96, SHORT) // a page of 6 rows
  expect(await t.session.scrolled(t.w.ports, t.m, 11)).toBe(true)
  expect(t.selected()).toBe('w5')
  expect(t.w.ui.focused).toEqual(['r5'])
  expect(await t.session.scrolled(t.w.ports, t.m, 11)).toBe(true)
  expect(t.selected()).toBe('w10')
  expect(await t.session.scrolled(t.w.ports, t.m, 11)).toBe(true) // clamps at the last row
  expect(t.selected()).toBe('w11')
  expect(await t.session.scrolled(t.w.ports, t.m, -11)).toBe(true)
  expect(t.selected()).toBe('w6')
})

test('scrolled: a wheel tick moves one row; at the first row it moves nothing but the engine stays out of it', async () => {
  const t = setup(TWELVE)
  t.w.state.set('selected', 'w1')
  await t.draw(96, SHORT)
  expect(await t.session.scrolled(t.w.ports, t.m, 1)).toBe(true)
  expect(t.selected()).toBe('w2')
  expect(await t.session.scrolled(t.w.ports, t.m, -1)).toBe(true)
  expect(await t.session.scrolled(t.w.ports, t.m, -1)).toBe(true)
  expect(t.selected()).toBe('w0')
  t.w.ui.focused.length = 0
  expect(await t.session.scrolled(t.w.ports, t.m, -1)).toBe(true) // already at the top
  expect(t.w.ui.focused).toEqual([])
})

test('scrolled: with no row selected a page key starts from the first row', async () => {
  const t = setup(TWELVE)
  await t.draw(96, SHORT)
  expect(await t.session.scrolled(t.w.ports, t.m, 11)).toBe(true)
  expect(t.selected()).toBe('w5')
})

test('scrolled leaves the move to the engine when no window cuts the rows', async () => {
  const t = setup(TWELVE)
  expect(await t.session.scrolled(t.w.ports, t.m, 1)).toBe(false) // nothing drawn yet
  await t.draw(96, 40)
  expect(await t.session.scrolled(t.w.ports, t.m, 11)).toBe(false)
  await t.draw(96, undefined)
  expect(await t.session.scrolled(t.w.ports, t.m, 11)).toBe(false)
  expect(t.w.ui.focused).toEqual([])
})

test('scrolled with a failing write logs one line and keeps the engine out of the move', async () => {
  const t = setup(TWELVE)
  await t.draw(96, SHORT)
  ;(t.w.ports.state as { selected: unknown }).selected = {
    get: async () => null,
    update: async () => {
      throw new Error('boom')
    },
  }
  expect(await t.session.scrolled(t.w.ports, t.m, 11)).toBe(true)
  expect(t.w.logs).toEqual(['pane: scroll failed: boom'])
})

/** The ids of the rows drawn in full: the host of the row title, as `web()` makes it. */
const viewIds = (tree: unknown): string[] =>
  rowBoxes(tree).map(
    b =>
      leaves(b)
        .join(' ')
        .match(/https:\/\/(\w+)\.example/)?.[1] ?? '?',
  )

test('a run folds while its last agent is selected: its agents are no unit of the window and the window follows the fold row', async () => {
  // Twenty agents are rows below four others, and the last of them is selected, so the window sits at the end. The run folds
  // (issue #49): its agents are the children of one closed row. The pane falls to that row, which sits far above the old
  // window. The agents have no stop and no part in the hints, and the window moves up to the fold row.
  const agents = Array.from({ length: 20 }, (_, i) => web(`a${i}`))
  const head = webs('h0', 'h1', 'h2', 'h3')
  const tail = webs('t0', 't1')
  const t = setup([...head, ...agents, ...tail])
  t.w.state.set('selected', 'a19')
  const before = await t.draw(96, SHORT)
  expect(viewIds(before)).toContain('a19')
  expect(handlesOf(before)).toHaveLength(26)

  t.host.setRows([...head, web('fold', { children: agents, can: { dismiss: false, priority: false } }), ...tail])
  const after = await t.draw(96, SHORT)
  expect(handlesOf(after)).toHaveLength(7) // four rows, the fold row and two rows: no stop for an agent below the fold
  expect(viewIds(after)).toContain('fold') // in view, though it was far above the window that held a19
  expect(viewIds(after).some(id => id.startsWith('a'))).toBe(false)
  const marked = rowBoxes(after).find(b => leaves(b)[0] === '>')
  expect(marked === undefined ? undefined : leaves(marked).join(' ')).toContain('https://fold.example/')
  const counted = texts(after)
    .map(([, line]) => line.match(/^[▲▼] (\d+) more (above|below)$/)?.[1])
    .reduce((sum, n) => sum + Number(n ?? 0), 0)
  expect(viewIds(after).length + counted).toBe(7) // the hints count the rows out of view and no agent
  expect(t.selected()).toBe('a19') // nothing writes the atom
})

test('scrolled: after the selected row hid, a page key moves from the row the selection fell to, not from the first row', async () => {
  // w11 is the last row and selected. It leaves with no key from the person (issue #49): the pane treats w10 as selected and
  // the atom still names w11. The wheel moves one row up from w10, so it must not read the atom and start at the first row.
  const t = setup(TWELVE)
  t.w.state.set('selected', 'w11')
  await t.draw(96, SHORT)
  t.host.setRows(TWELVE.filter(r => r.id !== 'w11'))
  expect(shownIds(await t.draw(96, SHORT))).toContain('w10')
  expect(await t.session.scrolled(t.w.ports, t.m, -1)).toBe(true)
  expect(t.selected()).toBe('w9')
  expect(t.w.ui.focused).toEqual(['r9'])
})

test('Enter on an "N more" Button after the selected row hid puts the ring on the row the selection fell to', async () => {
  // w4 is the last row of the cap and selected. It hides with no key (issue #49) and the pane falls to w3. The Button asks
  // for the ring on the selected row: the atom names w4, which has no handle, so the ring would stay on the stop of the
  // first new row, a row the window may hide.
  const t = setup(TWELVE, { file: { global: { ui: { sectionRows: 5 } } } })
  t.w.state.set('selected', 'w4')
  await t.draw(96, SHORT)
  t.host.setRows(TWELVE.filter(r => r.id !== 'w4'))
  const second = await t.draw(96, SHORT)
  press(buttonOf(second, 'm0'))
  await t.session.idle()
  expect(await t.w.ports.state.shown.get('web')).toBe(5)
  expect(t.w.ui.focused).toEqual(['r3'])
  expect(t.selected()).toBe('w3')
})

test('toggle flips the id in expanded; more adds sectionRows to shown(section)', async () => {
  const t = setup(webs('a', 'b'))
  const tree = await t.draw()
  press(buttonOf(tree, 'r1'))
  await t.session.idle()
  expect(t.w.state.get('expanded')).toEqual(['b'])
  press(buttonOf(tree, 'r1'))
  await t.session.idle()
  expect(t.w.state.get('expanded')).toEqual([])
  expect(await t.w.ports.state.shown.get('web')).toBe(0)
  const over = setup(webs('a', 'b', 'c', 'd', 'e', 'f', 'g'), { file: { global: { ui: { sectionRows: 5 } } } })
  press(buttonOf(await over.draw(), 'm0'))
  await over.session.idle()
  expect(await over.w.ports.state.shown.get('web')).toBe(5)
  expect(handlesOf(await over.draw())).toHaveLength(7)
})

// Issue #108, option 2. A click on the arrow of a row is a press, and the press must select the row. The ring follows, as
// after `x` and the digits, so Tab and the arrows go on from the row the person chose.
test('toggle also selects the row and asks the engine for the ring on its handle', async () => {
  const t = setup(webs('a', 'b', 'c'))
  t.w.state.set('selected', 'a')
  const tree = await t.draw()
  press(buttonOf(tree, 'r2')) // a click on c
  await t.session.idle()
  expect(t.w.state.get('expanded')).toEqual(['c'])
  expect(t.selected()).toBe('c')
  expect(t.w.ui.focused).toEqual(['r2'])
  press(buttonOf(await t.draw(), 'r2')) // the second press closes the row and keeps it selected
  await t.session.idle()
  expect(t.w.state.get('expanded')).toEqual([])
  expect(t.selected()).toBe('c')
})

test('a press asks for the ring on the handle of the pressed row, also after an earlier row opened', async () => {
  // `a` has a child, so once `a` is open `b` has the handle r2 and not r1: the ring must go where `b` is in the drawing.
  const t = setup([web('a', { children: [web('a1')] }), web('b')])
  const tree = await t.draw()
  expect(handlesOf(tree)).toEqual(['r0', 'r1'])
  press(buttonOf(tree, 'r1')) // b, at r1 while a is closed
  await t.session.idle()
  expect(t.selected()).toBe('b')
  expect(t.w.ui.focused).toEqual(['r1'])
  t.w.ui.focused.length = 0
  t.w.state.set('expanded', ['a'])
  press(buttonOf(await t.draw(), 'r2')) // b again, now at r2: closing leaves it there
  await t.session.idle()
  expect(t.w.ui.focused).toEqual(['r2'])
})

test('a refused or failed ring request leaves the selection written', async () => {
  const t = setup(webs('a', 'b'))
  for (const focus of [async () => false, async () => Promise.reject(new Error('no engine'))]) {
    ;(t.w.ports.ui as { focus: unknown }).focus = focus
    press(buttonOf(await t.draw(), 'r1'))
    await t.session.idle()
    expect(t.selected()).toBe('b')
    t.w.state.set('selected', null)
  }
})

// Issue #115. A press on a Button does not give the pane the keys, and `ui.focus` only moves the ring inside a pane that
// holds them (live: `{"deny":"that site does not hold the keys"}`). So Up and Down went on to the prompt history. The
// press asks for the keys with the one call that grants them: `ui.open` with `focus: true`. The calls below are named in
// the order the engine sees them.
function engineLog(t: ReturnType<typeof setup>) {
  const calls: string[] = []
  const ui = t.w.ports.ui as { open: () => Promise<boolean>; focus: (key: string) => Promise<boolean> }
  ui.open = async () => {
    calls.push('open')
    t.w.ui.opened++
    return true
  }
  ui.focus = async key => {
    calls.push(`focus ${key}`)
    t.w.ui.focused.push(key)
    return true
  }
  return calls
}

test('a press while the pane has no keys selects and opens the row, asks for the keys, then for the ring', async () => {
  const t = setup(webs('a', 'b', 'c'))
  t.w.state.set('selected', 'a')
  const calls = engineLog(t)
  press(buttonOf(await t.draw(80, undefined, false), 'r2')) // a click on c while the prompt has the keys
  await t.session.idle()
  expect(calls).toEqual(['open', 'focus r2'])
  expect(t.selected()).toBe('c')
  expect(t.w.state.get('expanded')).toEqual(['c'])
})

test('a press while the pane has the keys, or does not say, asks for no keys', async () => {
  for (const focused of [true, undefined]) {
    const t = setup(webs('a', 'b', 'c'))
    const calls = engineLog(t)
    press(buttonOf(await t.draw(80, undefined, focused), 'r2'))
    await t.session.idle()
    expect(calls).toEqual(['focus r2'])
    expect(t.selected()).toBe('c')
  }
})

test('a press asks again after the keys came: only a drawing that says no keys makes it ask', async () => {
  const t = setup(webs('a', 'b'))
  const calls = engineLog(t)
  press(buttonOf(await t.draw(80, undefined, false), 'r0'))
  await t.session.idle()
  press(buttonOf(await t.draw(80, undefined, true), 'r1')) // the engine drew the pane again with the keys
  await t.session.idle()
  expect(calls).toEqual(['open', 'focus r0', 'focus r1'])
})

// One session can be drawn on several surfaces (a terminal and the desktop), and each has its own `Pane.isFocused`. A
// press belongs to the tree it was drawn in: it asks for the keys when that drawing said `false`, whichever surface drew
// last (review of PR #121).
test('a press asks for the keys by the drawing it belongs to, not by the drawing that came last', async () => {
  const t = setup(webs('a', 'b', 'c'))
  const calls = engineLog(t)
  const noKeys = await t.draw(80, undefined, false) // a surface that has no keys
  const keys = await t.draw(80, undefined, true) // another surface draws later, and it has them
  press(buttonOf(noKeys, 'r1'))
  await t.session.idle()
  expect(calls).toEqual(['open', 'focus r1'])
  press(buttonOf(keys, 'r2'))
  await t.session.idle()
  expect(calls).toEqual(['open', 'focus r1', 'focus r2'])
  const keysFirst = await t.draw(80, undefined, true)
  await t.draw(80, undefined, false) // the surface without keys draws last
  press(buttonOf(keysFirst, 'r0'))
  await t.session.idle()
  expect(calls).toEqual(['open', 'focus r1', 'focus r2', 'focus r0'])
})

// The engine refuses `focus: true` while the composer holds text (issue #108, case C): the pane stays without keys, and
// the ring request is refused too. The row stays selected and the dim hint stays. Nothing is shown and nothing loops: a
// later press asks once more.
test('a refused request for the keys leaves the row selected, shows no error and asks once per press', async () => {
  const t = setup(webs('a', 'b', 'c'))
  const calls = engineLog(t)
  ;(t.w.ports.ui as { focus: unknown }).focus = async (key: string) => {
    calls.push(`focus ${key}`)
    return false
  }
  press(buttonOf(await t.draw(80, undefined, false), 'r1'))
  await t.session.idle()
  expect(calls).toEqual(['open', 'focus r1'])
  expect(t.selected()).toBe('b')
  press(buttonOf(await t.draw(80, undefined, false), 'r2'))
  await t.session.idle()
  expect(calls).toEqual(['open', 'focus r1', 'open', 'focus r2'])
  expect(t.selected()).toBe('c')
  expect(t.w.ui.toasts).toEqual([])
  expect(t.w.logs).toEqual([])
  // The refused ring request is forgotten: a later Tab onto r2 selects the row drawn there, as it does after any refusal.
  await t.session.focused(t.w.ports, 'r0')
  expect(t.selected()).toBe('a')
})

test('a call for the keys that throws logs one line, and the press still selects the row and asks for the ring', async () => {
  const t = setup(webs('a', 'b'))
  const calls = engineLog(t)
  ;(t.w.ports.ui as { open: unknown }).open = async () => Promise.reject(new Error('no engine'))
  press(buttonOf(await t.draw(80, undefined, false), 'r1'))
  await t.session.idle()
  expect(calls).toEqual(['focus r1'])
  expect(t.selected()).toBe('b')
  expect(t.w.logs).toEqual(['pane: keys request failed: no engine'])
})

// A press runs detached. When the pane closes before that work reaches its call for the keys, the call must not come:
// `ui.open` would open the pane the person just closed (review of PR #121). A press after the pane opened again asks.
test('a press that began before the pane closed asks for no keys after it, and a press after it opened again does', async () => {
  const t = setup(webs('a', 'b', 'c'))
  const calls = engineLog(t)
  press(buttonOf(await t.draw(80, undefined, false), 'r1')) // the work stops at its first write
  await t.session.closed(t.w.ports)
  await t.session.idle()
  expect(calls).not.toContain('open')
  press(buttonOf(await t.draw(80, undefined, false), 'r2')) // /track again: a new press in a pane that has no keys
  await t.session.idle()
  expect(calls.filter(c => c === 'open').length).toBe(1)
})

// When the pane gets the keys, the engine puts the ring on the autoFocus handle of the frame it has, and that frame may
// have been read before the press wrote its row (live: the ring landed on the old row and `ui.focus` hook wrote it back
// into `selected`, while the ring request of the press was skipped as a re-entry of that hook). The row that was pressed
// must still be the selected one, whenever the hook of that landing runs. The orders pinned: the hook has finished when
// the ring request returns, it has started but not finished, and it runs in a later turn (live, 1 click in 112: the ring
// on the pressed row, the selection on the old row, until the next click). The landing has `origin` plugin: the engine's
// own take of the ring. Only the person's move or a request of the pane selects a row by a landing (next tests).
for (const landing of ['awaited', 'started', 'later'] as const) {
  test(`the ring landing of the engine on the old row does not take the selection from the pressed row (hook ${landing} at the return)`, async () => {
    const t = setup(webs('a', 'b', 'c'))
    t.w.state.set('selected', 'a')
    const calls = engineLog(t)
    const ui = t.w.ports.ui as { focus: (key: string) => Promise<boolean> }
    const focus = ui.focus
    ui.focus = async key => {
      const moved = await focus(key)
      // The hook of the engine's own landing, on the autoFocus handle of the old row.
      if (landing === 'awaited') await t.session.focused(t.w.ports, 'r0', 'plugin')
      else if (landing === 'started') void t.session.focused(t.w.ports, 'r0', 'plugin')
      return moved
    }
    const tree = await t.draw(80, undefined, false)
    press(buttonOf(tree, 'r2'))
    await t.session.idle()
    if (landing === 'later') await t.session.focused(t.w.ports, 'r0', 'plugin') // after the whole press has finished
    expect(calls).toEqual(['open', 'focus r2'])
    expect(t.selected()).toBe('c')
  })
}

// A move of the ring that the engine makes on its own (origin plugin: `autoFocus` as the pane takes the keys) starts the
// selection when no row is selected, or when the selected row is not drawn (it was dismissed or closed away). It never
// replaces a selected row that is drawn: the frame it reads can be older than the selection. The person's Tab, arrows
// and click (origin person, the default) always select the row under the ring.
test('a landing of the engine starts the selection and never replaces a drawn selected row', async () => {
  const t = setup(webs('a', 'b', 'c'))
  await t.draw(80, undefined, true) // nothing selected
  await t.session.focused(t.w.ports, 'r1', 'plugin')
  expect(t.selected()).toBe('b')
  await t.session.focused(t.w.ports, 'r2', 'plugin') // b is drawn and selected
  expect(t.selected()).toBe('b')
  t.w.state.set('selected', 'gone') // a row that is no longer drawn
  await t.draw(80, undefined, true)
  await t.session.focused(t.w.ports, 'r0', 'plugin')
  expect(t.selected()).toBe('a')
})

test('a move of the person selects the row under the ring, also when a selected row is drawn', async () => {
  const t = setup(webs('a', 'b', 'c'))
  t.w.state.set('selected', 'b')
  await t.draw(80, undefined, true)
  await t.session.focused(t.w.ports, 'r2', 'person')
  expect(t.selected()).toBe('c')
  await t.session.focused(t.w.ports, 'r0') // the origin defaults to the person
  expect(t.selected()).toBe('a')
})

test('draw hands Pane.isFocused to the table: no keys draws no background and a hint above the tree', async () => {
  const t = setup(webs('a', 'b'))
  t.w.state.set('selected', 'b')
  const lit = await t.draw(80, undefined, true)
  expect(rowBoxes(lit)[1]?.props.backgroundColor).toBe('blue')
  expect(leaves(lit).some(l => l.includes('ctrl+x Tab'))).toBe(false)
  for (const given of [undefined, true])
    expect(rowBoxes(await t.draw(80, undefined, given))[1]?.props.backgroundColor).toBe('blue')
  const dark = await t.draw(80, undefined, false)
  expect('backgroundColor' in (rowBoxes(dark)[1]?.props ?? {})).toBe(false)
  expect(leaves(dark)[0]).toContain('ctrl+x Tab')
  expect(handlesOf(dark)).toEqual(['r0', 'r1'])
})

test('draw leaves the hint off the help view, whether or not the pane has the keys', async () => {
  const t = setup(webs('a'), { path: '/p/config.json' })
  t.w.state.set('help', true)
  const dark = await t.draw(96, 11, false)
  expect(leaves(dark).some(l => l.includes('ctrl+x Tab'))).toBe(false)
  expect(JSON.stringify(await t.draw(96, 11, true))).toBe(JSON.stringify(dark))
})

test('Enter, N more, h and r run at once: a press that never finishes holds none of them', async () => {
  const never = new Promise<void>(() => {})
  for (const [hang, key] of [
    ['refreshManual', 'refresh'],
    ['setPriority', 'prio-1'],
    ['dismiss', 'dismiss'],
  ] as const) {
    const t = setup(webs('a', 'b', 'c', 'd', 'e', 'f', 'g'), { file: { global: { ui: { sectionRows: 5 } } } })
    t.w.state.set('selected', 'b')
    ;(t.host as Record<string, unknown>)[hang] = () => never
    const tree = await t.draw()
    press(buttonOf(tree, key)) // never done: it is the first in its chain, or detached
    press(buttonOf(tree, 'r2')) // Enter on c
    press(buttonOf(tree, 'm0'))
    press(buttonOf(tree, 'help'))
    if (key !== 'refresh') press(buttonOf(tree, 'refresh'))
    await turn() // no idle(): the press above never ends
    expect(t.w.state.get('expanded'), hang).toEqual(['c'])
    expect(await t.w.ports.state.shown.get('web'), hang).toBe(5)
    expect(t.w.state.get('help'), hang).toBe(true)
    if (key !== 'refresh') expect(t.host.calls, hang).toEqual(['refreshManual'])
  }
})

test('a tracker key whose work never finishes holds no later press', async () => {
  const t = await abc()
  t.host.keys.add('web', [{ id: 'open', key: 'o', label: 'open', scope: 'row' }])
  t.host.allLive = true
  t.host.runAction = () => new Promise<undefined>(() => {})
  const tree = await t.draw()
  press(buttonOf(tree, 'web.open'))
  press(buttonOf(tree, 'r2'))
  await turn()
  expect(t.w.state.get('expanded')).toEqual(['c'])
})

test('press refresh resets the width memo and runs refreshManual', async () => {
  const columns = [...COLS, { id: 'type', header: 'Type', width: { kind: 'content', max: 20 } } as const]
  const withType = (type: string) => [
    section('web', columns, [web('a', { cells: { key: { text: 'a' }, type: { text: type } } })]),
  ]
  const t = setup([])
  t.host.sections = withType('abcdefghijklmnop')
  const wide = typeWidth(await t.draw())
  expect(wide).toBe(16)
  t.host.sections = withType('abc')
  expect(typeWidth(await t.draw())).toBe(16) // the memo only grows
  await t.pressKey('refresh')
  expect(t.host.calls).toEqual(['refreshManual'])
  expect(typeWidth(await t.draw())).toBe(4) // the header `Type` is the widest text left
})

test('press help flips help', async () => {
  const t = setup(webs('a'))
  await t.pressKey('help')
  expect(t.w.state.get('help')).toBe(true)
  await t.pressKey('help') // the footer is the help view's own, `h` reads back
  expect(t.w.state.get('help')).toBe(false)
})

test('press prio-1 sets the priority of the selected row, then focuses its new handle', async () => {
  const t = setup(webs('a', 'b', 'c'))
  t.w.state.set('selected', 'c')
  t.host.onPriority = () => t.host.setRows(webs('c', 'a', 'b'))
  await t.pressKey('prio-1')
  expect(t.host.calls).toEqual(['setPriority c high'])
  expect(t.selected()).toBe('c')
  expect(t.w.ui.focused).toEqual(['r0'])
})

test('the digits set normal, low and auto (undefined)', async () => {
  const t = await abc()
  for (const key of ['prio-2', 'prio-3', 'prio-0']) await t.pressKey(key)
  expect(t.host.calls).toEqual(['setPriority b normal', 'setPriority b low', 'setPriority b undefined'])
})

test('x selects the next row and focuses its new handle', async () => {
  const t = await abc()
  t.host.onDismiss = () => t.host.setRows(webs('a', 'c'))
  await t.pressKey('dismiss')
  expect(t.host.calls).toEqual(['dismiss b'])
  expect(t.selected()).toBe('c')
  expect(t.w.ui.focused).toEqual(['r1'])
})

test('x on the last row selects the one before; on the only row it clears the selection', async () => {
  const last = setup(webs('a', 'b'))
  last.w.state.set('selected', 'b')
  last.host.onDismiss = () => last.host.setRows(webs('a'))
  await last.pressKey('dismiss')
  expect(last.selected()).toBe('a')
  expect(last.w.ui.focused).toEqual(['r0'])

  const only = setup(webs('a'))
  only.w.state.set('selected', 'a')
  only.host.onDismiss = () => only.host.setRows([])
  await only.pressKey('dismiss')
  expect(only.selected()).toBeNull()
  expect(only.w.ui.focused).toEqual([])
})

test('x skips the children of the row it dismisses', async () => {
  const t = setup([web('a'), web('b', { expandedByDefault: true, children: [web('b1')] }), web('c')])
  t.w.state.set('selected', 'b')
  t.host.onDismiss = () => t.host.setRows(webs('a', 'c'))
  await t.pressKey('dismiss')
  expect(t.selected()).toBe('c')
  expect(t.w.ui.focused).toEqual(['r1'])
})

test('a row key with no row selected or a stale one does nothing', async () => {
  for (const selected of [null, 'gone']) {
    const t = setup(webs('a', 'b'))
    t.host.allLive = true // the Buttons are live: the session decides
    t.w.state.set('selected', selected)
    for (const key of ['prio-1', 'prio-0', 'dismiss']) await t.pressKey(key)
    expect(t.host.calls, String(selected)).toEqual([])
    expect(t.w.ui.focused, String(selected)).toEqual([])
  }
})

test('a key on a row that cannot take it does nothing', async () => {
  // A row of another owner than an item owner takes no priority, though `can` says so. `can` has no `dismiss` here.
  const t = setup([
    row('p', { key: 'npm run dev', title: 'npm run dev' }, { owner: 'processes', can: { priority: true } }),
  ])
  t.host.allLive = true
  t.w.state.set('selected', 'p')
  for (const key of ['prio-1', 'prio-2', 'prio-3', 'prio-0', 'dismiss']) await t.pressKey(key)
  expect(t.host.calls).toEqual([])
  expect(t.w.ui.focused).toEqual([])
})

test('a disabled key does nothing', async () => {
  const t = setup([web('a', { can: {} })])
  t.w.state.set('selected', 'a')
  t.host.allLive = true
  for (const key of ['prio-1', 'dismiss']) await t.pressKey(key)
  expect(t.host.calls).toEqual([])
  const dim = setup([web('a', { can: {} })]) // the real footer draws them dim and inert too
  dim.w.state.set('selected', 'a')
  const tree = await dim.draw()
  expect(buttonOf(tree, 'dismiss').props.dimColor).toBe(true)
  press(buttonOf(tree, 'dismiss'))
  await dim.session.idle()
  expect(dim.host.calls).toEqual([])
})

test('a tracker key runs after the entry, with the owner, the id and the row', async () => {
  const t = setup(webs('a'))
  t.host.keys.add('web', [{ id: 'open', key: 'o', label: 'open', scope: 'row' }])
  t.w.state.set('selected', 'a')
  t.host.allLive = true
  await t.pressKey('web.open')
  expect(t.host.calls).toEqual(['entry', 'runAction web.open a'])
})

test('a key the registry does not know does nothing', async () => {
  const t = setup(webs('a'))
  const tree = await t.draw()
  // The footer Button of a key that left the registry between the draw and the press.
  t.host.keys.get = () => undefined
  press(buttonOf(tree, 'refresh'))
  await t.session.idle()
  expect(t.host.calls).toEqual([])
})

test('a refused ui.focus is caught', async () => {
  const t = await abc()
  t.host.onDismiss = () => t.host.setRows(webs('a', 'c'))
  t.w.ports.ui.focus = async () => {
    throw new Error('refused')
  }
  await t.pressKey('dismiss')
  expect(t.selected()).toBe('c')
  expect(t.w.logs).toEqual([])
})

test('a refused refocus forgets its request: a later Tab onto that key selects the row drawn there', async () => {
  const refusals = [
    async () => false, // the engine answers that nothing moved (another move came first)
    async () => {
      throw new Error('refused')
    },
  ]
  for (const refuse of refusals) {
    const t = setup(webs('a', 'b', 'c'))
    t.w.state.set('selected', 'c')
    await t.draw() // r0 a, r1 b, r2 c
    t.host.onPriority = () => t.host.setRows(webs('c', 'a', 'b')) // c moves first: the request is r0 for c
    t.w.ports.ui.focus = refuse
    await t.pressKey('prio-1')
    expect(t.selected()).toBe('c')
    await t.session.focused(t.w.ports, 'r0') // the person tabs onto r0, which the last drawing gave to a
    expect(t.selected()).toBe('a')
  }
})

test('a drawing that holds the refocus key retires the request; one that does not keeps it', async () => {
  const moved = async (rows: readonly string[]) => {
    const t = setup(webs('a', 'b', 'c'))
    t.w.state.set('selected', 'c')
    await t.draw()
    t.host.onPriority = () => t.host.setRows(webs('c', 'a', 'b'))
    await t.pressKey('prio-1') // the request: r0 for c, the focus did not answer
    expect(t.w.ui.focused).toEqual(['r0'])
    t.host.setRows(webs(...rows))
    await t.draw()
    await t.session.focused(t.w.ports, 'r0')
    return t.selected()
  }
  expect(await moved(['a', 'c', 'b'])).toBe('a') // r0 draws another row: the request is stale
  expect(await moved(['c', 'a', 'b'])).toBe('c') // r0 draws the row the request meant: the drawing answers
  expect(await moved([])).toBe('c') // no r0 yet: the request still waits for its element
})

test('a refocus on a row no drawing holds writes the selection and skips the focus', async () => {
  const t = await abc()
  // The dismissed row is `b`; its neighbour `c` has also left, as a refresh in between can do.
  t.host.onDismiss = () => t.host.setRows(webs('a'))
  await t.pressKey('dismiss')
  expect(t.selected()).toBe('c')
  expect(t.w.ui.focused).toEqual([])
})

test('a failing action logs one line', async () => {
  const t = await abc()
  t.host.setPriorityError = new Error('boom')
  await t.pressKey('prio-1')
  expect(t.w.logs).toEqual(['pane: prio-1 failed: boom'])
  expect(t.selected()).toBe('b')
})

test('two quick presses run one after the other', async () => {
  const t = await abc()
  let at = 0
  t.host.onDismiss = ids => {
    const gone = new Set(ids)
    t.host.setRows((t.host.sections[0]?.rows ?? []).filter(r => !gone.has(r.id)))
    at++
  }
  const tree = await t.draw()
  press(buttonOf(tree, 'dismiss'))
  press(buttonOf(tree, 'dismiss'))
  await t.session.idle()
  expect(at).toBe(2)
  expect(t.host.calls).toEqual(['dismiss b', 'dismiss c']) // the second press found the selection the first one made
})

test('closed forgets the pending refocus and clears selected and help', async () => {
  const t = setup(webs('a', 'b', 'c'))
  t.w.state.set('selected', 'c')
  await t.draw()
  t.host.onPriority = () => t.host.setRows(webs('c', 'a', 'b'))
  await t.pressKey('prio-1') // a pending refocus now: r0 is c
  t.w.state.set('help', true)
  await t.session.closed(t.w.ports)
  expect(t.selected()).toBeNull()
  expect(t.w.state.get('help')).toBe(false)
  await t.session.focused(t.w.ports, 'r0') // no pending: the drawn map answers
  expect(t.selected()).toBe('a')
})

test('focused and closed never throw; a failed write logs one line', async () => {
  const t = setup(webs('a'))
  await t.draw()
  const boom: AtomPort<never> = {
    get: async () => {
      throw new Error('boom')
    },
    update: async () => {
      throw new Error('boom')
    },
  }
  ;(t.w.ports.state as { selected: unknown }).selected = boom
  await t.session.focused(t.w.ports, 'r0')
  await t.session.closed(t.w.ports)
  expect(t.w.logs).toEqual(['pane: focus failed: boom', 'pane: close failed: boom'])
})

test('closed clears help even when the selection write fails', async () => {
  const t = setup(webs('a'))
  t.w.state.set('help', true)
  ;(t.w.ports.state as { selected: unknown }).selected = {
    get: async () => null,
    update: async () => {
      throw new Error('boom')
    },
  }
  await t.session.closed(t.w.ports)
  expect(t.w.state.get('help')).toBe(false)
  expect(t.w.logs).toEqual(['pane: close failed: boom'])
})

test('neighbourOf: the next row at the same or a lower depth, else the one before, else none', () => {
  const at = (id: string, depth: number) => ({ id, owner: 't', section: 's', can: {}, handle: `r-${id}`, depth })
  const rows = [at('a', 0), at('b', 0), at('b1', 1), at('c', 0), at('c1', 1)]
  expect(neighbourOf(rows, 'b')).toBe('c')
  expect(neighbourOf(rows, 'b1')).toBe('c')
  expect(neighbourOf(rows, 'c')).toBe('b1') // nothing at depth 0 or lower follows c: the drawn row before it
  expect(neighbourOf(rows, 'zz')).toBeNull()
  expect(neighbourOf([at('a', 0)], 'a')).toBeNull()
})

test('listText is the text of paneData with nothing selected', async () => {
  const t = setup(webs('a'))
  const out = await listText(t.w.ports, t.m)
  expect(t.host.views).toEqual([TEXT_VIEW])
  expect(t.host.views[0]).toBe(TEXT_VIEW)
  expect(out).toContain('a  https://a.example/')
})

test('helpTextOf prints the help view with the config path and every problem', async () => {
  const t = setup(webs('a'), { path: '/p/config.json', problems: ['X.'] })
  t.host.keyProblems = ['Y.']
  const out = await helpTextOf(t.w.ports, t.m)
  expect(out.startsWith('Pane keys (Tab, Shift+Tab, Up, Down move between rows)\n  r  refresh\n  h  help')).toBe(true)
  expect(out.endsWith('Config file: /p/config.json\nProblems\n  X.\n  Y.')).toBe(true)
  expect(t.host.views[0]).toBe(TEXT_VIEW)
})

test('helpTextOf prints the version of the host after the config line', async () => {
  const t = setup(webs('a'), { path: '/p/config.json', problems: ['X.'], version: 'unknown' })
  const out = await helpTextOf(t.w.ports, t.m)
  expect(out.endsWith('Config file: /p/config.json\nVersion: unknown\nProblems\n  X.')).toBe(true)
})
