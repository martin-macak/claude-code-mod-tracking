// The tracker list: ids and orders are unique, no tracker takes the id of the item list, and every `store` serves its
// defaults with the tracker on. The OCP proof of the list: tests/tracker-host.test.ts runs a fake tracker with no edit
// to core. The list holds all eight trackers, in the order of the pane.
import { expect, test } from 'claude-code/testing'
import { TRACKERS } from '../trackers'
import type { AutoState } from './fixtures/contracts'
import { porcelain as gitPorcelain } from './fixtures/git'
import { res, sleep } from './fixtures/items'
import { managerWorld } from './fixtures/manager'
import { hostWorld } from './fixtures/tracker-host'

const list = TRACKERS

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

test('trackers: eight trackers in order 10 … 80: auto, jira, github, artifact, repos, web, file, processes', () => {
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
  // The jira and web trackers declare their identity and config only (plan decision D13): no events, no data. The github
  // tracker runs the PR lane since plan L5, Task 12: it hears a fact and the commands, and keeps the lane state in a
  // run-scoped slot like auto.
  for (const id of ['jira', 'web']) {
    const t = list.find(x => x.id === id)
    expect(t?.events).toBeUndefined()
    expect(t?.data).toBeUndefined()
  }
  const github = list.find(x => x.id === 'github')
  expect(github?.persist).toBe(false)
  expect(Object.keys(github?.events?.facts ?? {})).toEqual(['auto.branches'])
})

test('the list is a constant: a second manager over it shares no per-load state', async () => {
  const ROOT = '/work'
  // Two managers over the same list, each with its own ports. A round runs `git worktree list` in the world it belongs to.
  const world = () =>
    managerWorld({
      fake: { now: 1_000_000, session: { cwd: ROOT } },
      run: async argv => {
        if (argv[0] !== 'git') return undefined
        return argv[1] === 'rev-parse' ? res(`${ROOT}\n`) : res(gitPorcelain(ROOT))
      },
    })
  const a = world()
  const b = world()
  for (const t of [a, b]) await t.m.start(t.w.ports, { cwd: ROOT, fromSessionStart: true })
  expect(a.m.facts).not.toBe(b.m.facts)
  const rounds = (t: typeof a) => t.w.calls.filter(c => c[0] === 'git' && c[1] === 'worktree').length
  const seq = (t: typeof a) => t.m.facts.read<{ seq: number }>('auto.branches')?.seq
  // Each tick runs the round of its own manager. A list that shared the round, the scheduler or the lane would run the
  // round of the first manager for both, in its world.
  await a.m.tick()
  await sleep(15)
  expect([rounds(a), rounds(b)]).toEqual([1, 0])
  expect([seq(a), seq(b)]).toEqual([1, 0])
  await b.m.tick()
  await sleep(15)
  expect([rounds(a), rounds(b)]).toEqual([1, 1])
  expect([seq(a), seq(b)]).toEqual([1, 1])
  expect((b.w.state.get('auto') as unknown as AutoState).snapshot).not.toBeNull()
  expect(b.w.stateSets.github).toBe(a.w.stateSets.github) // each lane wrote its own world, the same once
})
