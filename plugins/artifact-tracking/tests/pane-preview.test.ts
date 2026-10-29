// PaneSession and the preview (issue #57, L2): `v` on a row whose tracker has a preview opens the view in place of the table, `v`,
// `d` and `r` of its key line switch the mode or read again, Esc goes back to the list, and the content sits in module memory only.
// On fakePorts and a fake host, as pane-session.test.ts does. A kit test cannot raise `ui.close` (pane.test.tsx says so), so the
// close hook is tested here, through `PaneSession.closeOrBack`, which register.tsx calls. Design study R9 to R13, G11, G18:
// https://github.com/martin-macak/claude-code-mod-tracking/issues/57#issuecomment-6414682787

import type { PluginState } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { CORE_KEYS, footerKeys, KeyRegistry } from '../core/infra/keys'
import type { PreviewContent, PreviewMode, PreviewModeId, PreviewState } from '../core/interfaces/preview'
import type { FooterKey, PaneKey, PaneView, RowRef, SectionSpec, TreeRow } from '../core/interfaces/view'
import { type PlanLine, planLines } from '../core/lib/clean-text'
import { frameFromState, type Refocus, RING_PAUSE_MS } from '../hooks/pane-refocus'
import { listText, type PaneHost, PaneSession } from '../hooks/pane-session'
import type { TurnPaneHost } from '../hooks/pane-turn'
import { resetWidths } from '../ux/tree-data-table/columns'
import { footerRows } from '../ux/tree-data-table/footer'
import { fakeConfig } from './fixtures/config-fs'
import { buttonOf, footerOf, handlesOf, leaves, nodes, press, texts } from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { fakePorts } from './fixtures/ports'
import { row, section } from './fixtures/sections'

const MARKER = 'MARKER_OF_THE_CONTENT'
const VIEW: PreviewMode = { id: 'view', enabled: true }
/** The plan that the fake host gives for `p`: one line that says what it is. */
const PLAN: readonly PlanLine[] = planLines([], [])

/** A row of the owner `file`, whose tracker has a preview, and one of `web`, whose tracker has none. */
const fileRow = (id: string): TreeRow => row(id, { control: '', name: id, description: '' }, { owner: 'file' })
const webRow = (id: string): TreeRow => row(id, { control: '', name: id, description: '' }, { owner: 'web' })

/** What the fake provider returns for a view: the marker and the mode, so a test sees which view it got. */
const contentOf = (rowId: string, mode: PreviewModeId): PreviewContent => ({
  title: rowId,
  subtitle: `code · ${mode}`,
  blocks: [
    { kind: 'notice', text: `a notice of ${mode}` },
    { kind: 'code', source: `${MARKER} ${rowId} ${mode}\n`, path: rowId, startLine: 1 },
  ],
})

function setup(
  rows: readonly TreeRow[] = [fileRow('a.ts'), fileRow('b.ts'), webRow('w')],
  keys: readonly PaneKey[] = CORE_KEYS,
) {
  resetWidths()
  const w = fakePorts()
  const reg = new KeyRegistry(keys)
  reg.addPreview('file')
  const host = {
    sections: [section('mixed', rows)] as SectionSpec[],
    calls: [] as string[],
    /** The modes of a row by id. Absent: the view only. `undefined`: the row has no preview. */
    modes: new Map<string, readonly PreviewMode[] | undefined>(),
    loads: [] as string[],
    /** Holds every load open until it is called. */
    gate: undefined as Promise<void> | undefined,
    /** Holds the loads of one row id open until its gate is called: a slow read of one row, the others fast. */
    gates: new Map<string, Promise<void>>(),
    content: contentOf,
    /** Holds the read of the plan of `p` open until it is called (the plan view, issue #199). */
    planGate: undefined as Promise<void> | undefined,
    entry: async () => void host.calls.push('entry'),
    paneData: async (_p: unknown, _view: PaneView) => host.sections,
    inventory: async () => host.sections,
    footer: async (
      _p: unknown,
      rowRef: RowRef | undefined,
      help: boolean,
      markedRows?: readonly RowRef[],
    ): Promise<readonly FooterKey[]> => footerKeys(reg, rowRef, () => true, help, undefined, markedRows),
    dismiss: async () => void host.calls.push('dismiss'),
    setPriority: async () => void host.calls.push('setPriority'),
    setPriorities: async () => void host.calls.push('setPriorities'),
    refreshManual: async () => void host.calls.push('refreshManual'),
    runAction: async () => {},
    previewModes: async (_p: unknown, _owner: string, rowId: string) =>
      host.modes.has(rowId) ? host.modes.get(rowId) : [VIEW],
    loadPreview: async (_p: unknown, owner: string, rowId: string, mode: PreviewModeId) => {
      host.loads.push(`${owner} ${rowId} ${mode}`)
      await host.gate
      await host.gates.get(rowId)
      return host.content(rowId, mode)
    },
    cleanPlan: async (): Promise<readonly PlanLine[]> => {
      host.calls.push('cleanPlan')
      await host.planGate
      return PLAN
    },
    problems: () => [] as string[],
    liveTools: (): readonly string[] => [],
    isItemOwner: () => true,
    keys: reg,
    config: fakeConfig({}),
  }
  const session = new PaneSession()
  const m = host as unknown as PaneHost
  const draw = (cols = 96, rows?: number, focused?: boolean, s = session) =>
    s.draw(w.ports, m, EL, { bodyColumns: cols, bodyRows: rows, focused })
  const preview = () => w.state.get('preview') ?? null
  return { w, host, session, m, draw, preview }
}

/** Lets the work already started run, as far as it can: the fake ports answer in microtasks. */
const turn = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

/** The Code and Markdown elements of a drawing: what the person reads. */
const contentIn = (tree: unknown): string[] =>
  [...nodes(tree, 'Code'), ...nodes(tree, 'Markdown')].map(n => String(n.props.source ?? n.props.text))

