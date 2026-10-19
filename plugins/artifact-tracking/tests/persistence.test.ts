// Persistence on fakePorts: the v2 layout, the debounce, the size bound, the end write and the legacy sweep.
// The slots are small fakes. Spec 5.6 and 5.13. Plan: L3 Task 4.
import { expect, test } from 'claude-code/testing'
import { GLOBAL_DEFAULTS } from '../core/infra/global-defaults'
import { KEYS, MIN_END_BUDGET_MS, Persistence } from '../core/infra/persistence'
import type { Json } from '../core/interfaces/items'
import type { StorePort } from '../core/interfaces/ports'
import type { DataSlot, PendingEnd } from '../core/interfaces/slots'
import { type FakeOpts, fakePorts } from './fixtures/ports'

type TestSlot = DataSlot & { live: Json | undefined }

/** A slot over a plain value. `settle` puts the stored array under the live one. */
function slot(id: string, live: Json | undefined, persist = true): TestSlot {
  const s: TestSlot = {
    id,
    persist,
    live,
    read: async () => s.live,
    empty: v => v === undefined || (Array.isArray(v) && v.length === 0),
    settle: async (l, stored) => (Array.isArray(l) && Array.isArray(stored) ? [...stored, ...l] : (l ?? stored)),
    restore: async v => {
      s.live = v
    },
  }
  return s
}

const LIMITS = {
  flushMs: GLOBAL_DEFAULTS.refresh.flushMs,
  keepSessions: GLOBAL_DEFAULTS.store.keepSessions,
  maxBytes: GLOBAL_DEFAULTS.store.maxBytes,
}

function setup(
  o: {
    slots?: TestSlot[]
    fake?: FakeOpts
    limits?: Partial<typeof LIMITS>
    beforeFlush?: () => Promise<void>
    store?: (real: StorePort) => StorePort
  } = {},
) {
  const w = fakePorts(o.fake)
  const slots = o.slots ?? [slot('items', ['i1']), slot('repos', ['r1']), slot('processes', [])]
  const p = new Persistence({
    store: o.store ? o.store(w.ports.store) : w.ports.store,
    clock: w.ports.clock,
    sessionId: () => w.ports.session.id(),
    slots: () => slots,
    limits: () => ({ ...LIMITS, ...o.limits }),
    beforeFlush: o.beforeFlush ?? (async () => {}),
    log: w.ports.log,
  })
  return { w, p, slots }
}

const PENDING: PendingEnd = { reason: 'clear', fromId: 'sess-1', at: 5 }

/** A copy whose JSON is exactly `len` characters: `{"items":["xxx"]}`. */
const copyOf = (len: number): Json => ({ items: ['x'.repeat(len - 14)] })

test('touch arms one flush after 1500 ms and a burst writes once', async () => {
  const { w, p } = setup()
  await p.touch()
  await p.touch()
  await p.touch()
  await w.clock.advance(1499)
  expect(w.storeSets).toBe(0)
  await w.clock.advance(2)
  expect(w.storeSets).toBe(2) // the copy and the index
  expect(w.store.get('v2:index')).toEqual(['sess-1'])
})

test('a later touch does not move the timer', async () => {
  const { w, p } = setup()
  await p.touch()
  await w.clock.advance(1000)
  await p.touch()
  await w.clock.advance(501)
  expect(w.storeSets).toBe(2)
})

test('a timer pending over two periods is replaced', async () => {
  const { w, p } = setup()
  w.clock.refuse('after', 1500)
  await p.touch()
  await w.clock.advance(3001)
  expect(w.storeSets).toBe(0) // the refused timer never fired
  await p.touch()
  await w.clock.advance(1501)
  expect(w.store.has('v2:s:sess-1')).toBe(true)
})

test('touch never rejects, even when the clock does', async () => {
  const w = fakePorts()
  const p = new Persistence({
    store: w.ports.store,
    clock: { now: async () => Promise.reject(new Error('no clock')), after: w.ports.clock.after },
    sessionId: async () => 'sess-1',
    slots: () => [],
    limits: () => LIMITS,
    beforeFlush: async () => {},
    log: w.ports.log,
  })
  await p.touch()
  expect(w.storeSets).toBe(0)
})

