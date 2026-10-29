// Persistence on fakePorts: the v2 layout, the debounce, the size bound, the end write, the legacy sweep and the audit log.
// The slots are small fakes. Spec 5.6 and 5.13. Plan: L3 Task 4.
import { expect, test } from 'claude-code/testing'
import { KEYS, LOG_KEEP, MIN_END_BUDGET_MS, Persistence, parseLogRun } from '../core/infra/persistence'
import type { LogEntry } from '../core/interfaces/clean'
import type { Json } from '../core/interfaces/items'
import type { StorePort } from '../core/interfaces/ports'
import type { DataSlot, PendingEnd } from '../core/interfaces/slots'
import { GLOBAL_DEFAULTS } from '../core/lib/global-config'
import { logKeys, storedLog } from './fixtures/log'
import { type FakeOpts, type FakeWorld, fakePorts } from './fixtures/ports'

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

test('dropRun deletes the record the start read, and a record with nothing in it is left alone', async () => {
  const { w, p } = setup({ fake: { store: { 'v2:run': { run: { auto: { root: '/old' } } } } } })
  await p.dropRun(await p.loadRun())
  expect(w.store.has('v2:run')).toBe(false)
  const sets = w.storeSets
  await p.dropRun({})
  expect(w.storeSets).toBe(sets)
})

test('dropRun leaves a v2:run that another process wrote after the start read it', async () => {
  const { w, p } = setup({ fake: { store: { 'v2:run': { run: { auto: { root: '/old' } } } } } })
  const stale = await p.loadRun()
  w.store.set('v2:run', { pendingEnd: PENDING }) // a second process ended its session while this start ran
  await p.dropRun(stale)
  expect(w.store.get('v2:run')).toEqual({ pendingEnd: PENDING })
  await p.clearRun() // the size it counts is the fresh record's
  expect(w.store.has('v2:run')).toBe(false)
})

test('KEYS names the v2 keys, and a log run key holds its time, its size and its tag', () => {
  expect(KEYS.session('abc')).toBe('v2:s:abc')
  expect(KEYS.index).toBe('v2:index')
  expect(KEYS.run).toBe('v2:run')
  expect(KEYS.log).toBe('v2:log')
  expect(KEYS.logRun(5, 102, 'abc-1')).toBe('v2:log:0000000000005:102:abc-1')
})

test('parseLogRun gives back what KEYS.logRun was given, and nothing for a key that is no run key', () => {
  expect(parseLogRun(KEYS.logRun(1730000000123, 4096, 'abcdefgh-17'))).toEqual({
    at: 1730000000123,
    chars: 4096,
    seq: 17,
  })
  expect(parseLogRun(KEYS.logRun(0, 1, 'x'))).toEqual({ at: 0, chars: 1, seq: 0 }) // a tag with no counter ranks as 0
  expect(parseLogRun(KEYS.logRun(7, 9, 'a-b-3'))).toEqual({ at: 7, chars: 9, seq: 3 }) // the counter is the last dash part
  expect(parseLogRun(KEYS.log)).toBeUndefined()
  expect(parseLogRun('v2:log:hand-made')).toBeUndefined()
  expect(parseLogRun('v2:log:5:87:x-1')).toBeUndefined() // the time has 13 digits
  expect(parseLogRun('v2:logs')).toBeUndefined()
})

// ---------------------------------------------------------------- the audit log (issues #122 and #213)
// One key per `--yes` run: an append never reads another run's key, so two sessions that append at once lose nothing.

const entry = (n: number, f: Partial<LogEntry> = {}): LogEntry => ({
  at: n,
  by: 'manual',
  kind: 'tasks',
  id: `task:t${n}`,
  action: 'stop',
  outcome: 'done',
  ...f,
})

/** An entry of about 250 characters. */
const big = (n: number): LogEntry => entry(n, { outcome: `skipped: ${'x'.repeat(150)}` })

const ats = (log: readonly LogEntry[]): number[] => log.map(e => e.at)

/** Another process over the same store: its own session id and its own `Persistence`. */
function another(
  w: FakeWorld,
  id: string,
  o: { store?: StorePort; limits?: Partial<typeof LIMITS> } = {},
): Persistence {
  return new Persistence({
    store: o.store ?? w.ports.store,
    clock: w.ports.clock,
    sessionId: async () => id,
    slots: () => [],
    limits: () => ({ ...LIMITS, ...o.limits }),
    beforeFlush: async () => {},
    log: w.ports.log,
  })
}

/**
 * A store whose first call of `method` waits until `open()`. `reached` settles when that call arrives, so a test holds one
 * process in the middle of its append, lets another run in full, and then lets the first go on: an order, not a duration.
 */
function gated(real: StorePort, method: 'set' | 'get' | 'delete') {
  let open: () => void = () => {}
  const release = new Promise<void>(r => {
    open = r
  })
  let arrive: () => void = () => {}
  const reached = new Promise<void>(r => {
    arrive = r
  })
  let held = false
  const hold = async () => {
    if (held) return
    held = true
    arrive()
    await release
  }
  const store = {
    ...real,
    [method]: async (...args: unknown[]) => {
      await hold()
      return (real[method] as (...a: unknown[]) => unknown)(...args)
    },
  } as StorePort
  return { store, reached, open }
}

