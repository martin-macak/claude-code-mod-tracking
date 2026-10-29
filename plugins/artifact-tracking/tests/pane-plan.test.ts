// The plan view of the pane (issue #199): `p` reads the plan of `/track clean` once and shows it in the slot of the help view, cut to
// the body. It changes nothing: it writes no atom, stops no task and removes no worktree. `p` again goes back, `r` reads the plan
// again, and every other key is a dim Button, so no letter leaves the pane for the prompt. The pure parts (the cut, the footer, the
// route) run in tests/plan-view.test.ts and tests/keys.test.ts. Here the session reads the plan, keeps the lines, draws them, asks for
// the ring, and drops them when the pane closes. Order and causality, not time: a read that is held open shows what a press does while
// it waits.
import { expect, test } from 'claude-code/testing'
import { footerKeys, KeyRegistry } from '../core/infra/keys'
import type { CleanStep } from '../core/interfaces/clean'
import type { PaneView, RowRef, SectionSpec, TreeRow } from '../core/interfaces/view'
import { type PlanLine, planLines } from '../core/lib/clean-text'
import { NEXT_DRAWING_MS, type Refocus, RING_PAUSE_MS } from '../hooks/pane-refocus'
import { type PaneHost, PaneSession } from '../hooks/pane-session'
import { KEYS as GITHUB_ROW_KEYS } from '../trackers/github/actions'
import { resetWidths } from '../ux/tree-data-table/columns'
import { fakeConfig } from './fixtures/config-fs'
import { buttonOf, handlesOf, leaves, type Node, nodes, press, texts, viewLineOf } from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { heightOf } from './fixtures/height'
import { fakePorts } from './fixtures/ports'
import { row, section } from './fixtures/sections'

const web = (id: string): TreeRow =>
  row(id, { control: '', name: id, description: `https://${id}.example/` }, { owner: 'web' })

const task = (n: number): CleanStep => ({ kind: 'tasks', id: `task:${n}`, label: `job ${n}`, action: 'stop' })
const tree = (n: number): CleanStep => ({
  kind: 'worktrees',
  id: `wt:${n}`,
  label: `/Users/someone/projects/a-long-repository-name/.claude/worktrees/wf_82cd3937-b16-${n}`,
  action: 'remove-worktree',
})
const PLAN: readonly PlanLine[] = planLines([{ step: task(1) }, { step: task(2) }], [])
const BIG: readonly PlanLine[] = planLines(
  [task(1), task(2), tree(1), tree(2), tree(3), tree(4), tree(5)].map(step => ({ step })),
  ['auto: plan failed: boom'],
)

function setup(ids: readonly string[] = ['a', 'b', 'c']) {
  resetWidths()
  const w = fakePorts()
  const reg = new KeyRegistry()
  const host = {
    sections: [section('web', ids.map(web))] as SectionSpec[],
    /** Every call the pane makes of the host, in order. */
    calls: [] as string[],
    /** False: the item host did not start, and the plan read answers with no plan (study G5). The host makes the entry itself. */
    ready: true,
    /** The lines a plan read gives, and a gate that holds the read open until it is released. */
    plan: PLAN,
    gate: undefined as Promise<void> | undefined,
    entry: async () => void host.calls.push('entry'),
    paneData: async (_p: unknown, _view: PaneView) => host.sections,
    inventory: async () => host.sections,
    footer: async (_p: unknown, ref: RowRef | undefined, help: boolean, marked?: readonly RowRef[]) =>
      footerKeys(reg, ref, owner => owner === 'web', help, undefined, marked),
    cleanPlan: async () => {
      host.calls.push('cleanPlan')
      await host.gate
      return host.ready ? host.plan : undefined
    },
    refreshManual: async () => void host.calls.push('refreshManual'),
    dismiss: async (_p: unknown, rowIds: readonly string[]) => void host.calls.push(`dismiss ${rowIds.join(',')}`),
    setPriority: async (_p: unknown, id: string, level: string | undefined) =>
      void host.calls.push(`setPriority ${id} ${level}`),
    setPriorities: async () => void host.calls.push('setPriorities'),
    runAction: async (_p: unknown, owner: string, id: string) => void host.calls.push(`runAction ${owner}.${id}`),
    problems: () => [] as string[],
    liveTools: () => [] as string[],
    isItemOwner: (owner: string) => owner === 'web',
    version: undefined,
    keys: reg,
    config: fakeConfig(),
  }
  const session = new PaneSession()
  const m = host as unknown as PaneHost
  const draw = (cols = 96, rows?: number, focused?: boolean) =>
    session.draw(w.ports, m, EL, { bodyColumns: cols, bodyRows: rows, focused })
  /** Presses the Button of a drawing and waits for the work it started. */
  const pressKey = async (key: string, rows?: number, focused?: boolean) => {
    press(buttonOf(await draw(96, rows, focused), key))
    await session.idle()
  }
  const selected = () => w.state.get('selected') ?? null
  return { w, host, session, m, draw, pressKey, selected }
}

