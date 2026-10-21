// Issue #49, PR 2: a removed worktree row hides after a TTL, a finished workflow run is one row, a long process name
// shows from `./`, and the process rows have a cap. Like PR 1, all of it is a view of the state: the sections read
// and write nothing. The clock is the world's: NOW.
import { expect, test } from 'claude-code/testing'
import { ConfigManager } from '../core/infra/config-manager'
import { NO_VIEW } from '../core/infra/views'
import type { Json } from '../core/interfaces/items'
import type { SectionSpec, TreeRow } from '../core/interfaces/view'
import { listGroups } from '../core/lib/grouping'
import { type PaneHost, PaneSession } from '../hooks/pane-session'
import { TRACKERS } from '../trackers'
import { AUTO_DEFAULTS } from '../trackers/auto/config'
import { autoIds } from '../trackers/auto/dismiss'
import { shortRunId, workflowRowId } from '../trackers/auto/ids'
import type { AgentProof, AgentRow, AutoState, WorktreeProof } from '../trackers/auto/types'
import { PROCESSES_DEFAULTS } from '../trackers/processes/config'
import type { ProcessRecord } from '../trackers/processes/types'
import { handleOf, layout } from '../ux/tree-data-table/table'
import { fakeConfig, fakeConfigFs } from './fixtures/config-fs'
import { buttonOf, nodes } from './fixtures/drawn'
import { EL } from './fixtures/elements'
import {
  draw,
  find,
  flat,
  ids,
  MIN,
  noDockerIssue,
  proc,
  proof,
  setAgents,
  setProcesses,
  type World,
} from './fixtures/hide-world'
import { managerWorld } from './fixtures/manager'
import { NOW, paneWorld, WORLD_AUTO, WORLD_SNAPSHOT } from './fixtures/pane-world'

// ---------------------------------------------------------------- the keys

test('the defaults are the owner’s: removed worktrees hide after 10 min, workflow runs fold, 200 process rows', () => {
  expect(AUTO_DEFAULTS.removedTtlMs).toBe(10 * MIN)
  expect(AUTO_DEFAULTS.foldWorkflows).toBe(true)
  expect(PROCESSES_DEFAULTS.maxRows).toBe(200)
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
  expect(written.trackers.auto).toMatchObject({ removedTtlMs: 600000, foldWorkflows: true })
  expect(written.trackers.processes).toMatchObject({ maxRows: 200 })
})

test('a value outside the bounds is clamped with one problem each, and a word where a switch belongs keeps the default', () => {
  const cfg = fakeConfig({
    specs: TRACKERS,
    file: { trackers: { auto: { removedTtlMs: 86400001, foldWorkflows: 'yes' }, processes: { maxRows: 5 } } },
  })
  expect(cfg.slice('auto').removedTtlMs).toBe(86400000)
  expect(cfg.slice('auto').foldWorkflows).toBe(AUTO_DEFAULTS.foldWorkflows)
  expect(cfg.slice('processes').maxRows).toBe(20)
  expect(cfg.problems()).toHaveLength(3)
})

// ---------------------------------------------------------------- removed worktrees

/** The world's removed child is `wt:/work/old-wt`. A proof with this path dates it. */
const oldWt = (f: Partial<WorktreeProof> = {}): WorktreeProof => ({
  path: '/work/old-wt',
  origin: 'agent',
  provenAt: 1,
  ...f,
})
const setProofs = (t: World, worktrees: WorktreeProof[]) =>
  t.w.state.set('auto', { ...WORLD_AUTO, worktrees } as unknown as Json)

test('a removed worktree row that was removed 11 min ago is absent, and the note ends with (1 hidden)', async () => {
  const t = await paneWorld()
  setProofs(t, [oldWt({ removedAt: NOW - 11 * MIN })])
  const s = await draw(t, 'worktrees')
  expect(flat(s.rows)).toEqual(['wt:/work', 'wt:/work/feat-x', 'wt:/work/detached-wt'])
  expect(s.note?.text).toBe('git · 2 live · 1 removed · checked 30s ago (1 hidden)')
})

test('a removed worktree row that was removed 9 min ago shows, dimmed, with no hidden count', async () => {
  const t = await paneWorld()
  setProofs(t, [oldWt({ removedAt: NOW - 9 * MIN })])
  const s = await draw(t, 'worktrees')
  expect(find(s.rows, 'wt:/work/old-wt')?.dim).toBe(true)
  expect(s.note?.text).toBe('git · 2 live · 1 removed · checked 30s ago')
})

