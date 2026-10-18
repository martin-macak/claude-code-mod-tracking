// The tracker list: ids and orders are unique, no tracker takes the id of the item list, and every `store` serves its
// defaults with the tracker on. The OCP proof of the list: tests/tracker-host.test.ts runs a fake tracker with no edit
// to core. Tasks 9 to 12 add their trackers here; Task 12 adds the order check for all eight.
import { expect, test } from 'claude-code/testing'
import { buildTrackers } from '../trackers'
import { hostWorld } from './fixtures/tracker-host'

const list = buildTrackers({})

test('ids are unique and none is items', () => {
  const ids = list.map(t => t.id)
  expect(new Set(ids).size).toBe(ids.length)
  expect(ids).not.toContain('items')
})

test('order values are unique', () => {
  const orders = list.map(t => t.order)
  expect(new Set(orders).size).toBe(orders.length)
})

test('each store(ctx) equals its config.defaults and enabled is true', async () => {
  const t = hostWorld(list)
  await t.host.init()
  expect(t.host.failed()).toEqual([])
  for (const tracker of list) {
    expect(t.host.stored().get(tracker.id)).toEqual(tracker.config.defaults)
    expect((tracker.config.defaults as { enabled?: boolean }).enabled).toBe(true)
  }
})

test('each call builds new trackers, so per-load state is not shared', () => {
  expect(buildTrackers({})[0]).not.toBe(buildTrackers({})[0])
})