/** Holds the plan read open: the returned function lets it go. */
function holdRead(t: ReturnType<typeof setup>): () => void {
  let release!: () => void
  t.host.gate = new Promise<void>(resolve => {
    release = resolve
  })
  return release
}

/** Lets the work already started run, as far as it can: the fake ports answer in microtasks. */
const turn = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

/** The words of the plan view's body: the Texts of the first child of the root, in order. */
const bodyWords = (drawn: unknown): string[] => {
  const [body] = (drawn as Node).children as Node[]
  return nodes(body, 'Text').map(t => String((t.children as unknown[]).join('')))
}
const hotkeys = (drawn: unknown): string[] =>
  nodes(drawn, 'Button')
    .filter(b => b.props.hotkey !== undefined)
    .map(b => String(b.props.hotkey))
const dim = (drawn: unknown, key: string): boolean => buttonOf(drawn, key).props.dimColor === true

const CORE_HOTKEYS = ['r', 'h', 'g', 'a', 't', 'p', 'm', 'e', 'x', '1', '2', '3', '0']

// ---------------------------------------------------------------- open, read, go back

test('p reads the plan and draws it in place of the rows: no row, no view line, and the plan footer under the lines', async () => {
  const t = setup()
  t.w.state.set('selected', 'b')
  expect(handlesOf(await t.draw())).toEqual(['r0', 'r1', 'r2'])
  expect(viewLineOf(await t.draw()).map(b => b.props.hotkey)).toEqual(['g', 'a', 't', 'p', 'm', 'e'])
  await t.pressKey('clean')
  expect(t.host.calls).toEqual(['cleanPlan']) // one read, which makes the entry of the host itself
  const drawn = await t.draw()
  expect(handlesOf(drawn)).toEqual([])
  expect(texts(drawn).some(([, s]) => s.startsWith('View:'))).toBe(false)
  expect(bodyWords(drawn)).toEqual(PLAN.filter(l => l.role !== 'blank').map(l => l.text)) // a tall body: every line of the command
  expect(hotkeys(drawn)).toEqual(CORE_HOTKEYS) // a Button for every core key, so no letter leaves the pane
  expect(buttonOf(drawn, 'clean').props.label).toBe('back')
  expect(buttonOf(drawn, 'help').props.label).toBe('help')
})

test('only p and r are live in the plan view: every other key is a dim Button', async () => {
  const t = setup()
  await t.pressKey('clean')
  const drawn = await t.draw()
  const live = nodes(drawn, 'Button')
    .filter(b => b.props.hotkey !== undefined && b.props.dimColor !== true)
    .map(b => String(b.props.hotkey))
  expect(live).toEqual(['r', 'p'])
})

test('the plan view shows the same lines as /track clean, cut by the body and never read again by a drawing', async () => {
  const t = setup()
  t.host.plan = BIG
  await t.pressKey('clean')
  const reads = () => t.host.calls.filter(c => c === 'cleanPlan').length
  expect(reads()).toBe(1)
  const tall = bodyWords(await t.draw(96, 40))
  expect(tall).toEqual(BIG.filter(l => l.role !== 'blank').map(l => l.text))
  const short = bodyWords(await t.draw(96, 11))
  expect(short.length).toBeLessThan(tall.length)
  expect(short.filter(s => s.includes('/track clean --yes'))).toHaveLength(2) // both kind heads stay in the cut
  expect(short[0]).toBe('Clean plan. Nothing changed.')
  expect(reads()).toBe(1) // a draw must not run the trackers
})