test('the TTL counts from the removal: exactly removedTtlMs ago hides', async () => {
  const t = await paneWorld()
  setProofs(t, [oldWt({ removedAt: NOW - 10 * MIN })])
  expect(flat((await draw(t, 'worktrees')).rows)).not.toContain('wt:/work/old-wt')
  setProofs(t, [oldWt({ removedAt: NOW - 10 * MIN + 1 })])
  expect(flat((await draw(t, 'worktrees')).rows)).toContain('wt:/work/old-wt')
})

test('a removed row with no proof or no removedAt never hides, and the live rows never hide', async () => {
  const t = await paneWorld()
  const all = ['wt:/work', 'wt:/work/feat-x', 'wt:/work/old-wt', 'wt:/work/detached-wt']
  expect(flat((await draw(t, 'worktrees')).rows)).toEqual(all) // the world has no proof at all
  setProofs(t, [oldWt()])
  expect(flat((await draw(t, 'worktrees')).rows)).toEqual(all)
  setProofs(t, [
    oldWt({ removedAt: NOW - 999 * MIN }),
    { path: '/work/feat-x', origin: 'agent', provenAt: 1, removedAt: NOW - 999 * MIN }, // a live row ignores it
  ])
  expect(flat((await draw(t, 'worktrees')).rows)).toEqual(all.filter(id => id !== 'wt:/work/old-wt'))
})

test('hideEnded false: a removed worktree row shows however long ago it was removed', async () => {
  const t = await paneWorld({ config: { auto: { hideEnded: false } } })
  setProofs(t, [oldWt({ removedAt: NOW - 999 * MIN })])
  const s = await draw(t, 'worktrees')
  expect(flat(s.rows)).toContain('wt:/work/old-wt')
  expect(s.note?.text).toBe('git · 2 live · 1 removed · checked 30s ago')
})

test('removedTtlMs comes from the trackers.auto slice, in ms; 0 hides a removed row at once', async () => {
  const t = await paneWorld({ config: { auto: { removedTtlMs: 1000 } } })
  setProofs(t, [oldWt({ removedAt: NOW - 1500 })])
  expect(flat((await draw(t, 'worktrees')).rows)).not.toContain('wt:/work/old-wt')
  setProofs(t, [oldWt({ removedAt: NOW - 500 })])
  expect(flat((await draw(t, 'worktrees')).rows)).toContain('wt:/work/old-wt')
  const now = await paneWorld({ config: { auto: { removedTtlMs: 0 } } })
  setProofs(now, [oldWt({ removedAt: NOW })])
  expect(flat((await draw(now, 'worktrees')).rows)).not.toContain('wt:/work/old-wt')
})

test('the worktrees band counts the live children, hidden removed rows or not', async () => {
  const t = await paneWorld()
  setProofs(t, [oldWt({ removedAt: NOW - 11 * MIN })])
  expect((await draw(t, 'worktrees')).band).toEqual({ label: 'Worktrees', count: 2, failing: 0, rank: 7 })
})

test('/track show-all brings a hidden removed worktree row back, a second one hides it again', async () => {
  const t = await paneWorld()
  setProofs(t, [oldWt({ removedAt: NOW - 11 * MIN })])
  expect((await t.m.track(t.w.ports, '')).text).not.toContain('old-wt')
  const on = await t.m.track(t.w.ports, 'show-all')
  expect(on.text).toContain('old-wt')
  const shown = await draw(t, 'worktrees')
  expect(flat(shown.rows)).toContain('wt:/work/old-wt')
  expect(shown.note?.text).toBe('git · 2 live · 1 removed · checked 30s ago')
  await t.m.track(t.w.ports, 'show-all')
  expect(flat((await draw(t, 'worktrees')).rows)).not.toContain('wt:/work/old-wt')
})

test('the git failure note keeps the hidden count', async () => {
  const t = await paneWorld()
  setProofs(t, [oldWt({ removedAt: NOW - 11 * MIN })])
  const auto = t.w.state.get('auto') as unknown as AutoState
  const git = { ok: false, at: NOW, error: 'not a repo' }
  t.w.state.set('auto', { ...auto, snapshot: { ...auto.snapshot, git } } as unknown as Json)
  expect((await draw(t, 'worktrees')).note?.text).toBe('git failed: not a repo (1 hidden)')
})

// ---------------------------------------------------------------- workflow runs