/**
 * A wrapper for the stores of several processes: the first write of a log key waits until `parties` writes have arrived, and
 * then all go on. Every process has written when the first one prunes: an order, not a duration.
 */
function meeting(parties: number) {
  let arrived = 0
  let go: () => void = () => {}
  const all = new Promise<void>(r => {
    go = r
  })
  return (real: StorePort): StorePort => ({
    ...real,
    set: async (k, v) => {
      if (k.startsWith(`${KEYS.log}:`)) {
        if (++arrived === parties) go()
        await all
      }
      return real.set(k, v)
    },
  })
}

/** The keys of the `get` and `delete` calls, and the number of `keys` calls, that a `spied` store saw. */
const noCalls = () => ({ get: [] as string[], delete: [] as string[], keys: 0 })

/** A store that records the key of every `get` and `delete`, and counts every `keys`, in `calls`. */
const spied = (real: StorePort, calls: ReturnType<typeof noCalls>): StorePort => ({
  ...real,
  keys: async () => {
    calls.keys++
    return real.keys()
  },
  get: async k => {
    calls.get.push(k)
    return real.get(k)
  },
  delete: async k => {
    calls.delete.push(k)
    return real.delete(k)
  },
})

/** A store that rejects a `get` of the keys that `fails` accepts. */
const refusing = (real: StorePort, fails: (key: string) => boolean): StorePort => ({
  ...real,
  get: async k => {
    if (fails(k)) throw new Error('timeout')
    return real.get(k)
  },
})

test('the log is empty until something is appended', async () => {
  const { w, p } = setup()
  expect(await p.readLog()).toEqual([])
  expect(logKeys(w.store)).toEqual([])
})

test('two appends whose writes interleave both survive: the second session appends while the first holds its write open', async () => {
  const w = fakePorts()
  const held = gated(w.ports.store, 'set')
  const a = another(w, 'sess-a', { store: held.store })
  const b = another(w, 'sess-b')
  const pending = a.appendLog([entry(1)])
  await held.reached // A is at its first write; an append that read the key first has read it by now
  await b.appendLog([entry(2)])
  held.open()
  await pending
  expect(ats(await b.readLog())).toEqual([2, 1])
  expect(ats(await a.readLog())).toEqual([2, 1])
})

test('B appends between the write and the prune of A: both runs stay', async () => {
  const w = fakePorts()
  const held = gated(w.ports.store, 'get')
  const a = another(w, 'sess-a', { store: held.store })
  const b = another(w, 'sess-b')
  const pending = a.appendLog([entry(1)])
  await held.reached // A listed the keys, wrote its key and now reads the keys to prune
  await b.appendLog([entry(2)])
  held.open()
  await pending
  expect(ats(await a.readLog())).toEqual([2, 1])
  expect(logKeys(w.store)).toHaveLength(2)
})

/** Two sessions whose runs pass half of `maxBytes` together: each run fits, both do not. Both write before either prunes. */
async function twoRunsAtOnce() {
  const w = fakePorts()
  const limits = { maxBytes: 2000 } // half is 1000: a run of three big entries is about 760 characters
  const meet = meeting(2)
  const a = another(w, 'sess-a', { store: meet(w.ports.store), limits })
  const b = another(w, 'sess-b', { store: meet(w.ports.store), limits })
  await Promise.all([a.appendLog([big(1), big(2), big(3)]), b.appendLog([big(11), big(12), big(13)])])
  return { w, a, limits }
}

test('two runs that pass half of maxBytes together and write at once both stay: a prune deletes only keys that were written before its own listing', async () => {
  const { w, a } = await twoRunsAtOnce()
  expect(logKeys(w.store)).toHaveLength(2) // each prune ran with both keys there; the old rule deleted both runs
  expect(ats(await a.readLog())).toEqual([13, 12, 11, 3, 2, 1])
})

test('the next append takes the runs that passed half of maxBytes when they were written at once', async () => {
  const { w, a, limits } = await twoRunsAtOnce()
  expect(logKeys(w.store)).toHaveLength(2) // over half of maxBytes until a later prune
  await another(w, 'sess-c', { limits }).appendLog([big(21), big(22), big(23)])
  const bytes = logKeys(w.store).reduce((n, k) => n + JSON.stringify(w.store.get(k)).length, 0)
  expect(bytes).toBeLessThanOrEqual(limits.maxBytes / 2)
  expect(ats(await a.readLog())).toEqual([23, 22, 21]) // the run that just wrote stays, the older two went
})

