// PaneSession: the per-load state of the pane (the last drawing, a pending refocus) and the writes behind its Buttons,
// on fakePorts and a fake host. The text helpers (listText, helpTextOf) are tested here too. Plan: L6 Task 11 (G6, G8, G22).
import { expect, test } from 'claude-code/testing'
import { buttonKeyOf, footerKeys, KeyRegistry } from '../core/infra/keys'
import type { AtomPort, Ports } from '../core/interfaces/ports'
import type { FooterKey, PaneView, RowRef, SectionSpec, TreeRow } from '../core/interfaces/view'
import { type Frame, NEXT_DRAWING_MS, Refocus, RING_PAUSE_MS } from '../hooks/pane-refocus'
import { helpTextOf, listText, type PaneHost, PaneSession, TEXT_VIEW } from '../hooks/pane-session'
import { KEYS as GITHUB_ROW_KEYS } from '../trackers/github/actions'
import { resetWidths } from '../ux/tree-data-table/columns'
import { neighbourOf, survivorOf } from '../ux/tree-data-table/table'
import { fakeConfig } from './fixtures/config-fs'
import {
  buttonOf,
  footerOf,
  handlesOf,
  leaves,
  nodes,
  press,
  rowBoxes,
  texts,
  VIEW_LINE_KEYS,
  viewLineOf,
} from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { fakePorts } from './fixtures/ports'
import { row, section } from './fixtures/sections'

/** A web row of the owner `web`, the one item owner of these tests. */
const web = (id: string, extra: Partial<TreeRow> = {}, key = id): TreeRow =>
  row(id, { control: '', name: key, description: `https://${id}.example/` }, { owner: 'web', ...extra })

const webs = (...ids: string[]): TreeRow[] => ids.map(id => web(id))

function setup(
  rows: readonly TreeRow[],
  o: { path?: string; problems?: string[]; file?: Record<string, unknown>; version?: string } = {},
) {
  resetWidths()
  const w = fakePorts()
  const reg = new KeyRegistry()
  const host = {
    sections: [section('web', rows)] as SectionSpec[],
    views: [] as PaneView[],
    calls: [] as string[],
    /** The surface each `runAction` got, in order. */
    surfaces: [] as (string | undefined)[],
    keyProblems: [] as string[],
    /** The version the manager read from the manifest. Absent: the help view has no version line. */
    version: o.version,
    /** Every footer key live: the session's own route decides, not the footer's state. */
    allLive: false,
    setRows: (rows: readonly TreeRow[]): void => {
      host.sections = [section('web', rows)]
    },
    /** What a fake write does to `sections`. */
    onDismiss: (_ids: readonly string[]): void => {},
    onPriority: (_id: string, _level: string | undefined): void => {},
    onPriorities: (_ids: readonly string[], _level: string | undefined): void => {},
    setPriorityError: undefined as Error | undefined,
    entry: async () => void host.calls.push('entry'),
    paneData: async (_p: unknown, view: PaneView) => {
      host.views.push(view)
      return host.sections
    },
    /** The rows that the trackers hold and the sections leave out for a rule of time or of a cap (issue #138). */
    held: [] as TreeRow[],
    /** The sections with no rule of time or of a cap: what `paneData` draws, and the held rows. */
    inventory: async (_p: unknown) => [...host.sections, section('held', host.held)],
    footer: async (
      _p: unknown,
      rowRef: RowRef | undefined,
      help: boolean,
      markedRows?: readonly RowRef[],
    ): Promise<readonly FooterKey[]> =>
      host.allLive
        ? reg.all().map(k => ({ ...k, enabled: true, buttonKey: buttonKeyOf(k) }))
        : footerKeys(reg, rowRef, owner => owner === 'web', help, undefined, markedRows),
    dismiss: async (_p: unknown, ids: readonly string[]) => {
      host.calls.push(`dismiss ${ids.join(',')}`)
      host.onDismiss(ids)
    },
    setPriority: async (_p: unknown, id: string, level: string | undefined) => {
      if (host.setPriorityError) throw host.setPriorityError
      host.calls.push(`setPriority ${id} ${level}`)
      host.onPriority(id, level)
    },
    setPriorities: async (_p: unknown, ids: readonly string[], level: string | undefined) => {
      host.calls.push(`setPriorities ${ids.join(',')} ${level}`)
      host.onPriorities(ids, level)
    },
    refreshManual: async () => void host.calls.push('refreshManual'),
    runAction: async (_p: unknown, owner: string, id: string, rowId: string | null, surface?: string) => {
      host.calls.push(`runAction ${owner}.${id} ${rowId}`)
      host.surfaces.push(surface)
    },
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

/** The width of the `type` cell of the first row: the gutter, then control, name, description, type. */
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
  // The full view is 2 titles, 11 keys (g, a and t are pane keys, issue #63, L3; m is a row key, issue #138), the config line and the
  // version line. The compact view is 8 lines: three keys to a line.
  expect((await help(undefined)).children[0]?.children).toHaveLength(15)
  expect((await help(28)).children[0]?.children).toHaveLength(15)
  expect((await help(11)).children[0]?.children).toHaveLength(8)
})

test('with many problems a short body draws the help view capped with a count, and /track help prints every problem of its model', async () => {
  const problems = Array.from({ length: 30 }, (_, i) => `Problem ${i + 1}.`)
  const t = setup(webs('a'), { path: '/p/config.json', problems, version: '1.2.3' })
  t.w.state.set('help', true)
  const shown = leaves(await t.draw(96, 11))
  expect(shown[0]).toBe('Pane keys (Tab, Shift+Tab, Up, Down move between rows)')
  expect(shown.filter(l => /^Problem \d+\.$/.test(l)).length).toBeLessThan(30)
  expect(shown.filter(l => /^\d+ (more )?problems: \/track help$/.test(l))).toHaveLength(1)
  const printed = await helpTextOf(t.w.ports, t.m)
  expect(printed.split('\n').filter(l => /^ {2}Problem \d+\.$/.test(l))).toEqual(problems.map(p => `  ${p}`))
})

test('with a tracker row selected the help view still fits the 11-row inline body: the footer has no tracker keys', async () => {
  const path = '/var/folders/sn/0_q8tr7x4vv44d69rbtyckwr0000gn/T/cc-tracker-config-oa5411/config.json' // 86 cells
  const t = setup(webs('a'), { path, problems: ['A.', 'B.', 'C.'], version: '1.2.3' })
  t.m.keys.add('web', GITHUB_ROW_KEYS) // c and f: the keys that wrap the footer in a row of 96 cells
  t.w.state.set('selected', 'a')
  t.w.state.set('help', true)
  const tree = await t.draw(96, 11)
  expect(leaves(tree)[0]).toBe('Pane keys (Tab, Shift+Tab, Up, Down move between rows)')
  expect(footerOf(tree).map(b => b.props.hotkey)).toEqual(['r', 'h', 'x', '1', '2', '3', '0'])
  const [body] = (tree as unknown as { children: unknown[] }).children
  expect((body as { children: unknown[] }).children.length + 1 + 1).toBeLessThanOrEqual(11) // body, the wrapped path, the footer
})