test('the plan view fits the 11 rows of an inline body at 100x40, and the footer stays in it', async () => {
  const t = setup()
  for (const [name, lines] of [
    ['two tasks', PLAN],
    ['worktrees and a problem', BIG],
    ['nothing to clean', planLines([], [])],
  ] as const) {
    t.host.plan = lines
    if (name !== 'two tasks') await t.session.closed(t.w.ports)
    await t.pressKey('clean', 11)
    for (const columns of [96, 58]) {
      const drawn = await t.draw(columns, 11)
      if (columns === 96) expect(heightOf(drawn, columns), name).toBeLessThanOrEqual(11)
      expect(hotkeys(drawn), name).toEqual(CORE_HOTKEYS)
    }
    await t.session.closed(t.w.ports)
  }
})

test('p again goes back to the rows: the lines are dropped and the plan is not read again', async () => {
  const t = setup()
  t.w.state.set('selected', 'b')
  await t.pressKey('clean')
  await t.pressKey('clean') // the footer of the plan view carries `p: back`
  expect(handlesOf(await t.draw())).toEqual(['r0', 'r1', 'r2'])
  expect(t.selected()).toBe('b')
  expect(t.host.calls).toEqual(['cleanPlan'])
  await t.pressKey('clean')
  expect(t.host.calls).toEqual(['cleanPlan', 'cleanPlan']) // the next p reads it again
})

test('r in the plan view refreshes and reads the plan again; in the rows it only refreshes', async () => {
  const t = setup()
  await t.pressKey('refresh')
  expect(t.host.calls).toEqual(['refreshManual'])
  t.host.calls.length = 0
  await t.pressKey('clean')
  t.host.plan = planLines([{ step: task(7) }], [])
  await t.pressKey('refresh')
  expect(t.host.calls).toEqual(['cleanPlan', 'refreshManual', 'cleanPlan'])
  expect(bodyWords(await t.draw())).toContain('  job 7: stop') // the new lines
  expect(bodyWords(await t.draw())).not.toContain('  job 1: stop')
})

test('the frame of the plan view names the view and holds the keys of its footer: no row, no stop and no view line', async () => {
  const t = setup()
  await t.pressKey('clean')
  const refocus = (t.session as unknown as { refocus: Refocus }).refocus
  const waited = refocus.awaitFrame(t.w.ports, () => true)
  const drawn = await t.draw()
  const frame = await waited
  expect(frame).toMatchObject({ view: 'plan', rows: new Map(), stops: [] })
  expect(frame?.keys).toEqual(nodes(drawn, 'Button').map(b => String(b.props.key)))
  expect(frame?.keys).toEqual([
    'refresh',
    'help',
    'view',
    'show-all',
    'touched',
    'clean',
    'mark',
    'quick',
    'dismiss',
    'prio-1',
    'prio-2',
    'prio-3',
    'prio-0',
  ])
})

// ---------------------------------------------------------------- no quick view (issue #276)

// The plan view is a text view, like the help view: no rows, no view line, no status area. With the flags of `e` on in both forms it
// still draws no quick view, builds none and asks for no `detail()` that nobody would see (A8 of #275, said there for the help view).
test('the plan view draws no quick view, in either form, and asks for no detail() that nobody would see', async () => {
  for (const rows of [31, 11]) {
    const t = setup()
    const seen: string[] = []
    t.host.sections = [
      section(
        'web',
        ['a', 'b', 'c'].map(id => ({
          ...web(id),
          detail: () => {
            seen.push(id)
            return [{ label: 'note', cell: { text: `note of ${id}` } }]
          },
        })),
      ),
    ]
    t.w.state.set('selected', 'b')
    t.w.state.set('quick', { full: true, compact: true })
    // The guard: the rows view draws the quick view of the selected row, so the checks below can fail.
    const rowsView = leaves(await t.draw(96, rows))
    expect(rowsView, `${rows} rows view`).toContain('Selected:')
    expect(rowsView, `${rows} rows view`).toContain('note of b')
    await t.pressKey('clean', rows)
    seen.length = 0
    const plan = leaves(await t.draw(96, rows))
    expect(plan, `${rows} plan view`).not.toContain('Selected:')
    expect(plan, `${rows} plan view`).not.toContain('note of b')
    expect(seen, `${rows} plan view`).toEqual([])
  }
})

