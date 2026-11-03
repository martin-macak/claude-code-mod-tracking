// Kit tests of the lifecycle layer (L3): the v2 store layout, the session switch and `session.end`.
// New behavior goes in this file, so the older wiring tests keep their cases (spec 10, item 14).

import type { Engine } from 'claude-code/testing'
import { expect } from 'claude-code/testing'
import { test } from './fixtures/kit'
import { LIMITS } from './fixtures/limits'
import { reasonsOfSources } from './fixtures/reasons'
import {
  clearSession,
  fileTool,
  PANE,
  quiet,
  readDone,
  response,
  SESSION,
  START,
  spin,
  startSettled,
  track,
  until,
  world,
  writeCreated,
} from './fixtures/world'

test('the first start deletes the s:* and index keys of the old layout', async ($, on) => {
  const { store } = world(on, {
    seed: { 's:old': { items: [] }, index: ['old'], 'v2:s:sess-1': { items: [] }, 'v2:index': ['sess-1'] },
  })
  await startSettled($)
  expect(store.has('s:old')).toBe(false)
  expect(store.has('index')).toBe(false)
  expect(store.has('v2:s:sess-1')).toBe(true)
  expect(store.get('v2:index')).toEqual(['sess-1'])
})

test('a second start of the same load does not sweep the store again', async ($, on) => {
  const { store } = world(on)
  await $.session.start(START)
  store.set('s:late', { items: [] }) // a key of the old layout that appears after the sweep
  await $.session.start(START)
  expect(store.has('s:late')).toBe(true)
})

test('a flush writes v2:s:<id> and v2:index', async ($, on) => {
  const { clock, calls, store } = world(on)
  await $.session.append(response('https://one.example/'))
  expect(store.size).toBe(0)
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  expect(store.get('v2:index')).toEqual([SESSION])
  expect((store.get(`v2:s:${SESSION}`) as { items: unknown[] }).items.length).toBe(1)
  expect([...store.keys()].sort()).toEqual(['v2:index', `v2:s:${SESSION}`]) // no key of the old layout
})

test('a resume switch to an id with no stored copy starts empty (/branch)', async ($, on) => {
  const w = world(on, { isolateState: true })
  await $.session.append(response('https://one.example/'))
  expect((await track($)).text).toContain('one.example')
  await clearSession($, w, 'sess-new', 'resume') // the engine cannot tell /branch from /resume; nothing is stored for the id
  expect((await track($)).text).toBe('No tracked items yet.')
})

test('session.end writes the pending copy before next', async ($, on) => {
  const { clock, calls, store, fake } = world(on)
  await $.session.append(response('https://one.example/'))
  expect(store.has(`v2:s:${SESSION}`)).toBe(false) // the flush is still 1.5 s away
  await $.session.end({ reason: 'prompt_input_exit', sessionId: SESSION } as never)
  expect((store.get(`v2:s:${SESSION}`) as { items: unknown[] }).items.length).toBe(1)
  const sets = fake.storeSets
  await clock.advance(LIMITS.flushMs + 10)
  await quiet(calls)
  expect(fake.storeSets).toBe(sets) // the end cancelled the timer
})

test('two tool calls at once right after /clear both land on the carried row', async ($, on) => {
  const w = world(on, { isolateState: true })
  await $.session.start(START)
  await fileTool($, w.fake, 'Write', writeCreated('/work/a.md'))
  await clearSession($, w, 'sess-2', 'clear', { row: false }) // no row: the first hook of the new session is a Read
  await Promise.all([
    fileTool($, w.fake, 'Read', readDone('/work/a.md')),
    fileTool($, w.fake, 'Read', readDone('/work/a.md')),
  ])
  expect((await track($)).text).toBe('Files  1 files\n  a.md  docs  created  viewed 2')
})