test('a flush that fails to read a slot is swallowed and the next touch tries again', async () => {
  let fail = true
  const { w, p } = setup({
    beforeFlush: async () => {
      if (fail) throw new Error('no session')
    },
  })
  await p.touch()
  await w.clock.advance(1501) // the timer callback must not reject
  expect(w.storeSets).toBe(0)
  fail = false
  await p.touch()
  await w.clock.advance(1501)
  expect(w.store.has('v2:s:sess-1')).toBe(true)
})

test('a flush with every persisted slot empty writes nothing', async () => {
  const { w, p } = setup({ slots: [slot('items', []), slot('repos', []), slot('processes', [])] })
  await p.touch()
  await w.clock.advance(2000)
  expect(w.storeSets).toBe(0)
})

test('an unchanged copy is not written again', async () => {
  const { w, p, slots } = setup()
  await p.flushNow()
  expect(w.storeSets).toBe(2)
  await p.flushNow()
  expect(w.storeSets).toBe(2)
  slots[0]!.live = ['i1', 'i2']
  await p.flushNow()
  expect(w.storeSets).toBe(3) // the copy only: the index did not change
})

test('the copy is { items, repos, processes } under v2:s:<id>; a persist:false slot is not in it', async () => {
  const { w, p } = setup({
    slots: [
      slot('items', ['i1']),
      slot('repos', ['r1']),
      slot('processes', []),
      slot('auto', { dismissed: ['x'] }, false),
    ],
  })
  await p.flushNow()
  expect(w.store.get('v2:s:sess-1')).toEqual({ items: ['i1'], repos: ['r1'], processes: [] })
})

test('a slot that reads undefined is left out of the copy', async () => {
  const { w, p } = setup({ slots: [slot('items', ['i1']), slot('repos', undefined)] })
  await p.flushNow()
  expect(w.store.get('v2:s:sess-1')).toEqual({ items: ['i1'] })
})

test('v2:index holds the newest ids first, at most keepSessions', async () => {
  const ids = Array.from({ length: 25 }, (_, k) => `old${k}`)
  const store: Record<string, Json> = { 'v2:index': ids }
  for (const id of ids) store[`v2:s:${id}`] = { items: [] }
  const { w, p } = setup({ fake: { store } })
  await p.flushNow()
  const index = w.store.get('v2:index') as string[]
  expect(index.length).toBe(20)
  expect(index[0]).toBe('sess-1')
  expect(index[1]).toBe('old0')
  expect(w.store.has('v2:s:old24')).toBe(false)
  expect(w.store.has('v2:s:old18')).toBe(true)
})

test('over maxBytes the oldest sessions go first, never the one being written', async () => {
  const seed = () => ({
    fake: {
      store: {
        'v2:index': ['old1', 'old2', 'old3'],
        'v2:s:old1': copyOf(150),
        'v2:s:old2': copyOf(150),
        'v2:s:old3': copyOf(150),
      },
    },
    limits: { maxBytes: 400 },
  })
  const small = setup({ ...seed(), slots: [slot('items', ['x'.repeat(86)])] }) // a copy of 100 characters
  await small.p.flushNow()
  expect(small.w.store.get('v2:index')).toEqual(['sess-1', 'old1'])
  expect(small.w.store.has('v2:s:old1')).toBe(true)
  expect(small.w.store.has('v2:s:old2')).toBe(false)
  expect(small.w.store.has('v2:s:old3')).toBe(false)

  const big = setup({ ...seed(), slots: [slot('items', ['x'.repeat(486)])] }) // 500 characters, over the bound alone
  await big.p.flushNow()
  expect(big.w.store.get('v2:index')).toEqual(['sess-1'])
  expect(big.w.store.has('v2:s:sess-1')).toBe(true)
  expect(big.w.store.has('v2:s:old1')).toBe(false)
})

test('the size of v2:run counts against maxBytes', async () => {
  const { w, p } = setup({
    fake: { store: { 'v2:index': ['old1'], 'v2:s:old1': copyOf(150), 'v2:run': { pad: 'x'.repeat(200) } } },
    limits: { maxBytes: 400 },
    slots: [slot('items', ['x'.repeat(86)])],
  })
  await p.flushNow()
  expect(w.store.get('v2:index')).toEqual(['sess-1']) // 100 + 150 + the run copy is over 400
})

/** The store calls that change data, in order: `set v2:s:a`, `delete v2:s:b`. */
function logged(ops: string[]) {
  return (real: StorePort): StorePort => ({
    ...real,
    set: async (k, v) => {
      ops.push(`set ${k}`)
      return real.set(k, v)
    },
    delete: async k => {
      ops.push(`delete ${k}`)
      return real.delete(k)
    },
  })
}