/** A pane on `a.ts` with its preview open: the press of `v` has run. */
async function opened(rows?: readonly TreeRow[]) {
  const t = setup(rows)
  t.w.state.set('selected', 'a.ts')
  press(buttonOf(await t.draw(), 'preview'))
  await t.session.idle()
  return t
}

// ---------------------------------------------------------------- the key

test('v is on the footer of a row whose tracker has a preview, and on no other row (R11)', async () => {
  const t = setup()
  t.w.state.set('selected', 'a.ts')
  expect(footerOf(await t.draw()).map(b => b.props.hotkey)).toEqual(['r', 'h', 'x', '1', '2', '3', '0', 'v'])
  t.w.state.set('selected', 'w')
  expect(footerOf(await t.draw()).map(b => b.props.hotkey)).toEqual(['r', 'h', 'x', '1', '2', '3', '0'])
  t.w.state.set('selected', null)
  expect(footerOf(await t.draw()).map(b => b.props.hotkey)).toEqual(['r', 'h', 'x', '1', '2', '3', '0'])
})

test('v at 100x40 inline keeps the footer to one row: r h x 1 2 3 0 v and Esc close fit the 96 cells of the body', async () => {
  const t = setup()
  t.w.state.set('selected', 'a.ts')
  const keys = await t.m.footer(t.w.ports, { id: 'a.ts', owner: 'file', group: 'g', can: {} }, false)
  expect(keys.map(k => k.key).join('')).toBe('rhx1230v')
  expect(footerRows(keys, 96, false)).toBe(1)
})

// ---------------------------------------------------------------- opening

test('v loads the content of the selected row, then writes the row id, the owner and the mode, never the content (R10, R13)', async () => {
  const t = setup()
  t.w.state.set('selected', 'b.ts')
  let release = () => {}
  t.host.gate = new Promise<void>(go => (release = go))
  press(buttonOf(await t.draw(), 'preview'))
  await turn()
  // Hold the fake call open: the read has begun and the state does not name the preview yet, so the table stays as it is.
  expect(t.host.loads).toEqual(['file b.ts view'])
  expect(t.preview()).toBeNull()
  expect(handlesOf(await t.draw())).toEqual(['r0', 'r1', 'r2'])
  release()
  await t.session.idle()
  expect(t.preview()).toEqual({ rowId: 'b.ts', owner: 'file', mode: 'view' })
  expect(JSON.stringify([...t.w.state.entries()])).not.toContain(MARKER)
  expect(JSON.stringify([...t.w.store.entries(), t.w.prompts, t.w.logs])).not.toContain(MARKER)
})

test('the preview draws in place of the table: the header, the key line, the notice, then the content, and no row (R10)', async () => {
  const t = await opened()
  const tree = await t.draw()
  expect(handlesOf(tree)).toEqual([])
  expect(contentIn(tree)).toEqual([`${MARKER} a.ts view\n`])
  const lines = leaves(tree)
  expect(lines.slice(0, 2)).toEqual(['a.ts', ' · code · view'])
  expect(lines.indexOf('a notice of view')).toBeGreaterThan(lines.indexOf('Esc back'))
  expect(nodes(tree, 'Button').map(b => [b.props.key, b.props.hotkey, b.props.label])).toEqual([
    ['preview', 'v', 'view'],
    ['refresh', 'r', 'reload'],
  ])
  // The list is not drawn: no footer key but those of the key line, no view line.
  expect(texts(tree).some(([, s]) => s.startsWith('View:'))).toBe(false)
})

test('a press of v on a row that says it has no preview, or whose mode is off, gives a toast and opens nothing', async () => {
  const t = setup()
  t.w.state.set('selected', 'a.ts')
  t.host.modes.set('a.ts', undefined)
  press(buttonOf(await t.draw(), 'preview'))
  await t.session.idle()
  expect(t.preview()).toBeNull()
  expect(t.w.ui.toasts).toEqual(['This row has no preview.'])
  t.host.modes.set('a.ts', [{ id: 'view', enabled: false, reason: 'Secret.' }])
  press(buttonOf(await t.draw(), 'preview'))
  await t.session.idle()
  expect(t.preview()).toBeNull()
  expect(t.w.ui.toasts).toEqual(['This row has no preview.', 'Secret.'])
  expect(t.host.loads).toEqual([])
})

// ---------------------------------------------------------------- modes and reload

test('the key line has a Button for each mode the row has, dim when the mode is off; a press of d switches the mode, and the cache keeps both views', async () => {
  const t = setup()
  t.host.modes.set('a.ts', [VIEW, { id: 'diff', enabled: true }])
  t.w.state.set('selected', 'a.ts')
  press(buttonOf(await t.draw(), 'preview'))
  await t.session.idle()
  const view = await t.draw()
  expect(nodes(view, 'Button').map(b => b.props.hotkey)).toEqual(['v', 'd', 'r'])
  press(buttonOf(view, 'diff'))
  await t.session.idle()
  expect(t.preview()).toEqual({ rowId: 'a.ts', owner: 'file', mode: 'diff' })
  expect(contentIn(await t.draw())).toEqual([`${MARKER} a.ts diff\n`])
  // Back to the view: it is in the cache, but a press reads again, as `v` says (the file may have changed).
  press(buttonOf(await t.draw(), 'preview'))
  await t.session.idle()
  expect(t.host.loads).toEqual(['file a.ts view', 'file a.ts diff', 'file a.ts view'])
  expect(contentIn(await t.draw())).toEqual([`${MARKER} a.ts view\n`])
})

test('a mode that is off draws dim and says why in a toast; a mode that is gone does nothing', async () => {
  const t = setup()
  t.host.modes.set('a.ts', [VIEW, { id: 'diff', enabled: false, reason: 'No repo here.' }])
  t.w.state.set('selected', 'a.ts')
  press(buttonOf(await t.draw(), 'preview'))
  await t.session.idle()
  const tree = await t.draw()
  expect(buttonOf(tree, 'diff').props.dimColor).toBe(true)
  press(buttonOf(tree, 'diff'))
  await t.session.idle()
  expect(t.w.ui.toasts).toEqual(['No repo here.'])
  expect(t.preview()).toMatchObject({ mode: 'view' })
  expect(t.host.loads).toHaveLength(1)
})