test('each append writes its own key: the name holds the time, the size and the tag, and the value is the run, newest first', async () => {
  const { w, p } = setup()
  await p.appendLog([entry(1), entry(2)])
  const run = [entry(2), entry(1)]
  expect(logKeys(w.store)).toEqual([KEYS.logRun(2, JSON.stringify(run).length, 'sess-1-1')])
  expect(w.store.get(logKeys(w.store)[0] as string)).toEqual(run)
  await p.appendLog([entry(3)])
  expect(logKeys(w.store)).toHaveLength(2)
  expect(ats(await p.readLog())).toEqual([3, 2, 1])
})

test('the tag is the first 8 characters of the session id and a counter of the load', async () => {
  const w = fakePorts()
  const p = another(w, 'abcdefghijkl')
  await p.appendLog([entry(1)])
  await p.appendLog([entry(2)])
  expect(logKeys(w.store).map(k => k.split(':').slice(4).join(':'))).toEqual(['abcdefgh-1', 'abcdefgh-2'])
})

test('one run keeps its newest 200 entries: the key holds them, not only the read', async () => {
  const { w, p } = setup()
  await p.appendLog(Array.from({ length: 250 }, (_, i) => entry(i + 1))) // given oldest first
  expect(logKeys(w.store)).toHaveLength(1)
  const run = w.store.get(logKeys(w.store)[0] as string) as LogEntry[]
  expect(ats(run)).toEqual(Array.from({ length: LOG_KEEP }, (_, i) => 250 - i))
})

test('the time in the key name is clamped to 13 digits: a negative time and a 15-digit time both give a key that parses', async () => {
  const { w, p } = setup()
  await p.appendLog([entry(-5)])
  await p.appendLog([entry(1e14)]) // 15 digits, still a valid Date
  const keys = logKeys(w.store).sort()
  expect(keys).toHaveLength(2)
  for (const k of keys) expect(k).toMatch(/^v2:log:\d{13}:\d+:/)
  expect(keys.map(k => parseLogRun(k)?.at)).toEqual([0, 9_999_999_999_999])
  expect(ats(await p.readLog())).toEqual([1e14, -5]) // the entries keep their own times
})

test('a session id that cannot be read does not lose the run: it is written under the tag nosess and one line names the fault', async () => {
  const w = fakePorts()
  const p = new Persistence({
    store: w.ports.store,
    clock: w.ports.clock,
    sessionId: async () => {
      throw new Error('no session')
    },
    slots: () => [],
    limits: () => LIMITS,
    beforeFlush: async () => {},
    log: w.ports.log,
  })
  await p.appendLog([entry(1)])
  await p.appendLog([entry(2)])
  expect(logKeys(w.store).map(k => k.split(':').slice(4).join(':'))).toEqual(['nosess-1', 'nosess-2'])
  expect(ats(await p.readLog())).toEqual([2, 1])
  expect(w.logs).toEqual([
    'store: read of the session id for the log key failed: no session',
    'store: read of the session id for the log key failed: no session',
  ])
})

test('a session id port that throws at once, not by a rejected promise, does not reject the append either', async () => {
  const w = fakePorts()
  const p = new Persistence({
    store: w.ports.store,
    clock: w.ports.clock,
    sessionId: () => {
      throw new Error('gone')
    },
    slots: () => [],
    limits: () => LIMITS,
    beforeFlush: async () => {},
    log: w.ports.log,
  })
  await p.appendLog([entry(1)])
  expect(logKeys(w.store)).toHaveLength(1)
})

test('the log keeps the newest 200 entries across runs, and a whole run key stays while one of its entries is among them', async () => {
  const { w, p } = setup()
  expect(LOG_KEEP).toBe(200)
  await p.appendLog(Array.from({ length: 150 }, (_, i) => entry(i)))
  await p.appendLog(Array.from({ length: 100 }, (_, i) => entry(1000 + i)))
  const log = await p.readLog()
  expect(log).toHaveLength(200)
  expect(log[0]?.at).toBe(1099) // the newest
  expect(log[99]?.at).toBe(1000)
  expect(log[100]?.at).toBe(149) // the oldest 50 of the first run fell out of the read
  expect(log[199]?.at).toBe(50)
  expect(logKeys(w.store)).toHaveLength(2) // the first run still has entries among the newest 200
})

test('--log merges the runs of two sessions by time: the newest 200 of 300 entries, no entry missing', async () => {
  const w = fakePorts()
  const a = another(w, 'sess-a')
  const b = another(w, 'sess-b')
  for (let i = 0; i < 150; i++) {
    await a.appendLog([entry(2 * i)])
    await b.appendLog([entry(2 * i + 1)])
  }
  const log = await a.readLog()
  expect(ats(log)).toEqual(Array.from({ length: 200 }, (_, i) => 299 - i))
  expect(ats(await b.readLog())).toEqual(ats(log))
})

test('two runs in the same millisecond read in the order they were appended: the counter breaks the tie, not the size', async () => {
  const { p } = setup()
  await p.appendLog([entry(5)]) // about 90 characters: its size text sorts after the 250 of the next run
  await p.appendLog([big(5)])
  expect((await p.readLog()).map(e => e.outcome === 'done')).toEqual([false, true])
})

