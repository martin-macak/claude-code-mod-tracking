// The lifecycle manager serves the pane keys: the registry built at each start, the footer states, the tracker actions and
// the problems of the help view. Fake trackers on fakePorts. Plan: L6 Task 10 (G6, G7, G15).
import { expect, test } from 'claude-code/testing'
import { CORE_KEYS } from '../core/infra/keys'
import { LifecycleManager } from '../core/infra/lifecycle'
import type { ItemKind, ItemsHost, JsonObject } from '../core/interfaces/items'
import type { PreviewSpec } from '../core/interfaces/preview'
import type { KeySpec, Tracker } from '../core/interfaces/tracker'
import type { ActionImpls, RowRef } from '../core/interfaces/view'
import { PREVIEW_LIMITS } from '../core/lib/preview'
import { fakeConfig } from './fixtures/config-fs'
import { IDLE_ITEMS } from './fixtures/items-host'
import { fakePorts } from './fixtures/ports'
import { fake } from './fixtures/tracker-host'

const OPEN: KeySpec = { id: 'open', key: 'o', label: 'open', scope: 'row' }
const ROW: RowRef = { id: 'row-1', owner: 't', group: 'web', can: {} }

/** An item host that does nothing: the keys do not need the item list. */
function stubItems(): ItemsHost {
  return {
    ...IDLE_ITEMS,
    slot: {
      id: 'items',
      persist: true,
      read: async () => [],
      empty: () => true,
      settle: async live => live,
      restore: async () => {},
    },
    start: async () => {},
    replay: async () => {},
    tick: async () => {},
    sessionChanged: async () => {},
    dispose: () => {},
    list: async () => [],
    update: async () => false,
    track: async () => {},
    refresh: () => {},
  }
}

function setup(trackers: readonly Tracker[], file: JsonObject = {}, items: ItemsHost = stubItems()) {
  const w = fakePorts()
  const m = new LifecycleManager(
    {
      trackers,
      items,
      dismiss: () => ({ list: async () => new Set(), add: async () => {} }),
      config: () => fakeConfig({ specs: trackers, file }),
      paneId: 'track',
    },
    w.ports,
  )
  return { w, m }
}

const started = async (trackers: readonly Tracker[], file: JsonObject = {}, items?: ItemsHost) => {
  const t = setup(trackers, file, items)
  await t.m.start(t.w.ports, { fromSessionStart: true })
  return t
}

const keysOf = (m: LifecycleManager) => m.keys.all().map(k => `${k.owner}.${k.id}`)

test('before any start the registry holds the core keys', () => {
  const { m } = setup([fake('t', 10, { keys: [OPEN] })])
  expect(m.keys.all()).toHaveLength(CORE_KEYS.length)
  expect(m.keys.all().every(k => k.owner === 'core')).toBe(true)
  expect(m.problems()).toEqual([])
})

test('start builds the key registry from the live trackers', async () => {
  const { m } = await started([fake('t', 10, { keys: [OPEN] })])
  expect(m.keys.get('t.open')?.owner).toBe('t')
  expect(
    m.keys
      .all()
      .slice(0, CORE_KEYS.length)
      .map(k => k.key),
  ).toEqual(['r', 'h', 'g', 'a', 't', 'p', 'm', 'x', '1', '2', '3', '0', 'v', 'd'])
  expect(keysOf(m).at(-1)).toBe('t.open')
})

test('the tracker keys follow the order of the trackers, not the order of the list', async () => {
  const late = fake('late', 20, { keys: [{ ...OPEN, id: 'a', key: 'q' }] })
  const early = fake('early', 10, { keys: [{ ...OPEN, id: 'b', key: 'b' }] })
  const { m } = await started([late, early])
  expect(keysOf(m).slice(CORE_KEYS.length)).toEqual(['early.b', 'late.a'])
})