test('the selected row hides while the help view is open: the help footer keeps the core keys, and the row the selection fell to has its keys back after', async () => {
  // Issue #105 with issue #49: the help footer never holds a tracker's keys, and the keys of a closed help view follow the
  // row the selection fell to, not the atom that names the row that went.
  const path = '/var/folders/sn/0_q8tr7x4vv44d69rbtyckwr0000gn/T/cc-tracker-config-oa5411/config.json' // 86 cells
  const t = setup(webs('a', 'b'), { path, problems: ['A.', 'B.', 'C.'], version: '1.2.3' })
  t.m.keys.add('web', GITHUB_ROW_KEYS) // c and f
  t.w.state.set('selected', 'a')
  await t.draw(96, 11) // the last drawing holds `a` and `b`
  t.w.state.set('help', true)
  await t.draw(96, 11)
  t.host.setRows(webs('b')) // `a` hides while the person reads the help
  const help = await t.draw(96, 11)
  expect(leaves(help)[0]).toBe('Pane keys (Tab, Shift+Tab, Up, Down move between rows)')
  expect(footerOf(help).map(b => b.props.hotkey)).toEqual(['r', 'h', 'x', '1', '2', '3', '0'])
  const [body] = (help as unknown as { children: unknown[] }).children
  expect((body as { children: unknown[] }).children.length + 1 + 1).toBeLessThanOrEqual(11)
  t.w.state.set('help', false)
  const rows = await t.draw(96, 11)
  expect(footerOf(rows).map(b => b.props.hotkey)).toEqual(['r', 'h', 'x', '1', '2', '3', '0', 'c', 'f'])
  expect(footerOf(rows).every(b => b.props.dimColor !== true)).toBe(true) // the keys of `b` are live
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
/**
 * A body of 12 rows, 96 cells wide: the 11 rows of the inline pane at 100x40 and the row of the view line (issue #63, L3). It
 * shows 6 of 12 rows, as the 11 rows showed before the view line.
 */
const SHORT = 12
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
  expect(await t.w.ports.state.shown.get('list:web')).toBe(5)
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
  expect(await t.w.ports.state.shown.get('list:web')).toBe(5)
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

// Issue #130, the refocus of a scroll. It reads `selected` first, and the pane may close while that read is in flight.
test('scrolled that began before the pane closed selects nothing and asks for no ring after it', async () => {
  const t = setup(TWELVE)
  t.w.state.set('selected', 'w0')
  await t.draw(96, SHORT)
  const release = holdFirst(t.w.ports.state.selected, 'get')
  const done = t.session.scrolled(t.w.ports, t.m, 11)
  await turn()
  await t.session.closed(t.w.ports)
  release()
  expect(await done).toBe(true)
  expect(t.selected()).toBeNull()
  expect(t.w.ui.focused).toEqual([])
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
  expect(await t.w.ports.state.shown.get('list:web')).toBe(5)
  expect(t.w.ui.focused).toEqual(['r3'])
  expect(t.selected()).toBe('w3')
})

test('toggle flips the id in expanded; more adds sectionRows to shown(group), keyed by view and group', async () => {
  const t = setup(webs('a', 'b'))
  const tree = await t.draw()
  press(buttonOf(tree, 'r1'))
  await t.session.idle()
  expect(t.w.state.get('expanded')).toEqual(['b'])
  press(buttonOf(tree, 'r1'))
  await t.session.idle()
  expect(t.w.state.get('expanded')).toEqual([])
  expect(await t.w.ports.state.shown.get('list:web')).toBe(0)
  const over = setup(webs('a', 'b', 'c', 'd', 'e', 'f', 'g'), { file: { global: { ui: { sectionRows: 5 } } } })
  press(buttonOf(await over.draw(), 'm0'))
  await over.session.idle()
  expect(await over.w.ports.state.shown.get('list:web')).toBe(5)
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

// Issue #129. A click on a footer key or on an "N more" row is a press too, and a press moves no focus. With the keys in
// the prompt each of them asks for the keys, as a row press does since #115, so Up and Down then move the selection. The
// ask comes before the work: `x` and the digits end in a ring request that the engine refuses while the prompt has the
// keys, and `r` may run long. One press asks once: `x` and the digits must not ask again when they refocus.
const SMALL = { file: { global: { ui: { sectionRows: 5 } } } }
const seven = () => webs('a', 'b', 'c', 'd', 'e', 'f', 'g')

test('N more while the pane has no keys asks for them and shows the next rows', async () => {
  const t = setup(seven(), SMALL)
  const calls = engineLog(t)
  press(buttonOf(await t.draw(80, undefined, false), 'm0'))
  await t.session.idle()
  expect(calls).toEqual(['open'])
  expect(await t.w.ports.state.shown.get('list:web')).toBe(5)
})

test('N more with a row selected asks for the keys once, then for the ring on that row', async () => {
  const t = setup(seven(), SMALL)
  t.w.state.set('selected', 'b')
  const calls = engineLog(t)
  press(buttonOf(await t.draw(80, undefined, false), 'm0'))
  await t.session.idle()
  expect(calls).toEqual(['open', 'focus r1'])
  expect(t.selected()).toBe('b')
})

test('N more while the pane has the keys, or does not say, asks for no keys', async () => {
  for (const focused of [true, undefined]) {
    const t = setup(seven(), SMALL)
    const calls = engineLog(t)
    press(buttonOf(await t.draw(80, undefined, focused), 'm0'))
    await t.session.idle()
    expect(calls).toEqual([])
    expect(await t.w.ports.state.shown.get('list:web')).toBe(5)
  }
})

/**
 * A press of a footer key and what it should do. `engine` is one log: the calls the engine sees (`open`, `focus`) and the
 * work of the host (`refreshManual`, `dismiss`, `setPriority`, `entry`, `runAction`), in the order they happen. The ask
 * (`open`) comes first, then the work, then the ring. `help` has no work in the log: the test reads its atom.
 */
const FOOTER_KEYS = [
  { key: 'refresh', what: 'refreshManual', engine: ['open', 'refreshManual'] },
  { key: 'help', what: 'help', engine: ['open'] },
  { key: 'dismiss', what: 'x', engine: ['open', 'dismiss b', 'focus r1'] },
  { key: 'prio-1', what: 'a digit', engine: ['open', 'setPriority b high', 'focus r1'] },
  { key: 'web.open', what: 'a tracker key', engine: ['open', 'entry', 'runAction web.open b'] },
] as const

for (const { key, what, engine } of FOOTER_KEYS) {
  test(`a click on the footer key ${key} (${what}) while the pane has no keys asks for them once, before the work`, async () => {
    const t = setup(webs('a', 'b', 'c'))
    t.host.keys.add('web', [{ id: 'open', key: 'o', label: 'open', scope: 'row' }])
    t.host.allLive = true
    t.w.state.set('selected', 'b')
    const calls = engineLog(t)
    t.host.calls = calls // one log: the work of the host and the calls the engine sees
    t.host.onDismiss = () => t.host.setRows(webs('a', 'c'))
    press(buttonOf(await t.draw(80, undefined, false), key))
    await t.session.idle()
    expect(calls).toEqual(engine)
    expect(t.w.state.get('help') === true).toBe(key === 'help')
  })

  test(`a click on the footer key ${key} (${what}) while the pane has the keys asks for none`, async () => {
    for (const focused of [true, undefined]) {
      const t = setup(webs('a', 'b', 'c'))
      t.host.keys.add('web', [{ id: 'open', key: 'o', label: 'open', scope: 'row' }])
      t.host.allLive = true
      t.w.state.set('selected', 'b')
      const calls = engineLog(t)
      t.host.calls = calls
      t.host.onDismiss = () => t.host.setRows(webs('a', 'c'))
      press(buttonOf(await t.draw(80, undefined, focused), key))
      await t.session.idle()
      expect(calls).toEqual(engine.slice(1))
      expect(t.w.state.get('help') === true).toBe(key === 'help')
    }
  })
}

// Issue #130. `closed` clears the selection and the help view. A press that began before the closing must write none of
// them after it. The pane's work runs detached, so a closing can land between two writes of one press, or while one
// write is in flight: an atom `update` reads, applies its function and writes, and a retry applies it again to the value
// that the closing wrote. These tests hold one engine call open, close the pane, and let the call go on.

/** Holds the first call of `fn` of `owner` until `release()`: an engine call that is still in flight. Later calls run at once. */
function holdFirst<T extends object, K extends keyof T>(owner: T, name: K): () => void {
  const real = (owner[name] as (...a: unknown[]) => Promise<unknown>).bind(owner)
  let release!: () => void
  const held = new Promise<void>(r => {
    release = r
  })
  let first = true
  ;(owner as Record<K, unknown>)[name] = async (...a: unknown[]) => {
    if (first) {
      first = false
      await held
    }
    return real(...a)
  }
  return release
}

test('a row press whose expanded write is in flight when the pane closes writes nothing after it', async () => {
  const t = setup(webs('a', 'b', 'c'))
  const calls = engineLog(t)
  const release = holdFirst(t.w.ports.state.expanded, 'update')
  press(buttonOf(await t.draw(80, undefined, false), 'r1'))
  await turn()
  await t.session.closed(t.w.ports)
  release()
  await t.session.idle()
  expect(t.w.state.get('expanded') ?? []).toEqual([])
  expect(t.selected()).toBeNull()
  expect(calls).toEqual([]) // no ask for the keys, no ring request
})

test('a row press whose selected write is in flight when the pane closes does not select after it', async () => {
  const t = setup(webs('a', 'b', 'c'))
  const calls = engineLog(t)
  const release = holdFirst(t.w.ports.state.selected, 'update')
  press(buttonOf(await t.draw(80, undefined, false), 'r1'))
  await turn() // the row is open, and its selection is the call in flight
  expect(t.w.state.get('expanded')).toEqual(['b'])
  await t.session.closed(t.w.ports)
  release()
  await t.session.idle()
  expect(t.selected()).toBeNull()
  expect(calls).toEqual([])
})

test('a refocus that began before the pane closed asks for no ring after it', async () => {
  const t = setup(webs('a', 'b', 'c'))
  const calls = engineLog(t)
  const tree = await t.draw()
  let release!: () => void
  const held = new Promise<void>(r => {
    release = r
  })
  const real = t.host.paneData
  t.host.paneData = async (p: unknown, v: PaneView) => {
    await held // the ring request reads the sections to find the handle of the row
    return real(p, v)
  }
  press(buttonOf(tree, 'r1'))
  await turn() // the row is open and selected, and the refocus waits for its sections
  expect(t.selected()).toBe('b')
  await t.session.closed(t.w.ports)
  release()
  await t.session.idle()
  expect(t.selected()).toBeNull()
  expect(calls).toEqual([])
  await t.session.focused(t.w.ports, 'r1') // no request is pending: the drawn map answers, as for any ring move
  expect(t.selected()).toBe('b')
})

test('x that began before the pane closed does not select after it', async () => {
  const t = await abc()
  const calls = engineLog(t)
  let release!: () => void
  const held = new Promise<void>(r => {
    release = r
  })
  t.host.dismiss = async (_p: unknown, ids: readonly string[]) => {
    t.host.calls.push(`dismiss ${ids.join(',')}`)
    await held
  }
  press(buttonOf(await t.draw(), 'dismiss'))
  await turn()
  await t.session.closed(t.w.ports)
  t.w.stateSets = {}
  release()
  await t.session.idle()
  expect(t.host.calls).toEqual(['dismiss b']) // the press began before the closing: its own work finished
  expect(t.selected()).toBeNull()
  expect(t.w.stateSets.selected).toBeUndefined() // no write of `selected` at all, not even one that keeps the value
  expect(calls).toEqual([])
})

test('a digit whose setPriority is in flight when the pane closes does not select or ask for a ring after it', async () => {
  const t = await abc()
  const calls = engineLog(t)
  let release!: () => void
  const held = new Promise<void>(r => {
    release = r
  })
  t.host.setPriority = async (_p: unknown, id: string, level: string | undefined) => {
    t.host.calls.push(`setPriority ${id} ${level}`)
    await held
  }
  press(buttonOf(await t.draw(), 'prio-1'))
  await turn()
  await t.session.closed(t.w.ports)
  t.w.stateSets = {}
  release()
  await t.session.idle()
  expect(t.host.calls).toEqual(['setPriority b high']) // the press began before the closing: its own work finished
  expect(t.selected()).toBeNull()
  expect(t.w.stateSets.selected).toBeUndefined() // no write of `selected` at all, not even one that keeps the value
  expect(calls).toEqual([]) // no ask for the keys, no ring request
})

// The "N more" press writes `shown`, then reads `selected`. A closing in between ends the press: no ask, no ring. The pane
// had no keys when the person pressed, so without the check the press would ask `ui.open` for the keys of a closed pane.
test('N more whose shown write is in flight when the pane closes asks for no keys and no ring after it', async () => {
  const t = setup(seven(), SMALL)
  t.w.state.set('selected', 'b')
  const calls = engineLog(t)
  const release = holdFirst(t.w.ports.state.shown, 'update')
  press(buttonOf(await t.draw(80, undefined, false), 'm0'))
  await turn()
  await t.session.closed(t.w.ports)
  release()
  await t.session.idle()
  expect(t.selected()).toBeNull()
  expect(calls).toEqual([])
})

// The read of `selected` is the first await of a footer press. It can still be in flight when the pane closes and opens
// again, and then it returns a row of the new pane: the old key must not act on it (a review finding on this PR).
test('a digit whose read of selected is in flight through a closing and a reopening acts on nothing', async () => {
  for (const key of ['prio-1', 'dismiss']) {
    const t = setup(webs('a', 'b', 'c', 'd'))
    t.w.state.set('selected', 'b')
    const calls = engineLog(t)
    t.host.calls = calls
    const tree = await t.draw(80, undefined, false) // the pane has no keys: the press would ask for them
    const release = holdFirst(t.w.ports.state.selected, 'get') // after the draw, which reads `selected` too
    press(buttonOf(tree, key))
    await turn()
    await t.session.closed(t.w.ports)
    t.w.state.set('selected', 'd') // /track again, and a click on d
    release()
    await t.session.idle()
    expect(calls, key).toEqual([]) // no `setPriority d high`, no `dismiss d`, no ask, no ring
    expect(t.selected(), key).toBe('d')
  }
})

// The read of the marks follows the ask for the keys, and a bulk key waits for it. It can still be in flight when the pane closes and
// opens again, and then the key must not act on the rows of the old pane (issue #138, review M1).
test('a digit or x whose read of the marks is in flight through a closing and a reopening acts on nothing', async () => {
  for (const key of ['prio-1', 'dismiss']) {
    const t = setup(webs('a', 'b', 'c', 'd'))
    t.w.state.set('selected', 'b')
    const calls = engineLog(t)
    t.host.calls = calls
    const tree = await t.draw() // the pane has the keys: the press asks for none
    const release = holdFirst(t.w.ports.state.marks, 'get') // after the draw, which reads `marks` too
    press(buttonOf(tree, key))
    await turn()
    await t.session.closed(t.w.ports)
    t.w.state.set('selected', 'd') // /track again, and a click on d
    release()
    await t.session.idle()
    expect(calls, key).toEqual([]) // no `setPriority b high`, no `dismiss b`
    expect(t.selected(), key).toBe('d')
  }
})

test('h whose write is in flight when the pane closes does not bring the help view back', async () => {
  const t = setup(webs('a'))
  const release = holdFirst(t.w.ports.state.help, 'update')
  press(buttonOf(await t.draw(), 'help'))
  await turn()
  await t.session.closed(t.w.ports)
  expect(t.w.state.get('help')).toBe(false)
  release()
  await t.session.idle()
  expect(t.w.state.get('help')).toBe(false)
})

// A key that waits in the chain behind a press that does not end began before the closing too. It must not run after the
// pane opened again: it reads `selected`, and by then that is a row the person chose in the new pane (a priority key
// would set the priority of that row).
test('a digit that waited in the chain through a closing and a reopening acts on nothing', async () => {
  const t = setup(webs('a', 'b', 'c', 'd'))
  t.w.state.set('selected', 'b')
  const calls = engineLog(t)
  let release!: () => void
  const held = new Promise<void>(r => {
    release = r
  })
  t.host.dismiss = async (_p: unknown, ids: readonly string[]) => {
    t.host.calls.push(`dismiss ${ids.join(',')}`)
    await held
  }
  const tree = await t.draw()
  press(buttonOf(tree, 'dismiss')) // starts and waits
  press(buttonOf(tree, 'prio-1')) // waits behind it
  await turn()
  await t.session.closed(t.w.ports)
  t.w.state.set('selected', 'd') // /track again, and a click on d
  release()
  await t.session.idle()
  expect(t.host.calls).toEqual(['dismiss b']) // no `setPriority d high`
  expect(t.selected()).toBe('d') // and the old x did not refocus onto c
  expect(calls).toEqual([])
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
    expect(await t.w.ports.state.shown.get('list:web'), hang).toBe(5)
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
  const withType = (type: string) => [
    section('web', [web('a', { cells: { name: { text: 'a' }, type: { text: type } } })]),
  ]
  const t = setup([])
  t.host.sections = withType('abcdefghij')
  const wide = typeWidth(await t.draw())
  expect(wide).toBe(10)
  t.host.sections = withType('abc')
  expect(typeWidth(await t.draw())).toBe(10) // the memo only grows
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
    row('p', { name: 'npm run dev', description: 'npm run dev' }, { owner: 'processes', can: { priority: true } }),
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

// Issue #129, a dim footer key. It does no work, but it is a Button: a click on it moves no focus, so with the keys in the
// prompt it would be a dead spot that leaves them there. The click asks for the keys and does nothing else.
test('a click on a dim footer key while the pane has no keys asks for them and does no work', async () => {
  const t = setup([web('a', { can: {} })])
  t.w.state.set('selected', 'a')
  const calls = engineLog(t)
  t.host.calls = calls
  const tree = await t.draw(80, undefined, false)
  expect(buttonOf(tree, 'dismiss').props.dimColor).toBe(true)
  press(buttonOf(tree, 'dismiss'))
  await t.session.idle()
  expect(calls).toEqual(['open']) // no `dismiss a`, no ring
  expect(t.selected()).toBe('a')
})

test('a click on a dim footer key while the pane has the keys, or does not say, asks for none', async () => {
  for (const focused of [true, undefined]) {
    const t = setup([web('a', { can: {} })])
    t.w.state.set('selected', 'a')
    const calls = engineLog(t)
    t.host.calls = calls
    press(buttonOf(await t.draw(80, undefined, focused), 'dismiss'))
    await t.session.idle()
    expect(calls).toEqual([])
  }
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

// Issue #140. The engine keeps the ring at its position among the Buttons, not on its key (live, Claude Code 2.1.306). `h`
// swaps the rows and the tracker keys for the help view, and `x` on the last row takes the rows and the tracker keys away.
// The ring then lands on another Button or on none, and the engine tells the mod nothing. So the press asks for the ring
// again: on its own Button when the next footer holds it, else on `h: back` (the help view) or on the selected row.
// The session knows the ring from the `ui.focus` hook (`focused`), so each test tells it where the ring is. A ring it never
// heard of stays alone: the tests above press `h` with no word of the ring and expect no ring request.

/**
 * A press, then the drawing that the engine makes after the write of the press, then the pause before the request. The
 * ring request waits for that drawing (`Refocus.awaitFrame`) and then for the pause (`Refocus.pause`), so a test that never
 * draws would wait for the bound, and one that never ends the pause would wait for it. `turn` lets the press reach its write.
 */
async function pressDraw(t: Pick<ReturnType<typeof setup>, 'draw' | 'session' | 'w'>, key: string): Promise<void> {
  press(buttonOf(await t.draw(), key))
  await turn()
  await t.draw()
  await endPause(t)
  await t.session.idle()
}

/** The frame has returned: lets the press reach its pause, then lets the pause run out. */
async function endPause(t: Pick<ReturnType<typeof setup>, 'w'>): Promise<void> {
  await turn()
  await t.w.clock.advance(RING_PAUSE_MS)
}

/** A pane with the rows `ids`, the github keys `c` and `f` on every row, and the ring where `at` says. `calls` is the engine log. */
async function ringOn(at: string | undefined, ids: string[] = ['a', 'b'], selected = 'a') {
  const t = setup(webs(...ids))
  t.m.keys.add('web', GITHUB_ROW_KEYS) // buttons web.resolve and web.files
  t.w.state.set('selected', selected)
  await t.draw()
  const calls = engineLog(t)
  if (at !== undefined) await t.session.focused(t.w.ports, at)
  return { ...t, calls }
}

test('h opens the help view while the ring is on a tracker key: the ring goes to h: back', async () => {
  const t = await ringOn('web.resolve')
  await pressDraw(t, 'help')
  expect(t.w.state.get('help')).toBe(true)
  expect(t.calls).toEqual(['focus help'])
  expect(t.selected()).toBe('a') // a footer Button leaves the selection alone
})

test('h opens the help view while the ring is on a row: the ring goes to h: back', async () => {
  const t = await ringOn('r1', ['a', 'b'], 'b')
  await pressDraw(t, 'help')
  expect(t.calls).toEqual(['focus help'])
  expect(t.selected()).toBe('b')
})

test('h opens the help view while the ring is on an N more Button: the ring goes to h: back', async () => {
  const t = await ringOn('m0')
  await pressDraw(t, 'help')
  expect(t.calls).toEqual(['focus help'])
})

test('the second h closes the help view and the ring goes back to the selected row', async () => {
  for (const [selected, handle] of [
    ['a', 'r0'],
    ['b', 'r1'],
  ] as const) {
    const t = await ringOn('web.resolve', ['a', 'b'], selected)
    await pressDraw(t, 'help')
    await t.session.focused(t.w.ports, 'help', 'plugin') // the engine reports the landing of the request
    await pressDraw(t, 'help')
    expect(t.w.state.get('help')).toBe(false)
    expect(t.calls).toEqual(['focus help', `focus ${handle}`])
    await t.session.focused(t.w.ports, handle, 'plugin') // and the landing on the row, which selects the row it was asked for
    expect(t.selected()).toBe(selected)
  }
})

test('the second h returns the ring to the row that the selection fell to while the help view was open', async () => {
  const t = await ringOn('web.resolve', ['a', 'b'], 'a')
  await pressDraw(t, 'help')
  await t.session.focused(t.w.ports, 'help', 'plugin')
  t.host.setRows(webs('b')) // `a` hid while the person read the help: the selection falls to `b`, which is now r0
  await t.draw()
  await pressDraw(t, 'help')
  expect(t.calls).toEqual(['focus help', 'focus r0'])
})

test('a ring that the person moved off h: back stays on that Button when the help view closes', async () => {
  const t = await ringOn('web.resolve')
  await pressDraw(t, 'help')
  await t.session.focused(t.w.ports, 'help', 'plugin')
  await t.session.focused(t.w.ports, 'refresh') // Tab in the help view
  await pressDraw(t, 'help')
  expect(t.w.state.get('help')).toBe(false)
  expect(t.calls).toEqual(['focus help', 'focus refresh']) // not home to the row: the person chose r
})

// The rows leave with the help view, so every footer Button changes its position. The engine keeps the position, so a
// ring that is left alone lands on the next Button (live: the ring on `h: help` went to `x: dismiss`). The press asks for
// the ring on the same Button again, and no other.
test('a ring on h or r stays on that Button when h opens or closes the help view: the press asks for it again', async () => {
  for (const at of ['help', 'refresh']) {
    const t = await ringOn(at)
    await pressDraw(t, 'help')
    expect(t.w.state.get('help')).toBe(true)
    await pressDraw(t, 'help')
    expect(t.w.state.get('help')).toBe(false)
    expect(t.calls).toEqual([`focus ${at}`, `focus ${at}`])
    expect(t.selected()).toBe('a')
  }
})

test('a ring on a core key that the help view keeps (x, a digit) stays on it when h opens the help view', async () => {
  for (const at of ['dismiss', 'prio-2']) {
    const t = await ringOn(at)
    await pressDraw(t, 'help')
    expect(t.w.state.get('help')).toBe(true)
    expect(t.calls).toEqual([`focus ${at}`])
  }
})

test('with no row selected the second h leaves the ring on h: no row can take it home', async () => {
  const t = setup(webs('a', 'b'))
  await t.draw()
  const calls = engineLog(t)
  await t.session.focused(t.w.ports, 'r0', 'plugin') // autoFocus took the ring onto the first row; it selects that row
  t.w.state.set('selected', null) // the person never selected: this is the pane before any selection
  await pressDraw(t, 'help')
  await t.session.focused(t.w.ports, 'help', 'plugin')
  await pressDraw(t, 'help')
  expect(calls).toEqual(['focus help', 'focus help'])
})

test('a ring that nobody reported stays alone when h opens the help view', async () => {
  const t = await ringOn(undefined)
  await pressDraw(t, 'help')
  expect(t.w.state.get('help')).toBe(true)
  expect(t.calls).toEqual([])
})

test('a refused ring request leaves nothing to bring home: the second h asks for the Button the person had', async () => {
  const t = await ringOn('web.resolve')
  ;(t.w.ports.ui as { focus: unknown }).focus = async (key: string) => {
    t.calls.push(`focus ${key}`)
    return false
  }
  await pressDraw(t, 'help')
  await pressDraw(t, 'help')
  expect(t.calls).toEqual(['focus help', 'focus web.resolve']) // the ring never moved: c is still the ring's Button
})

test('a pane that closed since the ring moved to h: back does not bring the ring back to the next pane', async () => {
  const t = await ringOn('web.resolve')
  await pressDraw(t, 'help')
  await t.session.focused(t.w.ports, 'help', 'plugin')
  await t.session.closed(t.w.ports)
  t.w.state.set('selected', 'a') // the next pane, with the help view open again
  t.w.state.set('help', true)
  await pressDraw(t, 'help')
  expect(t.calls).toEqual(['focus help'])
})

// Live (Claude Code 2.1.306): a request that came before the drawing of the new state landed on the old frame, and the
// engine then kept its position through the new one, so the ring ended one Button off (`h: back` became `x: dismiss`).
// The request must follow the drawing that began after the write. These tests pin the order, not the time.
test('the ring request waits for the drawing that follows the write', async () => {
  const t = await ringOn('web.resolve')
  press(buttonOf(await t.draw(), 'help'))
  await turn()
  expect(t.w.state.get('help')).toBe(true) // the write is done
  expect(t.calls).toEqual([]) // and no frame follows it yet: nothing is asked
  await t.draw()
  await endPause(t)
  await t.session.idle()
  expect(t.calls).toEqual(['focus help'])
})

// Issue #156. The request needs one thing more than the frame: a turn of the engine's own loop, so that it has taken the
// frame before the request names a Button of it. Live (Claude Code 2.1.306), a request sent at once, after one read of an
// atom or after a busy wait of 20 ms landed one Button off. `Refocus.pause` is that turn: one timer of `RING_PAUSE_MS` on
// the engine clock. These tests pin the order, frame wait then pause then request. The fake clock holds the pause open, so no
// test waits for time.
test('h: the ring request comes after the frame wait and then after the pause, and no sooner', async () => {
  const t = await ringOn('web.resolve')
  press(buttonOf(await t.draw(), 'help'))
  await turn()
  await t.w.clock.advance(RING_PAUSE_MS) // time passes before any frame: the pause has not begun
  await turn()
  expect(t.calls).toEqual([])
  await t.draw() // the frame
  await turn()
  expect(t.calls).toEqual([]) // the frame alone is not enough: the pause is running
  await t.w.clock.advance(RING_PAUSE_MS - 1)
  await turn()
  expect(t.calls).toEqual([]) // and it has not ended
  await t.w.clock.advance(1)
  await t.session.idle()
  expect(t.calls).toEqual(['focus help'])
})

test('x on the last row: the ring request comes after the frame without the row and then after the pause', async () => {
  const t = await ringOn('r0', ['a'])
  t.host.onDismiss = () => t.host.setRows([])
  press(buttonOf(await t.draw(), 'dismiss'))
  await turn()
  expect(t.selected()).toBeNull() // the write is done
  await t.w.clock.advance(RING_PAUSE_MS) // time passes before any frame: the pause has not begun
  await turn()
  expect(t.calls).toEqual([])
  await t.draw() // the frame without the row
  await turn()
  expect(t.calls).toEqual([]) // the pause is running
  await t.w.clock.advance(RING_PAUSE_MS)
  await t.session.idle()
  expect(t.calls).toEqual(['focus refresh'])
})

test('h: a second drawing inside the pause neither ends it nor moves it', async () => {
  const t = await ringOn('web.resolve')
  press(buttonOf(await t.draw(), 'help'))
  await turn()
  await t.draw() // the frame
  await turn()
  await t.w.clock.advance(RING_PAUSE_MS - 1)
  await t.draw() // another drawing inside the pause
  await turn()
  expect(t.calls).toEqual([]) // it does not end the pause
  await t.w.clock.advance(1)
  await t.session.idle()
  expect(t.calls).toEqual(['focus help']) // the pause ended RING_PAUSE_MS after the first frame
})

test('h: a ring that the person moves during the pause is the ring the request keeps', async () => {
  const t = await ringOn('web.resolve')
  press(buttonOf(await t.draw(), 'help'))
  await turn()
  await t.draw()
  await turn()
  await t.session.focused(t.w.ports, 'refresh', 'person') // the person tabs onto r: refresh, a Button the help view keeps
  await t.w.clock.advance(RING_PAUSE_MS)
  await t.session.idle()
  expect(t.calls).toEqual(['focus refresh'])
})

// Codex review of PR #181. A second render can change the rows or the footer while the pause runs. The engine takes that
// frame in a turn of its own loop too, so the pause is measured from it, and the request names a Button of it.
test('x on the last row: a drawing with other rows during the pause restarts it, and the request follows that drawing', async () => {
  const t = await ringOn('r0', ['a'])
  t.host.onDismiss = () => t.host.setRows([])
  press(buttonOf(await t.draw(), 'dismiss'))
  await turn()
  await t.draw() // the frame without the row: the pause begins
  await turn()
  await t.w.clock.advance(RING_PAUSE_MS - 1)
  t.host.setRows(webs('b')) // another row shows up while the engine takes the first frame
  await t.draw()
  await turn()
  await t.w.clock.advance(1) // the pause of the first frame would end here
  await turn()
  expect(t.calls).toEqual([]) // the new frame moved it
  await t.w.clock.advance(RING_PAUSE_MS - 2)
  await turn()
  expect(t.calls).toEqual([]) // RING_PAUSE_MS - 1 after the new frame
  await t.w.clock.advance(1)
  await t.session.idle()
  expect(t.calls).toEqual(['focus refresh']) // RING_PAUSE_MS after the new frame
})

test('the frame of a drawing carries the keys of its footer and view line Buttons and the handle of each of its rows', async () => {
  const t = await ringOn(undefined, ['a', 'b'], 'a')
  const refocus = (t.session as unknown as { refocus: Refocus }).refocus
  const waited = refocus.awaitFrame(t.w.ports, () => true)
  const tree = await t.draw()
  const frame = await waited
  expect(frame?.help).toBe(false)
  expect(frame?.rows).toEqual(
    new Map([
      ['a', 'r0'],
      ['b', 'r1'],
    ]),
  )
  expect(frame?.keys).toEqual([...footerOf(tree), ...viewLineOf(tree)].map(b => String(b.props.key))) // footer first
  expect(frame?.stops).toEqual(['r0', 'r1']) // the focus stops of the body, in drawing order
  expect(frame?.keys).toContain('web.resolve')
  expect(frame?.keys).toContain('view') // `g`, on the view line (issue #63, L3)
})

/**
 * A bare `Refocus` on ports that hold the clock and `ui.focus` alone, and no host: it reaches for nothing but those. `keep`
 * runs with `next` and `atBound`, the read of the state that only the bound may call. `asked` collects the keys it asked
 * the engine for, `done` ends with `keep`.
 */
function bareKeep(at: string, next: { help: boolean; row: string | null }, atBound: () => Promise<Frame>) {
  const w = fakePorts()
  const asked: string[] = []
  const ports = {
    clock: w.ports.clock,
    ui: {
      focus: async (key: string) => {
        asked.push(key)
        return true
      },
    },
    log: w.ports.log,
  } as unknown as Ports
  const refocus = new Refocus()
  refocus.noted(at)
  const drawn = refocus.awaitFrame(ports, () => true)
  const done = refocus.keep(ports, next, { keys: false, still: () => true }, drawn, atBound)
  return { refocus, w, asked, done }
}

/** The state read of the bound. After a frame it must not run: a call fails the test. */
const noRead = async (): Promise<Frame> => {
  throw new Error('keep read the state after a frame')
}

/** `keep` with the frame `frame`, then the pause. Resolves with the keys it asked the engine for. */
async function keepOn(at: string, next: { help: boolean; row: string | null }, frame: Frame): Promise<string[]> {
  const k = bareKeep(at, next, noRead)
  k.refocus.frame(frame)
  await turn()
  await k.w.clock.advance(RING_PAUSE_MS)
  await k.done
  return k.asked
}

test('keep reads nothing after the frame wait: it chooses from the Button keys and the row handles of the frame', async () => {
  const rows = new Map([
    ['a', 'r0'],
    ['b', 'r1'],
  ])
  const keys = ['refresh', 'help', 'dismiss']
  const none = new Map<string, string>()
  // the ring's Button is in the frame: the ring stays on it
  expect(await keepOn('dismiss', { help: false, row: 'a' }, { help: false, rows, keys, stops: [] })).toEqual([
    'dismiss',
  ])
  // it is not: the selected row takes the ring, by its handle in the frame
  expect(await keepOn('web.resolve', { help: false, row: 'b' }, { help: false, rows, keys, stops: [] })).toEqual(['r1'])
  // no row is selected: the first Button of the footer
  expect(await keepOn('web.resolve', { help: false, row: null }, { help: false, rows: none, keys, stops: [] })).toEqual(
    ['refresh'],
  )
  // the help view: h: back
  expect(
    await keepOn(
      'web.resolve',
      { help: true, row: null },
      { help: true, rows: none, keys: ['refresh', 'help'], stops: [] },
    ),
  ).toEqual(['help'])
})

test('keep with a row that the frame does not hold asks for no ring', async () => {
  const rows = new Map([['a', 'r0']])
  expect(
    await keepOn('web.resolve', { help: false, row: 'zzz' }, { help: false, rows, keys: ['refresh'], stops: [] }),
  ).toEqual([])
})

test('keep at the bound chooses from the frame that the state gives and asks at once, with no pause', async () => {
  const state: Frame = { help: false, rows: new Map([['a', 'r0']]), keys: ['refresh'], stops: [] }
  const k = bareKeep('web.resolve', { help: false, row: 'a' }, async () => state)
  await k.w.clock.advance(NEXT_DRAWING_MS)
  await k.done // a pause after the bound would hold it here
  expect(k.asked).toEqual(['r0'])
})

// Codex review of PR #181. The pause follows the latest frame. A drawing with other controls (the footer Button keys or the
// handle of a row, in drawing order) restarts it from that frame, and the request chooses from that frame. A drawing with
// the same controls changes nothing ("h: a second drawing inside the pause neither ends it nor moves it"). Restarts end at
// `NEXT_DRAWING_MS` after the first frame, so a stream of changing drawings cannot hold the press for ever.
const BEFORE: Frame = {
  help: false,
  rows: new Map([
    ['a', 'r0'],
    ['b', 'r1'],
  ]),
  keys: ['web.resolve', 'refresh'],
  stops: ['r0', 'r1'],
}
const AFTER: Frame = { help: false, rows: new Map([['b', 'r0']]), keys: ['refresh'], stops: ['r0'] } // `a` hid: `b` is r0

test('a drawing with other controls during the pause restarts it from that frame, and the request chooses from it', async () => {
  // From BEFORE the ring stays on web.resolve, a Button it holds. From AFTER the selected row `b` takes it, as r0.
  const k = bareKeep('web.resolve', { help: false, row: 'b' }, noRead)
  k.refocus.frame(BEFORE)
  await turn()
  await k.w.clock.advance(RING_PAUSE_MS - 1)
  k.refocus.frame(AFTER)
  await turn()
  await k.w.clock.advance(1) // the pause of BEFORE would end here
  await turn()
  expect(k.asked).toEqual([])
  await k.w.clock.advance(RING_PAUSE_MS - 2)
  await turn()
  expect(k.asked).toEqual([]) // RING_PAUSE_MS - 1 after AFTER
  await k.w.clock.advance(1) // RING_PAUSE_MS after AFTER
  await k.done
  expect(k.asked).toEqual(['r0'])
})

test('a drawing that returns before the press reaches its pause is the latest frame of the pause', async () => {
  const k = bareKeep('web.resolve', { help: false, row: 'b' }, noRead)
  k.refocus.frame(BEFORE) // ends the frame wait: the press runs on in a microtask
  k.refocus.frame(AFTER) // a second render, before it does
  await turn()
  await k.w.clock.advance(RING_PAUSE_MS - 1)
  await turn()
  expect(k.asked).toEqual([])
  await k.w.clock.advance(1)
  await k.done
  expect(k.asked).toEqual(['r0'])
})

test('a drawing with the same controls during the pause neither ends it nor moves it, and the frame stays', async () => {
  const k = bareKeep('web.resolve', { help: false, row: 'b' }, noRead)
  k.refocus.frame(BEFORE)
  await turn()
  await k.w.clock.advance(RING_PAUSE_MS - 1)
  k.refocus.frame({ help: false, rows: new Map(BEFORE.rows), keys: [...BEFORE.keys], stops: [...BEFORE.stops] }) // equal, but another object
  await turn()
  expect(k.asked).toEqual([])
  await k.w.clock.advance(1) // RING_PAUSE_MS after the first frame
  await k.done
  expect(k.asked).toEqual(['web.resolve'])
})

test('a drawing that adds or drops an "N more" Button has other controls, though its keys and rows are the same', async () => {
  // The ring sits on a position among the Buttons: an `m0` before the footer shifts every Button after it.
  const k = bareKeep('web.resolve', { help: false, row: 'b' }, noRead)
  k.refocus.frame(BEFORE)
  await turn()
  await k.w.clock.advance(RING_PAUSE_MS - 1)
  k.refocus.frame({ ...BEFORE, stops: ['r0', 'r1', 'm0'] }) // a row beyond the cap came: `m0` appears, no handle moves
  await turn()
  await k.w.clock.advance(1) // the pause of BEFORE would end here
  await turn()
  expect(k.asked).toEqual([])
  await k.w.clock.advance(RING_PAUSE_MS - 2)
  await turn()
  expect(k.asked).toEqual([]) // RING_PAUSE_MS - 1 after the drawing with `m0`
  k.refocus.frame(BEFORE) // `m0` is gone again: the Buttons shift back
  await turn()
  await k.w.clock.advance(RING_PAUSE_MS - 1)
  await turn()
  expect(k.asked).toEqual([]) // the pause started again, so the earlier timer did not end it
  await k.w.clock.advance(1)
  await k.done
  expect(k.asked).toEqual(['web.resolve'])
})

test('a drawing that holds the same keys and rows in another order has other controls', async () => {
  const k = bareKeep('web.resolve', { help: false, row: 'b' }, noRead)
  const swappedKeys: Frame = { ...BEFORE, keys: ['refresh', 'web.resolve'] }
  const swappedRows: Frame = { ...BEFORE, rows: new Map([...BEFORE.rows].reverse()) }
  k.refocus.frame(BEFORE)
  await turn()
  for (const next of [swappedKeys, BEFORE, swappedRows]) {
    await k.w.clock.advance(RING_PAUSE_MS - 1)
    k.refocus.frame(next) // each one differs from the one before it: the pause starts again
    await turn()
    expect(k.asked).toEqual([])
  }
  await k.w.clock.advance(RING_PAUSE_MS)
  await k.done
  expect(k.asked).toEqual(['web.resolve'])
})

test('a stream of drawings with other controls does not hold the request for ever: it goes out with the latest at the bound', async () => {
  const k = bareKeep('web.resolve', { help: false, row: 'a' }, noRead)
  const nth = (n: number): Frame => ({
    help: false,
    rows: new Map([['a', `r${n}`]]),
    keys: ['refresh'],
    stops: [`r${n}`],
  })
  let n = 0
  k.refocus.frame(nth(n))
  let elapsed = 0
  while (elapsed + RING_PAUSE_MS - 1 < NEXT_DRAWING_MS) {
    await turn()
    await k.w.clock.advance(RING_PAUSE_MS - 1) // each drawing comes just before the pause would end
    elapsed += RING_PAUSE_MS - 1
    k.refocus.frame(nth(++n))
    await turn()
    expect(k.asked).toEqual([]) // no drawing ends it, and each one starts it again
  }
  expect(n).toBeGreaterThan(50) // a long stream
  await k.w.clock.advance(NEXT_DRAWING_MS - elapsed) // the bound, NEXT_DRAWING_MS after the first frame
  await turn()
  expect(k.asked).toEqual([`r${n}`]) // the latest frame, at the bound
  await k.done
})

test('a pause whose timer the engine refuses ends with a drawing after its deadline that has other controls, and asks from it', async () => {
  const k = bareKeep('web.resolve', { help: false, row: 'b' }, noRead)
  k.w.clock.refuse('after', RING_PAUSE_MS)
  k.refocus.frame(BEFORE)
  await turn()
  await k.w.clock.advance(RING_PAUSE_MS) // the deadline: the refused timer never fires
  await turn()
  expect(k.asked).toEqual([]) // nothing tells the press yet
  k.refocus.frame(AFTER) // the first drawing after the deadline ends the pause and is the latest frame
  await k.done
  expect(k.asked).toEqual(['r0'])
})

test('a closing ends a pause that a drawing restarted, with no request', async () => {
  const k = bareKeep('web.resolve', { help: false, row: 'b' }, noRead)
  k.refocus.frame(BEFORE)
  await turn()
  await k.w.clock.advance(RING_PAUSE_MS - 1)
  k.refocus.frame(AFTER)
  await turn()
  k.refocus.clear() // the pane closed
  await k.done // it would hang here until the clock moves
  await k.w.clock.advance(RING_PAUSE_MS) // the timer of the restart finds nobody
  expect(k.asked).toEqual([])
})

test('a drawing that still holds the row does not release the ring request of x on the last row', async () => {
  // Live: the dismissal caused a draw of its own, and it came before the row was gone. The request that followed it landed
  // on the old frame, and the engine moved the ring one Button on.
  const t = await ringOn('r0', ['a'])
  let land!: () => void
  const gate = new Promise<void>(resolve => {
    land = resolve
  })
  t.host.dismiss = async () => {
    await gate
    t.host.setRows([])
  }
  press(buttonOf(await t.draw(), 'dismiss'))
  await turn()
  await t.draw() // the dismissal has not landed: this frame holds the row
  await turn()
  expect(t.calls).toEqual([])
  land()
  await turn()
  expect(t.calls).toEqual([]) // the row is gone, but no frame shows it yet
  await t.draw()
  await endPause(t)
  await t.session.idle()
  expect(t.calls).toEqual(['focus refresh'])
})

// The bound is the one path that reads the state (owner decision on PR #181): with no frame to choose a Button from, the
// press reads the footer and the rows as before issue #156 and asks for the ring at once. No pause follows: no frame waits
// for the engine, and the bound is long past.
test('a drawing that never comes does not hold the press for ever: the request follows after the bound', async () => {
  const t = await ringOn('web.resolve')
  press(buttonOf(await t.draw(), 'help'))
  await turn()
  expect(t.calls).toEqual([])
  await t.w.clock.advance(NEXT_DRAWING_MS - 1)
  await turn()
  expect(t.calls).toEqual([])
  await t.w.clock.advance(1)
  await t.session.idle() // no pause follows the bound: it would hang here otherwise
  expect(t.calls).toEqual(['focus help'])
})

test('the second h at the bound reads the state and sends the ring home to the selected row', async () => {
  const t = await ringOn('web.resolve')
  await pressDraw(t, 'help')
  await t.session.focused(t.w.ports, 'help', 'plugin') // the ring sits on h: back
  press(buttonOf(await t.draw(), 'help')) // the second h
  await turn()
  await t.w.clock.advance(NEXT_DRAWING_MS) // no frame comes
  await t.session.idle()
  expect(t.calls).toEqual(['focus help', 'focus r0']) // the row handle comes from the state read of the bound
})

test('a pane that closes while the press waits for the drawing gets no ring request, and the press ends', async () => {
  const t = await ringOn('web.resolve')
  press(buttonOf(await t.draw(), 'help'))
  await turn()
  await t.session.closed(t.w.ports)
  await t.session.idle() // the closing released the wait: it would hang here otherwise
  expect(t.calls).toEqual([])
})

// A closing ends the pause as it ends the frame wait (`Refocus.clear`): the press does not wait for a timer of a pane that is
// gone, and a pane that opens again at once and reports its ring gets no request from the old press. The closing count of
// the press (`Press.still`) says the same when the pause ends by itself, and `request` checks it too.
test('a pane that closes and reopens during the pause ends the press at once and gets no ring request from it', async () => {
  const t = await ringOn('web.resolve')
  press(buttonOf(await t.draw(), 'help'))
  await turn()
  await t.draw() // the help drawing ends the frame wait: `keep` is in its pause
  await turn()
  expect(t.calls).toEqual([])
  await t.session.closed(t.w.ports) // the pane closes and opens again, and the person's ring is reported
  t.w.state.set('selected', 'a')
  await t.session.focused(t.w.ports, 'r0', 'plugin')
  await t.session.idle() // the closing ended the pause: it would hang here until the clock moves
  expect(t.calls).toEqual([]) // the old press must not ask for a ring in the new pane
  await t.w.clock.advance(RING_PAUSE_MS) // the timer of the pause comes later and finds nobody
  expect(t.calls).toEqual([])
})

// The engine can refuse a timer (a hook that denies `clock.after`). The timer never fires and the caller hears nothing: a
// `Timer` has `cancel` and no more. The press tells by the clock. A drawing that returns after the deadline of its wait
// ends it as the timer would have: the press must not hang until the pane closes (owner decision on PR #181). Without a
// drawing, nothing wakes it.
test('a pause whose timer the engine refuses ends with the first drawing after its deadline, and asks then', async () => {
  const t = await ringOn('web.resolve')
  t.w.clock.refuse('after', RING_PAUSE_MS)
  press(buttonOf(await t.draw(), 'help'))
  await turn()
  await t.draw() // the frame
  await turn()
  await t.w.clock.advance(RING_PAUSE_MS - 1)
  await t.draw() // inside the pause: the deadline has not come
  await turn()
  expect(t.calls).toEqual([])
  await t.w.clock.advance(1) // the deadline: the refused timer never fires
  await turn()
  expect(t.calls).toEqual([]) // nothing tells the press yet
  await t.draw() // the first drawing after the deadline
  await t.session.idle() // the drawing ended the pause: it would hang here otherwise
  expect(t.calls).toEqual(['focus help'])
})

test('a frame bound whose timer the engine refuses ends with the first drawing after it, and the press reads the state', async () => {
  const t = await ringOn('r0', ['a']) // x on the last row, and the row stays: no drawing is the one the press waits for
  t.w.clock.refuse('after', NEXT_DRAWING_MS)
  press(buttonOf(await t.draw(), 'dismiss'))
  await turn()
  expect(t.selected()).toBeNull() // the write is done
  await t.draw() // still holds the row: not the frame the ring waits for
  await t.w.clock.advance(NEXT_DRAWING_MS - 1)
  await t.draw() // inside the bound
  await turn()
  expect(t.calls).toEqual([])
  await t.w.clock.advance(1) // the bound: the refused timer never fires
  await turn()
  expect(t.calls).toEqual([])
  await t.draw() // the first drawing after the bound
  await t.session.idle() // it ended the wait with no frame, and no pause follows: it would hang here otherwise
  expect(t.calls).toEqual(['focus refresh'])
})

// A frame that the press wants and that comes after the deadline of a refused bound is late: the bound has passed, so the
// press falls back to the state read at once. It does not start a pause, whose timer the engine may refuse as well.
test('a frame bound whose timer the engine refuses ends with a wanted frame that comes after it, with no frame and no pause', async () => {
  const t = await ringOn('web.resolve')
  t.w.clock.refuse('after', NEXT_DRAWING_MS)
  press(buttonOf(await t.draw(), 'help'))
  await turn()
  await t.w.clock.advance(NEXT_DRAWING_MS) // the bound: the refused timer never fires
  await turn()
  expect(t.calls).toEqual([])
  await t.draw() // the help view, which the press wants, but after the bound
  await t.session.idle() // no pause follows it: it would hang here otherwise
  expect(t.calls).toEqual(['focus help'])
})

// A drawing that began before the write read the old help state. It returns after the press armed its wait, but it is not
// the frame the ring waits for. The `x` side has the same test ("a drawing that still holds the row ...").
test('a drawing that still holds the old help state does not release the ring request of h', async () => {
  const t = await ringOn('web.resolve')
  const tree = await t.draw()
  let land!: () => void
  const gate = new Promise<void>(resolve => {
    land = resolve
  })
  const paneData = t.host.paneData
  let first = true
  t.host.paneData = async (p: unknown, view: PaneView) => {
    if (first) {
      first = false
      await gate // the drawing has read `help` (false) and waits for its sections
    }
    return paneData(p, view)
  }
  const old = t.draw()
  await turn()
  press(buttonOf(tree, 'help'))
  await turn()
  expect(t.w.state.get('help')).toBe(true) // the write is done
  land()
  await old // the old drawing returns: it shows the rows, not the help view
  await turn()
  expect(t.calls).toEqual([])
  await t.draw() // the drawing that holds the help view
  await endPause(t)
  await t.session.idle()
  expect(t.calls).toEqual(['focus help'])
})

// The wait for `x` ends with the drawing that no longer holds the dismissed row, not with an empty pane: a drawing that
// shows one row can have more rows behind an "N more" (`sectionRows`, the budget), and those take its place. The selection
// is cleared then as well (`neighbourOf` found no drawn neighbour), so the tracker keys left the footer in this case too.
test('x on the only drawn row waits for the drawing without that row, also when other rows take its place', async () => {
  const t = await ringOn('r0', ['a'])
  t.host.onDismiss = () => t.host.setRows(webs('b')) // `b` was hidden behind an "N more" and is drawn now
  press(buttonOf(await t.draw(), 'dismiss'))
  await turn()
  expect(t.calls).toEqual([])
  await t.draw() // the drawing that holds `b` and not `a`
  await endPause(t)
  await t.session.idle() // that drawing released the wait: otherwise it would wait for the bound
  expect(t.selected()).toBeNull()
  expect(t.calls).toEqual(['focus refresh'])
})

test('x waits through the drawings that still hold the dismissed row even when other rows are drawn with it', async () => {
  const t = await ringOn('r0', ['a'])
  let land!: () => void
  const gate = new Promise<void>(resolve => {
    land = resolve
  })
  t.host.dismiss = async () => {
    await gate
    t.host.setRows(webs('b'))
  }
  press(buttonOf(await t.draw(), 'dismiss'))
  await turn()
  t.host.setRows(webs('a', 'b')) // a drawing that holds the dismissed row and a second row
  await t.draw()
  await turn()
  expect(t.calls).toEqual([])
  land()
  await turn()
  await t.draw()
  await endPause(t)
  await t.session.idle()
  expect(t.calls).toEqual(['focus refresh'])
})

// A press that the bound released leaves the queue, so a drawing that comes later does not test it again.
test('a press that the bound released is no longer asked about the drawings that follow', async () => {
  const w = fakePorts()
  const refocus = new Refocus()
  let asked = 0
  const waited = refocus.awaitFrame(w.ports, () => {
    asked++
    return true
  })
  await w.clock.advance(NEXT_DRAWING_MS)
  await waited // the bound released it
  refocus.frame({ help: false, rows: new Map(), keys: [], stops: [] })
  expect(asked).toBe(0)
})

test('x on the last row waits for the drawing that follows it before it asks for the ring', async () => {
  const t = await ringOn('r0', ['a'])
  t.host.onDismiss = () => t.host.setRows([])
  press(buttonOf(await t.draw(), 'dismiss'))
  await turn()
  expect(t.selected()).toBeNull()
  expect(t.calls).toEqual([])
  await t.draw()
  await endPause(t)
  await t.session.idle()
  expect(t.calls).toEqual(['focus refresh'])
})

test('x on the last row: the ring request sits behind the dismiss and the write of the selection, not before them', async () => {
  const t = await ringOn('r0', ['a'])
  const order: string[] = []
  t.host.dismiss = async () => {
    order.push('dismiss')
    t.host.setRows([])
  }
  ;(t.w.ports.ui as { focus: unknown }).focus = async (key: string) => {
    order.push(`focus ${key}`)
    return true
  }
  await pressDraw(t, 'dismiss')
  expect(order).toEqual(['dismiss', 'focus refresh'])
})

test('x on the last row while the ring is on that row: the ring goes to the first footer Button', async () => {
  const t = await ringOn('r0', ['a'])
  t.host.onDismiss = () => t.host.setRows([])
  await pressDraw(t, 'dismiss')
  expect(t.selected()).toBeNull()
  expect(t.calls).toEqual(['focus refresh'])
})

test('x on the last row while the ring is on a tracker key: the ring goes to the first footer Button', async () => {
  const t = await ringOn('web.files', ['a'])
  t.host.onDismiss = () => t.host.setRows([])
  await pressDraw(t, 'dismiss')
  expect(t.calls).toEqual(['focus refresh'])
})

test('x on the last row while the ring is on x or r asks for the ring on that Button again: the row Button left, so its position moved', async () => {
  for (const at of ['dismiss', 'refresh']) {
    const t = await ringOn(at, ['a'])
    t.host.onDismiss = () => t.host.setRows([])
    await pressDraw(t, 'dismiss')
    expect(t.selected()).toBeNull()
    expect(t.calls).toEqual([`focus ${at}`])
  }
})

// `g`, `a`, `t` and `m` sit on the view line, not in the footer. A ring on one of them is a ring on a Button that the next drawing
// still holds, so the press that took the last row asks for that Button again (issue #63, L3, review m1).
test('x on the only row while the ring sits on a view line Button keeps the ring on it: the Button is still drawn', async () => {
  for (const at of VIEW_LINE_KEYS) {
    const t = await ringOn(at, ['a'])
    t.host.onDismiss = () => t.host.setRows([])
    await pressDraw(t, 'dismiss')
    expect(t.selected(), at).toBeNull()
    expect(t.calls, at).toEqual([`focus ${at}`])
  }
})

// The bound reads the state (`frameFromState`), which must name the view line Buttons too, as the drawing does.
test('x on the only row while the ring sits on a view line Button, with no frame before the bound: the state read keeps the ring on it', async () => {
  for (const at of VIEW_LINE_KEYS) {
    const t = await ringOn(at, ['a'])
    t.host.onDismiss = () => t.host.setRows([])
    press(buttonOf(await t.draw(), 'dismiss'))
    await turn()
    await t.w.clock.advance(NEXT_DRAWING_MS) // no frame comes
    await t.session.idle()
    expect(t.selected(), at).toBeNull()
    expect(t.calls, at).toEqual([`focus ${at}`])
  }
})

test('h opens the help view while the ring sits on g: the help view has no view line, so the ring goes to h: back', async () => {
  const t = await ringOn('view')
  await pressDraw(t, 'help')
  expect(t.w.state.get('help')).toBe(true)
  expect(t.calls).toEqual(['focus help'])
})

test('x on a row that has a neighbour asks for the ring on the neighbour only', async () => {
  const t = await ringOn('r1', ['a', 'b', 'c'], 'b')
  t.host.onDismiss = () => t.host.setRows(webs('a', 'c'))
  await pressDraw(t, 'dismiss')
  expect(t.calls).toEqual(['focus r1']) // c is r1 now: no second request for a footer Button
})

test('neighbourOf: the next row at the same or a lower depth, else the one before, else none', () => {
  const at = (id: string, depth: number) => ({ id, owner: 't', group: 's', can: {}, handle: `r-${id}`, depth })
  const rows = [at('a', 0), at('b', 0), at('b1', 1), at('c', 0), at('c1', 1)]
  expect(neighbourOf(rows, 'b')).toBe('c')
  expect(neighbourOf(rows, 'b1')).toBe('c')
  expect(neighbourOf(rows, 'c')).toBe('b1') // nothing at depth 0 or lower follows c: the drawn row before it
  expect(neighbourOf(rows, 'zz')).toBeNull()
  expect(neighbourOf([at('a', 0)], 'a')).toBeNull()
})

test('survivorOf: the row itself when it stays, else the next row outside a dismissed subtree, else the one before, else none', () => {
  const at = (id: string, depth: number) => ({ id, owner: 't', group: 's', can: {}, handle: `r-${id}`, depth })
  const rows = [at('a', 0), at('b', 0), at('b1', 1), at('c', 0), at('c1', 1), at('d', 0)]
  const gone = new Set(['b', 'c'])
  expect(survivorOf(rows, 'a', gone)).toBe('a')
  expect(survivorOf(rows, 'b1', new Set(['c']))).toBe('b1') // a child that stays
  expect(survivorOf(rows, 'b', gone)).toBe('d') // past b1 (a child of b), c and c1
  expect(survivorOf(rows, 'c', gone)).toBe('d')
  expect(survivorOf(rows, 'd', new Set(['c', 'd']))).toBe('b1') // nothing stays after d: the drawn row before that stays
  expect(survivorOf(rows, 'a', new Set(rows.map(r => r.id)))).toBeNull()
  expect(survivorOf(rows, 'zz', gone)).toBe('zz') // a row no drawing holds: the selection is not touched
  expect(survivorOf(rows, null, gone)).toBeNull()
  expect(survivorOf(rows, 'b', new Set(['b']))).toBe('c') // as neighbourOf: the one row dismissed
})

test('listText is the text of paneData with nothing selected', async () => {
  const t = setup(webs('a'))
  const out = await listText(t.w.ports, t.m)
  expect(t.host.views).toEqual([TEXT_VIEW])
  expect(t.host.views[0]).toBe(TEXT_VIEW)
  expect(out).toContain('a  https://a.example/')
})

test('helpTextOf prints the help view with the config path and every problem of its model', async () => {
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

// ---------------------------------------------------------------- the views and their keys (issue #63, L3)

/** A web row with a status token: the views group by it. */
const failing = (id: string): TreeRow => web(id, { facets: { status: { label: 'failed', token: 'failed' } } })
const reasoned = (id: string, strongest: 'discovered' | 'created'): TreeRow =>
  web(id, { reasons: { first: strongest, all: [strongest], strongest } })

/** `a`, `b`, `c` with `c` failing and `b` selected: by list `b` is r1, by status the failed `c` is r0 and `b` is r2. */
async function views(o: Parameters<typeof setup>[1] = {}) {
  const t = setup([web('a'), web('b'), failing('c')], o)
  t.w.state.set('selected', 'b')
  await t.draw()
  t.w.stateSets = {}
  return t
}

test('draw puts the view line above the footer: the view, then g, a, t and m; the footer keeps its keys', async () => {
  const t = await views()
  const tree = await t.draw()
  expect(texts(tree).some(([, s]) => s === 'View: list')).toBe(true)
  expect(viewLineOf(tree).map(b => [b.props.hotkey, b.props.label])).toEqual([
    ['g', 'view'],
    ['a', 'show all'],
    ['t', 'touched only'],
    ['m', 'mark'],
  ])
  expect(footerOf(tree).map(b => b.props.hotkey)).toEqual(['r', 'h', 'x', '1', '2', '3', '0'])
})

test('the view line says the view, the filter with its hidden rows and the show-all toggle', async () => {
  const t = await views()
  await t.w.ports.state.view.update(() => 'status')
  await t.w.ports.state.filters.update(() => ({ touchedOnly: true }))
  await t.w.ports.state.hidden.update(() => ({ showAll: true }))
  const line = texts(await t.draw()).find(([, s]) => s.startsWith('View:'))?.[1]
  expect(line).toBe('View: status · touched only · showing all') // no row says discovered or mentioned: none hidden
})

// Only the by-list view draws the notes of the sections, where the TTL count sits as text. The sections carry it as data
// (`hiddenRows`), so the line of every view says how many rows `a` would bring back (issue #63, L3, review M1).
test('the view line counts the rows that the sections leave out until a shows them, in the view that has no notes', async () => {
  const t = await views()
  t.host.sections = [section('web', [web('a'), web('b'), failing('c')], { hiddenRows: 2 })]
  await t.w.ports.state.view.update(() => 'status')
  const line = async () => texts(await t.draw()).find(([, s]) => s.startsWith('View:'))?.[1]
  expect(await line()).toBe('View: status · 2 ended hidden')
  await t.pressKey('show-all')
  expect(await line()).toBe('View: status · showing all') // the toggle is on: the line says it, not a count
  await t.pressKey('show-all')
  expect(await line()).toBe('View: status · 2 ended hidden')
})

// Owner decision of 2026-10-22 (Q37): the by-list view draws the notes of the sections, which say `(N hidden)`, so its view line
// does not count the ended rows a second time.
test('the view line of the by-list view leaves out the ended count that the section notes say', async () => {
  const t = await views()
  t.host.sections = [section('web', [web('a'), web('b')], { hiddenRows: 2 })]
  const line = async () => texts(await t.draw()).find(([, s]) => s.startsWith('View:'))?.[1]
  expect(await line()).toBe('View: list')
  await t.pressKey('touched')
  expect(await line()).toBe('View: list · touched only')
  await t.pressKey('touched')
  await t.pressKey('view') // the next view of the default cycle: status, which has no notes
  expect(await line()).toBe('View: status · 2 ended hidden')
})

test('the help view has no view line, and the help keys name g, a and t', async () => {
  const t = await views()
  t.w.state.set('help', true)
  const tree = await t.draw()
  expect(viewLineOf(tree)).toEqual([])
  expect(texts(tree).some(([, s]) => s.startsWith('View:'))).toBe(false)
  const out = leaves(tree)
  expect(out).toContain('view')
  expect(out).toContain('show all')
  expect(out).toContain('touched only')
})

test('help titles a tracker by its sections, whatever the view draws: never by Failed or No status', async () => {
  const t = await views()
  t.host.keys.add('web', [{ id: 'open', key: 'o', label: 'open', scope: 'row' }])
  t.w.state.set('help', true)
  const byList = leaves(await t.draw())
  expect(byList).toContain('web') // the section of the tracker, as the by-list view titles it
  for (const view of ['status', 'tracker', 'reason', 'flat']) {
    await t.w.ports.state.view.update(() => view)
    expect(leaves(await t.draw()), view).toEqual(byList)
    expect(await helpTextOf(t.w.ports, t.m), view).toContain('\nweb\n  o  open')
  }
  const text = await helpTextOf(t.w.ports, t.m)
  expect(text).not.toMatch(/Failed|No status|Pinned/)
})

test('g takes the next view of global.ui.views, keeps the row selected and asks for the ring on its new handle', async () => {
  const t = await views()
  expect(handlesOf(await t.draw())).toEqual(['r0', 'r1', 'r2']) // by list: a, b, c
  await t.pressKey('view')
  expect(t.w.state.get('view')).toBe('status')
  expect(t.selected()).toBe('b')
  // By status the failed row `c` is first: `b` is the third row now.
  expect(t.w.ui.focused).toEqual(['r2'])
  await t.pressKey('view')
  expect(t.w.state.get('view')).toBe('flat')
  await t.pressKey('view')
  expect(t.w.state.get('view')).toBe('list')
  expect(t.selected()).toBe('b')
  expect(t.w.ui.focused.at(-1)).toBe('r1')
})

test('g, a and t redraw the pane once and write no config file and no store key', async () => {
  for (const key of ['view', 'show-all', 'touched']) {
    const t = await views()
    await t.w.clock.advance(5000) // the opening of the pane may write the store: let it happen first
    const drawn = t.w.ui.invalidated
    const files = { ...t.w.files }
    const sets = t.w.storeSets
    await t.pressKey(key)
    await t.w.clock.advance(5000) // past the flush delay of the stored copy, as in view-state.test.ts
    expect(t.w.ui.invalidated - drawn, key).toBe(1)
    expect(t.w.files, key).toEqual(files)
    expect(t.w.storeSets, key).toBe(sets)
    expect(t.w.stateSets.selected, key).toBeDefined() // the selection is written again, to the same row
  }
})

test('g cycles the views the config lists, and starts the cycle when the live view is not in the list', async () => {
  const t = await views({ file: { global: { ui: { views: ['reason', 'tracker'] } } } })
  await t.pressKey('view')
  expect(t.w.state.get('view')).toBe('reason') // by list is not in the list: the first of it
  await t.pressKey('view')
  expect(t.w.state.get('view')).toBe('tracker')
  await t.pressKey('view')
  expect(t.w.state.get('view')).toBe('reason')
})

test('g starts from global.ui.view when no view was chosen', async () => {
  const t = await views({ file: { global: { ui: { view: 'status', views: ['list', 'status', 'flat'] } } } })
  await t.pressKey('view')
  expect(t.w.state.get('view')).toBe('flat') // the pane was by status, so the next is flat
})

test('a toggles the show-all state of /track show-all, keeps the selection and asks for the ring', async () => {
  const t = await views()
  await t.pressKey('show-all')
  expect(t.w.state.get('hidden')).toEqual({ showAll: true })
  expect(t.selected()).toBe('b')
  expect(t.w.ui.focused.at(-1)).toBe('r1')
  await t.pressKey('show-all')
  expect(t.w.state.get('hidden')).toEqual({ showAll: false })
})

test('t hides the rows that were only discovered or mentioned, and a selected row that goes falls to the next shown row', async () => {
  const t = setup([web('a'), reasoned('b', 'discovered'), reasoned('c', 'created')])
  t.w.state.set('selected', 'b')
  await t.draw()
  await t.pressKey('touched')
  expect(t.w.state.get('filters')).toEqual({ touchedOnly: true })
  expect(handlesOf(await t.draw())).toEqual(['r0', 'r1']) // a and c: b is hidden
  expect(t.selected()).toBe('c') // the row after `b` in the last drawing that is still drawn
  expect(t.w.ui.focused.at(-1)).toBe('r1')
  await t.pressKey('touched')
  expect(t.w.state.get('filters')).toEqual({ touchedOnly: false })
  expect(handlesOf(await t.draw())).toEqual(['r0', 'r1', 'r2'])
})

test('g, a and t with no row selected change the view and ask for no ring', async () => {
  const t = setup([web('a'), failing('b')])
  await t.draw()
  for (const key of ['view', 'show-all', 'touched']) await t.pressKey(key)
  expect(t.w.state.get('view')).toBe('status')
  expect(t.w.state.get('hidden')).toEqual({ showAll: true })
  expect(t.w.state.get('filters')).toEqual({ touchedOnly: true })
  expect(t.selected()).toBeNull()
  expect(t.w.ui.focused).toEqual([])
})

test('a press of g, a or t whose write is in flight when the pane closes changes nothing after it', async () => {
  for (const [key, atom, rest] of [
    ['view', 'view', null],
    ['show-all', 'hidden', { showAll: false }],
    ['touched', 'filters', { touchedOnly: false }],
  ] as const) {
    const t = await views()
    const calls = engineLog(t)
    const release = holdFirst(t.w.ports.state[atom], 'update')
    press(buttonOf(await t.draw(), key))
    await turn()
    await t.session.closed(t.w.ports)
    release()
    await t.session.idle()
    expect(await t.w.ports.state[atom].get(), key).toEqual(rest)
    expect(calls, key).toEqual([]) // no ask for the keys, no ring request
  }
})

test('g forgets the "N more" stop the ring sat on: its group index means another group in the next view', async () => {
  const t = setup(TWELVE, { file: { global: { ui: { sectionRows: 8 } } } })
  t.w.state.set('selected', 'w0')
  await t.draw(96, SHORT)
  await t.session.focused(t.w.ports, 'm0') // the ring is on the N more Button: the window follows it
  expect(shownIds(await t.draw(96, SHORT))).not.toContain('w0')
  await t.pressKey('view')
  expect(t.w.state.get('view')).toBe('status')
  expect(shownIds(await t.draw(96, SHORT))).toContain('w0') // the window follows the selected row again
})

test('g in a pane that has no keys asks for them once, before the write', async () => {
  const t = await views()
  const tree = await t.draw(80, undefined, false)
  const opened = t.w.ui.opened
  press(buttonOf(tree, 'view'))
  await t.session.idle()
  expect(t.w.ui.opened - opened).toBe(1)
  expect(t.w.state.get('view')).toBe('status')
})

// Codex review of PR 191. A session can be drawn on several surfaces. A tracker key that copies must copy on the surface that
// the person pressed, and the press event names it: the pane hands it to the action as it got it.
test('a tracker key passes the surface of its press to runAction', async () => {
  const t = setup(webs('a', 'b', 'c'))
  t.host.keys.add('web', [{ id: 'open', key: 'o', label: 'open', scope: 'row' }])
  t.host.allLive = true
  t.w.state.set('selected', 'b')
  press(buttonOf(await t.draw(), 'web.open'), 'desktop')
  await t.session.idle()
  press(buttonOf(await t.draw(), 'web.open'))
  await t.session.idle()
  expect(t.host.surfaces).toEqual(['desktop', undefined])
})

// ---------------------------------------------------------------------------------------------------------------------
// Issue #138, row marks and bulk actions. `m` marks the selected row, `x` and the digits then act on the marked rows, and a
// bulk `x` asks first: the view line holds the question, and only an `x` from a drawing that showed it answers.

const marksOf = (t: ReturnType<typeof setup>): unknown => t.w.state.get('marks')
const QUESTION = (n: number): string => `Dismiss ${n} marked rows? x again: yes`
const viewWords = (tree: unknown): string | undefined =>
  texts(tree).find(([, s]) => s.startsWith('View:') || s.startsWith('Dismiss '))?.[1]
const labelOf = (tree: unknown, key: string): unknown => buttonOf(tree, key).props.label
/** Rows `a` to `d` with `b` selected, and the rows in `ids` marked. The first drawing is made. */
async function marked(...ids: string[]) {
  const t = setup(webs('a', 'b', 'c', 'd'))
  t.w.state.set('selected', 'b')
  t.w.state.set('marks', ids)
  await t.draw()
  t.w.stateSets = {}
  return t
}
/** The ring requests that the engine got, as `r<n>`. */
const rings = (t: ReturnType<typeof setup>): string[] => t.w.ui.focused

test('draw with marks writes nothing: a render never prunes the marks (E9)', async () => {
  const t = await marked('a', 'gone')
  await t.draw()
  expect(t.w.stateSets).toEqual({})
  expect(marksOf(t)).toEqual(['a', 'gone'])
})

test('m marks the selected row, redraws once and asks for the ring on that row; a second m unmarks it', async () => {
  const t = await abc()
  const drawn = t.w.ui.invalidated
  await t.pressKey('mark')
  expect(marksOf(t)).toEqual(['b'])
  expect(t.w.ui.invalidated - drawn).toBe(1)
  expect(t.selected()).toBe('b')
  expect(rings(t)).toEqual(['r1'])
  await t.pressKey('mark')
  expect(marksOf(t)).toEqual([])
  expect(rings(t)).toEqual(['r1', 'r1'])
})

test('marks live in a session atom: no config file write, no store key', async () => {
  const t = await abc()
  await t.w.clock.advance(5000)
  const files = { ...t.w.files }
  const sets = t.w.storeSets
  await t.pressKey('mark')
  await t.w.clock.advance(5000)
  expect(t.w.files).toEqual(files)
  expect(t.w.storeSets).toBe(sets)
})

test('a marked row draws * and the view line says how many are marked; x names the count', async () => {
  const t = await marked('a', 'c')
  const tree = await t.draw()
  expect(rowBoxes(tree).map(b => leaves(b).includes('*'))).toEqual([true, false, true, false])
  expect(viewWords(tree)).toBe('View: list · 2 marked')
  expect(labelOf(tree, 'dismiss')).toBe('dismiss 2')
  expect(labelOf(tree, 'prio-1')).toBe('high') // the digits keep their words
  const none = await (await abc()).draw()
  expect(viewWords(none)).toBe('View: list')
  expect(labelOf(none, 'dismiss')).toBe('dismiss')
})

test('a mark survives a view switch: it is a row id', async () => {
  const t = await views()
  await t.pressKey('mark')
  await t.pressKey('view')
  expect(marksOf(t)).toEqual(['b'])
  expect(rowBoxes(await t.draw()).filter(b => leaves(b).includes('*'))).toHaveLength(1)
})

test('m is dim on a row that takes no bulk key, and does nothing; a marked row can always be unmarked', async () => {
  const t = setup([web('a', { can: {} }), web('b')])
  t.w.state.set('selected', 'a')
  const tree = await t.draw()
  expect(buttonOf(tree, 'mark').props.dimColor).toBe(true)
  press(buttonOf(tree, 'mark'))
  await t.session.idle()
  expect(marksOf(t) ?? []).toEqual([])
  t.w.state.set('marks', ['a']) // marked another way (a later press that marks a whole turn): it stays unmarkable
  expect(buttonOf(await t.draw(), 'mark').props.dimColor).toBeUndefined()
  await t.pressKey('mark')
  expect(marksOf(t)).toEqual([])
})

test('the next mark write prunes the ids that no tracker row holds', async () => {
  const t = await marked('a', 'gone')
  await t.pressKey('mark') // b
  expect(marksOf(t)).toEqual(['a', 'b'])
})

test('the next mark write keeps the marks of rows that the trackers hold and a rule of time or of a cap leaves out', async () => {
  const t = await marked('a', 'old', 'gone')
  t.host.held = [web('old', { children: [web('older')] })] // the trackers hold `old`; the sections (what `paneData` gives) do not
  await t.pressKey('mark') // b
  expect(marksOf(t)).toEqual(['a', 'old', 'b']) // `gone` is held by no tracker: it goes
  t.w.state.set('marks', ['older', 'gone'])
  await t.pressKey('mark')
  expect(marksOf(t)).toEqual(['older', 'b']) // a child of a held row is held too
})

test('the next mark write keeps the marks of rows that the filter t, a cap and a closed parent leave out of the drawing', async () => {
  const t = setup(
    [web('a'), web('p', { children: [web('k')] }), reasoned('d', 'discovered'), ...webs('c', 'e', 'f', 'g')],
    {
      file: { global: { ui: { sectionRows: 5 } } },
    },
  )
  t.w.state.set('selected', 'a')
  t.w.state.set('marks', ['k', 'd', 'g']) // `k` under a closed row, `d` out by the filter, `g` past the cap
  await t.draw()
  await t.pressKey('touched')
  await t.pressKey('mark') // a
  expect(marksOf(t)).toEqual(['k', 'd', 'g', 'a'])
})

test('a mark press that began before the pane closed writes nothing after it', async () => {
  const t = await abc()
  const release = holdFirst(t.w.ports.state.marks, 'update')
  press(buttonOf(await t.draw(), 'mark'))
  await turn()
  await t.session.closed(t.w.ports)
  release()
  await t.session.idle()
  expect(marksOf(t)).toEqual([])
  expect(rings(t)).toEqual([])
})

// One press asks for the keys once, before the work (issue #115). `m` and a bulk digit have refocus calls of their own.
test('m and a bulk digit in a pane that has no keys ask for them once, before the work', async () => {
  const cases = [
    { key: 'mark', marks: [] as string[], engine: ['open', 'focus r1'] },
    { key: 'prio-1', marks: ['a', 'c'], engine: ['open', 'setPriorities a,c high', 'focus r1'] },
  ]
  for (const { key, marks, engine } of cases) {
    const t = setup(webs('a', 'b', 'c'))
    t.w.state.set('selected', 'b')
    t.w.state.set('marks', marks)
    const calls = engineLog(t)
    t.host.calls = calls
    press(buttonOf(await t.draw(80, undefined, false), key))
    await t.session.idle()
    expect(calls, key).toEqual(engine)
  }
})

test('x on one marked row that is the selected row dismisses it at once, as it did, and the marks clear', async () => {
  const t = await marked('b')
  t.host.onDismiss = () => t.host.setRows(webs('a', 'c', 'd'))
  await t.pressKey('dismiss')
  expect(t.host.calls).toEqual(['dismiss b'])
  expect(marksOf(t)).toEqual([])
  expect(t.selected()).toBe('c')
  expect(rings(t)).toEqual(['r1'])
})

test('x with two marked rows asks first: the view line holds the question, x says confirm 2, nothing is dismissed', async () => {
  const t = await marked('a', 'c')
  press(buttonOf(await t.draw(), 'dismiss'))
  await t.session.idle()
  expect(t.host.calls).toEqual([])
  const tree = await t.draw()
  expect(viewWords(tree)).toBe(QUESTION(2))
  expect(texts(tree).some(([, s]) => s.startsWith('View:'))).toBe(false) // the question replaces the words
  expect(labelOf(tree, 'dismiss')).toBe('confirm 2')
  expect(marksOf(t)).toEqual(['a', 'c']) // asking changes no mark
})

test('x again, from the drawing that showed the question, dismisses both rows in one call and clears the marks', async () => {
  const t = await marked('a', 'c')
  t.host.onDismiss = () => t.host.setRows(webs('b', 'd'))
  await t.pressKey('dismiss') // asks
  await t.pressKey('dismiss') // a drawing with the question, then the press
  expect(t.host.calls).toEqual(['dismiss a,c'])
  expect(marksOf(t)).toEqual([])
  // The selected row `b` stays: the ring goes to its new handle.
  expect(t.selected()).toBe('b')
  expect(rings(t)).toEqual(['r0'])
  expect(viewWords(await t.draw())).toBe('View: list') // no question is left
})

test('x on a selected row that was dismissed selects the next row that stays, and the ring follows it', async () => {
  const t = setup(webs('a', 'b', 'c', 'd', 'e'))
  t.w.state.set('selected', 'b')
  t.w.state.set('marks', ['b', 'c'])
  await t.draw()
  t.host.onDismiss = () => t.host.setRows(webs('a', 'd', 'e'))
  await t.pressKey('dismiss')
  await t.pressKey('dismiss')
  expect(t.host.calls).toEqual(['dismiss b,c'])
  expect(t.selected()).toBe('d') // past the marked c, not onto it
  expect(rings(t)).toEqual(['r1'])
})

test('x on the marked rows that were the last ones selects the row before; with no row left it clears the selection', async () => {
  const last = setup(webs('a', 'b', 'c'))
  last.w.state.set('selected', 'c')
  last.w.state.set('marks', ['b', 'c'])
  await last.draw()
  last.host.onDismiss = () => last.host.setRows(webs('a'))
  await last.pressKey('dismiss')
  await last.pressKey('dismiss')
  expect(last.selected()).toBe('a')
  expect(rings(last)).toEqual(['r0'])

  const all = setup(webs('a', 'b'))
  all.w.state.set('selected', 'a')
  all.w.state.set('marks', ['a', 'b'])
  await all.draw()
  all.host.onDismiss = () => all.host.setRows([])
  await all.pressKey('dismiss')
  await all.pressKey('dismiss')
  expect(all.host.calls).toEqual(['dismiss a,b'])
  expect(all.selected()).toBeNull()
  expect(rings(all)).toEqual([])
})

test('x skips the children of a dismissed row when it picks the next row to select', async () => {
  const t = setup([web('a'), web('b', { expandedByDefault: true, children: [web('b1')] }), web('c'), web('d')])
  t.w.state.set('selected', 'b')
  t.w.state.set('marks', ['b', 'c'])
  await t.draw()
  t.host.onDismiss = () => t.host.setRows(webs('a', 'd'))
  await t.pressKey('dismiss')
  await t.pressKey('dismiss')
  expect(t.selected()).toBe('d')
})

test('x with one marked row that is not the selected row asks as well (a stale mark must not act in silence)', async () => {
  const t = await marked('d')
  await t.pressKey('dismiss')
  expect(t.host.calls).toEqual([])
  expect(viewWords(await t.draw())).toBe('Dismiss 1 marked row? x again: yes')
  await t.pressKey('dismiss')
  expect(t.host.calls).toEqual(['dismiss d'])
})

test('an x from a drawing where it was live does nothing once no marked row can be dismissed', async () => {
  const process = row('p', { name: 'p', description: 'p' }, { owner: 'processes', can: {} })
  const t = setup([...webs('a', 'b'), process])
  t.w.state.set('selected', 'a')
  t.w.state.set('marks', ['a', 'b'])
  const tree = await t.draw() // x is live: a and b can be dismissed
  t.w.state.set('marks', ['p']) // the marks changed before the press ran
  press(buttonOf(tree, 'dismiss'))
  await t.session.idle()
  expect(t.host.calls).toEqual([])
  expect(viewWords(await t.draw())).toBe('View: list · 1 marked') // no "Dismiss 0 marked rows?"
})

test('a marked child and its marked parent go to one dismiss call, each once', async () => {
  const t = setup([web('a'), web('p', { expandedByDefault: true, children: [web('k')] }), web('c')])
  t.w.state.set('selected', 'a')
  t.w.state.set('marks', ['p', 'k'])
  await t.draw()
  t.host.onDismiss = () => t.host.setRows(webs('a', 'c'))
  await t.pressKey('dismiss')
  expect(viewWords(await t.draw())).toBe(QUESTION(2))
  await t.pressKey('dismiss')
  expect(t.host.calls).toEqual(['dismiss p,k'])
  expect(t.selected()).toBe('a')
})

test('two presses of x from one drawing do not confirm: only a drawing that showed the question answers', async () => {
  const t = await marked('a', 'c')
  const tree = await t.draw()
  press(buttonOf(tree, 'dismiss'))
  press(buttonOf(tree, 'dismiss'))
  await t.session.idle()
  expect(t.host.calls).toEqual([])
  // The next drawing shows the question: its press confirms.
  press(buttonOf(await t.draw(), 'dismiss'))
  await t.session.idle()
  expect(t.host.calls).toEqual(['dismiss a,c'])
})

test('two presses of x from two drawings that came before the question do not confirm either', async () => {
  const t = await marked('a', 'c')
  const first = await t.draw()
  const second = await t.draw() // a redraw between the presses, before the first press ran
  press(buttonOf(first, 'dismiss'))
  press(buttonOf(second, 'dismiss'))
  await t.session.idle()
  expect(t.host.calls).toEqual([])
  const shown = await t.draw() // shows the question
  press(buttonOf(first, 'dismiss')) // a press of a drawing from before the question keeps it armed
  await t.session.idle()
  expect(t.host.calls).toEqual([])
  press(buttonOf(shown, 'dismiss'))
  await t.session.idle()
  expect(t.host.calls).toEqual(['dismiss a,c'])
})

test('x with marked rows that changed since the question asks again, for the new rows', async () => {
  const t = await marked('a', 'c')
  await t.pressKey('dismiss') // asks about a and c
  t.w.state.set('marks', ['a', 'c', 'd']) // a mark that no key made
  await t.pressKey('dismiss')
  expect(t.host.calls).toEqual([])
  expect(viewWords(await t.draw())).toBe(QUESTION(3))
})

test('an x from the drawing that showed the question does not dismiss rows that were marked after it', async () => {
  const t = await marked('a', 'c')
  await t.pressKey('dismiss') // asks about a and c
  const shown = await t.draw() // shows the question
  t.w.state.set('marks', ['a', 'c', 'd']) // a mark that no key made, after the drawing
  press(buttonOf(shown, 'dismiss'))
  await t.session.idle()
  expect(t.host.calls).toEqual([])
  expect(marksOf(t)).toEqual(['a', 'c', 'd'])
  expect(viewWords(await t.draw())).toBe(QUESTION(3))
})

test('a drawing that holds other marked rows than the question withdraws it', async () => {
  const t = await marked('a', 'c')
  await t.pressKey('dismiss')
  expect(viewWords(await t.draw())).toBe(QUESTION(2))
  t.w.state.set('marks', ['a'])
  expect(viewWords(await t.draw())).toBe('View: list · 1 marked')
})

// Every key and every move of the person that is not the answer ends the question. The next x asks again.
const ENDS: [string, (t: ReturnType<typeof setup>) => Promise<void>][] = [
  ['r', t => t.pressKey('refresh')],
  ['g', t => t.pressKey('view')],
  ['a', t => t.pressKey('show-all')],
  ['t', t => t.pressKey('touched')],
  ['m', t => t.pressKey('mark')],
  [
    'h and back',
    async t => {
      await t.pressKey('help')
      await t.pressKey('help')
    },
  ],
  ['a click on a row', async t => press(buttonOf(await t.draw(), 'r0'))],
  ['the ring on an N more row', t => t.session.focused(t.w.ports, 'm0', 'person')],
  ['a ring move of the person onto a row', t => t.session.focused(t.w.ports, 'r0', 'person')],
]

test('any other key, a click on a row and a ring move onto a row end the question: the next x asks again', async () => {
  for (const [name, end] of ENDS) {
    const t = await marked('a', 'c')
    await t.pressKey('dismiss') // asks
    expect(viewWords(await t.draw()), name).toBe(QUESTION(2))
    await end(t)
    await t.session.idle()
    expect(viewWords(await t.draw()), name).toMatch(/^View: /)
    await t.pressKey('dismiss')
    expect(
      t.host.calls.filter(c => c.startsWith('dismiss')),
      name,
    ).toEqual([])
  }
})

const repoRow = (id: string) => row(id, { name: id, description: id }, { owner: 'repos', can: { dismiss: true } })

test('a click on a dim footer key or on an "N more" Button ends the question and the pane redraws without it', async () => {
  for (const end of ['prio-1', 'm0']) {
    const t = setup([repoRow('r1'), repoRow('r2'), ...webs('a', 'b', 'c', 'd', 'e', 'f')], {
      file: { global: { ui: { sectionRows: 5 } } },
    })
    t.w.state.set('selected', 'a')
    t.w.state.set('marks', ['r1', 'r2'])
    await t.draw()
    await t.pressKey('dismiss') // asks: two repo rows take x and no digit
    const tree = await t.draw()
    expect(viewWords(tree), end).toBe(QUESTION(2))
    expect(buttonOf(tree, 'prio-1').props.dimColor).toBe(true)
    const drawn = t.w.ui.invalidated
    press(buttonOf(tree, end))
    await t.session.idle()
    expect(t.w.ui.invalidated, end).toBeGreaterThan(drawn) // the pane is asked to draw without the question
    expect(viewWords(await t.draw()), end).toMatch(/^View: /)
    await t.pressKey('dismiss')
    expect(t.host.calls, end).toEqual([]) // asks again, dismisses nothing
  }
})

// A page key and the wheel move the selection and the ring, so they end the question like any move of the person (review m7).
test('a page key and a wheel tick end the question: the next x asks again', async () => {
  for (const by of [11, 1, -1]) {
    const t = setup(TWELVE)
    t.w.state.set('selected', 'w3')
    t.w.state.set('marks', ['w0', 'w2'])
    press(buttonOf(await t.draw(96, SHORT), 'dismiss'))
    await t.session.idle()
    expect(viewWords(await t.draw(96, SHORT)), String(by)).toBe(QUESTION(2))
    expect(await t.session.scrolled(t.w.ports, t.m, by)).toBe(true)
    expect(viewWords(await t.draw(96, SHORT)), String(by)).toMatch(/^View: /)
    press(buttonOf(await t.draw(96, SHORT), 'dismiss'))
    await t.session.idle()
    expect(t.host.calls, String(by)).toEqual([]) // asks again, dismisses nothing
    expect(viewWords(await t.draw(96, SHORT)), String(by)).toBe(QUESTION(2))
  }
})

// Codex review of #239 (round 5). With every row in view no window cuts the list, so `scrolled` leaves the move to the engine and
// returns false. The question must end before that return: a page key, Home, End and the wheel are things the person did other
// than answer, with a window or without one.
test('a page key and a wheel tick end the question also when every row fits, and the engine still scrolls', async () => {
  for (const by of [11, 1, -1]) {
    const t = await marked('a', 'c') // four rows in a body of no limit: no window
    press(buttonOf(await t.draw(), 'dismiss'))
    await t.session.idle()
    expect(viewWords(await t.draw()), String(by)).toBe(QUESTION(2))
    const drawn = t.w.ui.invalidated
    expect(await t.session.scrolled(t.w.ports, t.m, by), String(by)).toBe(false) // no window: the move is the engine's
    expect(t.w.ui.invalidated, String(by)).toBeGreaterThan(drawn) // the pane is asked to draw without the question
    expect(viewWords(await t.draw()), String(by)).toMatch(/^View: /)
    press(buttonOf(await t.draw(), 'dismiss'))
    await t.session.idle()
    expect(t.host.calls, String(by)).toEqual([]) // asks again, dismisses nothing
    expect(viewWords(await t.draw()), String(by)).toBe(QUESTION(2))
  }
})

// A body that holds every row of the list: `scrolled` finds a drawing with no window (`page` is absent).
test('a page key, Home and End end the question when a tall body holds every row of a long list', async () => {
  for (const by of [40, -40]) {
    const t = setup(TWELVE)
    t.w.state.set('selected', 'w3')
    t.w.state.set('marks', ['w0', 'w2'])
    press(buttonOf(await t.draw(96, 40), 'dismiss'))
    await t.session.idle()
    expect(viewWords(await t.draw(96, 40)), String(by)).toBe(QUESTION(2))
    expect(await t.session.scrolled(t.w.ports, t.m, by), String(by)).toBe(false)
    expect(viewWords(await t.draw(96, 40)), String(by)).toMatch(/^View: /)
  }
})

// Home on the first row and End on the last row of a window move nothing: the clamp leaves the selection where it is. The person
// still pressed a key other than the answer.
test('a page key that the window clamps at the first or the last row still ends the question', async () => {
  for (const [at, by] of [
    ['w0', -11],
    ['w0', -1],
    ['w11', 11],
    ['w11', 1],
  ] as const) {
    const t = setup(TWELVE)
    t.w.state.set('selected', at)
    t.w.state.set('marks', ['w1', 'w2'])
    press(buttonOf(await t.draw(96, SHORT), 'dismiss'))
    await t.session.idle()
    expect(viewWords(await t.draw(96, SHORT)), `${at} ${by}`).toBe(QUESTION(2))
    expect(await t.session.scrolled(t.w.ports, t.m, by), `${at} ${by}`).toBe(true)
    expect(t.selected(), `${at} ${by}`).toBe(at) // the clamp moved nothing
    expect(viewWords(await t.draw(96, SHORT)), `${at} ${by}`).toMatch(/^View: /)
  }
})

// A scroll event with no distance or no number is no move of the person: it leaves the question, with a window and without one.
test('a scroll event of 0 or of no number leaves the question standing', async () => {
  for (const rows of [undefined, SHORT]) {
    for (const by of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const t = setup(TWELVE)
      t.w.state.set('selected', 'w3')
      t.w.state.set('marks', ['w0', 'w2'])
      press(buttonOf(await t.draw(96, rows), 'dismiss'))
      await t.session.idle()
      expect(viewWords(await t.draw(96, rows)), `${rows} ${by}`).toBe(QUESTION(2))
      await t.session.scrolled(t.w.ports, t.m, by)
      expect(viewWords(await t.draw(96, rows)), `${rows} ${by}`).toBe(QUESTION(2))
    }
  }
})

// The close mark is a stop of the ring between the footer Buttons and the first row, with no key. A move onto it ends nothing, as a
// move onto a footer Button ends nothing: Tab from `x` walks the Buttons of the footer and the view line, then the close mark.
test('a ring move onto the close mark keeps the question, as a move onto a footer Button does', async () => {
  const t = await marked('a', 'c')
  await t.pressKey('dismiss')
  expect(viewWords(await t.draw())).toBe(QUESTION(2))
  await t.session.focused(t.w.ports, undefined, 'person')
  expect(viewWords(await t.draw())).toBe(QUESTION(2))
  await t.session.focused(t.w.ports, 'mark', 'person') // a Button of the view line
  expect(viewWords(await t.draw())).toBe(QUESTION(2))
})

// The label counts the marked rows that the drawing lays with the caps of the config. The budget guard may halve the caps of the
// drawing it keeps (a pane of thousands of values), and then a row that the label counted is no row of the drawing. The press
// reads the same laid rows as the label (review m5), so the question names the rows that the label named.
test('with the budget guard cutting the rows, the press acts on the rows that the label counted', async () => {
  // 300 rows with four open children each: 1500 rows, too many values for the budget, so the guard halves the caps.
  const kids = (id: string) => [1, 2, 3, 4].map(n => web(`${id}.${n}`))
  const rows = Array.from({ length: 300 }, (_, i) => web(`u${i}`, { expandedByDefault: true, children: kids(`u${i}`) }))
  const t = setup(rows, { file: { global: { ui: { sectionRows: 300, maxRows: 1000 } } } })
  t.w.state.set('selected', 'u0')
  t.w.state.set('marks', ['u0', 'u299'])
  const tree = await t.draw()
  expect(handlesOf(tree)).toHaveLength(750) // the guard halved the caps to 150 rows: u299 is no row of the drawing
  expect(labelOf(tree, 'dismiss')).toBe('dismiss 2')
  expect(viewWords(tree)).toBe('View: list · 2 marked')
  press(buttonOf(tree, 'dismiss'))
  await t.session.idle()
  expect(t.host.calls).toEqual([]) // two targets, as the label said: the press asks
  expect(viewWords(await t.draw())).toBe(QUESTION(2))
})

test('a digit ends the question as well, and clears the marks it acted on', async () => {
  const t = await marked('a', 'c')
  await t.pressKey('dismiss')
  expect(viewWords(await t.draw())).toBe(QUESTION(2))
  await t.pressKey('prio-3')
  expect(viewWords(await t.draw())).toBe('View: list')
  expect(marksOf(t)).toEqual([])
})

test('a ring move onto x keeps the question, and Enter on x confirms', async () => {
  const t = await marked('a', 'c')
  await t.pressKey('dismiss')
  const tree = await t.draw()
  await t.session.focused(t.w.ports, 'dismiss', 'person') // Tab onto x: a footer Button, no row
  expect(viewWords(await t.draw())).toBe(QUESTION(2))
  press(buttonOf(tree, 'dismiss'))
  await t.session.idle()
  expect(t.host.calls).toEqual(['dismiss a,c'])
})

test('a move of the plugin onto a row (its own ring request) does not end the question', async () => {
  const t = await marked('a', 'c')
  await t.pressKey('dismiss')
  await t.draw()
  await t.session.focused(t.w.ports, 'r1', 'plugin')
  expect(viewWords(await t.draw())).toBe(QUESTION(2))
})

test('a drawing without the keys ends the question, and the next x asks again', async () => {
  const t = await marked('a', 'c')
  await t.pressKey('dismiss')
  expect(viewWords(await t.draw())).toBe(QUESTION(2))
  expect(viewWords(await t.draw(80, undefined, false))).toBe('View: list · 2 marked')
  expect(viewWords(await t.draw())).toBe('View: list · 2 marked')
  await t.pressKey('dismiss')
  expect(t.host.calls).toEqual([])
})

test('closing the pane clears the marks and the question', async () => {
  const t = await marked('a', 'c')
  await t.pressKey('dismiss')
  await t.session.closed(t.w.ports)
  expect(marksOf(t)).toEqual([])
  t.w.state.set('selected', 'b')
  t.w.state.set('marks', ['a', 'c']) // marked again in the next pane
  expect(viewWords(await t.draw())).toBe('View: list · 2 marked')
  await t.pressKey('dismiss')
  expect(t.host.calls).toEqual([])
})

test('a press of x that began before the pane closed arms nothing after it', async () => {
  const t = await marked('a', 'c')
  press(buttonOf(await t.draw(), 'dismiss'))
  await t.session.closed(t.w.ports) // the press has not run: it reads `selected` first
  await t.session.idle()
  t.w.state.set('marks', ['a', 'c'])
  expect(viewWords(await t.draw())).toBe('View: list · 2 marked')
})

test('a digit with marked rows sets every marked row that takes it in one call, never asks and clears the marks', async () => {
  const t = await marked('a', 'c')
  await t.pressKey('prio-1')
  expect(t.host.calls).toEqual(['setPriorities a,c high'])
  expect(marksOf(t)).toEqual([])
  expect(t.selected()).toBe('b')
  expect(rings(t)).toEqual(['r1'])
  const auto = await marked('a', 'd')
  await auto.pressKey('prio-0')
  expect(auto.host.calls).toEqual(['setPriorities a,d undefined'])
})

test('a bulk dismiss and a bulk digit that fail log one line, keep the marks and leave the selection', async () => {
  const t = await marked('a', 'c')
  t.host.dismiss = async () => {
    throw new Error('boom')
  }
  await t.pressKey('dismiss') // asks
  await t.pressKey('dismiss') // confirms and fails
  expect(t.w.logs).toEqual(['pane: dismiss failed: boom'])
  expect(marksOf(t)).toEqual(['a', 'c'])
  expect(t.selected()).toBe('b')
  await t.pressKey('dismiss')
  expect(viewWords(await t.draw())).toBe(QUESTION(2)) // the answer was used: the next x asks again
  expect(t.w.logs).toHaveLength(1)
  t.host.setPriorities = async () => {
    throw new Error('bang')
  }
  await t.pressKey('prio-1')
  expect(t.w.logs.at(-1)).toBe('pane: prio-1 failed: bang')
  expect(marksOf(t)).toEqual(['a', 'c'])
})

test('a digit with a marked row that cannot take it leaves that row out', async () => {
  const t = setup([web('a'), web('b'), web('c', { can: { dismiss: true } })])
  t.w.state.set('selected', 'a')
  t.w.state.set('marks', ['b', 'c'])
  await t.draw()
  await t.pressKey('prio-2')
  expect(t.host.calls).toEqual(['setPriorities b normal'])
})

test('marks win: with two marked rows that take no digit and an item row selected, the digits are dim and change nothing', async () => {
  const t = setup([web('a'), repoRow('r1'), repoRow('r2')])
  t.w.state.set('selected', 'a')
  t.w.state.set('marks', ['r1', 'r2'])
  const tree = await t.draw()
  for (const key of ['prio-1', 'prio-2', 'prio-3', 'prio-0']) expect(buttonOf(tree, key).props.dimColor, key).toBe(true)
  expect(buttonOf(tree, 'dismiss').props.dimColor).toBeUndefined()
  for (const key of ['prio-1', 'prio-0']) press(buttonOf(tree, key))
  await t.session.idle()
  expect(t.host.calls).toEqual([])
  expect(marksOf(t)).toEqual(['r1', 'r2'])
  // x acts on the marked rows, not on the selected `a`: it asks about two rows.
  await t.pressKey('dismiss')
  expect(viewWords(await t.draw())).toBe(QUESTION(2))
})

test('marks win for x too: marked rows that cannot be dismissed make x dim, though the selected row could be', async () => {
  const process = (id: string) => row(id, { name: id, description: id }, { owner: 'processes', can: {} })
  const t = setup([web('a'), process('p1')])
  t.w.state.set('selected', 'a')
  t.w.state.set('marks', ['p1'])
  const tree = await t.draw()
  expect(buttonOf(tree, 'dismiss').props.dimColor).toBe(true)
  press(buttonOf(tree, 'dismiss'))
  await t.session.idle()
  expect(t.host.calls).toEqual([])
  expect(t.w.ui.invalidated).toBe(0) // it asked nothing
})

test('x acts on the marked rows while the selected row is a process row that cannot be dismissed', async () => {
  const process = row('p', { name: 'p', description: 'p' }, { owner: 'processes', can: {} })
  const t = setup([process, ...webs('a', 'b')])
  t.w.state.set('selected', 'p')
  t.w.state.set('marks', ['a', 'b'])
  const tree = await t.draw()
  expect(buttonOf(tree, 'dismiss').props.dimColor).toBeUndefined()
  expect(labelOf(tree, 'dismiss')).toBe('dismiss 2')
  await t.pressKey('dismiss')
  await t.pressKey('dismiss')
  expect(t.host.calls).toEqual(['dismiss a,b'])
})

test('a tracker key stays on the selected row, whatever is marked', async () => {
  const t = await marked('a', 'c')
  t.host.keys.add('web', [{ id: 'open', key: 'o', label: 'open', scope: 'row' }])
  t.host.allLive = true
  await t.pressKey('web.open')
  expect(t.host.calls).toEqual(['entry', 'runAction web.open b'])
})

test('marked rows that the drawing lacks (a cap, a closed parent) count nowhere and get no action', async () => {
  const t = setup([web('a'), web('p', { children: [web('k')] }), ...webs('c', 'd', 'e', 'f', 'g')], {
    file: { global: { ui: { sectionRows: 5 } } },
  })
  t.w.state.set('selected', 'a')
  t.w.state.set('marks', ['a', 'g', 'k']) // `g` is past the cap, `k` sits under a closed row
  const tree = await t.draw()
  expect(viewWords(tree)).toBe('View: list · 1 marked')
  expect(labelOf(tree, 'dismiss')).toBe('dismiss 1')
  await t.pressKey('dismiss') // one target, the selected row: at once
  expect(t.host.calls).toEqual(['dismiss a'])
})

test('a mark of a row that the touched filter hides is not drawn, counted or acted on', async () => {
  const t = setup([web('a'), reasoned('b', 'discovered'), reasoned('c', 'created')])
  t.w.state.set('selected', 'a')
  t.w.state.set('marks', ['a', 'b'])
  await t.draw()
  await t.pressKey('touched')
  const tree = await t.draw()
  expect(viewWords(tree)).toBe('View: list · touched only · 1 hidden · 1 marked')
  expect(rowBoxes(tree).map(b => leaves(b).includes('*'))).toEqual([true, false]) // a and c are drawn; b is not
  expect(labelOf(tree, 'dismiss')).toBe('dismiss 1')
  await t.pressKey('dismiss') // one target, the selected row: at once
  expect(t.host.calls).toEqual(['dismiss a'])
})

test('with no marked row drawn, x and the digits act on the selected row as before', async () => {
  const t = await marked('gone')
  await t.pressKey('prio-1')
  expect(t.host.calls).toEqual(['setPriority b high'])
  await t.pressKey('dismiss')
  expect(t.host.calls).toEqual(['setPriority b high', 'dismiss b'])
})

test('at 40 cells m keeps the selected row drawn and asks for the ring on it', async () => {
  const t = setup(TWELVE)
  t.w.state.set('selected', 'w9')
  await t.draw(40, 14)
  await t.pressKey('mark')
  const tree = await t.draw(40, 14)
  expect(shownIds(tree)).toContain('w9')
  expect(rings(t).at(-1)).toBe('r9')
})

test('the help view draws no question', async () => {
  const t = await marked('a', 'c')
  await t.pressKey('dismiss')
  t.w.state.set('help', true)
  const tree = await t.draw()
  expect(texts(tree).some(([, s]) => s.startsWith('Dismiss '))).toBe(false)
})