test('reading the log writes and deletes nothing', async () => {
  const { w, p } = setup()
  await p.appendLog([entry(1)])
  const sets = w.storeSets
  const seen = noCalls()
  const reader = another(w, 'sess-b', { store: spied(w.ports.store, seen) })
  await reader.readLog()
  expect(w.storeSets).toBe(sets)
  expect(seen.delete).toEqual([])
})

test('reading the log deletes nothing even when a prune would: 201 run keys and a key that holds nothing stay', async () => {
  const seed: Record<string, Json> = { [KEYS.logRun(0, 5, 'junk-1')]: 'junk' as never }
  for (let i = 1; i <= 201; i++) seed[KEYS.logRun(i, 87, 'x-1')] = [entry(i)]
  const seen = noCalls()
  const { w, p } = setup({ fake: { store: seed }, store: real => spied(real, seen) })
  expect(await p.readLog()).toHaveLength(200)
  expect(seen.delete).toEqual([])
  expect(w.storeSets).toBe(0)
  expect(logKeys(w.store)).toHaveLength(202)
  await p.appendLog([entry(300)]) // the same store does lose keys at a prune, so the read above proves the read-only part
  expect(seen.delete.length).toBeGreaterThan(0)
})

test('--log reads the newest keys first and stops once no key left can hold one of the newest 200', async () => {
  const seed: Record<string, Json> = {}
  for (let i = 1; i <= 300; i++) seed[KEYS.logRun(i, 87, 'x-1')] = [entry(i)]
  const seen = noCalls()
  const { p } = setup({ fake: { store: seed }, store: real => spied(real, seen) })
  expect(ats(await p.readLog())).toEqual(Array.from({ length: 200 }, (_, i) => 300 - i))
  expect(seen.get).toHaveLength(200) // the oldest 100 keys were never read
})

test('a run key whose entries are older than its name says goes when none of them is among the newest 200', async () => {
  const seed: Record<string, Json> = { [KEYS.logRun(5000, 87, 'x-1')]: [entry(1)] }
  for (let i = 1000; i < 1200; i++) seed[KEYS.logRun(i, 87, 'x-1')] = [entry(i)]
  const { w, p } = setup({ fake: { store: seed } })
  await p.appendLog([entry(1300)])
  expect(w.store.has(KEYS.logRun(5000, 87, 'x-1'))).toBe(false)
  expect(logKeys(w.store)).toHaveLength(200)
})

test('a prune keeps 200 keys: 260 runs of one entry leave the newest 200, and the oldest went', async () => {
  const { w, p } = setup()
  for (let i = 1; i <= 260; i++) await p.appendLog([entry(i)])
  expect(logKeys(w.store)).toHaveLength(200)
  expect(ats(await p.readLog())).toEqual(Array.from({ length: 200 }, (_, i) => 260 - i))
})

test('a prune leaves the other keys of the store alone', async () => {
  const { w, p } = setup({
    fake: { store: { 'v2:index': ['a'], 'v2:s:a': copyOf(40), 'v2:run': { run: {} }, 'v2:logs': 1 } },
  })
  for (let i = 1; i <= 205; i++) await p.appendLog([entry(i)])
  expect([...w.store.keys()].filter(k => !k.startsWith('v2:log:')).sort()).toEqual([
    'v2:index',
    'v2:logs',
    'v2:run',
    'v2:s:a',
  ])
})

test('an empty append writes nothing', async () => {
  const { w, p } = setup()
  await p.appendLog([])
  expect(w.storeSets).toBe(0)
})

test('a refused log write is logged with the key it was for, never rejects, and prunes nothing', async () => {
  const { w, p } = setup({
    store: real => ({
      ...real,
      set: async () => {
        throw new Error('full')
      },
    }),
  })
  await p.appendLog([entry(1)])
  expect(w.logs).toEqual([
    `store: write of ${KEYS.logRun(1, JSON.stringify([entry(1)]).length, 'sess-1-1')} failed: full`,
  ])
})

test('a refused log write prunes nothing: the keys that were there stay', async () => {
  const seed: Record<string, Json> = {}
  for (let i = 1; i <= 201; i++) seed[KEYS.logRun(i, 87, 'x-1')] = [entry(i)]
  const { w, p } = setup({
    fake: { store: seed },
    store: real => ({
      ...real,
      set: async () => {
        throw new Error('full')
      },
    }),
  })
  await p.appendLog([entry(300)])
  expect(logKeys(w.store)).toHaveLength(201) // a prune after the failed write would have taken the oldest, at 1
  expect(w.logs).toHaveLength(1) // the fault of the write, and no line of a prune
})

test('a refused delete stops the prune, is logged once and never rejects', async () => {
  const seed: Record<string, Json> = {}
  for (let i = 1; i <= 202; i++) seed[KEYS.logRun(i, 87, 'x-1')] = [entry(i)]
  const { w, p } = setup({
    fake: { store: seed },
    store: real => ({
      ...real,
      delete: async () => {
        throw new Error('busy')
      },
    }),
  })
  await p.appendLog([entry(300)])
  expect(w.logs).toEqual(['store: prune of v2:log failed: busy'])
  expect(logKeys(w.store)).toHaveLength(203) // the append is written, and the first refused delete ended the prune
})