// ---------------------------------------------------------------- the key changes nothing

test('p writes no atom, no store key and no file, and calls no key, no dismiss and no refresh of a tracker', async () => {
  const t = setup()
  t.w.state.set('selected', 'b')
  t.w.state.set('marks', ['a'])
  await t.draw()
  t.w.stateSets = {}
  const store = t.w.storeSets
  const files = { ...t.w.files }
  await t.pressKey('clean')
  await t.draw()
  await t.pressKey('clean') // and back
  expect(t.w.stateSets).toEqual({}) // `selected`, `hidden`, `filters`, `view`, `help` and `marks` stay as they were
  expect(t.w.storeSets).toBe(store)
  expect(t.w.files).toEqual(files)
  expect(t.host.calls).toEqual(['cleanPlan']) // no refreshManual, no dismiss, no setPriority, no runAction
  expect(t.w.state.get('marks')).toEqual(['a'])
})

test('every other key of the plan view does nothing: it asks the pane for the keys and no more', async () => {
  const t = setup()
  await t.pressKey('clean', undefined, false) // the prompt has the keys: a click asks for them
  t.host.calls.length = 0
  const opened = t.w.ui.opened
  const sets = { ...t.w.stateSets }
  for (const key of [
    'view',
    'show-all',
    'touched',
    'mark',
    'help',
    'dismiss',
    'prio-1',
    'prio-2',
    'prio-3',
    'prio-0',
  ]) {
    const drawn = await t.draw(96, undefined, false)
    expect(dim(drawn, key), key).toBe(true)
    press(buttonOf(drawn, key))
    await t.session.idle()
    expect(bodyWords(await t.draw())[0], key).toBe('Clean plan. Nothing changed.') // still the plan view
  }
  expect(t.host.calls).toEqual([])
  expect(t.w.stateSets).toEqual(sets)
  expect(t.w.state.get('help')).toBeUndefined()
  expect(t.w.ui.opened).toBeGreaterThan(opened) // a click on a Button gives the pane the keys, as for a dim footer key
})

test('the plan view and the help view exclude each other: a stale h or p changes the view that is open, not both', async () => {
  const t = setup()
  const rows = await t.draw() // a drawing with the live `h` and `p`
  await t.pressKey('clean')
  press(buttonOf(rows, 'help')) // an h from the older drawing reaches the pane while the plan view is open
  await t.session.idle()
  expect(t.w.state.get('help')).toBe(true)
  expect(leaves(await t.draw()).some(s => s.startsWith('Pane keys'))).toBe(true) // the help view
  expect(bodyWords(await t.draw())).not.toContain('Clean plan. Nothing changed.')
  await t.pressKey('help') // h: back
  expect(handlesOf(await t.draw())).toEqual(['r0', 'r1', 'r2']) // the rows: the plan lines went when the help view opened
  // And a p from an older drawing while the help view is open reads nothing.
  const before = t.host.calls.length
  await t.pressKey('help')
  press(buttonOf(rows, 'clean'))
  await t.session.idle()
  expect(t.host.calls.length).toBe(before)
  expect(t.w.state.get('help')).toBe(true)
})

test('p ends the question of a bulk dismiss like any other key', async () => {
  const t = setup()
  t.w.state.set('marks', ['a', 'b'])
  await t.pressKey('dismiss') // asks
  expect(texts(await t.draw()).some(([, s]) => s.startsWith('Dismiss 2'))).toBe(true)
  await t.pressKey('clean')
  await t.pressKey('clean')
  const words = texts(await t.draw()).map(([, s]) => s)
  expect(words.some(s => s.startsWith('Dismiss'))).toBe(false)
  expect(words.some(s => s.startsWith('View: '))).toBe(true)
  await t.pressKey('dismiss')
  expect(t.host.calls.filter(c => c.startsWith('dismiss'))).toEqual([]) // it asks again, and dismisses nothing
})

// ---------------------------------------------------------------- not ready, close, race

