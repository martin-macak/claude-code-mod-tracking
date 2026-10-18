// Kit tests of the lifecycle layer (L3): the v2 store layout, the session switch and `session.end`.
// New behavior goes in this file, so the older wiring tests keep their cases (spec 10, item 14).

import { expect, test } from 'claude-code/testing'
import { LIMITS } from '../hooks/contracts'
import {
  clearSession,
  fileTool,
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
