// viewInputs: the state and the facts the pane, the band and the `/track` text draw from. It only reads. Plan: L3 Task 12.
import { expect, test } from 'claude-code/testing'
import { Facts } from '../core/infra/facts'
import type { Json } from '../core/interfaces/items'
import { IDLE_ACLI, IDLE_GH, viewInputs } from '../hooks/view-inputs'
import type { ItemRecord, ProcessRecord, RepoRecord } from './fixtures/contracts'
import { fakePorts } from './fixtures/ports'

const WEB: ItemRecord = {
  key: 'web:https://docs.example/a',
  category: 'web',
  url: 'https://docs.example/a',
  label: 'docs.example/a',
  sources: ['prompt'],
  firstSeen: 1,
  lastSeen: 1,
  seenCount: 1,
}
const PROC: ProcessRecord = {
  id: 'p1',
  kind: 'background-task',
  name: 'sleep 9',
  state: 'running',
  firstSeen: 1,
  lastSeen: 1,
}
const REPO: RepoRecord = {
  key: 'remote:github.com/acme/sdk',
  name: 'acme/sdk',
  root: '/x/sdk',
  touchedBy: ['main'],
  firstSeen: 1,
  lastSeen: 1,
}

test('view inputs read the slots and the facts and never write', async () => {
  const w = fakePorts()
  w.state.set('items', [WEB] as unknown as Json)
  w.state.set('processes', [PROC] as unknown as Json)
  w.state.set('repos', [REPO] as unknown as Json)
  w.state.set('ui', { folded: ['gh:x'] })
  w.state.set('auto', { root: { cwd: '/work', at: 1 }, worktrees: [], agents: [], dismissed: [], snapshot: null })
  const facts = new Facts()
  facts.publish('processes.ui', { breaker: 'open', openUntil: 9 })
  facts.publish('session.repo', { host: 'github.com', owner: 'acme', repo: 'web' })
  facts.publish('auto.checkedAt', 77)
  const v = await viewInputs(w.ports, facts, { bodyColumns: 90 })
  expect(v.items).toEqual([WEB])
  expect(v.processes).toEqual([PROC])
  expect(v.repos).toEqual([REPO])
  expect(v.processUi).toEqual({ breaker: 'open', openUntil: 9 })
  expect(v.ctx.folded).toEqual(['gh:x'])
  expect(v.ctx.sessionRepo).toEqual({ host: 'github.com', owner: 'acme', repo: 'web' })
  expect(v.ctx.autoCheckedAt).toBe(77)
  expect(v.ctx.bodyColumns).toBe(90)
  expect(v.ctx.auto?.root).toEqual({ cwd: '/work', at: 1 })
  expect(typeof v.ctx.now).toBe('number')
  expect(w.stateSets).toEqual({}) // nothing was written
})

test('a world with no state reads as empty: an idle probe state, idle tools, an empty auto state', async () => {
  const w = fakePorts()
  const v = await viewInputs(w.ports, new Facts(), {})
  expect([v.items, v.processes, v.repos]).toEqual([[], [], []])
  expect(v.processUi).toEqual({ breaker: 'closed' })
  expect(v.ctx.tools).toEqual({ gh: IDLE_GH, acli: IDLE_ACLI })
  expect(v.ctx.auto).toEqual({ root: null, worktrees: [], agents: [], dismissed: [], snapshot: null })
  expect('autoCheckedAt' in v.ctx).toBe(false)
  expect('bodyColumns' in v.ctx).toBe(false)
  expect(v.ctx.sessionRepo).toBeUndefined()
})

test('the tools come from the tools atom; a tool it does not list reads as not probed', async () => {
  const w = fakePorts()
  w.state.set('tools', { gh: { name: 'gh', available: true, loggedIn: true, breaker: 'closed' } })
  const v = await viewInputs(w.ports, new Facts(), {})
  expect(v.ctx.tools.gh.available).toBe(true)
  expect(v.ctx.tools.acli).toEqual(IDLE_ACLI)
})