test('before the item host is ready p shows a toast and opens no view', async () => {
  const t = setup()
  t.host.ready = false
  await t.pressKey('clean')
  expect(t.w.ui.toasts).toEqual(['artifact-tracking: not ready.'])
  expect(t.host.calls).toEqual(['cleanPlan']) // the host was asked once, and it gave no plan
  expect(handlesOf(await t.draw())).toEqual(['r0', 'r1', 'r2'])
  t.host.ready = true
  await t.pressKey('clean') // the next press works
  expect(bodyWords(await t.draw())[0]).toBe('Clean plan. Nothing changed.')
})

test('closed drops the lines: the next drawing is the rows, and the next p reads the plan again', async () => {
  const t = setup()
  await t.pressKey('clean')
  expect(handlesOf(await t.draw())).toEqual([])
  await t.session.closed(t.w.ports)
  expect(handlesOf(await t.draw())).toEqual(['r0', 'r1', 'r2'])
  await t.pressKey('clean')
  expect(t.host.calls.filter(c => c === 'cleanPlan')).toHaveLength(2)
})

test('a read that is in flight when the pane closes opens no view after it', async () => {
  const t = setup()
  const release = holdRead(t)
  press(buttonOf(await t.draw(), 'clean'))
  await turn() // the press waits on the read
  expect(t.host.calls).toEqual(['cleanPlan'])
  await t.session.closed(t.w.ports)
  release()
  await t.session.idle()
  await turn()
  expect(handlesOf(await t.draw())).toEqual(['r0', 'r1', 'r2']) // the result of the read is dropped
  expect(t.w.ui.focused).toEqual([])
})

test('a pane that closed during a read lets the next pane read the plan: the old read does not hold the key', async () => {
  const t = setup()
  const release = holdRead(t)
  press(buttonOf(await t.draw(), 'clean'))
  await turn()
  await t.session.closed(t.w.ports)
  press(buttonOf(await t.draw(), 'clean')) // the next pane presses p while the old read is still open
  await turn()
  release()
  await t.session.idle()
  expect(t.host.calls.filter(c => c === 'cleanPlan')).toHaveLength(2)
  expect(bodyWords(await t.draw())[0]).toBe('Clean plan. Nothing changed.') // the new press opened the view, the old one dropped its result
})

test('a second p while the plan is being read does nothing: one read, and the view opens', async () => {
  const t = setup()
  const release = holdRead(t)
  const drawn = await t.draw()
  press(buttonOf(drawn, 'clean'))
  await turn()
  press(buttonOf(drawn, 'clean')) // a double tap, from the same drawing
  await turn()
  release()
  await t.session.idle()
  expect(t.host.calls.filter(c => c === 'cleanPlan')).toHaveLength(1)
  expect(bodyWords(await t.draw())[0]).toBe('Clean plan. Nothing changed.')
})

test('a read that fails opens no view and logs one line', async () => {
  const t = setup()
  t.host.cleanPlan = async () => {
    throw new Error('boom')
  }
  await t.pressKey('clean')
  expect(handlesOf(await t.draw())).toEqual(['r0', 'r1', 'r2'])
  expect(t.w.logs.filter(l => l.includes('boom'))).toHaveLength(1)
  await t.pressKey('clean') // the key is not stuck
  expect(t.w.logs.filter(l => l.includes('boom'))).toHaveLength(2)
})

test('an h that comes while the plan is read wins: the lines are dropped, and h again shows the rows', async () => {
  const t = setup()
  const release = holdRead(t)
  const rows = await t.draw()
  press(buttonOf(rows, 'clean'))
  await turn() // p waits on its read
  press(buttonOf(rows, 'help')) // an h from the same drawing, while the read is open
  await turn()
  expect(t.w.state.get('help')).toBe(true)
  release()
  await t.session.idle()
  await turn()
  expect(leaves(await t.draw()).some(s => s.startsWith('Pane keys'))).toBe(true) // the help view, not both views
  await t.pressKey('help') // h again
  expect(handlesOf(await t.draw())).toEqual(['r0', 'r1', 'r2']) // the rows, not the plan view
  expect(bodyWords(await t.draw())).not.toContain('Clean plan. Nothing changed.')
})