/** Twenty stored sessions: the next write drops `old19` by the retention rule. */
function fullHistory(): Record<string, Json> {
  const ids = Array.from({ length: 20 }, (_, k) => `old${k}`)
  const store: Record<string, Json> = { 'v2:index': ids }
  for (const id of ids) store[`v2:s:${id}`] = { items: [] }
  return store
}

test('the copy is written before the sessions that the retention drops', async () => {
  const ops: string[] = []
  const { w, p } = setup({ fake: { store: fullHistory() }, store: logged(ops) })
  await p.flushNow()
  expect(ops).toEqual(['set v2:s:sess-1', 'delete v2:s:old19', 'set v2:index'])
  expect(w.store.has('v2:s:old19')).toBe(false)
})

test('a rejected copy write deletes no older session and leaves the index alone', async () => {
  const { w, p } = setup({
    fake: { store: fullHistory() },
    store: real => ({
      ...real,
      set: async (k, v) => {
        if (k === 'v2:s:sess-1') throw new Error('quota')
        return real.set(k, v)
      },
    }),
  })
  await p.flushNow()
  expect(w.store.has('v2:s:old19')).toBe(true) // the retention would drop it, but the new copy is not saved
  expect((w.store.get('v2:index') as string[]).length).toBe(20)
  expect(w.store.get('v2:index')).not.toContain('sess-1')
  expect(w.logs).toEqual(['store: write of v2:s:sess-1 failed: quota'])
})

test('when the store would refuse the copy beside the sessions to drop, they go first', async () => {
  const ops: string[] = []
  const { w, p } = setup({
    fake: {
      store: {
        'v2:index': ['old1', 'old2'],
        'v2:s:old1': copyOf(1_500_000),
        'v2:s:old2': copyOf(1_500_000),
      },
    },
    slots: [slot('items', ['x'.repeat(1_200_000 - 14)])], // 1.2M + 1.5M fit the 3M bound; old2 goes, and 4.2M would not fit the store
    store: logged(ops),
  })
  await p.flushNow()
  expect(ops).toEqual(['delete v2:s:old2', 'set v2:s:sess-1', 'set v2:index'])
  expect(w.store.get('v2:index')).toEqual(['sess-1', 'old1'])
})

test('end counts the v2:run it is about to write against maxBytes', async () => {
  const { w, p } = setup({
    fake: { store: { 'v2:index': ['old1'], 'v2:s:old1': copyOf(150), 'v2:run': {} } },
    limits: { maxBytes: 400 },
    slots: [slot('items', ['x'.repeat(86)]), slot('auto', 'y'.repeat(200), false)],
  })
  await p.end('sess-1', 1000, PENDING) // 100 + 150 + the old run record fit; the new run record of 300 does not
  expect(w.store.get('v2:index')).toEqual(['sess-1'])
  expect(w.store.has('v2:s:old1')).toBe(false)
})

test('a session named in the index with no copy counts as nothing', async () => {
  const { w, p } = setup({ fake: { store: { 'v2:index': ['ghost'] } } })
  await p.flushNow()
  expect(w.store.get('v2:index')).toEqual(['sess-1', 'ghost'])
})

test('a rejected set is logged once and the next touch writes again', async () => {
  let fail = true
  const { w, p } = setup({
    store: real => ({
      ...real,
      set: async (k, v) => {
        if (fail) throw new Error('quota')
        return real.set(k, v)
      },
    }),
  })
  await p.touch()
  await w.clock.advance(1501)
  expect(w.logs).toEqual(['store: write of v2:s:sess-1 failed: quota'])
  expect(w.store.has('v2:s:sess-1')).toBe(false)
  fail = false
  await p.touch()
  await w.clock.advance(1501)
  expect(w.store.has('v2:s:sess-1')).toBe(true)
  expect(w.logs.length).toBe(1)
})

test('a failed index write forgets the remembered copy, so an older copy is written again', async () => {
  let failIndex = false
  const { w, p } = setup({
    store: real => ({
      ...real,
      set: async (k, v) => {
        if (failIndex && k === 'v2:index') throw new Error('quota')
        return real.set(k, v)
      },
    }),
  })
  await p.write('x', { items: ['a'] })
  await p.write('y', { items: ['c'] })
  failIndex = true
  await p.write('x', { items: ['b'] }) // the copy lands, then the index (x moves to the front) fails
  failIndex = false
  await p.write('x', { items: ['a'] })
  expect(w.store.get('v2:s:x')).toEqual({ items: ['a'] })
})