test('a tracker that is off adds no key', async () => {
  // `fake` keeps the defaults whatever the file says, so this tracker reads its own `enabled`.
  const config = { defaults: { enabled: true }, normalise: (raw: JsonObject) => ({ enabled: raw.enabled !== false }) }
  const t = fake('t', 10, { keys: [OPEN], config })
  const { m } = await started([t], { trackers: { t: { enabled: false } } })
  expect(m.keys.get('t.open')).toBeUndefined()
  expect(m.keys.all()).toHaveLength(CORE_KEYS.length)
})

test('a second start rebuilds the registry with no duplicate problem', async () => {
  const t = await started([fake('t', 10, { keys: [OPEN] })])
  await t.m.start(t.w.ports, { fromSessionStart: true })
  expect(t.m.problems()).toEqual([])
  expect(keysOf(t.m).filter(k => k === 't.open')).toHaveLength(1)
})

test('a duplicate key shows in problems()', async () => {
  const { m } = await started([fake('t', 10, { keys: [{ id: 'kill', key: 'x', label: 'kill', scope: 'row' }] })])
  expect(m.problems()).toEqual(['keys: t key "x" (kill) is taken by core (dismiss). The key is off.'])
  expect(m.keys.get('t.kill')).toBeUndefined()
})

test('a failed tracker shows in problems(), and its keys are off', async () => {
  const bad = fake('t', 10, {
    keys: [OPEN],
    init: () => {
      throw new Error('boom')
    },
  })
  const { m } = await started([bad])
  expect(m.problems()).toEqual(['trackers.t: init or store failed. Its sections, keys and commands are off.'])
  expect(m.keys.get('t.open')).toBeUndefined()
})

test('problems lists the key problems before the failed trackers', async () => {
  const dup = fake('a', 10, { keys: [{ id: 'kill', key: 'x', label: 'kill', scope: 'row' }] })
  const bad = fake('b', 20, {
    init: () => {
      throw new Error('boom')
    },
  })
  const { m } = await started([dup, bad])
  expect(m.problems().map(p => p.split(':')[0])).toEqual(['keys', 'trackers.b'])
})

test('problems lists the key problems, then the kind reasons that are off, then the failed trackers (#62)', async () => {
  const dup = fake('a', 10, { keys: [{ id: 'kill', key: 'x', label: 'kill', scope: 'row' }] })
  const bad = fake('b', 20, {
    init: () => {
      throw new Error('boom')
    },
  })
  const offReason = 'reasons: kind review reason "reviewed" is not mapped to a core reason. The reason is off.'
  const items = { ...stubItems(), problems: () => [offReason] }
  const { m } = await started([dup, bad], {}, items)
  expect(m.problems()).toEqual([
    'keys: a key "x" (kill) is taken by core (dismiss). The key is off.',
    offReason,
    'trackers.b: init or store failed. Its sections, keys and commands are off.',
  ])
})

// Issue #138, owner decision Q4 of the delta study (https://github.com/martin-macak/claude-code-mod-tracking/issues/138#issuecomment-6412630538):
// the health line names the tools of the trackers that run. A tool of a tracker that is off is never probed, so it would say
// `checking…` for good.
const tool = (id: string) => ({ id, probe: [id, '--version'] })
const toggled = { defaults: { enabled: true }, normalise: (raw: JsonObject) => ({ enabled: raw.enabled !== false }) }

test('liveTools names the tools of the trackers that run, in the order of the trackers', async () => {
  const late = fake('late', 20, { tools: [tool('acli'), tool('jq')] })
  const early = fake('early', 10, { tools: [tool('gh')] })
  const none = fake('none', 15)
  const { m } = await started([late, none, early])
  expect(m.liveTools()).toEqual(['gh', 'acli', 'jq'])
})

test('liveTools names a tool once when two trackers declare it: the tool runner keeps the first owner', async () => {
  const a = fake('a', 10, { tools: [tool('gh')] })
  const b = fake('b', 20, { tools: [tool('gh'), tool('jq')] })
  const { m } = await started([a, b])
  expect(m.liveTools()).toEqual(['gh', 'jq'])
})