test('r in the preview reads the content again and does not refresh the trackers; the same view is drawn again', async () => {
  const t = await opened()
  let n = 0
  t.host.content = (id, mode) =>
    contentOf(id, mode).blocks.length > 0
      ? { ...contentOf(id, mode), blocks: [{ kind: 'code', source: `read ${++n}\n` }] }
      : contentOf(id, mode)
  const before = t.w.ui.invalidated
  press(buttonOf(await t.draw(), 'refresh'))
  await t.session.idle()
  expect(t.host.calls).not.toContain('refreshManual')
  expect(t.host.loads).toEqual(['file a.ts view', 'file a.ts view'])
  expect(contentIn(await t.draw())).toEqual(['read 1\n'])
  expect(t.w.ui.invalidated).toBeGreaterThan(before) // the state is the same, so the pane is asked to draw again
})

test('r in the list still refreshes the trackers', async () => {
  const t = setup()
  t.w.state.set('selected', 'a.ts')
  press(buttonOf(await t.draw(), 'refresh'))
  await t.session.idle()
  expect(t.host.calls).toContain('refreshManual') // in the list, r is refresh as before
})

test('a press from the drawing before the preview does nothing while the preview shows: no dismiss, no priority, no toast, no new read (R10)', async () => {
  const t = setup()
  t.w.state.set('selected', 'a.ts')
  const list = await t.draw() // the drawing the stale press comes from
  press(buttonOf(list, 'preview'))
  await t.session.idle()
  press(buttonOf(list, 'dismiss'))
  press(buttonOf(list, 'prio-1'))
  await t.session.idle()
  expect(t.host.calls).not.toContain('dismiss')
  expect(t.host.calls).not.toContain('setPriority')
  expect(t.w.ui.toasts).toEqual([])
  expect(t.host.loads).toEqual(['file a.ts view'])
  expect(t.preview()).toEqual({ rowId: 'a.ts', owner: 'file', mode: 'view' })
})

test('a press of v from a drawing before h opens nothing over the help view (the body is one view)', async () => {
  const t = setup()
  t.w.state.set('selected', 'a.ts')
  const list = await t.draw()
  t.w.state.set('help', true) // `h` came first
  press(buttonOf(list, 'preview'))
  await t.session.idle()
  expect(t.preview()).toBeNull()
  expect(t.host.loads).toEqual([])
  expect(t.w.ui.toasts).toEqual([])
})

// The plan view of issue #199 and the preview are two more views of the one body. `Frame.view` names the one that a drawing shows.
test('a press of v from a drawing before p opens nothing over the plan view (the body is one view)', async () => {
  const t = setup()
  t.w.state.set('selected', 'a.ts')
  const list = await t.draw()
  press(buttonOf(list, 'clean')) // `p` came first
  await t.session.idle()
  expect(handlesOf(await t.draw())).toEqual([]) // the plan view shows, and no row
  const asked = t.host.calls.length
  press(buttonOf(list, 'preview'))
  await t.session.idle()
  expect(t.preview()).toBeNull()
  expect(t.host.loads).toEqual([])
  expect(t.host.calls).toHaveLength(asked)
  expect(t.w.ui.toasts).toEqual([])
  expect(handlesOf(await t.draw())).toEqual([]) // still the plan view
})

test('a read of the plan that ends after v opened the preview opens no plan view: Esc goes back to the list', async () => {
  const t = setup()
  t.w.state.set('selected', 'a.ts')
  const list = await t.draw()
  let release = () => {}
  t.host.planGate = new Promise<void>(go => (release = go))
  press(buttonOf(list, 'clean')) // `p` starts to read the plan
  await turn()
  press(buttonOf(list, 'preview')) // `v` opens the preview while the plan is read
  await turn()
  expect(t.preview()).toEqual({ rowId: 'a.ts', owner: 'file', mode: 'view' })
  release() // the read ends and finds the preview open: it writes no lines
  await turn()
  expect(await t.session.closeOrBack(t.w.ports, t.m, 'person')).toEqual({ deny: 'back to the list' })
  await t.session.idle()
  expect(handlesOf(await t.draw())).toEqual(['r0', 'r1', 'r2']) // the list, not the plan view
})

// ---------------------------------------------------------------- the quick view (issue #276, L1 of #275)

// The quick view belongs to the list. The preview, the help view and the plan view are other views of the one body, and none of them
// draws `e` as a live Button, so a press of `e` from a drawing before the view changed flips nothing: the person would find a flipped
// flag on the way back. In this layer the two stay apart: `v` leaves the quick view alone, `e` leaves the preview alone, and both
// come back as they were (the preview and the quick view share one body in L2, issue #277). Each test ends with a control: the same
// press from a fresh list drawing flips the flag, so the guard does not hold `e` for good.
const QUICK_DEFAULT = { full: true, compact: false }
/** After one `e` in a draw with no body height, which is the compact form: its flag turns on. */
const QUICK_COMPACT_ON = { full: true, compact: true }
/** After one `e` in a body of 30 rows, which is the full form: its flag turns off. */
const QUICK_FULL_OFF = { full: false, compact: false }