test('a log key that cannot be read hides only itself: --log still shows the others, and the line names the key', async () => {
  const { w, p } = setup({
    fake: { store: { 'v2:log': [entry(1)], [KEYS.logRun(2, 87, 'x-1')]: [entry(2)] } },
    store: real => refusing(real, k => k === 'v2:log'),
  })
  expect(ats(await p.readLog())).toEqual([2])
  expect(w.logs).toEqual(['store: read of v2:log failed: timeout'])
})

test('a run key that cannot be read hides only itself: --log shows the others, the line names the key, and nothing is deleted', async () => {
  const bad = KEYS.logRun(2, 87, 'x-1')
  const seen = noCalls()
  const { w, p } = setup({
    fake: {
      store: { [bad]: [entry(2)], [KEYS.logRun(1, 87, 'x-1')]: [entry(1)], [KEYS.logRun(3, 87, 'x-1')]: [entry(3)] },
    },
    store: real =>
      spied(
        refusing(real, k => k === bad),
        seen,
      ),
  })
  expect(ats(await p.readLog())).toEqual([3, 1])
  expect(w.logs).toEqual([`store: read of ${bad} failed: timeout`])
  expect(seen.delete).toEqual([])
})

test('a store that cannot list its keys gives an empty log with one line, and an append still writes its own key', async () => {
  const { w, p } = setup({
    store: real => ({
      ...real,
      keys: async () => {
        throw new Error('gone')
      },
    }),
  })
  expect(await p.readLog()).toEqual([])
  await p.appendLog([entry(1)])
  expect(logKeys(w.store)).toHaveLength(1)
  expect(w.logs).toEqual([
    'store: read of v2:log failed: gone',
    'store: prune of v2:log failed: gone', // the append wrote its run, and its prune could not list
  ])
})

test('a prune whose read fails deletes nothing, logs one line and never rejects; the append is already written', async () => {
  const seed: Record<string, Json> = {}
  for (let i = 1; i <= 205; i++) seed[KEYS.logRun(i, 87, 'x-1')] = [entry(i)]
  const unreadable = KEYS.logRun(205, 87, 'x-1')
  const { w, p } = setup({ fake: { store: seed }, store: real => refusing(real, k => k === unreadable) })
  await p.appendLog([entry(300)])
  expect(logKeys(w.store)).toHaveLength(206) // 205 seeded and the new one: nothing was deleted
  expect(w.logs).toEqual([`store: prune of v2:log failed: read of ${unreadable} failed: timeout`])
})

test('the key of the run that prunes stays even when the clock went back: the next prune takes it', async () => {
  const seed: Record<string, Json> = {}
  for (let i = 1000; i < 1200; i++) seed[KEYS.logRun(i, 87, 'x-1')] = [entry(i)]
  const { w, p } = setup({ fake: { store: seed } })
  await p.appendLog([entry(5)]) // older than the 200 entries that are there
  expect(logKeys(w.store)).toHaveLength(201)
  expect(ats(await p.readLog())).not.toContain(5)
  await p.appendLog([entry(1300)])
  expect(logKeys(w.store)).toHaveLength(200) // the run at 5 is no longer its own, and no entry of it is among the newest
})

test('two sessions that append in the same millisecond with the same counter read in one fixed order', async () => {
  const w = fakePorts()
  await another(w, 'sess-a').appendLog([entry(5, { id: 'task:a' })])
  await another(w, 'sess-b').appendLog([entry(5, { id: 'task:b' })])
  const ids = (await another(w, 'sess-c').readLog()).map(e => e.id)
  expect(ids).toEqual(['task:b', 'task:a']) // no order can be told apart, so the name decides: the same in every session
})

test('a prune lists the keys once and never deletes a key it did not see: a run that B writes during A prune stays', async () => {
  const seed: Record<string, Json> = {}
  for (let i = 1; i <= 200; i++) seed[KEYS.logRun(i, 87, 'x-1')] = [entry(i)]
  const w = fakePorts({ store: seed })
  const held = gated(w.ports.store, 'delete')
  const a = another(w, 'sess-a', { store: held.store })
  const b = another(w, 'sess-b')
  const pending = a.appendLog([entry(201)])
  await held.reached // A listed 201 keys and is at its first delete: the oldest, at 1
  await b.appendLog([entry(202)])
  held.open()
  await pending
  expect(ats(await a.readLog())).toEqual(Array.from({ length: 200 }, (_, i) => 202 - i))
  expect(logKeys(w.store)).toHaveLength(200)
})

