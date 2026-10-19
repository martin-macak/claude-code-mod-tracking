// Kit tests of the lifecycle layer (L3): the v2 store layout, the session switch and `session.end`.
// New behavior goes in this file, so the older wiring tests keep their cases (spec 10, item 14).

import type { Engine } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'
import { LIMITS } from '../hooks/contracts'
import {
  clearSession,
  fileTool,
  PANE,
  quiet,
  readDone,
  response,
  SESSION,
  START,
  track,
  world,
  writeCreated,
} from './fixtures/world'

test('the first start deletes the s:* and index keys of the old layout', async ($, on) => {
  const { store } = world(on, {
    seed: { 's:old': { items: [] }, index: ['old'], 'v2:s:sess-1': { items: [] }, 'v2:index': ['sess-1'] },
  })
  await $.session.start(START)
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
  expect((await track($)).text).toBe('Files  1 files\n  a.md  created  viewed 2')
})

const GH5 = {
  key: 'gh:github.com/acme/web#5',
  category: 'github',
  url: 'https://github.com/acme/web/issues/5',
  label: 'acme/web#5',
  sources: ['prompt'],
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

test('the first pane focus after a /resume does not wait for the switch', async ($, on) => {
  // The switch loads the transcript, and the transcript names issue #5: one gh call that takes 600 ms.
  const w = world(on, {
    isolateState: true,
    ghDelayMs: 600,
    messages: [{ role: 'user', text: 'please look at issue #5', toolUses: [] }],
  })
  await $.session.append(response('https://alpha.example/')) // learns the id
  await quiet(w.calls)
  await clearSession($, w, 'sess-b', 'resume') // a /resume raises no row: the focus is the first hook
  const t0 = Date.now()
  await $.ui.focus(FOCUS)
  expect(Date.now() - t0).toBeLessThan(300) // the check runs, but the key does not wait for it
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