test('two h presses while the plan is read cancel the opening: the rows stay, and the lines of the held read are dropped', async () => {
  const t = setup()
  const release = holdRead(t)
  press(buttonOf(await t.draw(), 'clean'))
  await turn() // p waits on its first read
  press(buttonOf(await t.draw(), 'help')) // h opens the help view
  await turn()
  expect(t.w.state.get('help')).toBe(true)
  press(buttonOf(await t.draw(), 'help')) // h again shows the rows: the help atom is false when the read returns
  await turn()
  expect(t.w.state.get('help')).toBe(false)
  release()
  await t.session.idle()
  await turn()
  expect(handlesOf(await t.draw())).toEqual(['r0', 'r1', 'r2']) // the rows, not the plan view
  expect(bodyWords(await t.draw())).not.toContain('Clean plan. Nothing changed.')
  expect(t.w.ui.focused).not.toContain('clean')
  await t.pressKey('clean') // the key is not stuck: the next p opens the view
  expect(bodyWords(await t.draw())[0]).toBe('Clean plan. Nothing changed.')
})

test('a help atom that is true when the read returns opens no view, even when no h moved the generation: the read looks at the atom again', async () => {
  const t = await ringOn('r1', 'b')
  const release = holdRead(t)
  press(buttonOf(await t.draw(), 'clean'))
  await turn() // p waits on its read
  t.w.state.set('help', true) // the atom is written, and the h that wrote it has not reached the generation yet
  release()
  await turn()
  await t.draw()
  await turn()
  await t.w.clock.advance(NEXT_DRAWING_MS)
  await t.session.idle()
  expect(bodyWords(await t.draw())).not.toContain('Clean plan. Nothing changed.')
  expect(t.calls).toEqual([]) // no ring request names p: back
})

test('an h that comes while the plan is read asks for no ring on p: the opening is cancelled before it writes', async () => {
  const t = await ringOn('r1', 'b') // the ring is reported, so a request for it can show
  const release = holdRead(t)
  const rows = await t.draw()
  press(buttonOf(rows, 'clean'))
  await turn() // p waits on its read
  press(buttonOf(rows, 'help')) // an h from the same drawing, while the read is open
  await turn()
  await t.draw()
  await turn()
  release()
  await turn()
  await t.draw()
  await turn()
  await t.w.clock.advance(NEXT_DRAWING_MS) // not RING_PAUSE_MS: with no re-read the p press waits for a plan frame, and idle would hang
  await t.session.idle()
  expect(t.calls).toEqual(['focus help']) // the ring follows the h to the help footer, and no request names `p`
  expect(t.calls).not.toContain('focus clean')
})

test('a stale press of an old pane does not free the read guard of the next pane: a double tap there reads once', async () => {
  const t = setup()
  const releaseA = holdRead(t)
  press(buttonOf(await t.draw(), 'clean')) // A reads in the old pane
  await turn()
  await t.session.closed(t.w.ports)
  const releaseB = holdRead(t) // the next pane reads behind a gate of its own
  press(buttonOf(await t.draw(), 'clean')) // B
  await turn()
  releaseA() // A returns after B began: it must leave the guard of B alone
  await turn()
  press(buttonOf(await t.draw(), 'clean')) // C, a double tap of B
  await turn()
  releaseB()
  await t.session.idle()
  expect(t.host.calls.filter(c => c === 'cleanPlan')).toHaveLength(2) // A and B: C did nothing
  expect(bodyWords(await t.draw())[0]).toBe('Clean plan. Nothing changed.') // the view B opened stays open
})

test('an r that is still reading when the plan view closes does not bring the view back', async () => {
  const t = setup()
  await t.pressKey('clean')
  const release = holdRead(t)
  press(buttonOf(await t.draw(), 'refresh'))
  await turn() // r waits on its read
  press(buttonOf(await t.draw(), 'clean')) // back to the rows: no pressKey, its idle would wait for the held read of r
  await turn()
  expect(handlesOf(await t.draw())).toEqual(['r0', 'r1', 'r2'])
  release()
  await turn()
  await t.session.idle()
  expect(handlesOf(await t.draw())).toEqual(['r0', 'r1', 'r2']) // the read of r returned: its lines are dropped
})