test('a stored entry that is not an entry is left out when the log is read; a key with none that prints goes at the next prune', async () => {
  const bad = [
    { ...entry(2), at: 'x' },
    { ...entry(2), at: 1e100 }, // finite, but no Date: toISOString() throws
    { ...entry(2), at: 8.64e15 + 1 }, // one ms past the last Date
    { ...entry(2), id: 7 },
    { ...entry(2), outcome: undefined },
    'junk',
    null,
    5,
  ]
  const mixed = KEYS.logRun(4, 400, 'x-1')
  const junk = KEYS.logRun(3, 400, 'x-2')
  const { w, p } = setup({ fake: { store: { [mixed]: [entry(4), ...bad, entry(1)] as never, [junk]: bad as never } } })
  expect(ats(await p.readLog())).toEqual([4, 1])
  await p.appendLog([entry(5)])
  expect(w.store.has(junk)).toBe(false) // nothing in it prints
  expect(w.store.has(mixed)).toBe(true) // an append never rewrites the key of another run
  expect(ats(await p.readLog())).toEqual([5, 4, 1])
})

test('a log key that holds no array reads as no entries, and the next prune takes it', async () => {
  const { w, p } = setup({
    fake: { store: { 'v2:log': 'junk' as never, [KEYS.logRun(1, 5, 'x-1')]: { a: 1 } as never } },
  })
  expect(await p.readLog()).toEqual([])
  await p.appendLog([entry(2)])
  expect(logKeys(w.store)).toHaveLength(1) // both stored values held nothing: the prune took them
})

test('a key under v2:log: with a name that does not parse is read to rank it, like the old key', async () => {
  const { w, p } = setup({
    fake: { store: { 'v2:log:hand-made': [entry(7)], [KEYS.logRun(5, 87, 'x-1')]: [entry(5)] } },
  })
  expect(ats(await p.readLog())).toEqual([7, 5])
  await p.appendLog([entry(9)])
  expect(ats(await p.readLog())).toEqual([9, 7, 5])
  expect(w.store.has('v2:log:hand-made')).toBe(true)
})

test('the log never takes more than half of maxBytes: the oldest entries of one run go first, the newest stay', async () => {
  const { w, p } = setup({ limits: { maxBytes: 2000 } })
  await p.appendLog(Array.from({ length: 10 }, (_, i) => big(i + 1)))
  const run = w.store.get(logKeys(w.store)[0] as string) as LogEntry[]
  expect(JSON.stringify(run).length).toBeLessThanOrEqual(1000)
  expect(run.length).toBeGreaterThan(0)
  expect(run[0]?.at).toBe(10) // the newest stays first
  expect(ats(run)).toEqual(Array.from({ length: run.length }, (_, i) => 10 - i)) // no gap: only the oldest went
})

test('when the runs pass half of maxBytes the oldest run keys go first, with no gap, and the newest run stays', async () => {
  const { w, p } = setup({ limits: { maxBytes: 2000 } })
  for (let i = 1; i <= 10; i++) await p.appendLog([big(i)]) // about 250 characters each: three fit in 1000
  const log = await p.readLog()
  expect(log.length).toBeGreaterThanOrEqual(2)
  expect(ats(log)).toEqual(Array.from({ length: log.length }, (_, i) => 10 - i))
  const chars = logKeys(w.store).reduce((n, k) => n + JSON.stringify(w.store.get(k)).length, 0)
  expect(chars).toBeLessThanOrEqual(1000)
})

test('one entry that is bigger than the bound is still kept: the newest try is never dropped', async () => {
  const { w, p } = setup({ limits: { maxBytes: 100 } })
  await p.appendLog([big(1)])
  expect(ats(await p.readLog())).toEqual([1])
  await p.appendLog([big(2)])
  expect(ats(await p.readLog())).toEqual([2]) // the older run went: the newest stays even when it alone is over
  expect(logKeys(w.store)).toHaveLength(1)
})

test('forget, flush, end and the legacy sweep leave every log key alone', async () => {
  const { w, p } = setup({ fake: { store: { 'v2:log': [entry(1)], index: ['old'] } } })
  await p.appendLog([entry(2)])
  await p.appendLog([entry(3)])
  const keys = logKeys(w.store).sort()
  expect(keys).toHaveLength(3)
  await p.flushNow()
  await p.forget('sess-1')
  await p.end('sess-1', 1000, PENDING)
  expect(await p.dropLegacy()).toBe(1)
  expect(logKeys(w.store).sort()).toEqual(keys)
  expect(ats(await p.readLog())).toEqual([3, 2, 1])
})

test('the size of the log keys counts against maxBytes, by the sizes in their names', async () => {
  const { w, p } = setup({
    fake: { store: { 'v2:index': ['old1'], 'v2:s:old1': copyOf(150) } },
    limits: { maxBytes: 500 },
    slots: [slot('items', ['x'.repeat(86)])],
  })
  await p.appendLog([big(1)]) // about 250 characters
  await p.flushNow()
  expect(w.store.get('v2:index')).toEqual(['sess-1']) // 100 + 150 + the log is over 500: the old copy goes
  expect(logKeys(w.store)).toHaveLength(1) // the log itself stays
})

