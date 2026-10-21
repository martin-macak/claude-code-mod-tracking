// Ended rows leave the pane after a TTL (issue #49, PR 1). The agents and the process rows hide once they ended longer
// ago than their TTL. The notes and the band count what is shown. `/track show-all` brings the hidden rows back until
// /clear. All of it is a view: no slot, no store and no config write. The clock is the world's: NOW.
import { expect, test } from 'claude-code/testing'
import { ConfigManager } from '../core/infra/config-manager'
import { listGroups } from '../core/lib/grouping'
import { type PaneHost, PaneSession } from '../hooks/pane-session'
import { TRACKERS } from '../trackers'
import { AUTO_DEFAULTS } from '../trackers/auto/config'
import type { AgentRow } from '../trackers/auto/types'
import { PROCESSES_DEFAULTS } from '../trackers/processes/config'
import { ENDED_STATES, FAILED_STATES } from '../trackers/processes/states'
import { handleOf } from '../ux/tree-data-table/table'
import { fakeConfig, fakeConfigFs } from './fixtures/config-fs'
import { buttonOf, handlesOf, nodes } from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { draw, find, flat, ids, MIN, noDockerIssue, proc, proof, setAgents, setProcesses } from './fixtures/hide-world'
import { managerWorld } from './fixtures/manager'
import { NOW, paneWorld, WORLD_PROCESSES, WORLD_SNAPSHOT } from './fixtures/pane-world'

// ---------------------------------------------------------------- agents

test('an agent that ended 11 min ago is absent and the Agents note ends with (1 hidden)', async () => {
  const t = await paneWorld()
  setAgents(t, [proof('review', { endedAt: NOW - 11 * MIN })])
  const s = await draw(t, 'agents')
  expect(flat(s.rows)).toEqual(['ag:master', 'ag:explore', 'ag:build', 'ag:lint'])
  expect(s.note?.text).toBe('2 running · 2 ended (1 hidden)')
})

test('an agent that ended 9 min ago shows, dimmed, and the note has no hidden count', async () => {
  const t = await paneWorld()
  setAgents(t, [proof('review', { endedAt: NOW - 9 * MIN })])
  const s = await draw(t, 'agents')
  expect(find(s.rows, 'ag:review')?.dim).toBe(true)
  expect(s.note?.text).toBe('2 running · 2 ended')
})

test('the TTL counts from the end: an agent that ended exactly endedTtlMs ago is hidden', async () => {
  const t = await paneWorld()
  setAgents(t, [proof('review', { endedAt: NOW - 10 * MIN })])
  expect(flat((await draw(t, 'agents')).rows)).not.toContain('ag:review')
  setAgents(t, [proof('review', { endedAt: NOW - 10 * MIN + 1 })])
  expect(flat((await draw(t, 'agents')).rows)).toContain('ag:review')
})

test('a failed agent follows failedTtlMs: shown after 11 min, hidden after 61', async () => {
  const t = await paneWorld()
  setAgents(t, [proof('lint', { failed: true, endedAt: NOW - 11 * MIN })])
  const shown = await draw(t, 'agents')
  expect(find(shown.rows, 'ag:lint')?.dim).toBe(true)
  expect(shown.note?.text).toBe('2 running · 2 ended')
  setAgents(t, [proof('lint', { failed: true, endedAt: NOW - 61 * MIN })])
  const gone = await draw(t, 'agents')
  expect(flat(gone.rows)).not.toContain('ag:lint')
  expect(gone.note?.text).toBe('2 running · 2 ended (1 hidden)')
})

test('hideEnded false: every ended agent shows and the note reads as before', async () => {
  const t = await paneWorld({ config: { auto: { hideEnded: false } } })
  setAgents(t, [
    proof('review', { endedAt: NOW - 11 * MIN }),
    proof('lint', { failed: true, endedAt: NOW - 600 * MIN }),
  ])
  const s = await draw(t, 'agents')
  expect(flat(s.rows)).toEqual(['ag:master', 'ag:explore', 'ag:review', 'ag:build', 'ag:lint'])
  expect(s.note?.text).toBe('2 running · 2 ended')
})

test('the TTLs come from the trackers.auto slice, in ms; 0 hides an ended agent at once', async () => {
  const t = await paneWorld({ config: { auto: { endedTtlMs: 1000, failedTtlMs: 5000 } } })
  setAgents(t, [proof('review', { endedAt: NOW - 1500 }), proof('lint', { failed: true, endedAt: NOW - 4000 })])
  expect(flat((await draw(t, 'agents')).rows)).toEqual(['ag:master', 'ag:explore', 'ag:build', 'ag:lint'])
  const now = await paneWorld({ config: { auto: { endedTtlMs: 0 } } })
  setAgents(now, [proof('review', { endedAt: NOW })])
  expect(flat((await draw(now, 'agents')).rows)).not.toContain('ag:review')
})