test('write remembers the last copy for each session on its own', async () => {
  const { w, p } = setup()
  await p.write('prev', { items: ['p'] })
  await p.flushNow()
  const sets = w.storeSets
  await p.write('prev', { items: ['p'] })
  expect(w.storeSets).toBe(sets) // the copy of the other session did not reset it
})

test('end cancels the pending flush and writes v2:s:<id> and v2:run before it resolves', async () => {
  const { w, p } = setup()
  await p.touch()
  await p.end('sess-1', 1000, PENDING)
  expect(w.store.get('v2:s:sess-1')).toEqual({ items: ['i1'], repos: ['r1'], processes: [] })
  expect((w.store.get('v2:run') as { pendingEnd: PendingEnd }).pendingEnd).toEqual(PENDING)
  const sets = w.storeSets
  await w.clock.advance(2000)
  expect(w.storeSets).toBe(sets)
})

test('end merges the stored copy under the live value through slot.settle', async () => {
  const { w, p } = setup({ fake: { store: { 'v2:s:sess-1': { items: ['a'] } } }, slots: [slot('items', ['b'])] })
  const snap = await p.end('sess-1', 1000, PENDING)
  expect(w.store.get('v2:s:sess-1')).toEqual({ items: ['a', 'b'] })
  expect(snap).toEqual({ from: 'sess-1', slots: { items: ['a', 'b'] } })
})

test('end puts persist:false slots in v2:run.run', async () => {
  const { w, p } = setup({ slots: [slot('items', ['i1']), slot('auto', { dismissed: ['x'] }, false)] })
  const snap = await p.end('sess-1', 1000, PENDING)
  expect(w.store.get('v2:run')).toEqual({ pendingEnd: PENDING, run: { auto: { dismissed: ['x'] } } })
  expect(w.store.get('v2:s:sess-1')).toEqual({ items: ['i1'] })
  expect(snap.slots.auto).toEqual({ dismissed: ['x'] })
})

test('end writes v2:run even when every persisted slot is empty, and no session copy', async () => {
  const { w, p } = setup({ slots: [slot('items', []), slot('auto', undefined, false)] })
  await p.end('sess-1', 1000, PENDING)
  expect(w.store.has('v2:s:sess-1')).toBe(false)
  expect(w.store.get('v2:run')).toEqual({ pendingEnd: PENDING })
})

test('end with a budget under 200 ms writes nothing and still returns the snapshot', async () => {
  const { w, p } = setup()
  const snap = await p.end('sess-1', MIN_END_BUDGET_MS - 1, PENDING)
  expect(w.storeSets).toBe(0)
  expect(snap.slots.items).toEqual(['i1'])
  await p.end('sess-1', MIN_END_BUDGET_MS, PENDING)
  expect(w.store.has('v2:run')).toBe(true)
})

test('end logs a rejected write and still returns the snapshot', async () => {
  const { w, p } = setup({
    store: real => ({
      ...real,
      set: async () => {
        throw new Error('full')
      },
    }),
  })
  const snap = await p.end('sess-1', 1000, PENDING)
  expect(snap.from).toBe('sess-1')
  expect(w.logs).toEqual(['store: write of v2:s:sess-1 failed: full', 'store: write of v2:run failed: full'])
})

/** A store whose `get` of the listed keys rejects. */
const unreadable =
  (...keys: string[]) =>
  (real: StorePort): StorePort => ({
    ...real,
    get: async k => {
      if (keys.includes(k)) throw new Error('timeout')
      return real.get(k)
    },
  })

test('end settles the live slots when the stored copy cannot be read, and still writes both keys', async () => {
  const { w, p } = setup({ fake: { store: { 'v2:s:sess-1': { items: ['old'] } } }, store: unreadable('v2:s:sess-1') })
  const snap = await p.end('sess-1', 1000, PENDING)
  const live = { items: ['i1'], repos: ['r1'], processes: [] }
  expect(snap).toEqual({ from: 'sess-1', slots: live })
  expect(w.store.get('v2:s:sess-1')).toEqual(live)
  expect((w.store.get('v2:run') as { pendingEnd: PendingEnd }).pendingEnd).toEqual(PENDING)
  expect(w.logs).toEqual(['store: read of v2:s:sess-1 failed: timeout'])
})