const RUN = 'wf_a35565d1-fd4'
const RUN_B = 'wf_b12345ee-9c1'
const master = (): AgentRow => WORLD_SNAPSHOT.agents[0] as AgentRow

/** A workflow agent row: ended unless the fields say more. `ag:<id>`, depth 1, under the master. */
const wfRow = (id: string, index: number, f: Partial<AgentRow> = {}, runId = RUN): AgentRow => ({
  id: `ag:${id}`,
  kind: 'workflow',
  label: id,
  depth: 1,
  worktreeLive: true,
  state: 'ended',
  workflow: { runId, agentIndex: index },
  ...f,
})
const wfProof = (id: string, index: number, f: Partial<AgentProof> = {}, runId = RUN): AgentProof =>
  proof(id, { kind: 'workflow', workflow: { runId, agentIndex: index }, ...f })
const plain = (id: string, f: Partial<AgentRow> = {}): AgentRow => ({
  id: `ag:${id}`,
  kind: 'subagent',
  label: id,
  depth: 1,
  worktreeLive: true,
  state: 'running',
  ...f,
})
/** The ids a closed fold row shows: the rows of the section depth first, but nothing below a fold row. */
const shown = (rows: readonly TreeRow[]): string[] =>
  rows.flatMap(r => (r.id.startsWith('ag:wf:') ? [r.id] : [r.id, ...shown(r.children ?? [])]))
/** The fold row of a run, or undefined. */
const foldOf = (s: SectionSpec, runId = RUN) => find(s.rows, `ag:wf:${runId}`)

/** A run of three agents that all ended 20 min ago, one of them failed: a fold, past the 10 min TTL but not the 60. */
async function finishedRun() {
  const t = await paneWorld()
  const old = NOW - 20 * MIN
  setAgents(
    t,
    [
      wfProof('w1', 1, { endedAt: old }),
      wfProof('w2', 2, { endedAt: old }),
      wfProof('w3', 3, { endedAt: old, failed: true }),
    ],
    [master(), wfRow('w1', 1), wfRow('w2', 2), wfRow('w3', 3, { state: 'failed' })],
  )
  return t
}

test('a run whose agents all ended is one row ag:wf:<runId> with the short run id, the agent count and the failed count', async () => {
  const t = await finishedRun()
  const s = await draw(t, 'agents')
  expect(shown(s.rows)).toEqual(['ag:master', `ag:wf:${RUN}`])
  const fold = foldOf(s) as TreeRow
  expect(fold.cells.name?.text).toBe('✗ wf_a35565')
  expect(fold.cells.description?.text).toBe('3 agents · 1 failed')
  expect((fold.children ?? []).map(c => c.id)).toEqual(['ag:w1', 'ag:w2', 'ag:w3'])
})

test('the fold row has no failure marker when no agent failed, says 1 agent, and counts 0 failed', async () => {
  const t = await paneWorld()
  setAgents(t, [wfProof('w1', 1, { endedAt: NOW })], [master(), wfRow('w1', 1)])
  const fold = foldOf(await draw(t, 'agents')) as TreeRow
  expect(fold.cells.name?.text).toBe('✓ wf_a35565')
  expect(fold.cells.description?.text).toBe('1 agent · 0 failed')
})

test('the fold row is closed, dim, and cannot be dismissed or marked; the agent rows below it can be dismissed', async () => {
  const fold = foldOf(await draw(await finishedRun(), 'agents')) as TreeRow
  expect(fold.expandedByDefault).toBeUndefined()
  expect(fold.dim).toBe(true)
  expect(fold.can).toEqual({ dismiss: false, priority: false })
  expect(fold.owner).toBe('auto')
  expect(fold.children?.[0]?.can).toEqual({ dismiss: true, priority: false })
})

test('Enter opens the fold row, and the closed row draws no agent rows', async () => {
  const t = await finishedRun()
  const groups = listGroups(await t.m.paneData(t.w.ports, NO_VIEW))
  const view = { shown: () => 0, limits: t.m.config.global().ui }
  const drawn = (expanded: string[]) =>
    layout(groups, { ...view, expanded: new Set(expanded) }).flatMap(s => s.rows.map(r => r.row.id))
  expect(drawn([])).toContain(`ag:wf:${RUN}`)
  expect(drawn([])).not.toContain('ag:w1')
  expect(drawn([`ag:wf:${RUN}`])).toEqual(expect.arrayContaining([`ag:wf:${RUN}`, 'ag:w1', 'ag:w2', 'ag:w3']))
})

