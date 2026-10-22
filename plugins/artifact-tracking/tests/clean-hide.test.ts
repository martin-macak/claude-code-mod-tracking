// `/track clean --hide` hides every ended row now (issue #122). It sets `hidden.before` to the time of the command. A row
// that is over and ended at or before it leaves the view, whatever its TTL or `hideEnded`. A live row stays. `/track
// show-all` shows every row again. The rule is a view: the trackers read `before` and write nothing.
import { expect, test } from 'claude-code/testing'
import type { Json } from '../core/interfaces/items'
import type { HiddenState } from '../core/interfaces/view'
import type { AgentRow, WorktreeProof } from '../trackers/auto/types'
import { draw, find, flat, ids, MIN, noDockerIssue, proc, proof, setAgents, setProcesses } from './fixtures/hide-world'
import { NOW, paneWorld, WORLD_AUTO, WORLD_SNAPSHOT } from './fixtures/pane-world'

type World = Awaited<ReturnType<typeof paneWorld>>

const sweep = (t: World, h: Partial<HiddenState> = {}) =>
  t.w.state.set('hidden', { showAll: false, before: NOW, ...h } as unknown as Json)

// ---------------------------------------------------------------- agents

test('an ended agent is hidden by the sweep at once, though its TTL has not run, and a live one stays', async () => {
  const t = await paneWorld()
  setAgents(t, [proof('review', { endedAt: NOW - 1 * MIN })])
  expect(flat((await draw(t, 'agents')).rows)).toContain('ag:review') // young: shown
  sweep(t)
  const s = await draw(t, 'agents')
  expect(flat(s.rows)).toEqual(['ag:master', 'ag:explore', 'ag:build'])
  expect(s.note?.text).toBe('2 running · 2 ended (2 hidden)') // review, and lint with no proof: over before now
})

test('an agent that ended after the sweep shows, and an agent with no end time is over before it', async () => {
  const t = await paneWorld()
  setAgents(t, [proof('review', { endedAt: NOW + 1 })])
  sweep(t)
  expect(flat((await draw(t, 'agents')).rows)).toContain('ag:review')
  sweep(t, { before: NOW + 1 }) // endedAt equal to `before` is over
  expect(flat((await draw(t, 'agents')).rows)).not.toContain('ag:review')
})

test('the sweep hides a failed agent too, and never the master', async () => {
  const t = await paneWorld()
  setAgents(t, [proof('lint', { failed: true, endedAt: NOW - 2 * MIN }), proof('master', { endedAt: NOW - 99 * MIN })])
  sweep(t)
  const s = await draw(t, 'agents')
  expect(flat(s.rows)).not.toContain('ag:lint')
  expect(flat(s.rows)).toContain('ag:master')
})

test('the sweep keeps an ended parent of a live child, and hides both once the child is over', async () => {
  const t = await paneWorld()
  const [master, explore, review] = WORLD_SNAPSHOT.agents as [AgentRow, AgentRow, AgentRow]
  const old = { endedAt: NOW - 20 * MIN }
  setAgents(t, [proof('explore', old)], [master, { ...explore, state: 'ended' }, { ...review, state: 'running' }])
  sweep(t)
  expect(flat((await draw(t, 'agents')).rows)).toEqual(['ag:master', 'ag:explore', 'ag:review'])
  setAgents(
    t,
    [proof('explore', old), proof('review', old)],
    [master, { ...explore, state: 'ended' }, { ...review, state: 'ended' }],
  )
  expect(flat((await draw(t, 'agents')).rows)).toEqual(['ag:master'])
})

test('show-all overrides the sweep, and the sweep works with hideEnded false', async () => {
  const t = await paneWorld({ config: { auto: { hideEnded: false } } })
  setAgents(t, [proof('review', { endedAt: NOW - 1 * MIN })])
  expect(flat((await draw(t, 'agents')).rows)).toContain('ag:review')
  sweep(t)
  expect(flat((await draw(t, 'agents')).rows)).not.toContain('ag:review')
  sweep(t, { showAll: true })
  expect(flat((await draw(t, 'agents')).rows)).toContain('ag:review')
  sweep(t, { showAll: false }) // a second show-all hides them again: `before` stays until /clear
  expect(flat((await draw(t, 'agents')).rows)).not.toContain('ag:review')
})

// ---------------------------------------------------------------- processes

test('the sweep hides every ended process row and no live one, and the note and band count what is shown', async () => {
  const t = await paneWorld()
  noDockerIssue(t)
  setProcesses(t, [
    proc('run', 'running'),
    proc('up', 'up'),
    proc('sick', 'unhealthy'),
    proc('done', 'completed', { endedAt: NOW - 1 * MIN }),
    proc('bad', 'failed', { endedAt: NOW - 2 * MIN }),
    proc('dead', 'killed', { endedAt: NOW - 3 * MIN }),
    proc('left', 'exited', { endedAt: NOW - 4 * MIN }),
    proc('lost', 'unknown', { endedAt: NOW - 5 * MIN }),
    proc('undated', 'completed'),
  ])
  sweep(t)
  const s = await draw(t, 'processes')
  expect(ids(s)).toEqual(['run', 'up', 'sick'])
  expect(s.note?.text).toBe('3 tracked (6 hidden)')
  expect(s.band).toEqual({ label: 'Processes', count: 3, failing: 1, rank: 10 }) // unhealthy is a failure token
})

test('a process row that ended after the sweep shows; show-all shows every row; hideEnded false does not stop the sweep', async () => {
  const t = await paneWorld({ config: { processes: { hideEnded: false } } })
  noDockerIssue(t)
  setProcesses(t, [proc('late', 'completed', { endedAt: NOW + 5 }), proc('early', 'completed', { endedAt: NOW - 5 })])
  sweep(t)
  expect(ids(await draw(t, 'processes'))).toEqual(['late'])
  sweep(t, { showAll: true })
  expect(ids(await draw(t, 'processes'))).toEqual(['late', 'early'])
})

// ---------------------------------------------------------------- worktrees

const removedProof = (f: Partial<WorktreeProof> = {}): WorktreeProof => ({
  path: '/work/old-wt',
  origin: 'agent',
  provenAt: 1,
  removedAt: NOW - 1 * MIN,
  ...f,
})

test('the sweep hides a removed worktree row at once and keeps a live one', async () => {
  const t = await paneWorld()
  t.w.state.set('auto', { ...WORLD_AUTO, worktrees: [removedProof()] } as unknown as Json)
  expect(flat((await draw(t, 'worktrees')).rows)).toContain('wt:/work/old-wt') // removed 1 min ago: shown
  sweep(t)
  const s = await draw(t, 'worktrees')
  expect(flat(s.rows)).not.toContain('wt:/work/old-wt')
  expect(flat(s.rows)).toContain('wt:/work/feat-x')
  expect(s.note?.text).toContain('(1 hidden)')
  sweep(t, { showAll: true })
  expect(flat((await draw(t, 'worktrees')).rows)).toContain('wt:/work/old-wt')
})

test('a worktree removed after the sweep shows, and a live row has no dim', async () => {
  const t = await paneWorld()
  t.w.state.set('auto', { ...WORLD_AUTO, worktrees: [removedProof({ removedAt: NOW + 1 })] } as unknown as Json)
  sweep(t)
  const s = await draw(t, 'worktrees')
  expect(find(s.rows, 'wt:/work/old-wt')?.dim).toBe(true)
  expect(find(s.rows, 'wt:/work/feat-x')?.dim).toBeUndefined()
})
