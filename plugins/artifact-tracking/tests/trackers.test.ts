// The tracker list: ids and orders are unique, no tracker takes the id of the item list, and every `store` serves its
// defaults with the tracker on. The OCP proof of the list: tests/tracker-host.test.ts runs a fake tracker with no edit
// to core. The list holds all eight trackers, in the order of the pane.
import { expect, test } from 'claude-code/testing'
import { buildTrackers } from '../trackers'
import type { AutoGithub } from '../trackers/auto'
import { hostWorld } from './fixtures/tracker-host'

/** The PR lane's GitHub side, not ready: the list only needs the object to build the auto tracker. */
const autoGithub: AutoGithub = {
  discovery: {} as AutoGithub['discovery'],
  ready: async () => false,
  repo: async () => null,
  hosts: () => [],
}
const build = () => buildTrackers({ autoGithub })
const list = build()

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

test('eight trackers in order 10, 20, 30, 40, 50, 60, 70, 80: auto, jira, github, artifact, repos, web, file, processes', () => {
  expect([...list].sort((a, b) => a.order - b.order).map(t => [t.id, t.order])).toEqual([
    ['auto', 10],
    ['jira', 20],
    ['github', 30],
    ['artifact', 40],
    ['repos', 50],
    ['web', 60],
    ['file', 70],
    ['processes', 80],
  ])
  expect(list.find(t => t.id === 'auto')?.persist).toBe(false)
  // The github, jira and web trackers declare their identity and config only (plan decision D13): no events, no data.
  for (const id of ['github', 'jira', 'web']) {
    const t = list.find(x => x.id === id)
    expect(t?.events).toBeUndefined()
    expect(t?.data).toBeUndefined()
  }
})

test('each call builds new trackers, so per-load state is not shared', () => {
  expect(build()[0]).not.toBe(build()[0])
})