test('liveTools leaves out the tools of a tracker that the config turned off, and of one that failed to start', async () => {
  const off = fake('off', 10, { tools: [tool('acli')], config: toggled })
  const bad = fake('bad', 20, {
    tools: [tool('docker')],
    init: () => {
      throw new Error('boom')
    },
  })
  const on = fake('on', 30, { tools: [tool('gh')] })
  const { m } = await started([off, bad, on], { trackers: { off: { enabled: false } } })
  expect(m.liveTools()).toEqual(['gh'])
})

test('isItemOwner is true only for a tracker with kinds', () => {
  const kind = { category: 'web' } as unknown as ItemKind
  const { m } = setup([fake('items', 10, { kinds: [kind] }), fake('plain', 20), fake('empty', 30, { kinds: [] })])
  expect(m.isItemOwner('items')).toBe(true)
  expect(m.isItemOwner('plain')).toBe(false)
  expect(m.isItemOwner('empty')).toBe(false)
  expect(m.isItemOwner('nobody')).toBe(false)
})

/** The footer Button of the key `t.open` for the row of `t`. */
const openKey = async (t: ReturnType<typeof setup>, help = false) =>
  (await t.m.footer(t.w.ports, ROW, help)).find(k => k.buttonKey === 't.open')

test("footer asks the owner's actions for the state of its keys", async () => {
  const run = () => {}
  const withState = (state: 'enabled' | 'disabled'): ActionImpls => ({ open: { run, state: () => state } })
  const off = await started([fake('t', 10, { keys: [OPEN], actions: () => withState('disabled') })])
  expect((await openKey(off))?.enabled).toBe(false)
  const on = await started([fake('t', 10, { keys: [OPEN], actions: () => withState('enabled') })])
  expect((await openKey(on))?.enabled).toBe(true)
  const noState = await started([fake('t', 10, { keys: [OPEN], actions: () => ({ open: { run } }) })])
  expect((await openKey(noState))?.enabled).toBe(true)
  const noImpl = await started([fake('t', 10, { keys: [OPEN], actions: () => ({}) })])
  expect((await openKey(noImpl))?.enabled).toBe(false)
  const noActions = await started([fake('t', 10, { keys: [OPEN] })])
  expect((await openKey(noActions))?.enabled).toBe(false)
})

test('the state of a key reads the actions with the selected row, nothing opened', async () => {
  const seen: { selected: string | null; expanded: number }[] = []
  const t = await started([
    fake('t', 10, {
      keys: [OPEN],
      actions: ctx => {
        seen.push({ selected: ctx.selected, expanded: ctx.expanded.size })
        return { open: { run: () => {}, state: rowId => (rowId === 'row-1' ? 'enabled' : 'disabled') } }
      },
    }),
  ])
  expect((await openKey(t))?.enabled).toBe(true)
  expect(seen).toEqual([{ selected: 'row-1', expanded: 0 }])
})

test('footer with no row, or for an owner with no key, reads no action', async () => {
  let reads = 0
  const t = await started([
    fake('t', 10, {
      keys: [OPEN],
      actions: () => {
        reads++
        return {}
      },
    }),
    fake('quiet', 20),
  ])
  const none = await t.m.footer(t.w.ports, undefined, false)
  expect(none.map(k => k.key)).toEqual(['r', 'h', 'x', '1', '2', '3', '0'])
  const quiet = await t.m.footer(t.w.ports, { ...ROW, owner: 'quiet' }, false)
  expect(quiet).toHaveLength(7)
  expect(reads).toBe(0)
})

test('footer with marked rows: x is live when a marked row can be dismissed, whatever row is selected, and the tracker key stays on the selected row', async () => {
  const t = await started([fake('t', 10, { keys: [OPEN], actions: () => ({ open: { run: () => {} } }) })])
  const marked: RowRef[] = [
    { id: 'm1', owner: 't', group: 'web', can: { dismiss: true } },
    { id: 'm2', owner: 't', group: 'web', can: {} },
  ]
  const live = async (marks: readonly RowRef[]) =>
    Object.fromEntries((await t.m.footer(t.w.ports, ROW, false, marks)).map(k => [k.buttonKey, k.enabled]))
  expect(await live([])).toMatchObject({ dismiss: false, 't.open': true }) // ROW takes no dismiss
  expect(await live(marked)).toMatchObject({ dismiss: true, 'prio-1': false, 't.open': true })
  expect(await live([marked[1] as RowRef])).toMatchObject({ dismiss: false })
})

