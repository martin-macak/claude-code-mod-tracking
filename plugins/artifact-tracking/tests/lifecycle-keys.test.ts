// The lifecycle manager serves the pane keys: the registry built at each start, the footer states, the tracker actions and
// the problems of the help view. Fake trackers on fakePorts. Plan: L6 Task 10 (G6, G7, G15).
import { expect, test } from 'claude-code/testing'
import { CORE_KEYS } from '../core/infra/keys'
import { LifecycleManager } from '../core/infra/lifecycle'
import type { ItemKind, ItemsHost, JsonObject } from '../core/interfaces/items'
import type { KeySpec, Tracker } from '../core/interfaces/tracker'
import type { ActionImpls, RowRef } from '../core/interfaces/view'
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
  ).toEqual(['r', 'h', 'g', 'a', 't', 'x', '1', '2', '3', '0'])
  expect(keysOf(m).at(-1)).toBe('t.open')
})

test('the tracker keys follow the order of the trackers, not the order of the list', async () => {
  const late = fake('late', 20, { keys: [{ ...OPEN, id: 'a', key: 'p' }] })
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