test('x is dim on the fold row: the dismiss Button of a drawn pane with it selected is off', async () => {
  const drawPane = async (t: World) => {
    const host: PaneHost = t.m
    return new PaneSession().draw(t.w.ports, host, EL, { bodyColumns: 120 })
  }
  const folded = await finishedRun()
  folded.w.state.set('selected', `ag:wf:${RUN}`)
  expect(buttonOf(await drawPane(folded), 'dismiss').props.dimColor).toBe(true)
  const loose = await paneWorld()
  setAgents(loose, [], [master(), plain('loose')])
  loose.w.state.set('selected', 'ag:loose')
  expect(buttonOf(await drawPane(loose), 'dismiss').props.dimColor).toBeUndefined() // an agent row: x works
})

test('/track clear leaves the fold row alone: its id is not in the dismissable ids', async () => {
  const t = await finishedRun()
  const auto = t.w.state.get('auto') as unknown as AutoState
  expect(autoIds(auto, []).filter(id => id.startsWith('ag:'))).toEqual(['ag:w1', 'ag:w2', 'ag:w3'])
})

test('each agent label carries the short run id, so wf·1 of one run is not the wf·1 of another', async () => {
  const t = await paneWorld()
  setAgents(
    t,
    [wfProof('a1', 1, { endedAt: NOW }), wfProof('b1', 1, { endedAt: NOW }, RUN_B)],
    [master(), wfRow('a1', 1), wfRow('b1', 1, {}, RUN_B)],
  )
  const s = await draw(t, 'agents')
  expect(shown(s.rows)).toEqual(['ag:master', `ag:wf:${RUN}`, `ag:wf:${RUN_B}`])
  expect(find(s.rows, 'ag:a1')?.cells.name?.text).toBe('✓ wf_a35565·1 a1')
  expect(find(s.rows, 'ag:b1')?.cells.name?.text).toBe('✓ wf_b12345·1 b1')
})

test('a run with one live agent does not fold, and its agents still say the run id', async () => {
  const t = await paneWorld()
  setAgents(
    t,
    [wfProof('w1', 1, { endedAt: NOW }), wfProof('w2', 2)],
    [master(), wfRow('w1', 1), wfRow('w2', 2, { state: 'running' })],
  )
  const s = await draw(t, 'agents')
  expect(shown(s.rows)).toEqual(['ag:master', 'ag:w1', 'ag:w2'])
  expect(find(s.rows, 'ag:w2')?.cells.name?.text).toBe('● wf_a35565·2 w2')
})

test('a waiting agent counts as live: the run does not fold', async () => {
  const t = await paneWorld()
  setAgents(t, [], [master(), wfRow('w1', 1), wfRow('w2', 2, { state: 'waiting' })])
  expect(foldOf(await draw(t, 'agents'))).toBeUndefined()
})

test('an agent below a workflow agent that is still live keeps the whole run unfolded', async () => {
  const t = await paneWorld()
  setAgents(t, [], [master(), wfRow('w1', 1), plain('child', { depth: 2, state: 'running' }), wfRow('w2', 2)])
  expect(foldOf(await draw(t, 'agents'))).toBeUndefined()
})

test('foldWorkflows false: a finished run shows every agent row, with the run id in the labels', async () => {
  const t = await paneWorld({ config: { auto: { foldWorkflows: false } } })
  setAgents(
    t,
    [wfProof('w1', 1, { endedAt: NOW }), wfProof('w2', 2, { endedAt: NOW })],
    [master(), wfRow('w1', 1), wfRow('w2', 2)],
  )
  const s = await draw(t, 'agents')
  expect(shown(s.rows)).toEqual(['ag:master', 'ag:w1', 'ag:w2'])
  expect(find(s.rows, 'ag:w1')?.cells.name?.text).toBe('✓ wf_a35565·1 w1')
})

test('the fold row sits where the first agent of the run was, and an agent of no run stays out of it', async () => {
  const t = await paneWorld()
  setAgents(
    t,
    [],
    [master(), plain('before'), wfRow('w1', 1), plain('between', { state: 'ended' }), wfRow('w2', 2), plain('after')],
  )
  const s = await draw(t, 'agents')
  expect(shown(s.rows)).toEqual(['ag:master', 'ag:before', `ag:wf:${RUN}`, 'ag:between', 'ag:after'])
  expect((foldOf(s)?.children ?? []).map(c => c.id)).toEqual(['ag:w1', 'ag:w2'])
})