test('in the help view the tracker key is off and h reads back', async () => {
  const t = await started([fake('t', 10, { keys: [OPEN], actions: () => ({ open: { run: () => {} } }) })])
  const footer = await t.m.footer(t.w.ports, ROW, true)
  expect(footer.find(k => k.buttonKey === 't.open')?.enabled).toBe(false)
  expect(footer.find(k => k.buttonKey === 'help')?.label).toBe('back')
})

test('actions that throw leave the key off and log one line', async () => {
  const t = await started([
    fake('t', 10, {
      keys: [OPEN],
      actions: () => {
        throw new Error('bad')
      },
    }),
  ])
  expect((await openKey(t))?.enabled).toBe(false)
  expect(t.w.logs.filter(l => l.startsWith('keys:'))).toEqual(['keys: t actions failed: bad'])
})

test('a state() that throws leaves its key off and logs one line', async () => {
  const boom = () => {
    throw new Error('worse')
  }
  const t = await started([fake('t', 10, { keys: [OPEN], actions: () => ({ open: { run: () => {}, state: boom } }) })])
  expect((await openKey(t))?.enabled).toBe(false)
  expect(t.w.logs.filter(l => l.startsWith('keys:'))).toEqual(['keys: t.open state failed: worse'])
})

test("runAction runs the owner's action with its context and the row id", async () => {
  const calls: { id: string; rowId: string | null }[] = []
  const t = await started([
    fake('t', 10, {
      keys: [OPEN],
      actions: () => ({ open: { run: (ctx, rowId) => void calls.push({ id: ctx.id, rowId }) } }),
    }),
  ])
  await t.m.runAction(t.w.ports, 't', 'open', 'row-1')
  await t.m.runAction(t.w.ports, 't', 'open', null)
  expect(calls).toEqual([
    { id: 't', rowId: 'row-1' },
    { id: 't', rowId: null },
  ])
})

test('runAction of a missing impl does nothing; a throw logs one line', async () => {
  const t = await started([
    fake('t', 10, {
      keys: [OPEN],
      actions: () => ({
        open: {
          run: () => {
            throw new Error('boom')
          },
        },
      }),
    }),
    fake('u', 20),
  ])
  await t.m.runAction(t.w.ports, 't', 'nope', 'row-1')
  await t.m.runAction(t.w.ports, 'u', 'open', 'row-1')
  await t.m.runAction(t.w.ports, 'ghost', 'open', 'row-1')
  expect(t.w.logs.filter(l => l.startsWith('keys:'))).toEqual([])
  await t.m.runAction(t.w.ports, 't', 'open', 'row-1')
  expect(t.w.logs.filter(l => l.startsWith('keys:'))).toEqual(['keys: t.open failed: boom'])
})

test('an async action is awaited before runAction resolves', async () => {
  const order: string[] = []
  const t = await started([
    fake('t', 10, {
      keys: [OPEN],
      actions: () => ({
        open: {
          run: async () => {
            await Promise.resolve()
            order.push('ran')
          },
        },
      }),
    }),
  ])
  await t.m.runAction(t.w.ports, 't', 'open', 'row-1')
  order.push('after')
  expect(order).toEqual(['ran', 'after'])
})

test('a copy from an action goes to the surface that runAction was given, and to none when it got none', async () => {
  const t = await started([
    fake('t', 10, { keys: [OPEN], actions: () => ({ open: { run: async ctx => void (await ctx.ui.copy('words')) } }) }),
  ])
  await t.m.runAction(t.w.ports, 't', 'open', 'row-1', 'desktop')
  await t.m.runAction(t.w.ports, 't', 'open', 'row-1')
  expect(t.w.ui.copied).toEqual(['words', 'words'])
  expect(t.w.ui.copiedOn).toEqual(['desktop', undefined])
})

