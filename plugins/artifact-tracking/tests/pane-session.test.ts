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
import { buttonOf, footerOf, handlesOf, leaves, press, rowBoxes } from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { fakePorts } from './fixtures/ports'
import { COLS, row, section } from './fixtures/sections'

/** A web row of the owner `web`, the one item owner of these tests. */
const web = (id: string, extra: Partial<TreeRow> = {}, key = id): TreeRow =>
  row(id, { prio: '', key, title: `https://${id}.example/` }, { owner: 'web', ...extra })

const webs = (...ids: string[]): TreeRow[] => ids.map(id => web(id))

function setup(
  rows: readonly TreeRow[],
  o: { path?: string; problems?: string[]; file?: Record<string, unknown> } = {},
) {
  resetWidths()
  const w = fakePorts()
  const reg = new KeyRegistry()
  const host = {
    sections: [section('web', COLS, rows)] as SectionSpec[],
    views: [] as PaneView[],
    calls: [] as string[],
    keyProblems: [] as string[],
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
  const draw = (cols = 80) => session.draw(w.ports, m, EL, cols)
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
  expect(lines).toContain('Pane keys')
  expect(lines).toContain('Config file: /p/config.json')
  expect(lines).toContain('X.')
  expect(buttonOf(tree, 'help').props.label).toBe('back')
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
  expect(out.startsWith('Pane keys\n  r  refresh\n  h  help')).toBe(true)
  expect(out.endsWith('Config file: /p/config.json\nProblems\n  X.\n  Y.')).toBe(true)
  expect(t.host.views[0]).toBe(TEXT_VIEW)
})
