// Kit tests of the lifecycle layer (L3): the v2 store layout and, in later tasks, the session switch and `session.end`.
// New behavior goes in this file, so the older wiring tests keep their cases (spec 10, item 14).

import { expect, test } from 'claude-code/testing'
import { LIMITS } from '../hooks/contracts'
import { quiet, response, SESSION, START, world } from './fixtures/world'

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