test('a press of e from a drawing before v changes nothing over the preview, and e works again on the way back', async () => {
  const t = setup()
  t.w.state.set('selected', 'a.ts')
  const list = await t.draw()
  press(buttonOf(list, 'preview')) // `v` came first
  await t.session.idle()
  expect(t.preview()).toEqual({ rowId: 'a.ts', owner: 'file', mode: 'view' })
  const loads = [...t.host.loads]
  press(buttonOf(list, 'quick'))
  await t.session.idle()
  expect(t.w.stateSets.quick).toBeUndefined() // no write at all
  expect(await t.w.ports.state.quick.get()).toEqual(QUICK_DEFAULT)
  expect(t.preview()).toEqual({ rowId: 'a.ts', owner: 'file', mode: 'view' }) // the preview stays
  expect(t.host.loads).toEqual(loads) // and reads nothing again
  expect(t.w.ui.toasts).toEqual([])
  const tree = await t.draw()
  expect(handlesOf(tree)).toEqual([]) // still the preview, and no `e` in its key line
  expect(nodes(tree, 'Button').map(b => b.props.hotkey)).toEqual(['v', 'r'])
  // Control: Esc goes back to the list, and `e` there flips the flag as it always did.
  expect(await t.session.closeOrBack(t.w.ports, t.m, 'person')).toEqual({ deny: 'back to the list' })
  await t.session.idle()
  press(buttonOf(await t.draw(), 'quick'))
  await t.session.idle()
  expect(t.w.state.get('quick')).toEqual(QUICK_COMPACT_ON)
})

test('a press of e from a drawing before p changes nothing over the plan view, and e works again after p', async () => {
  const t = setup()
  t.w.state.set('selected', 'a.ts')
  const list = await t.draw()
  press(buttonOf(list, 'clean')) // `p` came first
  await t.session.idle()
  expect(handlesOf(await t.draw())).toEqual([]) // the plan view shows
  press(buttonOf(list, 'quick'))
  await t.session.idle()
  expect(t.w.stateSets.quick).toBeUndefined()
  expect(await t.w.ports.state.quick.get()).toEqual(QUICK_DEFAULT)
  expect(t.w.ui.toasts).toEqual([])
  expect(handlesOf(await t.draw())).toEqual([]) // still the plan view
  // Control: `p` again shows the list, and `e` there flips the flag.
  press(buttonOf(await t.draw(), 'clean'))
  await t.session.idle()
  expect(handlesOf(await t.draw())).toEqual(['r0', 'r1', 'r2'])
  press(buttonOf(await t.draw(), 'quick'))
  await t.session.idle()
  expect(t.w.state.get('quick')).toEqual(QUICK_COMPACT_ON)
})

test('a press of e from a drawing before h changes nothing over the help view, and e works again after h', async () => {
  const t = setup()
  t.w.state.set('selected', 'a.ts')
  const list = await t.draw()
  t.w.state.set('help', true) // `h` came first
  press(buttonOf(list, 'quick'))
  await t.session.idle()
  expect(t.w.stateSets.quick).toBeUndefined()
  expect(await t.w.ports.state.quick.get()).toEqual(QUICK_DEFAULT)
  // Control: with the help view off again, `e` flips the flag.
  t.w.state.set('help', false)
  press(buttonOf(await t.draw(), 'quick'))
  await t.session.idle()
  expect(t.w.state.get('quick')).toEqual(QUICK_COMPACT_ON)
})

test('v from the list with the quick view hidden opens the preview, and the flag of e is what it was when the list comes back', async () => {
  const t = setup()
  t.w.state.set('selected', 'a.ts')
  press(buttonOf(await t.draw(96, 30), 'quick')) // `e` hides the quick view of the full form
  await t.session.idle()
  expect(t.w.state.get('quick')).toEqual(QUICK_FULL_OFF)
  press(buttonOf(await t.draw(96, 30), 'preview'))
  await t.session.idle()
  expect(t.preview()).toEqual({ rowId: 'a.ts', owner: 'file', mode: 'view' })
  expect(t.w.state.get('quick')).toEqual(QUICK_FULL_OFF) // `v` writes no flag
  expect(await t.session.closeOrBack(t.w.ports, t.m, 'person')).toEqual({ deny: 'back to the list' })
  await t.session.idle()
  expect(t.w.state.get('quick')).toEqual(QUICK_FULL_OFF) // Esc writes none either: the list comes back as it was
  expect(handlesOf(await t.draw(96, 30))).toEqual(['r0', 'r1', 'r2'])
})

// ---------------------------------------------------------------- scroll, hint, close

test('while the preview shows the pane leaves the scroll to the engine: the mod moves no selection', async () => {
  const t = await opened()
  await t.draw()
  expect(await t.session.scrolled(t.w.ports, t.m, 3)).toBe(false)
  expect(await t.session.scrolled(t.w.ports, t.m, -3)).toBe(false)
})

test('a pane with no keys draws the hint above the preview, as it does above the table', async () => {
  const t = await opened()
  const tree = await t.draw(96, 11, false)
  expect(leaves(tree)[0]).toBe('Keys go to the prompt. ctrl+x Tab gives them back.')
  expect(contentIn(tree)).toHaveLength(1)
})

test('Esc by the person goes back to the list: the state is cleared, the pane is opened again with the keys, and the answer is back (G11)', async () => {
  const t = await opened()
  t.w.state.set('marks', ['b.ts'])
  const opens = t.w.ui.opened
  expect(await t.session.closeOrBack(t.w.ports, t.m, 'person')).toEqual({ deny: 'back to the list' })
  expect(t.preview()).toBeNull()
  expect(t.w.ui.opened).toBe(opens + 1)
  // Not a closing: the selection, the marks and the pending presses stay.
  expect(t.w.state.get('selected')).toBe('a.ts')
  expect(t.w.state.get('marks')).toEqual(['b.ts'])
  expect(handlesOf(await t.draw())).toEqual(['r0', 'r1', 'r2'])
  expect(contentIn(await t.draw())).toEqual([])
})

test('Esc in the list closes the pane as before, and so does a close that the plugin or the engine makes, a preview or not', async () => {
  const t = setup()
  expect(await t.session.closeOrBack(t.w.ports, t.m, 'person')).toBeUndefined() // the list
  const shown = await opened()
  expect(await shown.session.closeOrBack(shown.w.ports, shown.m, 'plugin')).toBeUndefined()
  expect(await shown.session.closeOrBack(shown.w.ports, shown.m, 'unload')).toBeUndefined()
  expect(shown.preview()).toEqual({ rowId: 'a.ts', owner: 'file', mode: 'view' }) // `closed` clears it
  await shown.session.closed(shown.w.ports)
  expect(shown.preview()).toBeNull()
})