test('a row with no proof or no endedAt never hides, and the master never hides', async () => {
  const t = await paneWorld()
  setAgents(t, [proof('review', {}), proof('master', { endedAt: NOW - 999 * MIN })])
  const s = await draw(t, 'agents')
  expect(flat(s.rows)).toEqual(['ag:master', 'ag:explore', 'ag:review', 'ag:build', 'ag:lint']) // `lint` has no proof
})

test('an ended parent with a live child stays; when the child hides too, both go', async () => {
  const t = await paneWorld()
  const [master, explore, review] = WORLD_SNAPSHOT.agents as [AgentRow, AgentRow, AgentRow]
  const old = NOW - 20 * MIN
  setAgents(
    t,
    [proof('explore', { endedAt: old })],
    [master, { ...explore, state: 'ended' }, { ...review, state: 'running' }],
  )
  const kept = await draw(t, 'agents')
  expect(flat(kept.rows)).toEqual(['ag:master', 'ag:explore', 'ag:review'])
  expect(find(kept.rows, 'ag:explore')?.dim).toBe(true)
  expect(kept.note?.text).toBe('1 running · 1 ended')
  setAgents(
    t,
    [proof('explore', { endedAt: old }), proof('review', { endedAt: old })],
    [master, { ...explore, state: 'ended' }, { ...review, state: 'ended' }],
  )
  const gone = await draw(t, 'agents')
  expect(flat(gone.rows)).toEqual(['ag:master'])
  expect(gone.note?.text).toBe('2 ended (2 hidden)')
})

test('the agents band counts running agents only, hidden or not', async () => {
  const t = await paneWorld()
  setAgents(t, [proof('review', { endedAt: NOW - 11 * MIN })])
  expect((await draw(t, 'agents')).band).toEqual({ label: 'Agents', count: 2, failing: 0, rank: 8 })
})

// ---------------------------------------------------------------- processes

test('the ended states are completed, failed, killed, exited and unknown, and failed and killed are the failures', () => {
  expect([...ENDED_STATES].sort()).toEqual(['completed', 'exited', 'failed', 'killed', 'unknown'])
  expect([...FAILED_STATES].sort()).toEqual(['failed', 'killed'])
})

test('a row in an ended state hides once its endedAt is older than its TTL, whichever the state', async () => {
  const t = await paneWorld()
  for (const state of ENDED_STATES) {
    const age = FAILED_STATES.has(state) ? 61 : 31
    setProcesses(t, [proc('keep', 'running'), proc(`gone:${state}`, state, { endedAt: NOW - age * MIN })])
    expect(ids(await draw(t, 'processes'))).toEqual(['keep'])
  }
})

test('a state that is not an end never hides, whatever its endedAt', async () => {
  const t = await paneWorld()
  const rows = (['running', 'up', 'unhealthy'] as const).map(s => proc(s, s, { endedAt: NOW - 999 * MIN }))
  setProcesses(t, rows)
  expect(ids(await draw(t, 'processes'))).toEqual(['running', 'up', 'unhealthy'])
})

test('completed, exited and unknown follow endedTtlMs; failed and killed follow failedTtlMs', async () => {
  const t = await paneWorld()
  const at = (min: number) => NOW - min * MIN
  const rows = (min: number) =>
    (['completed', 'exited', 'unknown', 'failed', 'killed'] as const).map(s => proc(s, s, { endedAt: at(min) }))
  setProcesses(t, rows(29))
  expect(ids(await draw(t, 'processes'))).toEqual(['completed', 'exited', 'unknown', 'failed', 'killed'])
  setProcesses(t, rows(31))
  expect(ids(await draw(t, 'processes'))).toEqual(['failed', 'killed'])
  setProcesses(t, rows(61))
  expect(ids(await draw(t, 'processes'))).toEqual([])
})

test('the process TTLs come from the trackers.processes slice, in ms', async () => {
  const t = await paneWorld({ config: { processes: { endedTtlMs: 60000, failedTtlMs: 120000 } } })
  setProcesses(t, [
    proc('a', 'completed', { endedAt: NOW - 90000 }),
    proc('b', 'failed', { endedAt: NOW - 90000 }),
    proc('c', 'failed', { endedAt: NOW - 130000 }),
  ])
  expect(ids(await draw(t, 'processes'))).toEqual(['b'])
})