// Issue #57, L2: the preview of a row. A tracker that has a `preview` makes its rows draw `v`, and core finds the tracker, reads
// its modes with the view context of the row and calls its `load` with the context of the tracker.
const VIEW_ONLY = [{ id: 'view', enabled: true }] as const
const spec = (over: Partial<PreviewSpec> = {}): PreviewSpec => ({
  modes: () => VIEW_ONLY,
  load: async (_ctx, rowId) => ({ title: `title of ${rowId}`, blocks: [{ kind: 'notice', text: 'hello' }] }),
  ...over,
})

test('a live tracker with a preview makes its rows draw v; a tracker without one, one that is off and one that failed do not', async () => {
  const config = { defaults: { enabled: true }, normalise: (raw: JsonObject) => ({ enabled: raw.enabled !== false }) }
  const bad = fake('bad', 40, {
    preview: spec(),
    init: () => {
      throw new Error('boom')
    },
  })
  const t = await started(
    [fake('on', 10, { preview: spec() }), fake('plain', 20), fake('off', 30, { preview: spec(), config }), bad],
    { trackers: { off: { enabled: false } } },
  )
  expect([t.m.keys.hasPreview('on'), t.m.keys.hasPreview('plain')]).toEqual([true, false])
  expect([t.m.keys.hasPreview('off'), t.m.keys.hasPreview('bad')]).toEqual([false, false])
  const keys = async (owner: string) => (await t.m.footer(t.w.ports, { ...ROW, owner }, false)).map(k => k.key).join('')
  expect(await keys('on')).toBe('rhx1230v')
  expect(await keys('plain')).toBe('rhx1230')
})

test('the footer draws v dim for a row that the provider skips, and live for a row it has: the row decides, not the owner (R11)', async () => {
  const t = await started([
    fake('t', 10, { preview: spec({ modes: (_ctx, rowId) => (rowId === 'row-1' ? VIEW_ONLY : undefined) }) }),
  ])
  const v = async (id: string) =>
    (await t.m.footer(t.w.ports, { ...ROW, owner: 't', id }, false)).find(k => k.buttonKey === 'preview')
  expect(await v('row-1')).toMatchObject({ key: 'v', enabled: true })
  expect(await v('row-2')).toMatchObject({ key: 'v', enabled: false })
  // The help view reads no modes: it draws no row, so a provider is never asked for it.
  expect(
    (await t.m.footer(t.w.ports, { ...ROW, owner: 't', id: 'row-2' }, true)).find(k => k.buttonKey === 'preview')
      ?.enabled,
  ).toBe(false)
})

test('previewModes and loadPreview of a tracker that is off or failed ask nothing of it: no modes, a notice, and no read (R9)', async () => {
  const config = { defaults: { enabled: true }, normalise: (raw: JsonObject) => ({ enabled: raw.enabled !== false }) }
  const asked: string[] = []
  const watched = (id: string): PreviewSpec =>
    spec({
      modes: () => {
        asked.push(`${id} modes`)
        return VIEW_ONLY
      },
      load: async () => {
        asked.push(`${id} load`)
        return { title: 'T', blocks: [] }
      },
    })
  const bad = fake('bad', 30, {
    preview: watched('bad'),
    init: () => {
      throw new Error('boom')
    },
  })
  const t = await started(
    [fake('on', 10, { preview: watched('on') }), fake('off', 20, { preview: watched('off'), config }), bad],
    {
      trackers: { off: { enabled: false } },
    },
  )
  for (const owner of ['off', 'bad']) {
    expect(await t.m.previewModes(t.w.ports, owner, 'row-1'), owner).toBeUndefined()
    expect((await t.m.loadPreview(t.w.ports, owner, 'row-1', 'view')).blocks, owner).toEqual([
      { kind: 'notice', text: 'This row has no preview.', tone: 'info' },
    ])
  }
  expect(asked).toEqual([])
  expect(await t.m.previewModes(t.w.ports, 'on', 'row-1')).toEqual(VIEW_ONLY) // the spy does see a live tracker
  expect(asked).toEqual(['on modes'])
})