test('a state write that fails while Esc goes back lets the pane close: the person is never stuck in the preview', async () => {
  const t = await opened()
  ;(t.w.ports.state as { preview: unknown }).preview = {
    get: async () => ({ rowId: 'a.ts', owner: 'file', mode: 'view' }),
    update: async () => {
      throw new Error('boom')
    },
  }
  expect(await t.session.closeOrBack(t.w.ports, t.m, 'person')).toBeUndefined()
})

test('the second Esc closes the pane: closing in the list answers close, and closed clears the preview and the cache', async () => {
  const t = await opened()
  await t.session.closeOrBack(t.w.ports, t.m, 'person')
  expect(await t.session.closeOrBack(t.w.ports, t.m, 'person')).toBeUndefined()
  const reopened = await opened()
  await reopened.session.closed(reopened.w.ports)
  expect(reopened.preview()).toBeNull()
  expect(reopened.host.loads).toEqual(['file a.ts view'])
})

test('a read that finishes after the person went back writes no preview and keeps no content', async () => {
  const t = await opened()
  let release = () => {}
  t.host.gate = new Promise<void>(go => (release = go))
  press(buttonOf(await t.draw(), 'refresh')) // r: a slow read begins
  await turn()
  await t.session.closeOrBack(t.w.ports, t.m, 'person') // Esc while it runs
  release()
  await t.session.idle()
  expect(t.preview()).toBeNull() // the finished read did not bring the preview back
  expect(contentIn(await t.draw())).toEqual([])
})

// ---------------------------------------------------------------- the strip of a turn

/** The host of a turn press: the fake host and the two members that `PaneSession.openTurn` reads, a turn `ord` that lists `keys`. */
function turnHost(t: ReturnType<typeof setup>, keys: readonly string[], ord = 2): TurnPaneHost {
  return {
    ...t.host,
    bandTurn: async () => ({ ord, text: '+1 new', keys }),
    items: { kick: () => {} },
  } as unknown as TurnPaneHost
}

test('the open Button of a turn strip while the preview shows leaves the preview: the row of the turn is selected, drawn in the list and rung (R10, Codex of PR 280)', async () => {
  const t = await opened() // the preview of a.ts
  await t.session.openTurn(t.w.ports, turnHost(t, ['b.ts']), 2)
  expect(t.w.state.get('selected')).toBe('b.ts')
  expect(t.preview()).toBeNull()
  const tree = await t.draw()
  expect(contentIn(tree)).toEqual([]) // no file on show: the pane draws the list
  expect(handlesOf(tree)).toEqual(['r0', 'r1', 'r2'])
  expect(t.w.ui.focused).toEqual(['r1']) // the ring goes to the row of the turn, the handle of b.ts
})

test('the open Button of a turn strip while a read of the preview still runs: the read ends and brings no preview over the turn (R10, Codex of PR 280)', async () => {
  const t = await opened()
  let release = () => {}
  t.host.gate = new Promise<void>(go => (release = go))
  press(buttonOf(await t.draw(), 'refresh')) // r: a slow read of a.ts begins
  await turn()
  await t.session.openTurn(t.w.ports, turnHost(t, ['b.ts']), 2)
  release()
  await t.session.idle()
  expect(t.preview()).toBeNull() // the finished read did not bring the preview back over the turn
  expect(t.w.state.get('selected')).toBe('b.ts')
  expect(contentIn(await t.draw())).toEqual([])
})

test('the open Button of a turn strip while the first v still reads: the preview never opens over the turn (R10, Codex of PR 280)', async () => {
  const t = setup()
  t.w.state.set('selected', 'a.ts')
  let release = () => {}
  t.host.gate = new Promise<void>(go => (release = go))
  press(buttonOf(await t.draw(), 'preview')) // v: the read begins, the state names no preview yet
  await turn()
  expect(t.preview()).toBeNull()
  await t.session.openTurn(t.w.ports, turnHost(t, ['b.ts']), 2)
  release()
  await t.session.idle()
  expect(t.preview()).toBeNull()
  expect(t.w.state.get('selected')).toBe('b.ts')
  expect(contentIn(await t.draw())).toEqual([])
})

test('the open Button of a turn strip with no preview on show leaves the list as it was and still selects the row of the turn', async () => {
  const t = setup()
  t.w.state.set('selected', 'a.ts')
  await t.session.openTurn(t.w.ports, turnHost(t, ['b.ts']), 2)
  expect(t.preview()).toBeNull()
  expect(t.w.state.get('selected')).toBe('b.ts')
  expect(handlesOf(await t.draw())).toEqual(['r0', 'r1', 'r2'])
  expect(t.host.loads).toEqual([])
})

// ---------------------------------------------------------------- memory

test('after a hot reload the state names a preview and the memory is empty: the drawing says Loading, starts one read, and writes no state (G18)', async () => {
  const t = await opened()
  const fresh = new PaneSession() // module memory lost
  t.w.stateSets = {}
  let release = () => {}
  t.host.gate = new Promise<void>(go => (release = go))
  const first = await t.draw(96, undefined, undefined, fresh)
  expect(leaves(first)).toContain('Loading…')
  expect(nodes(first, 'Button')).toHaveLength(2) // the keys are there while it loads
  await t.draw(96, undefined, undefined, fresh) // a second drawing starts no second read
  await turn()
  expect(t.host.loads.filter(l => l === 'file a.ts view')).toHaveLength(2) // the first open, and the one read of the reload
  expect(t.w.stateSets).toEqual({}) // a render writes nothing
  const asked = t.w.ui.invalidated
  release()
  await fresh.idle()
  expect(t.w.ui.invalidated).toBe(asked + 1) // the pane is asked to draw again
  expect(contentIn(await t.draw(96, undefined, undefined, fresh))).toEqual([`${MARKER} a.ts view\n`])
  expect(t.host.loads.filter(l => l === 'file a.ts view')).toHaveLength(2)
})