test('the note reads N tracked (k hidden) over the shown rows, and the band does not count a hidden row', async () => {
  const t = await paneWorld()
  noDockerIssue(t)
  setProcesses(t, [
    ...WORLD_PROCESSES, // running, up, and a failed one with no endedAt
    proc('old-a', 'completed', { endedAt: NOW - 31 * MIN }),
    proc('old-b', 'exited', { endedAt: NOW - 40 * MIN }),
  ])
  const s = await draw(t, 'processes')
  expect(ids(s)).toEqual(['bg:1', 'docker:db', 'pid:77'])
  expect(s.note?.text).toBe('3 tracked (2 hidden)')
  expect(s.band).toEqual({ label: 'Processes', count: 3, failing: 1, rank: 10 })
})

test('a failing row that is hidden is not in the band failing count', async () => {
  const t = await paneWorld()
  setProcesses(t, [proc('up', 'up'), proc('bad', 'failed', { endedAt: NOW - 61 * MIN })])
  expect((await draw(t, 'processes')).band).toEqual({ label: 'Processes', count: 1, failing: 0, rank: 10 })
})

test('the docker issue stays the note, with the hidden count after it', async () => {
  const t = await paneWorld()
  setProcesses(t, [...WORLD_PROCESSES, proc('old', 'completed', { endedAt: NOW - 31 * MIN })])
  expect((await draw(t, 'processes')).note?.text).toBe('docker: daemon not running (1 hidden)')
})

test('hideEnded false: every process row shows and the note and band read as before', async () => {
  const t = await paneWorld({ config: { processes: { hideEnded: false } } })
  noDockerIssue(t)
  setProcesses(t, [...WORLD_PROCESSES, proc('old', 'completed', { endedAt: NOW - 999 * MIN })])
  const s = await draw(t, 'processes')
  expect(ids(s)).toEqual(['bg:1', 'docker:db', 'pid:77', 'old'])
  expect(s.note?.text).toBe('4 tracked')
  expect(s.band).toEqual({ label: 'Processes', count: 4, failing: 1, rank: 10 })
})

test('an ended row with no endedAt shows: a row the mod cannot date is never hidden', async () => {
  const t = await paneWorld()
  setProcesses(t, [proc('undated', 'completed')])
  expect(ids(await draw(t, 'processes'))).toEqual(['undated'])
})

test('when every row is hidden the section stays, so its note can tell', async () => {
  const t = await paneWorld()
  noDockerIssue(t)
  setProcesses(t, [
    proc('a', 'completed', { endedAt: NOW - 31 * MIN }),
    proc('b', 'killed', { endedAt: NOW - 61 * MIN }),
  ])
  const s = await draw(t, 'processes')
  expect(s.rows).toEqual([])
  expect(s.note?.text).toBe('0 tracked (2 hidden)')
  expect(s.band?.count).toBe(0)
})

// ---------------------------------------------------------------- /track show-all

/** A world with one hidden agent and two hidden process rows, named so the text can find them. */
async function hiddenWorld() {
  const t = await paneWorld()
  noDockerIssue(t)
  setAgents(t, [proof('review', { endedAt: NOW - 11 * MIN })])
  setProcesses(t, [
    proc('bg:live', 'running', { name: 'npm run dev' }),
    proc('bg:done', 'completed', { name: 'make old-build', endedAt: NOW - 31 * MIN }),
    proc('bg:bad', 'failed', { name: 'make old-test', endedAt: NOW - 61 * MIN }),
  ])
  return t
}

test('/track show-all shows the hidden rows in the pane and in the text; a second one hides them again', async () => {
  const t = await hiddenWorld()
  const track = (args: string) => t.m.track(t.w.ports, args)
  expect((await track('')).text).not.toContain('old-build')
  expect(flat((await draw(t, 'agents')).rows)).not.toContain('ag:review')

  const on = await track('show-all')
  expect(on.text).toContain('Showing all rows.')
  expect(on.text).toContain('old-build')
  expect(on.text).toContain('old-test')
  expect(on.text).toContain('review')
  expect(ids(await draw(t, 'processes'))).toEqual(['bg:live', 'bg:done', 'bg:bad'])
  expect(flat((await draw(t, 'agents')).rows)).toContain('ag:review')
  expect((await draw(t, 'processes')).note?.text).toBe('3 tracked')
  expect((await draw(t, 'agents')).note?.text).toBe('2 running · 2 ended')

  const off = await track('show-all')
  expect(off.text).toContain('Hiding ended rows again.')
  expect(off.text).not.toContain('old-build')
  expect(ids(await draw(t, 'processes'))).toEqual(['bg:live'])
  expect((await draw(t, 'processes')).note?.text).toBe('1 tracked (2 hidden)')
})