test('the agents of one run below different parents still make one fold row, so no row id repeats', async () => {
  const t = await paneWorld()
  setAgents(
    t,
    [],
    [
      master(),
      plain('p1', { state: 'ended' }),
      wfRow('w1', 1, { depth: 2 }),
      plain('p2', { state: 'ended' }),
      wfRow('w2', 2, { depth: 2 }),
    ],
  )
  const s = await draw(t, 'agents')
  const all = flat(s.rows)
  expect(all.filter(id => id === `ag:wf:${RUN}`)).toHaveLength(1)
  expect(new Set(all).size).toBe(all.length)
  expect((foldOf(s)?.children ?? []).map(c => c.id)).toEqual(['ag:w1', 'ag:w2'])
  expect(shown(s.rows)).toEqual(['ag:master', 'ag:p1', `ag:wf:${RUN}`, 'ag:p2'])
})

test('the fold does not change the note: it still counts every ended agent, and the band counts the running ones', async () => {
  const t = await finishedRun()
  const s = await draw(t, 'agents')
  expect(s.note?.text).toBe('3 ended')
  expect(s.band).toEqual({ label: 'Agents', count: 0, failing: 0, rank: 8 })
})

// A run folds as a unit: it leaves the view when every agent of it is past its own TTL, and then the hidden count counts
// every one of them. Until then it keeps all its agents, so its counts and its children agree.
test('a folded run hides as a unit: shown while one agent is inside its TTL, then every agent counts as hidden', async () => {
  const t = await finishedRun() // two ended 20 min ago (TTL 10 min) and one failed 20 min ago (TTL 60 min)
  const before = await draw(t, 'agents')
  expect(foldOf(before)?.children).toHaveLength(3)
  expect(before.note?.text).toBe('3 ended') // nothing left the view
  t.w.clock.now = NOW + 41 * MIN // the failed one is now 61 min past its end
  const gone = await draw(t, 'agents')
  expect(shown(gone.rows)).toEqual(['ag:master'])
  expect(gone.note?.text).toBe('3 ended (3 hidden)')
})

test('a folded run of ended agents only hides once all of them are past the TTL', async () => {
  const t = await paneWorld()
  setAgents(
    t,
    [wfProof('w1', 1, { endedAt: NOW - 20 * MIN }), wfProof('w2', 2, { endedAt: NOW - 5 * MIN })],
    [master(), wfRow('w1', 1), wfRow('w2', 2)],
  )
  expect(foldOf(await draw(t, 'agents'))?.children).toHaveLength(2) // w1 alone is past 10 min, w2 is not
  t.w.clock.now = NOW + 6 * MIN
  const s = await draw(t, 'agents')
  expect(shown(s.rows)).toEqual(['ag:master'])
  expect(s.note?.text).toBe('2 ended (2 hidden)')
})

test('a folded run with a young child below one of its agents stays whole until the child is past its TTL', async () => {
  const t = await paneWorld()
  const old = NOW - 20 * MIN
  setAgents(
    t,
    [wfProof('w1', 1, { endedAt: old }), proof('c1', { endedAt: NOW - 5 * MIN }), wfProof('w2', 2, { endedAt: old })],
    [master(), wfRow('w1', 1), plain('c1', { depth: 2, state: 'ended' }), wfRow('w2', 2)],
  )
  // `w1` and `w2` are past 10 min, the child of `w1` is not: the fold row, its count and its children still agree.
  const before = await draw(t, 'agents')
  expect(foldOf(before)?.cells.description?.text).toBe('2 agents · 0 failed')
  expect((foldOf(before)?.children ?? []).map(c => c.id)).toEqual(['ag:w1', 'ag:w2'])
  expect(flat(foldOf(before)?.children ?? [])).toEqual(['ag:w1', 'ag:c1', 'ag:w2'])
  expect(before.note?.text).toBe('3 ended') // nothing left the view
  t.w.clock.now = NOW + 6 * MIN // the child is 11 min past its end now
  const gone = await draw(t, 'agents')
  expect(shown(gone.rows)).toEqual(['ag:master'])
  expect(gone.note?.text).toBe('3 ended (3 hidden)')
})