const GH5 = {
  key: 'gh:github.com/acme/web#5',
  category: 'github',
  url: 'https://github.com/acme/web/issues/5',
  label: 'acme/web#5',
  sources: ['prompt'],
  reasons: reasonsOfSources(['prompt']),
  firstSeen: 2,
  lastSeen: 2,
  seenCount: 1,
  host: 'github.com',
  owner: 'acme',
  repo: 'web',
  number: 5,
  type: 'issue',
  title: 'Web five',
  state: 'open',
}

type PaneUi = { find(q: unknown): Promise<unknown>; unmount(): Promise<void> }
const mountPane = ($: Engine) => $.ui.mount({ ...PANE, surface: 'terminal' } as never) as unknown as Promise<PaneUi>

test('a /resume that loads a stored copy keeps the session repo it looked up', async ($, on) => {
  const w = world(on, { isolateState: true, seed: { 'v2:index': ['sess-b'], 'v2:s:sess-b': { items: [GH5] } } })
  await $.session.append(response('https://alpha.example/')) // learns the id
  await quiet(w.calls)
  await clearSession($, w, 'sess-b', 'resume')
  // A Write is the first hook of the resumed session and runs the switch. Nothing after it asks for the repo.
  await fileTool($, w.fake, 'Write', writeCreated('/work/docs/a.md'))
  await quiet(w.calls)
  const ui = await mountPane($)
  expect(await ui.find({ text: 'Web five' })).toBeDefined()
  expect(await ui.find({ text: 'acme/web#5' })).toBeUndefined() // the long key means the repo is forgotten
  await ui.unmount()
})

const FOCUS = {
  component: 'Pane',
  requestId: 'track',
  plugin: 'artifact-tracking',
  element: 'nothing-drawn',
  origin: { kind: 'person' },
} as never

// The switch loads the transcript, and the transcript names issue #5: one gh call. The test holds that call open, so it
// checks an order, not a time. The key must return while the call is open. A key that waits for it only returns when the
// hook times out (about 10 s), and the #5 below stays unresolved. The 30 s hang guard of `test` (fixtures/kit.ts) keeps
// that inside the limit of the test. Like the `session.start` test in register.test.tsx, it is no speed guard.
test('the first pane focus after a /resume does not wait for the switch', async ($, on) => {
  const w = world(on, {
    isolateState: true,
    messages: [{ role: 'user', text: 'please look at issue #5', toolUses: [] }],
  })
  await $.session.append(response('https://alpha.example/')) // learns the id
  await quiet(w.calls)
  await clearSession($, w, 'sess-b', 'resume') // a /resume raises no row: the focus is the first hook
  let release = () => {}
  w.fake.ghHold = new Promise<void>(resolve => {
    release = resolve
  })
  try {
    await $.ui.focus(FOCUS) // returns while the gh call is held: only the release below can end it
  } finally {
    release()
    w.fake.ghHold = undefined
  }
  expect((await track($)).text).toContain('#5') // /track waits for the switch the focus started
  await quiet(w.calls)
})

test('a tool no tracker declared passes straight through and starts nothing', async ($, on) => {
  const w = world(on)
  w.fake.tools.mcp__demo__ping = { ok: true }
  await $.tool.call({ tool: 'mcp__demo__ping' } as never)
  await quiet(w.calls)
  expect(w.calls).toEqual([]) // no gh or acli probe: the manager did not start for it
  await fileTool($, w.fake, 'Write', writeCreated('/work/a.md')) // a declared tool starts it
  await quiet(w.calls)
  expect(w.calls.length).toBeGreaterThan(0)
})