test('show-all also brings the hidden rows into the band count', async () => {
  const t = await hiddenWorld()
  const band = async () => (await t.m.bandData(t.w.ports)).find(s => s.id === 'processes')?.band?.count
  expect(await band()).toBe(1)
  await t.m.track(t.w.ports, 'show-all')
  expect(await band()).toBe(3)
})

test('show-all lives in the session atom `hidden`, writes no config and no store key, and redraws the pane once', async () => {
  const t = await hiddenWorld()
  await t.m.track(t.w.ports, '') // the first /track makes the first store write: let it happen
  await t.w.clock.advance(5000)
  const files = { ...t.w.files }
  const sets = t.w.storeSets
  const drawn = t.w.ui.invalidated
  await t.m.track(t.w.ports, 'show-all')
  expect(t.w.state.get('hidden')).toEqual({ showAll: true })
  expect(t.w.ui.invalidated - drawn).toBe(1)
  await t.m.track(t.w.ports, 'show-all')
  expect(t.w.state.get('hidden')).toEqual({ showAll: false })
  await t.w.clock.advance(5000) // past the flush delay of the stored copy
  expect(t.w.files).toEqual(files)
  expect(t.w.storeSets).toBe(sets)
})

test('show-all answers the same with the arguments in other case or with spaces around', async () => {
  const t = await hiddenWorld()
  expect((await t.m.track(t.w.ports, '  Show-All ')).text).toContain('Showing all rows.')
})

test('a hidden atom that was never written reads as showAll false', async () => {
  const t = await hiddenWorld()
  await t.m.track(t.w.ports, 'show-all')
  t.w.state.delete('hidden') // what the engine does to `$.state` at /clear
  expect(ids(await draw(t, 'processes'))).toEqual(['bg:live'])
})

// ---------------------------------------------------------------- the tick

test('with no event, a clock that passes a TTL moves a row out of the view with no write; each beat redraws (A22)', async () => {
  const t = await paneWorld()
  noDockerIssue(t)
  setAgents(t, [proof('review', { endedAt: NOW - 9 * MIN })])
  setProcesses(t, [proc('bg:live', 'running'), proc('bg:done', 'completed', { endedAt: NOW - 29 * MIN })])
  await t.m.entry(t.w.ports) // arms the tick
  await t.w.clock.advance(30000) // the first beat may settle the round
  expect(flat((await draw(t, 'agents')).rows)).toContain('ag:review')
  expect(ids(await draw(t, 'processes'))).toEqual(['bg:live', 'bg:done'])
  t.w.stateSets = {}
  const drawn = t.w.ui.invalidated
  await t.w.clock.advance(30000 * 4) // 2 min: both rows are past their TTL now
  expect(t.w.ui.invalidated - drawn).toBe(4)
  expect(t.w.stateSets.auto).toBeUndefined()
  expect(t.w.stateSets.processes).toBeUndefined()
  expect(flat((await draw(t, 'agents')).rows)).not.toContain('ag:review')
  expect(ids(await draw(t, 'processes'))).toEqual(['bg:live'])
})

// Other work in the world writes the store during these beats (the first copy of the session, the item refresh), so the
// proof is a control: the same beats with hiding off write the same number of times. A TTL that passes adds no store write.
test('a clock that passes a TTL adds no store write: the same beats write as often with hiding off', async () => {
  const beats = async (hideEnded: boolean) => {
    const t = await paneWorld({ config: { auto: { hideEnded }, processes: { hideEnded } } })
    noDockerIssue(t)
    setAgents(t, [proof('review', { endedAt: NOW - 9 * MIN })])
    setProcesses(t, [proc('bg:live', 'running'), proc('bg:done', 'completed', { endedAt: NOW - 29 * MIN })])
    await t.m.entry(t.w.ports)
    await t.w.clock.advance(30000)
    const sets = t.w.storeSets
    await t.w.clock.advance(30000 * 4) // both rows pass their TTL in this window
    return { writes: t.w.storeSets - sets, shown: ids(await draw(t, 'processes')) }
  }
  const hiding = await beats(true)
  const control = await beats(false)
  expect(hiding.shown).toEqual(['bg:live']) // the rows did leave
  expect(control.shown).toEqual(['bg:live', 'bg:done'])
  expect(hiding.writes).toBe(control.writes)
})