test('an r that returns after a closing does not write its lines into the plan view of the next pane', async () => {
  const t = setup()
  await t.pressKey('clean')
  const release = holdRead(t)
  press(buttonOf(await t.draw(), 'refresh'))
  await turn() // r waits on its read
  await t.session.closed(t.w.ports)
  t.host.gate = undefined // the next pane reads with no wait
  t.host.plan = planLines([{ step: task(5) }], [])
  press(buttonOf(await t.draw(), 'clean'))
  await turn()
  expect(bodyWords(await t.draw())).toContain('  job 5: stop')
  t.host.plan = planLines([{ step: task(6) }], []) // what the old read gives when it returns
  release()
  await turn()
  await t.session.idle()
  expect(bodyWords(await t.draw())).toContain('  job 5: stop')
  expect(bodyWords(await t.draw())).not.toContain('  job 6: stop')
})

test('an r that is still reading when the plan view closes and opens again does not overwrite the lines of the new view', async () => {
  const t = setup()
  await t.pressKey('clean')
  const release = holdRead(t)
  press(buttonOf(await t.draw(), 'refresh'))
  await turn() // r waits on its read
  press(buttonOf(await t.draw(), 'clean')) // back to the rows; no pressKey, its idle would wait for the held read of r
  await turn()
  t.host.gate = undefined // the next read goes through
  t.host.plan = planLines([{ step: task(5) }], [])
  press(buttonOf(await t.draw(), 'clean')) // the plan view again, with newer lines than the read of r began with
  await turn()
  expect(bodyWords(await t.draw())).toContain('  job 5: stop')
  t.host.plan = planLines([{ step: task(6) }], []) // what the old read gives when it returns
  release()
  await turn()
  await t.session.idle()
  expect(bodyWords(await t.draw())).toContain('  job 5: stop')
  expect(bodyWords(await t.draw())).not.toContain('  job 6: stop')
})

test('an r whose read began before a newer r read does not overwrite the lines of the newer read', async () => {
  const t = setup()
  await t.pressKey('clean')
  const release = holdRead(t)
  press(buttonOf(await t.draw(), 'refresh'))
  await turn() // the first r waits on its read
  t.host.gate = undefined // the second r reads with no wait
  t.host.plan = planLines([{ step: task(5) }], [])
  press(buttonOf(await t.draw(), 'refresh'))
  await turn()
  expect(bodyWords(await t.draw())).toContain('  job 5: stop')
  t.host.plan = planLines([{ step: task(6) }], []) // what the older read gives when it returns
  release()
  await turn()
  await t.session.idle()
  expect(bodyWords(await t.draw())).toContain('  job 5: stop')
  expect(bodyWords(await t.draw())).not.toContain('  job 6: stop')
})

test('an r whose plan read fails logs one line and keeps the view with its old lines', async () => {
  const t = setup()
  await t.pressKey('clean')
  t.host.cleanPlan = async () => {
    throw new Error('boom')
  }
  await t.pressKey('refresh')
  expect(t.w.logs.filter(l => l.includes('boom'))).toHaveLength(1)
  expect(bodyWords(await t.draw())[0]).toBe('Clean plan. Nothing changed.')
})

test('an r while the host gives no plan keeps the plan view with its old lines', async () => {
  const t = setup()
  await t.pressKey('clean')
  t.host.ready = false // the plan read answers with no plan (study G5)
  await t.pressKey('refresh')
  expect(bodyWords(await t.draw())[0]).toBe('Clean plan. Nothing changed.')
})

test('the plan view keeps the place of the window: p and p again show the same rows', async () => {
  const SHORT = 12
  const t = setup(Array.from({ length: 12 }, (_, i) => `w${i}`))
  const ids = async () =>
    texts(await t.draw(96, SHORT))
      .map(([, s]) => s)
      .filter(s => /^w\d+$/.test(s))
  t.w.state.set('selected', 'w10')
  await t.draw(96, SHORT) // the window began at w6
  t.w.state.set('selected', 'w6') // the ring walked up inside the window: it stays at w6
  const before = await ids()
  expect(before).toEqual(['w6', 'w7', 'w8', 'w9', 'w10', 'w11'])
  await t.pressKey('clean', SHORT) // the plan view draws no window: its place of 0 must not reset the one the rows left
  await t.pressKey('clean', SHORT)
  expect(await ids()).toEqual(before)
})