test('the cache keeps the last two views: a third pushes the oldest out', async () => {
  const t = setup()
  t.host.modes.set('a.ts', [VIEW, { id: 'diff', enabled: true }])
  t.host.modes.set('b.ts', [VIEW])
  t.w.state.set('selected', 'a.ts')
  press(buttonOf(await t.draw(), 'preview'))
  await t.session.idle()
  press(buttonOf(await t.draw(), 'diff'))
  await t.session.idle()
  // Another row's view: write the state by hand, as a second open would, and the fresh draw reads from the cache.
  t.w.state.set('preview', { rowId: 'b.ts', owner: 'file', mode: 'view' })
  await t.draw() // a miss: starts a read of b.ts, which enters the cache and pushes a.ts view out
  await t.session.idle()
  t.w.state.set('preview', { rowId: 'a.ts', owner: 'file', mode: 'view' })
  expect(leaves(await t.draw())).toContain('Loading…') // a.ts view was the oldest
  await t.session.idle()
  expect(t.host.loads).toEqual(['file a.ts view', 'file a.ts diff', 'file b.ts view', 'file a.ts view'])
})

test('the /track text is the list and holds no content of a preview that shows', async () => {
  const t = await opened()
  expect(await listText(t.w.ports, t.m)).not.toContain(MARKER)
})

test('Esc by the person drops the content from memory: a state that names the preview again finds none (R13)', async () => {
  const t = await opened()
  await t.session.closeOrBack(t.w.ports, t.m, 'person')
  t.w.state.set('preview', { rowId: 'a.ts', owner: 'file', mode: 'view' })
  const tree = await t.draw()
  expect(leaves(tree)).toContain('Loading…')
  expect(contentIn(tree)).toEqual([])
})

test('closed() drops the content from memory (R13)', async () => {
  const t = await opened()
  await t.session.closed(t.w.ports)
  t.w.state.set('preview', { rowId: 'a.ts', owner: 'file', mode: 'view' })
  expect(leaves(await t.draw())).toContain('Loading…')
})

test('a hot-reload read that ends after the pane closed keeps no content (R13, G18)', async () => {
  const t = await opened()
  const fresh = new PaneSession()
  let release = () => {}
  t.host.gate = new Promise<void>(go => (release = go))
  await t.draw(96, undefined, undefined, fresh) // starts the one read, held by the gate
  await turn()
  await fresh.closed(t.w.ports)
  const asked = t.w.ui.invalidated
  release()
  await fresh.idle()
  expect(t.w.ui.invalidated).toBe(asked) // the late read asks for no drawing
  t.w.state.set('preview', { rowId: 'a.ts', owner: 'file', mode: 'view' })
  expect(leaves(await t.draw(96, undefined, undefined, fresh))).toContain('Loading…')
})

test('a hot-reload read that ends after an r has shown newer content does not bring the older content back (R10, G18)', async () => {
  const t = await opened()
  const fresh = new PaneSession() // module memory lost: the state names a preview and the cache is empty
  const reads: Array<(content: PreviewContent) => void> = []
  t.m.loadPreview = () => new Promise<PreviewContent>(go => void reads.push(go))
  const loading = await t.draw(96, undefined, undefined, fresh) // `Loading…`, and the one read of the reload starts
  await turn()
  press(buttonOf(loading, 'refresh')) // r, while that read still runs
  await turn()
  expect(reads).toHaveLength(2)
  const codeOf = (source: string): PreviewContent => ({ title: 'a.ts', blocks: [{ kind: 'code', source }] })
  reads[1]?.(codeOf('NEW\n')) // the read of r ends first
  await turn()
  expect(contentIn(await t.draw(96, undefined, undefined, fresh))).toEqual(['NEW\n'])
  reads[0]?.(codeOf('OLD\n')) // the older read of the reload ends after it
  await fresh.idle()
  expect(contentIn(await t.draw(96, undefined, undefined, fresh))).toEqual(['NEW\n']) // it brings nothing over the newer content
  expect(t.preview()).toEqual({ rowId: 'a.ts', owner: 'file', mode: 'view' })
})

// ---------------------------------------------------------------- the newest press wins

/** Holds the reads of one row until `release` is called. */
function hold(t: ReturnType<typeof setup>, rowId: string): () => void {
  let release = () => {}
  t.host.gates.set(rowId, new Promise<void>(go => (release = go)))
  return release
}

test('two opens that overlap: the press that came last shows, whichever read ends last (R10)', async () => {
  const t = setup()
  const releaseA = hold(t, 'a.ts')
  const releaseB = hold(t, 'b.ts')
  t.w.state.set('selected', 'a.ts')
  press(buttonOf(await t.draw(), 'preview'))
  await turn()
  t.w.state.set('selected', 'b.ts')
  press(buttonOf(await t.draw(), 'preview'))
  await turn()
  expect(t.host.loads).toEqual(['file a.ts view', 'file b.ts view'])
  releaseB() // the newer read ends first, then the older one
  await turn()
  releaseA()
  await t.session.idle()
  expect(t.preview()).toEqual({ rowId: 'b.ts', owner: 'file', mode: 'view' })
  expect(contentIn(await t.draw())).toEqual([`${MARKER} b.ts view\n`])
})

test('two opens that overlap, the older read ending first: the older view never shows (R10)', async () => {
  const t = setup()
  const releaseA = hold(t, 'a.ts')
  const releaseB = hold(t, 'b.ts')
  t.w.state.set('selected', 'a.ts')
  press(buttonOf(await t.draw(), 'preview'))
  await turn()
  t.w.state.set('selected', 'b.ts')
  press(buttonOf(await t.draw(), 'preview'))
  await turn()
  releaseA()
  await turn()
  expect(t.preview()).toBeNull() // a newer press is on its way: the older read brings nothing
  releaseB()
  await t.session.idle()
  expect(t.preview()).toEqual({ rowId: 'b.ts', owner: 'file', mode: 'view' })
})