// A row can leave with no input from the person, so the row they selected may be the one that goes. The `selected` atom
// keeps the id, and a render must not write it. The pane draws, rings and acts on the row the selection falls to: the next
// row of the last drawing (issue #49, PR 2; PR 1 left the ring on the first row and the keys of the row off).
test('the selected row hides: the ring and the keys fall to the next row, and the atom is not written', async () => {
  const t = await paneWorld()
  setAgents(t, [proof('review', { endedAt: NOW - 9 * MIN })])
  t.w.state.set('expanded', ['ag:explore']) // `ag:review` is a child of `ag:explore`: open it so the row is drawn
  t.w.state.set('selected', 'ag:review')
  const session = new PaneSession()
  const host: PaneHost = t.m
  const drawPane = () => session.draw(t.w.ports, host, EL, { bodyColumns: 120 })
  const ring = (tree: unknown) =>
    nodes(tree, 'Button')
      .filter(b => b.props.autoFocus === true)
      .map(b => b.props.key)

  const before = await drawPane() // 9 min after the end: the row shows, dimmed, and holds the ring and the keys
  expect(find((await draw(t, 'agents')).rows, 'ag:review')?.dim).toBe(true)
  expect(buttonOf(before, 'dismiss').props.dimColor).toBeUndefined()

  t.w.clock.now = NOW + 2 * MIN // 11 min after the end: past the TTL, with no key pressed
  expect(flat((await draw(t, 'agents')).rows)).not.toContain('ag:review')
  t.w.stateSets = {}
  const after = await drawPane()
  const open = new Set(['ag:explore'])
  const groups = listGroups(await t.m.paneData(t.w.ports, { selected: null, expanded: open }))
  const build = handleOf(groups, { expanded: open, shown: () => 0, limits: t.m.config.global().ui }, 'ag:build')
  expect(build).toBeDefined()
  expect(ring(after)).toEqual([build]) // `ag:build` followed `ag:review` in the last drawing
  expect(handlesOf(after)[0]).not.toBe(build) // not the first row, as in PR 1
  expect(buttonOf(after, 'dismiss').props.dimColor).toBeUndefined() // x works: it acts on `ag:build`
  expect(t.w.state.get('selected')).toBe('ag:review') // a render writes nothing
  expect(t.w.stateSets).toEqual({})
})

// ---------------------------------------------------------------- the keys

test('the defaults are the owner’s: hiding on, agents 10 and 60 min, process rows 30 and 60 min', () => {
  const pick = (d: { hideEnded: boolean; endedTtlMs: number; failedTtlMs: number }) => ({
    hideEnded: d.hideEnded,
    endedTtlMs: d.endedTtlMs,
    failedTtlMs: d.failedTtlMs,
  })
  expect(pick(AUTO_DEFAULTS)).toEqual({ hideEnded: true, endedTtlMs: 10 * MIN, failedTtlMs: 60 * MIN })
  expect(pick(PROCESSES_DEFAULTS)).toEqual({ hideEnded: true, endedTtlMs: 30 * MIN, failedTtlMs: 60 * MIN })
})

test('a TTL outside 0 to 24 h is clamped, one that is not a number keeps the default, and each says so once', () => {
  const cfg = fakeConfig({
    specs: TRACKERS,
    file: { trackers: { auto: { endedTtlMs: -1, failedTtlMs: 'soon' }, processes: { endedTtlMs: 86400001 } } },
  })
  expect(cfg.slice('auto').endedTtlMs).toBe(0)
  expect(cfg.slice('auto').failedTtlMs).toBe(AUTO_DEFAULTS.failedTtlMs)
  expect(cfg.slice('processes').endedTtlMs).toBe(86400000)
  expect(cfg.problems()).toHaveLength(3)
})

test('with no config file the first start writes the new keys once, with the defaults', async () => {
  const file = fakeConfigFs()
  const env = { get: async (name: string) => (name === 'HOME' ? '/h' : undefined) }
  const t = managerWorld({
    config: specs => new ConfigManager({ fs: file.fs, env: env as never, specs, log: () => {} }),
  })
  await t.m.ensureStarted(t.w.ports)
  expect(file.writes).toHaveLength(1)
  const written = JSON.parse(file.writes[0]?.text ?? '{}') as { trackers: Record<string, Record<string, unknown>> }
  expect(written.trackers.auto).toMatchObject({ hideEnded: true, endedTtlMs: 600000, failedTtlMs: 3600000 })
  expect(written.trackers.processes).toMatchObject({ hideEnded: true, endedTtlMs: 1800000, failedTtlMs: 3600000 })
})