// The start sequence stays open until the test lets it go, and the tests wait on the hold itself, not on a clock: they
// check the order (issue #360). `session.start` must return while the sequence is open, and the sequence must still
// finish after.
test('session.start returns before the start sequence settles', async ($, on) => {
  let release = () => {}
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  const { store, fake, calls } = world(on)
  store.set('s:old', { items: [] }) // the legacy sweep is a step of the sequence
  fake.storeHold = held
  let returned = false
  const started = $.session.start(START).then(() => {
    returned = true
  })
  try {
    await until(() => fake.storeHoldHits > 0, 'the start sequence to reach the hold')
    await spin(() => returned)
    expect(returned).toBe(true) // the hook did not wait for it
    expect(store.has('s:old')).toBe(true) // the sequence did not reach the sweep yet
  } finally {
    release()
  }
  await started
  await quiet(calls)
  expect(store.has('s:old')).toBe(false) // the sequence ran to its end after the return
})

/**
 * Dispatches /track while the start is held and returns once the plugin has handled a later request. That request
 * (a tool no tracker declared) passes straight through and never waits for the start, so it is the in-order proof that
 * the command was dispatched. `fake.order` then shows what the command did while the start was held: nothing.
 */
async function trackWhileHeld($: Engine, fake: { order: string[]; tools: Record<string, unknown> }) {
  fake.tools.mcp__demo__ping = { ok: true }
  fake.order.length = 0
  const pending = track($)
  await $.tool.call({ tool: 'mcp__demo__ping' } as never)
  expect(fake.order).not.toContain('session.id') // the command did not pass the start wait: its first read comes after it
  fake.order.push('released')
  return { pending }
}

const readsAfterRelease = (order: string[]) => order.indexOf('session.id') > order.indexOf('released')

test('a command that follows session.start waits for the start sequence', async ($, on) => {
  let release = () => {}
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  const { store, fake } = world(on)
  store.set('s:old', { items: [] })
  fake.storeHold = held
  try {
    await $.session.start(START)
    await until(() => fake.storeHoldHits > 0, 'the start sequence to reach the hold')
    const { pending } = await trackWhileHeld($, fake) // /track waits for the in-flight start
    release()
    await pending
    expect(readsAfterRelease(fake.order)).toBe(true)
    expect(fake.order.indexOf('store.delete')).toBeLessThan(fake.order.indexOf('session.id')) // after the sweep
    expect(store.has('s:old')).toBe(false)
  } finally {
    release()
  }
})

const KEPT_WEB = {
  key: 'web:https://kept.test/x',
  category: 'web',
  url: 'https://kept.test/x',
  label: 'Kept late',
  sources: ['response'],
  reasons: reasonsOfSources(['response']),
  firstSeen: 1,
  lastSeen: 1,
  seenCount: 1,
}

// D5: a hot reload delivers `session.start` after a lazy start. The run it makes is the new flight, so a later entry
// waits for it, and the stored session of the run is there when the entry runs.
test('an entry after a late session.start waits for the run that start makes', async ($, on) => {
  let release = () => {}
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  const { fake } = world(on, {
    seed: { 'v2:index': [SESSION], ['v2:s:' + SESSION]: { items: [KEPT_WEB] } },
  })
  const lazy = await track($) // a lazy start: it loads no stored session
  expect(lazy.text).not.toContain('Kept late')
  fake.storeHold = held // the run of the late session.start only
  try {
    await $.session.start(START)
    await until(() => fake.storeHoldHits > 0, 'the start sequence to reach the hold')
    const { pending } = await trackWhileHeld($, fake) // it waits for the replaced flight
    release()
    expect((await pending).text).toContain('Kept late') // the session of the late start is loaded
    expect(readsAfterRelease(fake.order)).toBe(true)
  } finally {
    release()
  }
})

// `soft` wraps the detached register and start, so a refusal never escapes as an unhandled rejection (the test file
// would fail if it did).
test('a refused command does not stop the start sequence', async ($, on) => {
  const { store } = world(on, { denyRegister: true })
  store.set('s:old', { items: [] })
  await $.session.start(START) // resolves although the register is refused
  await track($) // waits for the start sequence
  expect(store.has('s:old')).toBe(false) // the sequence ran to its end
})