test('a second v whose modes are still read already supersedes the first: the first read, ending meanwhile, shows nothing (R10)', async () => {
  const t = setup()
  const releaseA = hold(t, 'a.ts')
  t.w.state.set('selected', 'a.ts')
  press(buttonOf(await t.draw(), 'preview'))
  await turn()
  t.w.state.set('selected', 'b.ts')
  let answer = (_modes: readonly PreviewMode[]) => {}
  t.m.previewModes = () => new Promise(go => (answer = go)) // the modes of the second press wait
  press(buttonOf(await t.draw(), 'preview'))
  await turn()
  releaseA() // the first read ends while the second press still waits for its modes
  await turn()
  expect(t.preview()).toBeNull() // the older view never shows over a newer press
  answer([VIEW])
  await t.session.idle()
  expect(t.preview()).toEqual({ rowId: 'b.ts', owner: 'file', mode: 'view' })
})

test('a mode switch that overlaps a reload: the press that came last decides the mode that shows (R12)', async () => {
  const t = setup()
  t.host.modes.set('a.ts', [VIEW, { id: 'diff', enabled: true }])
  t.w.state.set('selected', 'a.ts')
  press(buttonOf(await t.draw(), 'preview'))
  await t.session.idle()
  let slow = () => {}
  t.host.gate = new Promise<void>(go => (slow = go))
  const view = await t.draw()
  press(buttonOf(view, 'refresh')) // r: a slow read of the view
  await turn()
  t.host.gate = undefined
  press(buttonOf(view, 'diff')) // d: a fast read of the diff, after it
  await turn() // not `idle`: that waits for the slow read too
  expect(t.preview()).toMatchObject({ mode: 'diff' })
  slow()
  await t.session.idle()
  expect(t.preview()).toMatchObject({ mode: 'diff' }) // the slow read of the view does not bring it back
})

test('Esc while the modes of a press are still read: the press brings no preview back (R10, G11)', async () => {
  const t = await opened()
  const view = await t.draw()
  let answer = (_modes: readonly PreviewMode[]) => {}
  t.m.previewModes = () => new Promise(go => (answer = go)) // the next read of the modes waits
  press(buttonOf(view, 'refresh'))
  await turn()
  await t.session.closeOrBack(t.w.ports, t.m, 'person') // Esc while the press waits for the modes
  answer([VIEW])
  await t.session.idle()
  expect(t.preview()).toBeNull()
  expect(t.host.loads).toEqual(['file a.ts view']) // no second read
})

test('the pane closes while the modes of v are still read: nothing is read, and no preview opens (R10)', async () => {
  const t = setup()
  t.w.state.set('selected', 'a.ts')
  let answer = (_modes: readonly PreviewMode[]) => {}
  t.m.previewModes = () => new Promise(go => (answer = go)) // the read of the modes of the press waits
  press(buttonOf(await t.draw(), 'preview'))
  await turn()
  await t.session.closed(t.w.ports) // the pane closes while the press waits for the modes
  answer([VIEW])
  await t.session.idle()
  expect(t.host.loads).toEqual([]) // the tracker is not asked for the content of a pane that is gone
  expect(t.preview()).toBeNull()
})

test('the pane closes while v still asks if the help view shows: the tracker is asked for no modes, and no toast shows (R10)', async () => {
  const t = setup()
  t.host.modes.set('a.ts', undefined) // a row with no preview: a press that went on would toast "This row has no preview."
  t.w.state.set('selected', 'a.ts')
  const list = await t.draw()
  let answer = (_help: boolean) => {}
  ;(t.w.ports.state as { help: { get: () => Promise<boolean> } }).help.get = () => new Promise(go => (answer = go))
  press(buttonOf(list, 'preview'))
  await turn()
  await t.session.closed(t.w.ports) // the pane closes while the press waits for the help flag
  answer(false)
  await t.session.idle()
  expect(t.w.ui.toasts).toEqual([])
  expect(t.host.loads).toEqual([])
  expect(t.preview()).toBeNull()
})

// ---------------------------------------------------------------- the way back, as the hook sees it

test('Esc does not wait for the pane to open again: the state is cleared first, then ui.open starts, and the answer is deny (G11)', async () => {
  const t = await opened()
  const log: string[] = []
  const state = t.w.ports.state as { preview: { update: (fn: (cur: unknown) => unknown) => Promise<unknown> } }
  const update = state.preview.update
  state.preview.update = async fn => {
    log.push('clear')
    return update(fn)
  }
  ;(t.w.ports.ui as { open: () => Promise<boolean> }).open = () => {
    log.push('open')
    return new Promise<boolean>(() => {}) // the engine never answers: an `await` of it would hold the hook for ever
  }
  let answer: unknown // set when the hook has its answer: a hook that waits for `ui.open` never sets it
  void t.session.closeOrBack(t.w.ports, t.m, 'person').then(a => (answer = a))
  await turn()
  expect(answer).toEqual({ deny: 'back to the list' })
  expect(log).toEqual(['clear', 'open'])
  expect(t.preview()).toBeNull()
})

// ---------------------------------------------------------------- a mode core does not know yet (issue #275)

/** The key of a core mode that issue #275 adds: a third mode that every row has, with a key of its own. */
const DETAIL_KEY: PaneKey = {
  id: 'detail',
  key: 'i',
  label: 'detail',
  scope: 'row',
  owner: 'core',
  bar: 'preview',
  mode: 'detail',
}