test('read and loadRun log a rejected store read and answer nothing stored', async () => {
  const { w, p } = setup({ store: unreadable('v2:s:sess-1', 'v2:run') })
  expect(await p.read('sess-1')).toBeUndefined()
  expect(await p.loadRun()).toEqual({})
  expect(w.logs).toEqual(['store: read of v2:s:sess-1 failed: timeout', 'store: read of v2:run failed: timeout'])
})

test('beforeFlush runs before the slots are read', async () => {
  const seen: string[] = []
  const { w, p, slots } = setup({
    beforeFlush: async () => {
      seen.push('before')
      slots[0]!.live = ['moved']
    },
  })
  const read = slots[0]!.read
  slots[0]!.read = async () => {
    seen.push('read')
    return read()
  }
  await p.flushNow()
  expect(seen).toEqual(['before', 'read'])
  expect((w.store.get('v2:s:sess-1') as { items: string[] }).items).toEqual(['moved'])
})

test('the flush writes the copy of the session the check ended up on', async () => {
  const { w, p } = setup({
    beforeFlush: async () => {
      w.session.id = 'sess-2'
    },
  })
  await p.flushNow()
  expect(w.store.has('v2:s:sess-2')).toBe(true)
  expect(w.store.has('v2:s:sess-1')).toBe(false)
})

test('dropLegacy deletes s:* and index and nothing else; a second call deletes nothing', async () => {
  const keep = { 'v2:s:a': {}, 'v2:index': ['a'], 'v2:run': {}, other: 1 }
  const { w, p } = setup({ fake: { store: { ...keep, 's:a': {}, 's:b': {}, index: ['a', 'b'] } } })
  expect(await p.dropLegacy()).toBe(3)
  expect([...w.store.keys()].sort()).toEqual(Object.keys(keep).sort())
  expect(await p.dropLegacy()).toBe(0)
  expect(w.storeSets).toBe(0) // no marker key
})

test('forget deletes v2:s:<id>, drops it from v2:index, and the next equal copy is written again', async () => {
  const { w, p } = setup({ fake: { store: { 'v2:index': ['old1'], 'v2:s:old1': { items: [] } } } })
  await p.flushNow()
  expect(w.store.get('v2:index')).toEqual(['sess-1', 'old1'])
  await p.forget('sess-1')
  expect(w.store.has('v2:s:sess-1')).toBe(false)
  expect(w.store.get('v2:index')).toEqual(['old1'])
  await p.flushNow()
  expect(w.store.has('v2:s:sess-1')).toBe(true)
  await p.forget('nobody') // an id the index never held: no index write
  expect(w.store.get('v2:index')).toEqual(['sess-1', 'old1'])
})

test('flushNow writes at once and cancels the timer', async () => {
  const { w, p } = setup()
  await p.touch()
  await p.flushNow()
  expect(w.storeSets).toBe(2)
  await w.clock.advance(2000)
  expect(w.storeSets).toBe(2)
})

test('loadRun reads v2:run and clearRun drops pendingEnd and keeps the run values', async () => {
  const { w, p } = setup({ slots: [slot('items', ['i1']), slot('auto', { dismissed: ['x'] }, false)] })
  expect(await p.loadRun()).toEqual({})
  await p.end('sess-1', 1000, PENDING)
  expect(await p.loadRun()).toEqual({ pendingEnd: PENDING, run: { auto: { dismissed: ['x'] } } })
  await p.clearRun()
  expect(w.store.get('v2:run')).toEqual({ run: { auto: { dismissed: ['x'] } } })
  const sets = w.storeSets
  await p.clearRun() // no pendingEnd left: nothing to write
  expect(w.storeSets).toBe(sets)
})

test('clearRun deletes v2:run when only pendingEnd was in it', async () => {
  const { w, p } = setup({ slots: [slot('items', ['i1'])] })
  await p.end('sess-1', 1000, PENDING)
  await p.clearRun()
  expect(w.store.has('v2:run')).toBe(false)
})

test('KEYS names the three v2 keys', () => {
  expect(KEYS.session('abc')).toBe('v2:s:abc')
  expect(KEYS.index).toBe('v2:index')
  expect(KEYS.run).toBe('v2:run')
})