test('hideEnded false keeps a folded run for ever, show-all keeps it too, and an agent with no endedAt keeps it', async () => {
  const off = await paneWorld({ config: { auto: { hideEnded: false } } })
  setAgents(off, [wfProof('w1', 1, { endedAt: NOW - 999 * MIN })], [master(), wfRow('w1', 1)])
  expect(foldOf(await draw(off, 'agents'))).toBeDefined()
  const t = await paneWorld()
  setAgents(t, [wfProof('w1', 1, { endedAt: NOW - 999 * MIN })], [master(), wfRow('w1', 1)])
  expect(foldOf(await draw(t, 'agents'))).toBeUndefined()
  await t.m.track(t.w.ports, 'show-all')
  expect(foldOf(await draw(t, 'agents'))).toBeDefined()
  const undated = await paneWorld()
  setAgents(undated, [wfProof('w1', 1)], [master(), wfRow('w1', 1)])
  expect(foldOf(await draw(undated, 'agents'))).toBeDefined()
})

test('the /track text prints the fold row and every agent below it, so the text does not fold', async () => {
  const t = await finishedRun()
  const text = (await t.m.track(t.w.ports, '')).text
  expect(text).toContain('wf_a35565')
  expect(text).toContain('3 agents · 1 failed')
  for (const label of ['wf_a35565·1 w1', 'wf_a35565·2 w2', 'wf_a35565·3 w3']) expect(text).toContain(label)
})

test('the run id is short: wf_ and six characters, whatever the shape of the id', () => {
  expect(shortRunId('wf_a35565d1-fd4')).toBe('wf_a35565')
  expect(shortRunId('wf_x')).toBe('wf_x')
  expect(shortRunId('a35565d1-fd4')).toBe('wf_a35565')
  expect(workflowRowId('wf_a35565d1-fd4')).toBe('ag:wf:wf_a35565d1-fd4')
})

// ---------------------------------------------------------------- the process row cap

/** `n` rows with ids `<prefix>0` to `<prefix>n-1`. Each starts a second after the one before. */
const many = (
  n: number,
  prefix: string,
  state: ProcessRecord['state'],
  f: (i: number) => Partial<ProcessRecord> = () => ({}),
) => Array.from({ length: n }, (_, i) => proc(`${prefix}${i}`, state, { firstSeen: 1000 + i * 1000, ...f(i) }))
const capWorld = (maxRows = 20, extra: Record<string, Json> = {}) =>
  paneWorld({ config: { processes: { maxRows, ...extra } } })

test('past maxRows the oldest ended rows leave the view first, and the note counts them as hidden', async () => {
  const t = await capWorld()
  noDockerIssue(t)
  // 25 rows that ended within the TTL, the first one the oldest, and one running row.
  setProcesses(t, [
    proc('live', 'running', { firstSeen: 1 }),
    ...many(25, 'done', 'completed', i => ({ endedAt: NOW - (30 - i) * 1000 })),
  ])
  const s = await draw(t, 'processes')
  expect(s.rows).toHaveLength(20)
  expect(ids(s)[0]).toBe('live')
  expect(ids(s).slice(1)).toEqual(Array.from({ length: 19 }, (_, i) => `done${i + 6}`)) // done0 to done5 left
  expect(s.note?.text).toBe('20 tracked (6 hidden)')
  expect(s.band?.count).toBe(20)
})

test('a live row is never capped away, even when the live rows alone pass maxRows', async () => {
  const t = await capWorld()
  noDockerIssue(t)
  setProcesses(t, [...many(25, 'run', 'running'), ...many(3, 'up', 'up')])
  const s = await draw(t, 'processes')
  expect(s.rows).toHaveLength(28)
  expect(s.note?.text).toBe('28 tracked')
})

test('live rows count against the cap: 22 live rows leave room for none of the 5 ended ones', async () => {
  const t = await capWorld()
  noDockerIssue(t)
  setProcesses(t, [...many(22, 'run', 'running'), ...many(5, 'done', 'completed', i => ({ endedAt: NOW - i * 1000 }))])
  const s = await draw(t, 'processes')
  expect(ids(s).every(id => id.startsWith('run'))).toBe(true)
  expect(s.rows).toHaveLength(22)
  expect(s.note?.text).toBe('22 tracked (5 hidden)')
})