test('previewModes asks the preview of the owner for the modes of a row, with the view context of that row selected', async () => {
  const seen: { selected: string | null; id: string }[] = []
  const t = await started([
    fake('t', 10, {
      preview: spec({
        modes: (ctx, rowId) => {
          seen.push({ selected: ctx.selected, id: rowId })
          return [
            { id: 'view', enabled: true },
            { id: 'diff', enabled: false, reason: 'no repo' },
          ]
        },
      }),
    }),
    fake('plain', 20),
  ])
  expect(await t.m.previewModes(t.w.ports, 't', 'row-1')).toEqual([
    { id: 'view', enabled: true },
    { id: 'diff', enabled: false, reason: 'no repo' },
  ])
  expect(seen).toEqual([{ selected: 'row-1', id: 'row-1' }])
  // No preview and no tracker: no modes, and no log line (a tracker that is off or failed has its own test).
  expect(await t.m.previewModes(t.w.ports, 'plain', 'row-1')).toBeUndefined()
  expect(await t.m.previewModes(t.w.ports, 'ghost', 'row-1')).toBeUndefined()
  expect(t.w.logs.filter(l => l.startsWith('keys:'))).toEqual([])
})

test('previewModes of a row that says undefined has no preview; a modes() that throws gives none and logs one line', async () => {
  const none = await started([fake('t', 10, { preview: spec({ modes: () => undefined }) })])
  expect(await none.m.previewModes(none.w.ports, 't', 'row-1')).toBeUndefined()
  const bad = await started([
    fake('t', 10, {
      preview: spec({
        modes: () => {
          throw new Error('bad modes')
        },
      }),
    }),
  ])
  expect(await bad.m.previewModes(bad.w.ports, 't', 'row-1')).toBeUndefined()
  expect(bad.w.logs.filter(l => l.startsWith('keys:'))).toEqual(['keys: t preview modes failed: bad modes'])
})

test('loadPreview calls load of the owner with its context, the row, the mode and the limits of the drawing', async () => {
  const calls: unknown[][] = []
  const t = await started([
    fake('t', 10, {
      preview: spec({
        load: async (ctx, rowId, mode, limits) => {
          calls.push([ctx.id, rowId, mode, limits])
          return { title: 'T', subtitle: 'S', blocks: [{ kind: 'code', source: 'x', path: 'a.ts' }] }
        },
      }),
    }),
  ])
  expect(await t.m.loadPreview(t.w.ports, 't', 'row-1', 'view')).toEqual({
    title: 'T',
    subtitle: 'S',
    blocks: [{ kind: 'code', source: 'x', path: 'a.ts' }],
  })
  expect(calls).toEqual([['t', 'row-1', 'view', PREVIEW_LIMITS]])
})

test('loadPreview of a load that rejects gives a notice, never a throw, and logs one line; a tracker with no preview gives a notice too', async () => {
  const t = await started([
    fake('t', 10, {
      preview: spec({
        load: async () => {
          throw new Error('disk gone')
        },
      }),
    }),
    fake('plain', 20),
  ])
  const failed = await t.m.loadPreview(t.w.ports, 't', 'row-1', 'view')
  expect(failed.blocks).toEqual([{ kind: 'notice', text: 'The preview could not be read: disk gone', tone: 'warning' }])
  expect(failed.title).toBe('Preview')
  expect(t.w.logs.filter(l => l.startsWith('keys:'))).toEqual(['keys: t preview failed: disk gone'])
  const none = await t.m.loadPreview(t.w.ports, 'plain', 'row-1', 'view')
  expect(none.blocks).toEqual([{ kind: 'notice', text: 'This row has no preview.', tone: 'info' }])
})