test('in a fresh load a flush counts a run key by its name and reads no log key', async () => {
  const run = [big(1)]
  const name = KEYS.logRun(1, JSON.stringify(run).length, 'x-1')
  const seen = noCalls()
  const { w, p } = setup({
    fake: { store: { 'v2:index': ['old1'], 'v2:s:old1': copyOf(150), [name]: run as never } },
    limits: { maxBytes: 500 },
    slots: [slot('items', ['x'.repeat(86)])],
    store: real => spied(real, seen),
  })
  await p.flushNow() // this Persistence never appended: it knows the log only from the store
  expect(w.store.get('v2:index')).toEqual(['sess-1']) // the log took its room: the old copy went
  expect(w.store.has(name)).toBe(true)
  expect(seen.get.filter(k => k.startsWith('v2:log'))).toEqual([])
  expect(seen.keys).toBe(1) // one listing counts the whole log
})

test('session.end reads no log value and lists the keys once; the old v2:log is read once', async () => {
  const run = [big(1)]
  const name = KEYS.logRun(1, JSON.stringify(run).length, 'x-1')
  const seen = noCalls()
  const { w, p } = setup({
    fake: { store: { 'v2:index': ['old1'], 'v2:s:old1': copyOf(150), [name]: run as never, 'v2:log': [entry(0)] } },
    limits: { maxBytes: 600 },
    slots: [slot('items', ['x'.repeat(86)])],
    store: real => spied(real, seen),
  })
  await p.end('sess-1', 1000, PENDING)
  expect(w.store.has('v2:s:sess-1')).toBe(true) // the end wrote the copy, so it reached the size bound
  expect(w.store.get('v2:index')).toEqual(['sess-1']) // the log (a run key and the old key) took its room
  expect(seen.keys).toBe(1)
  expect(seen.get.filter(k => k.startsWith('v2:log'))).toEqual(['v2:log']) // the run key is counted by its name
})

test('a flush counts the log as nothing when the store cannot list its keys, and the copy is still written', async () => {
  const { w, p } = setup({
    store: real => ({
      ...real,
      keys: async () => {
        throw new Error('gone')
      },
    }),
  })
  await p.flushNow()
  expect(w.store.has('v2:s:sess-1')).toBe(true)
  expect(w.logs).toEqual(['store: list of v2:log keys failed: gone']) // counted as nothing, but not silent
})

test('a log key that cannot be read counts as nothing, the sizes already summed stay, and the line names the key', async () => {
  const run = [big(1)]
  const name = KEYS.logRun(1, JSON.stringify(run).length, 'x-1')
  const { w, p } = setup({
    fake: { store: { 'v2:index': ['old1'], 'v2:s:old1': copyOf(150), [name]: run as never, 'v2:log': [entry(0)] } },
    limits: { maxBytes: 500 },
    slots: [slot('items', ['x'.repeat(86)])],
    store: real => refusing(real, k => k === 'v2:log'),
  })
  await p.flushNow()
  expect(w.store.get('v2:index')).toEqual(['sess-1']) // the run key still took its room: the old copy went
  expect(w.logs).toEqual(['store: read of v2:log failed: timeout'])
})

test('a key of the old layout is read once per load, not at every flush', async () => {
  const items = slot('items', ['a'])
  const seen = noCalls()
  const { w, p } = setup({
    fake: { store: { 'v2:log': [entry(1)] } },
    slots: [items],
    store: real => spied(real, seen),
  })
  await p.flushNow()
  items.live = ['b'] // a different copy: the next flush writes again, and counts the log again
  await p.flushNow()
  items.live = ['c']
  await p.flushNow()
  expect(w.store.get('v2:s:sess-1')).toEqual({ items: ['c'] })
  expect(seen.get.filter(k => k.startsWith('v2:log'))).toEqual(['v2:log'])
})

test('a store with only the old v2:log reads, an append leaves the key as it is, and the merge is by time', async () => {
  const old = [entry(3), entry(1)]
  const { w, p } = setup({ fake: { store: { 'v2:log': old as never } } })
  expect(ats(await p.readLog())).toEqual([3, 1])
  await p.appendLog([entry(2)])
  expect(w.store.get('v2:log')).toEqual(old) // never rewritten by this build
  expect(logKeys(w.store)).toHaveLength(2)
  expect(ats(await p.readLog())).toEqual([3, 2, 1])
})

test('the old v2:log goes once none of its entries is among the newest 200, and not at 199 newer ones', async () => {
  const old = Array.from({ length: 200 }, (_, i) => entry(200 - i)) // at 200 down to 1
  const { w, p } = setup({ fake: { store: { 'v2:log': old as never } } })
  await p.appendLog(Array.from({ length: 199 }, (_, i) => entry(1001 + i)))
  expect(w.store.has('v2:log')).toBe(true) // its newest entry is the 200th of the log
  expect(ats(await p.readLog()).slice(-1)).toEqual([200])
  await p.appendLog([entry(1200)])
  expect(w.store.has('v2:log')).toBe(false)
  expect(ats(await p.readLog())).toHaveLength(200)
})