test('the oldest end goes first, not the oldest start: the order is endedAt', async () => {
  const t = await capWorld()
  noDockerIssue(t)
  // `late` started first and ended last. `early` started last and ended first. One row too many: `early` goes.
  setProcesses(t, [
    proc('late', 'completed', { firstSeen: 1, endedAt: NOW - 1000 }),
    ...many(19, 'mid', 'completed', i => ({ endedAt: NOW - 5000 + i })),
    proc('early', 'completed', { firstSeen: 99_999, endedAt: NOW - 20_000 }),
  ])
  const s = await draw(t, 'processes')
  expect(ids(s)).toContain('late')
  expect(ids(s)).not.toContain('early')
  expect(s.note?.text).toBe('20 tracked (1 hidden)')
})

test('an ended row with no endedAt goes by its first sighting, and a failed row goes like the others', async () => {
  const t = await capWorld()
  noDockerIssue(t)
  setProcesses(t, [
    proc('undated', 'completed', { firstSeen: 1 }),
    proc('failed', 'failed', { firstSeen: 2, endedAt: NOW - 1000 }),
    ...many(19, 'mid', 'completed', i => ({ endedAt: NOW - 5000 + i })),
  ])
  const s = await draw(t, 'processes')
  expect(ids(s)).not.toContain('undated')
  expect(ids(s)).toContain('failed')
})

test('the TTL hides first, and the cap counts what is left: both go into one hidden count', async () => {
  const t = await capWorld()
  noDockerIssue(t)
  setProcesses(t, [
    ...many(3, 'old', 'completed', () => ({ endedAt: NOW - 40 * MIN })), // past 30 min: hidden by the TTL
    ...many(22, 'new', 'completed', i => ({ endedAt: NOW - 1000 + i })),
  ])
  const s = await draw(t, 'processes')
  expect(s.rows).toHaveLength(20)
  expect(s.note?.text).toBe('20 tracked (5 hidden)') // 3 by the TTL, 2 by the cap
})

test('at maxRows exactly nothing is capped, and the default cap is 200 rows', async () => {
  const exact = await capWorld()
  noDockerIssue(exact)
  setProcesses(
    exact,
    many(20, 'done', 'completed', () => ({ endedAt: NOW })),
  )
  expect((await draw(exact, 'processes')).rows).toHaveLength(20)
  const t = await paneWorld()
  noDockerIssue(t)
  setProcesses(
    t,
    many(201, 'done', 'completed', () => ({ endedAt: NOW })),
  )
  const s = await draw(t, 'processes')
  expect(s.rows).toHaveLength(200)
  expect(s.note?.text).toBe('200 tracked (1 hidden)')
})

test('hideEnded false and /track show-all show every row, whatever the cap', async () => {
  const off = await capWorld(20, { hideEnded: false })
  noDockerIssue(off)
  setProcesses(
    off,
    many(25, 'done', 'completed', () => ({ endedAt: NOW })),
  )
  expect((await draw(off, 'processes')).rows).toHaveLength(25)
  const t = await capWorld()
  noDockerIssue(t)
  setProcesses(
    t,
    many(25, 'done', 'completed', () => ({ endedAt: NOW })),
  )
  expect((await draw(t, 'processes')).rows).toHaveLength(20)
  await t.m.track(t.w.ports, 'show-all')
  const all = await draw(t, 'processes')
  expect(all.rows).toHaveLength(25)
  expect(all.note?.text).toBe('25 tracked')
})

test('the cap is a view: the slot keeps every row and nothing is written', async () => {
  const t = await capWorld()
  noDockerIssue(t)
  setProcesses(
    t,
    many(25, 'done', 'completed', () => ({ endedAt: NOW })),
  )
  t.w.stateSets = {}
  await draw(t, 'processes')
  expect(t.w.state.get('processes') as unknown as ProcessRecord[]).toHaveLength(25)
  expect(t.w.stateSets.processes).toBeUndefined()
})

// ---------------------------------------------------------------- the selection follows a row that hides

/** The handle of the row `id` in a full drawing of the pane, with these rows open. */
async function handleIn(t: World, id: string, open: string[] = []) {
  const expanded = new Set(open)
  const groups = listGroups(await t.m.paneData(t.w.ports, { selected: null, expanded }))
  return handleOf(groups, { expanded, shown: () => 0, limits: t.m.config.global().ui }, id)
}
const ringOf = (tree: unknown) =>
  nodes(tree, 'Button')
    .filter(b => b.props.autoFocus === true)
    .map(b => b.props.key)