// ---------------------------------------------------------------- the ring (issue #140)

/** A press, the drawing the engine makes after its write, and the pause before the ring request. */
async function pressDraw(t: ReturnType<typeof setup>, key: string): Promise<void> {
  press(buttonOf(await t.draw(), key))
  await turn()
  await t.draw()
  await turn()
  await t.w.clock.advance(RING_PAUSE_MS)
  await t.session.idle()
}

/** A pane with the ring where `at` says, and the log of the engine's `ui.focus` calls. */
async function ringOn(at: string | undefined, selected = 'a') {
  const t = setup(['a', 'b'])
  t.m.keys.add('web', GITHUB_ROW_KEYS)
  t.w.state.set('selected', selected)
  await t.draw()
  const calls: string[] = []
  const ui = t.w.ports.ui as { focus: (key: string) => Promise<boolean> }
  ui.focus = async key => {
    calls.push(`focus ${key}`)
    return true
  }
  if (at !== undefined) await t.session.focused(t.w.ports, at)
  return { ...t, calls }
}

test('p opens the plan view while the ring is on a row or a tracker key: the ring goes to p: back', async () => {
  for (const at of ['r1', 'web.resolve', 'm0']) {
    const t = await ringOn(at, 'b')
    await pressDraw(t, 'clean')
    expect(t.calls, at).toEqual(['focus clean'])
    expect(t.selected(), at).toBe('b') // a footer Button leaves the selection alone
  }
})

test('the second p closes the plan view and the ring goes back to the selected row', async () => {
  for (const [selected, handle] of [
    ['a', 'r0'],
    ['b', 'r1'],
  ] as const) {
    const t = await ringOn('web.resolve', selected)
    await pressDraw(t, 'clean')
    await t.session.focused(t.w.ports, 'clean', 'plugin') // the engine reports the landing of the request
    await pressDraw(t, 'clean')
    expect(t.calls).toEqual(['focus clean', `focus ${handle}`])
    await t.session.focused(t.w.ports, handle, 'plugin')
    expect(t.selected()).toBe(selected)
  }
})

test('a ring on r, or on a dim Button that the plan footer keeps, stays there when p opens the plan view', async () => {
  for (const at of ['refresh', 'help', 'dismiss', 'view']) {
    const t = await ringOn(at)
    await pressDraw(t, 'clean')
    expect(t.calls, at).toEqual([`focus ${at}`])
  }
})

test('a ring on the clean Button stays on the Button of that key when the plan view opens and closes', async () => {
  const t = await ringOn('clean')
  await pressDraw(t, 'clean') // opens: `clean` is `p: back` in the plan footer
  await t.session.focused(t.w.ports, 'clean', 'plugin')
  await pressDraw(t, 'clean') // closes: `clean` is a Button of the view line
  expect(t.calls).toEqual(['focus clean', 'focus clean'])
})

test('a ring that the person moved off p: back stays on that Button when the plan view closes', async () => {
  const t = await ringOn('web.resolve')
  await pressDraw(t, 'clean')
  await t.session.focused(t.w.ports, 'clean', 'plugin')
  await t.session.focused(t.w.ports, 'refresh') // Tab in the plan view
  await pressDraw(t, 'clean')
  expect(t.calls).toEqual(['focus clean', 'focus refresh'])
})

test('a ring that nobody reported stays alone when p opens the plan view', async () => {
  const t = await ringOn(undefined)
  await pressDraw(t, 'clean')
  expect(t.calls).toEqual([])
  expect(bodyWords(await t.draw())[0]).toBe('Clean plan. Nothing changed.')
})

test('when no drawing follows the press the ring request reads the state after the bound and still lands on p: back', async () => {
  const t = await ringOn('web.resolve')
  press(buttonOf(await t.draw(), 'clean'))
  await turn()
  await t.w.clock.advance(NEXT_DRAWING_MS)
  await t.session.idle()
  expect(t.calls).toEqual(['focus clean'])
})