test('the old v2:log ranks by its newest entry: a full log keeps it, and --log shows its entry first', async () => {
  const seed: Record<string, Json> = { 'v2:log': [entry(5000)] }
  for (let i = 1000; i < 1200; i++) seed[KEYS.logRun(i, 87, 'x-1')] = [entry(i)]
  const { w, p } = setup({ fake: { store: seed } })
  expect(ats(await p.readLog())[0]).toBe(5000) // an old key that ranked last would be cut off by the 200 run keys
  await p.appendLog([entry(1300)])
  expect(w.store.has('v2:log')).toBe(true) // its entry is among the newest 200, so the prune keeps it
})

test('an old build that still writes v2:log does not push newer run keys out of the newest 200', async () => {
  const oldBuild = [entry(9000), ...Array.from({ length: 199 }, (_, i) => entry(199 - i))] // one new entry, 199 old ones
  const { w, p } = setup({ fake: { store: { 'v2:log': oldBuild as never } } })
  for (const n of [500, 600, 700]) await p.appendLog([entry(n)])
  expect(logKeys(w.store)).toHaveLength(4)
  expect(ats(await p.readLog()).slice(0, 4)).toEqual([9000, 700, 600, 500])
  // The old build adds a run after the new one wrote: its read-modify-write puts one more entry on top of v2:log.
  w.store.set('v2:log', [entry(9500), ...oldBuild])
  expect(ats(await p.readLog()).slice(0, 5)).toEqual([9500, 9000, 700, 600, 500])
})

test('the old v2:log goes when the budget is short, and the run that just wrote stays', async () => {
  const old = [entry(1, { id: `task:${'x'.repeat(600)}` })]
  const { w, p } = setup({ fake: { store: { 'v2:log': old as never } }, limits: { maxBytes: 1000 } })
  await p.appendLog([entry(5)]) // the old key is about 700 characters: over half of 1000 with the new run
  expect(w.store.has('v2:log')).toBe(false)
  expect(logKeys(w.store)).toHaveLength(1)
  expect(ats(await p.readLog())).toEqual([5])
})

test('a key that shares the time of the 200th entry and ranks after it goes at the prune', async () => {
  const seed: Record<string, Json> = {}
  for (let i = 2; i <= 200; i++) seed[KEYS.logRun(i, 87, 'x-1')] = [entry(i)]
  const tied = KEYS.logRun(2, 87, 'x-0') // the time of the 200th entry, and it ranks after the key at 2
  seed[tied] = [entry(2, { id: 'task:tie' })]
  const { w, p } = setup({ fake: { store: seed } })
  await p.appendLog([entry(300)])
  expect(w.store.has(tied)).toBe(false)
  expect(logKeys(w.store)).toHaveLength(200)
})

test('the log never holds more than half of maxBytes beside the run that just wrote, even when that run ranks after the others', async () => {
  const w = fakePorts()
  const half = JSON.stringify([big(5)]).length * 1.5 // one run fits, two do not
  const limits = { maxBytes: half * 2 }
  const b = another(w, 'sess-b', { limits })
  const a = another(w, 'sess-a', { limits })
  await b.appendLog([big(5)])
  await a.appendLog([big(5)]) // the same millisecond and size: the name ranks the key of A after the key of B
  const bytes = logKeys(w.store).reduce((n, k) => n + JSON.stringify(w.store.get(k)).length, 0)
  expect(bytes).toBeLessThanOrEqual(half)
  expect(logKeys(w.store).some(k => k.includes('sess-a-1'))).toBe(true) // the run that just wrote always stays
})

test('the fixture that the other tests read the log with orders the keys as readLog does, ties included', async () => {
  const seed: Record<string, Json> = {
    [KEYS.logRun(5, 87, 'a-1')]: [entry(5, { id: 'task:a1' })],
    [KEYS.logRun(5, 87, 'b-1')]: [entry(5, { id: 'task:b1' })], // the same time and counter: the name decides
    [KEYS.logRun(5, 87, 'a-2')]: [entry(5, { id: 'task:a2' })], // the same time, a later counter
    [KEYS.logRun(4, 87, 'a-9')]: [entry(4, { id: 'task:old' })],
    'v2:log': [entry(7, { id: 'task:legacy' }), entry(3, { id: 'task:legacy-old' })] as never,
  }
  const { w, p } = setup({ fake: { store: seed } })
  const read = (await p.readLog()).map(e => e.id)
  expect(read).toEqual(['task:legacy', 'task:a2', 'task:b1', 'task:a1', 'task:old', 'task:legacy-old'])
  expect(storedLog(w.store).map(e => e.id)).toEqual(read)
})

test('the size of the old v2:log counts too, before this load appended anything', async () => {
  const { w, p } = setup({
    fake: { store: { 'v2:index': ['old1'], 'v2:s:old1': copyOf(150), 'v2:log': [entry(1, { id: 'x'.repeat(250) })] } },
    limits: { maxBytes: 400 },
    slots: [slot('items', ['x'.repeat(86)])],
  })
  await p.flushNow()
  expect(w.store.get('v2:index')).toEqual(['sess-1'])
})