test('the selected agent of a run that folds: the ring and the keys fall to the fold row', async () => {
  const t = await paneWorld()
  setAgents(t, [], [master(), wfRow('w1', 1, { state: 'running' }), wfRow('w2', 2)])
  t.w.state.set('selected', 'ag:w1')
  const host: PaneHost = t.m
  const session = new PaneSession()
  const drawPane = () => session.draw(t.w.ports, host, EL, { bodyColumns: 120 })
  const live = await drawPane()
  expect(ringOf(live)).toEqual([await handleIn(t, 'ag:w1')])
  setAgents(t, [], [master(), wfRow('w1', 1), wfRow('w2', 2)]) // the run ends: it folds, and `ag:w1` is below a closed row
  const folded = await drawPane()
  expect(ringOf(folded)).toEqual([await handleIn(t, `ag:wf:${RUN}`)])
  expect(buttonOf(folded, 'dismiss').props.dimColor).toBe(true) // x is dim on a fold row
  expect(t.w.state.get('selected')).toBe('ag:w1') // a render writes nothing
})

test('the selected process row that the cap takes: the ring falls to the next row that is shown', async () => {
  const t = await capWorld()
  noDockerIssue(t)
  const rows = many(21, 'done', 'completed', i => ({ endedAt: NOW - (30 - i) * 1000 })) // 21 rows, `done0` the oldest end
  setProcesses(t, rows.slice(1)) // 20 rows: the cap holds none back yet
  t.w.state.set('selected', 'done1')
  const host: PaneHost = t.m
  const session = new PaneSession()
  const drawPane = () => session.draw(t.w.ports, host, EL, { bodyColumns: 120 })
  expect(ringOf(await drawPane())).toEqual([await handleIn(t, 'done1')])
  setProcesses(t, rows) // `done0` joins and is the oldest end, so it goes: 20 shown
  expect(ids(await draw(t, 'processes'))).not.toContain('done0')
  // `done1` is the oldest of the 20 now, so it is the row that goes if one more joins.
  setProcesses(t, [...rows, proc('done21', 'completed', { firstSeen: 99_000, endedAt: NOW })])
  expect(ids(await draw(t, 'processes'))).not.toContain('done1')
  const tree = await drawPane()
  expect(ringOf(tree)).toEqual([await handleIn(t, 'done2')]) // the row after `done1` in the last drawing
})

// ---------------------------------------------------------------- process names

const name = (s: SectionSpec, id: string) => find(s.rows, id)?.cells.description?.text

test('a detached row named by a path under the session root shows its Name from ./', async () => {
  const t = await paneWorld()
  setProcesses(t, [
    proc('pid:5', 'running', { kind: 'detached-process', pid: 5, name: '/work/scripts/serve.sh --port 3000' }),
    proc('bg:2', 'running', { name: 'node /work/app/server.js' }),
    proc('pid:6', 'running', { kind: 'detached-process', pid: 6, name: '/elsewhere/serve.sh' }),
  ])
  const s = await draw(t, 'processes')
  expect(name(s, 'pid:5')).toBe('./scripts/serve.sh --port 3000')
  expect(name(s, 'bg:2')).toBe('node ./app/server.js')
  expect(name(s, 'pid:6')).toBe('/elsewhere/serve.sh') // outside the root: as it is
})

test('the shortened name is display only: the stored name stays, and the /track text shows the short one', async () => {
  const t = await paneWorld()
  setProcesses(t, [proc('pid:5', 'running', { kind: 'detached-process', pid: 5, name: '/work/scripts/serve.sh' })])
  expect(((await draw(t, 'processes')).rows[0] as TreeRow).cells.description?.text).toBe('./scripts/serve.sh')
  expect((t.w.state.get('processes') as unknown as ProcessRecord[])[0]?.name).toBe('/work/scripts/serve.sh')
  const text = (await t.m.track(t.w.ports, '')).text
  expect(text).toContain('./scripts/serve.sh')
  expect(text).not.toContain('/work/scripts')
})

test('with no session root the name shows in full', async () => {
  const t = await paneWorld()
  t.m.facts.publish('auto.root', undefined)
  setProcesses(t, [proc('pid:5', 'running', { kind: 'detached-process', pid: 5, name: '/work/scripts/serve.sh' })])
  expect(name(await draw(t, 'processes'), 'pid:5')).toBe('/work/scripts/serve.sh')
})

test('a long process name is cut in the middle, so both ends of a path stay', async () => {
  const t = await paneWorld()
  const { rows } = await draw(t, 'processes')
  expect(rows.length).toBeGreaterThan(0)
  expect(rows.every(r => r.cells.description?.clip === 'middle')).toBe(true)
})