test('a third mode draws its Button between the modes of the provider and r: reload, in the order the provider lists them (N275)', async () => {
  const t = setup(undefined, [...CORE_KEYS, DETAIL_KEY])
  t.host.modes.set('a.ts', [VIEW, { id: 'detail', enabled: true }, { id: 'diff', enabled: true }])
  t.w.state.set('selected', 'a.ts')
  press(buttonOf(await t.draw(), 'preview'))
  await t.session.idle()
  const tree = await t.draw()
  expect(nodes(tree, 'Button').map(b => [b.props.hotkey, b.props.label])).toEqual([
    ['v', 'view'],
    ['i', 'detail'],
    ['d', 'diff'],
    ['r', 'reload'],
  ])
})

test('the key of a third mode loads that mode, and r reloads the mode on show (N275)', async () => {
  const t = setup(undefined, [...CORE_KEYS, DETAIL_KEY])
  t.host.modes.set('a.ts', [VIEW, { id: 'detail', enabled: true }])
  t.w.state.set('selected', 'a.ts')
  press(buttonOf(await t.draw(), 'preview'))
  await t.session.idle()
  press(buttonOf(await t.draw(), 'detail'))
  await t.session.idle()
  expect(t.preview()).toEqual({ rowId: 'a.ts', owner: 'file', mode: 'detail' })
  press(buttonOf(await t.draw(), 'refresh'))
  await t.session.idle()
  expect(t.host.loads).toEqual(['file a.ts view', 'file a.ts detail', 'file a.ts detail'])
  expect(contentIn(await t.draw())).toEqual([`${MARKER} a.ts detail\n`])
})

test('a mode that no core key picks has no Button, and the line keeps the others (N275)', async () => {
  const t = setup()
  t.host.modes.set('a.ts', [VIEW, { id: 'detail', enabled: true }])
  t.w.state.set('selected', 'a.ts')
  press(buttonOf(await t.draw(), 'preview'))
  await t.session.idle()
  expect(nodes(await t.draw(), 'Button').map(b => b.props.hotkey)).toEqual(['v', 'r'])
})

test('the stored preview and the mode of a provider are one type: a mode that core adds fits the atom (N275)', () => {
  // The proof is tsc: each side must assign to the other, so a union that closes on one side breaks the build.
  type Stored = NonNullable<PluginState['artifact-tracking']['preview']>
  const fromProvider: Stored['mode'] = 'detail' as PreviewState['mode']
  const toProvider: PreviewState['mode'] = 'detail' as Stored['mode']
  expect([fromProvider, toProvider]).toEqual(['detail', 'detail'])
})

// ---------------------------------------------------------------- the frame

test('the drawing of the preview names its view and holds the Buttons of its key line alone (Frame.view)', async () => {
  const t = await opened()
  const refocus = (t.session as unknown as { refocus: Refocus }).refocus
  const waited = refocus.awaitFrame(t.w.ports, () => true)
  await t.draw()
  expect(await waited).toEqual({ view: 'preview', rows: new Map(), keys: ['preview', 'refresh'], stops: [] })
})

test('the frame that the state gives for the preview is the same: the key line of the row the state names (Frame.view)', async () => {
  const t = await opened()
  expect(await frameFromState(t.w.ports, t.m, { view: 'preview', row: null })).toEqual({
    view: 'preview',
    rows: new Map(),
    keys: ['preview', 'refresh'],
    stops: [],
  })
  t.host.modes.set('a.ts', [VIEW, { id: 'diff', enabled: true }])
  expect((await frameFromState(t.w.ports, t.m, { view: 'preview', row: null })).keys).toEqual([
    'preview',
    'diff',
    'refresh',
  ])
  t.w.state.set('preview', null) // no preview named: the key line has the reload key alone
  expect((await frameFromState(t.w.ports, t.m, { view: 'preview', row: null })).keys).toEqual(['refresh'])
})

// ---------------------------------------------------------------- the ring

/** The engine log: the calls the session makes, in the order the engine sees them. */
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

/** A press, then the drawing the engine makes after its write, then the pause before the ring request. */
async function pressDraw(t: ReturnType<typeof setup>, key: string): Promise<void> {
  press(buttonOf(await t.draw(), key))
  await turn()
  await t.draw()
  await turn()
  await t.w.clock.advance(RING_PAUSE_MS)
  await t.session.idle()
}

test('v while the ring is on a row sends the ring to v: view of the key line, and Esc sends it home to the row', async () => {
  const t = setup()
  t.w.state.set('selected', 'b.ts')
  await t.draw()
  const calls = engineLog(t)
  await t.session.focused(t.w.ports, 'r1') // the ring is on the row
  await pressDraw(t, 'preview')
  expect(t.preview()).not.toBeNull()
  expect(calls).toEqual(['focus preview']) // the first Button of the key line
  await t.session.focused(t.w.ports, 'preview', 'plugin')
  // Esc: the pane answers deny, opens again with the keys, and asks for the ring on the selected row once the list is drawn.
  const back = await t.session.closeOrBack(t.w.ports, t.m, 'person')
  await turn()
  await t.draw() // the list again
  await turn()
  await t.w.clock.advance(RING_PAUSE_MS)
  await t.session.idle()
  expect(back).toEqual({ deny: 'back to the list' })
  expect(calls).toEqual(['focus preview', 'open', 'focus r1'])
})

test('a ring that nobody reported stays alone when the preview opens and when Esc goes back', async () => {
  const t = setup()
  t.w.state.set('selected', 'a.ts')
  await t.draw()
  const calls = engineLog(t)
  await pressDraw(t, 'preview')
  expect(t.preview()).not.toBeNull()
  await t.session.closeOrBack(t.w.ports, t.m, 'person')
  await turn()
  await t.draw()
  await t.session.idle()
  expect(calls).toEqual(['open']) // the reopen alone
})

test('a footer key of the row is a press of the same key in the list only: while the preview shows, x and the digits are not drawn', async () => {
  const t = await opened()
  const tree = await t.draw()
  expect(footerOf(tree).map(b => b.props.hotkey)).toEqual(['v', 'r'])
})
