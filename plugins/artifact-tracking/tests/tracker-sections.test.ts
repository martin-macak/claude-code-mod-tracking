// The sections of the auto, repos and processes trackers, drawn through a real LifecycleManager over fakePorts: rows, notes, tones, bands and the cases in which a section is left out. The item trackers' half is in
// item-sections.test.ts. Each row and cell is what the pane drew before L6. Plan: L5 Task 14, L6 A1.
import { expect, test } from 'claude-code/testing'
import { NO_VIEW } from '../core/infra/views'
import type { Json } from '../core/interfaces/items'
import type { Cell, CellId, SectionSpec, TreeRow } from '../core/interfaces/view'
import { listGroups } from '../core/lib/grouping'
import {
  NOW,
  paneWorld,
  WORLD_AUTO,
  WORLD_PROCESS_UI,
  WORLD_PROCESSES,
  WORLD_REPOS,
  WORLD_SNAPSHOT,
} from './fixtures/pane-world'

const ids = (sections: readonly SectionSpec[]) => sections.map(s => s.id)
const section = (sections: readonly SectionSpec[], id: string): SectionSpec => sections.find(s => s.id === id)!
const cell = (r: TreeRow | undefined, id: CellId): Cell => r?.cells[id] ?? { text: '<no cell>' }
const find = (rows: readonly TreeRow[], id: string): TreeRow | undefined => {
  for (const r of rows) {
    if (r.id === id) return r
    const deeper = find(r.children ?? [], id)
    if (deeper) return deeper
  }
  return undefined
}
const flat = (rows: readonly TreeRow[], depth = 0): [string, number][] =>
  rows.flatMap(r => [[r.id, depth] as [string, number], ...flat(r.children ?? [], depth + 1)])

test('every pane section is placed by its rank and band rank: Worktrees, Agents, Pull requests, … Processes', async () => {
  const t = await paneWorld()
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  expect(sections.map(s => [s.id, s.title, s.rank, s.band?.rank])).toEqual([
    ['worktrees', 'Worktrees', 10, 7],
    ['agents', 'Agents', 11, 8],
    ['prs', 'Pull requests', 12, 9],
    ['jira', 'Jira work items', 20, 1],
    ['github', 'GitHub', 30, 2],
    ['artifact', 'Artifacts', 40, 3],
    ['repos', 'Repos', 50, 6],
    ['web', 'Web links', 60, 4],
    ['file', 'Files', 70, 5],
    ['processes', 'Processes', 80, 10],
  ])
  expect(ids(sections)).toHaveLength(10)
})

test('the four sections write no control cell: no mark can be set on a row of them', async () => {
  const t = await paneWorld()
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  const all = (rows: readonly TreeRow[]): TreeRow[] => rows.flatMap(r => [r, ...all(r.children ?? [])])
  for (const id of ['worktrees', 'agents', 'repos', 'processes'])
    for (const r of all(section(sections, id).rows)) expect(r.cells.control, `${id} ${r.id}`).toBeUndefined()
})

test('the worktree root and the master agent are expandedByDefault', async () => {
  const t = await paneWorld()
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  const root = find(section(sections, 'worktrees').rows, 'wt:/work')
  expect(root?.expandedByDefault).toBe(true)
  expect(root?.children?.map(r => r.id)).toEqual(['wt:/work/feat-x', 'wt:/work/old-wt', 'wt:/work/detached-wt'])
  const master = find(section(sections, 'agents').rows, 'ag:master')
  expect(master?.expandedByDefault).toBe(true)
  // nothing else folds
  const folds = [...section(sections, 'worktrees').rows, ...section(sections, 'agents').rows].flatMap(
    function all(r): TreeRow[] {
      return [r, ...(r.children ?? []).flatMap(all)]
    },
  )
  expect(folds.filter(r => r.expandedByDefault).map(r => r.id)).toEqual(['wt:/work', 'ag:master'])
})

test('Worktrees and Agents count every row they hold, not the one root row that holds the rest (issue #63, L1)', async () => {
  const t = await paneWorld()
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  // The root worktree and its three children; the master agent and its four.
  expect(section(sections, 'worktrees').rows).toHaveLength(1)
  expect(section(sections, 'worktrees').count).toBe(4)
  expect(section(sections, 'agents').rows).toHaveLength(1)
  expect(section(sections, 'agents').count).toBe(5)
  // The flat sections set none: the group counts their top-level rows.
  expect(section(sections, 'prs').count).toBeUndefined()
  expect(Object.fromEntries(listGroups(sections).map(g => [g.id, g.count]))).toMatchObject({
    'list:worktrees': 4,
    'list:agents': 5,
    'list:prs': section(sections, 'prs').rows.length,
  })
})

test('the agents nest by their depth: the master holds the first level, an agent holds its own children', async () => {
  const t = await paneWorld()
  const s = section(await t.m.paneData(t.w.ports, NO_VIEW), 'agents')
  expect(flat(s.rows)).toEqual([
    ['ag:master', 0],
    ['ag:explore', 1],
    ['ag:review', 2],
    ['ag:build', 1],
    ['ag:lint', 1],
  ])
})

test('a depth that skips nothing nests under the last row above it, also past the third level', async () => {
  const t = await paneWorld()
  const agents = [
    ...WORLD_SNAPSHOT.agents.slice(0, 1),
    { ...WORLD_SNAPSHOT.agents[1]!, id: 'ag:a', depth: 1 },
    { ...WORLD_SNAPSHOT.agents[1]!, id: 'ag:b', depth: 2 },
    { ...WORLD_SNAPSHOT.agents[1]!, id: 'ag:c', depth: 3 },
    { ...WORLD_SNAPSHOT.agents[1]!, id: 'ag:d', depth: 3 }, // the ledger caps the depth at 3: a sibling of c
    { ...WORLD_SNAPSHOT.agents[1]!, id: 'ag:e', depth: 1 },
  ]
  t.w.state.set('auto', { ...WORLD_AUTO, snapshot: { ...WORLD_SNAPSHOT, agents } } as unknown as Json)
  const s = section(await t.m.paneData(t.w.ports, NO_VIEW), 'agents')
  expect(flat(s.rows)).toEqual([
    ['ag:master', 0],
    ['ag:a', 1],
    ['ag:b', 2],
    ['ag:c', 3],
    ['ag:d', 3],
    ['ag:e', 1],
  ])
})

test('worktree rows: names, branches, the removed one dimmed, and what can be dismissed', async () => {
  const t = await paneWorld()
  const s = section(await t.m.paneData(t.w.ports, NO_VIEW), 'worktrees')
  const root = find(s.rows, 'wt:/work')
  expect([cell(root, 'name'), cell(root, 'description'), cell(root, 'status')]).toEqual([
    { text: 'work' },
    { text: 'main', clip: 'middle' }, // a branch keeps both ends
    { text: '' },
  ])
  expect(root?.can).toEqual({ dismiss: false, priority: false })
  const live = find(s.rows, 'wt:/work/feat-x')
  expect([cell(live, 'name'), cell(live, 'description'), cell(live, 'status')]).toEqual([
    { text: 'feat-x' },
    { text: 'feat/x', clip: 'middle' },
    { text: '' },
  ])
  expect(live?.can).toEqual({ dismiss: true, priority: false })
  expect(live?.dim).toBeUndefined()
  const gone = find(s.rows, 'wt:/work/old-wt')
  expect(cell(gone, 'status')).toEqual({ text: 'removed', dim: true })
  expect(gone?.dim).toBe(true)
  expect(cell(find(s.rows, 'wt:/work/detached-wt'), 'description')).toEqual({ text: '(detached)', clip: 'middle' })
})

test('the worktrees note counts the children and says when git last ran; the band counts the live ones', async () => {
  const t = await paneWorld()
  const s = section(await t.m.paneData(t.w.ports, NO_VIEW), 'worktrees')
  expect(s.note).toEqual({ text: 'git · 2 live · 1 removed · checked 30s ago' })
  expect(s.band).toEqual({ label: 'Worktrees', count: 2, failing: 0, rank: 7 })
})

test('the worktrees note reads the fact auto.checkedAt first, else the age of the snapshot', async () => {
  const t = await paneWorld()
  t.m.facts.publish('auto.checkedAt', undefined)
  const note = async () => section(await t.m.paneData(t.w.ports, NO_VIEW), 'worktrees').note?.text
  expect(await note()).toBe('git · 2 live · 1 removed · checked 5m ago')
  t.m.facts.publish('auto.checkedAt', NOW)
  expect(await note()).toBe('git · 2 live · 1 removed · checked just now')
})

test('the worktrees note says when git failed, and the section stays', async () => {
  const t = await paneWorld()
  const git = { ok: false, at: NOW, error: 'fatal: not a git repository' }
  t.w.state.set('auto', { ...WORLD_AUTO, snapshot: { ...WORLD_SNAPSHOT, git } } as unknown as Json)
  expect(section(await t.m.paneData(t.w.ports, NO_VIEW), 'worktrees').note?.text).toBe(
    'git failed: fatal: not a git repository',
  )
  t.w.state.set('auto', {
    ...WORLD_AUTO,
    snapshot: { ...WORLD_SNAPSHOT, git: { ok: false, at: NOW } },
  } as unknown as Json)
  expect(section(await t.m.paneData(t.w.ports, NO_VIEW), 'worktrees').note?.text).toBe('git failed: unknown error')
})

test('agent rows: the state marker, the workflow index, the worktree, ended and failed dimmed, the master not dismissable', async () => {
  const t = await paneWorld()
  const s = section(await t.m.paneData(t.w.ports, NO_VIEW), 'agents')
  const master = find(s.rows, 'ag:master')
  expect([cell(master, 'name'), cell(master, 'description'), cell(master, 'type')]).toEqual([
    { text: '● this session' },
    { text: 'feat/x', clip: 'middle' },
    { text: 'feat-x', clip: 'middle' },
  ])
  expect(master?.can).toEqual({ dismiss: false, priority: false })
  expect(master?.dim).toBeUndefined()
  const explore = find(s.rows, 'ag:explore')
  expect(cell(explore, 'name')).toEqual({ text: '● explore' })
  expect(cell(explore, 'type')).toEqual({ text: 'agent-a94bdd45', clip: 'middle' }) // compactIds shortens the engine ids
  expect(explore?.can).toEqual({ dismiss: true, priority: false })
  expect(explore?.dim).toBeUndefined()
  const review = find(s.rows, 'ag:review')
  expect(cell(review, 'name')).toEqual({ text: '✓ review' })
  expect(review?.dim).toBe(true)
  expect(cell(find(s.rows, 'ag:build'), 'name')).toEqual({ text: '● wf_a35565·2 build' }) // waiting counts as running; the label says the run (issue #49)
  expect(find(s.rows, 'ag:build')?.dim).toBeUndefined()
  expect(cell(find(s.rows, 'ag:lint'), 'name')).toEqual({ text: '✗ lint' })
  expect(find(s.rows, 'ag:lint')?.dim).toBe(true)
  expect(cell(find(s.rows, 'ag:lint'), 'description')).toEqual({ text: '', clip: 'middle' })
})

test('the agents note and band: running and waiting are running, ended and failed are ended; the master is not counted', async () => {
  const t = await paneWorld()
  const s = section(await t.m.paneData(t.w.ports, NO_VIEW), 'agents')
  expect(s.note).toEqual({ text: '2 running · 2 ended' })
  expect(s.band).toEqual({ label: 'Agents', count: 2, failing: 0, rank: 8 })
  const sick = { ...WORLD_SNAPSHOT, agentList: { ok: false, at: NOW, error: 'x' } }
  t.w.state.set('auto', { ...WORLD_AUTO, snapshot: sick } as unknown as Json)
  expect(section(await t.m.paneData(t.w.ports, NO_VIEW), 'agents').note?.text).toBe(
    '2 running · 2 ended · agent list failed',
  )
})

test('the auto sections are left out: no snapshot, no git root, no child worktree, no agent but the master', async () => {
  const t = await paneWorld()
  const draw = async () =>
    ids(await t.m.paneData(t.w.ports, NO_VIEW)).filter(id => id === 'worktrees' || id === 'agents')
  expect(await draw()).toEqual(['worktrees', 'agents'])
  t.w.state.set('auto', { ...WORLD_AUTO, snapshot: null } as unknown as Json)
  expect(await draw()).toEqual([])
  t.w.state.set('auto', { ...WORLD_AUTO, root: { cwd: '/work', at: 1 } } as unknown as Json) // not resolved yet
  expect(await draw()).toEqual(['agents'])
  t.w.state.set('auto', { ...WORLD_AUTO, root: { cwd: '/work', at: 1, top: null } } as unknown as Json) // not a git repo
  expect(await draw()).toEqual(['agents'])
  const rootOnly = {
    ...WORLD_SNAPSHOT,
    worktrees: WORLD_SNAPSHOT.worktrees.slice(0, 1),
    agents: WORLD_SNAPSHOT.agents.slice(0, 1),
  }
  t.w.state.set('auto', { ...WORLD_AUTO, snapshot: rootOnly } as unknown as Json)
  expect(await draw()).toEqual([])
})

test('a slot that was never written draws nothing', async () => {
  const t = await paneWorld()
  for (const slot of ['auto', 'repos', 'processes']) t.w.state.delete(slot)
  t.m.facts.publish('processes.ui', undefined)
  expect(ids(await t.m.paneData(t.w.ports, NO_VIEW))).toEqual(['prs', 'jira', 'github', 'artifact', 'web', 'file'])
  expect((await t.m.bandData(t.w.ports)).map(s => s.id)).toEqual(['jira', 'github', 'artifact', 'web', 'file', 'prs'])
})

test('repo rows: oldest first, the touched-by list, the mode word and its tone', async () => {
  const t = await paneWorld()
  const s = section(await t.m.paneData(t.w.ports, NO_VIEW), 'repos')
  expect(s.rows.map(r => r.id)).toEqual(['rp:remote:github.com/acme/web', 'rp:remote:github.com/acme/sdk'])
  const web = s.rows[0]
  expect([cell(web, 'name'), cell(web, 'description'), cell(web, 'type')]).toEqual([
    { text: 'acme/web' },
    { text: '', clip: 'middle' },
    { text: 'main', clip: 'middle' },
  ])
  expect(cell(web, 'status')).toEqual({ text: 'read', dim: true })
  const sdk = s.rows[1]
  expect([cell(sdk, 'description'), cell(sdk, 'type')]).toEqual([
    { text: 'dev', clip: 'middle' },
    { text: 'main, planner', clip: 'middle' },
  ])
  expect(cell(sdk, 'status')).toEqual({ text: 'edit', fg: 'success' })
  for (const r of s.rows) {
    expect(r.owner).toBe('repos')
    expect(r.can).toEqual({ dismiss: true, priority: false })
    expect(r.dim).toBeUndefined()
  }
  expect(s.note).toEqual({ text: '2 tracked' })
  expect(s.band).toEqual({ label: 'Repos', count: 2, failing: 0, rank: 6 })
})

test('a repo row stored by an older version has no mode and reads as read; a slot that is no list draws nothing', async () => {
  const t = await paneWorld()
  const old = { ...WORLD_REPOS[1]!, mode: undefined }
  t.w.state.set('repos', [old] as unknown as Json)
  const s = section(await t.m.paneData(t.w.ports, NO_VIEW), 'repos')
  expect(cell(s.rows[0], 'status')).toEqual({ text: 'read', dim: true })
  t.w.state.set('repos', 'not a list' as unknown as Json)
  expect(ids(await t.m.paneData(t.w.ports, NO_VIEW))).not.toContain('repos')
})

test('process rows: the short kind word, the name, the kind with a space, the state with its tone', async () => {
  const t = await paneWorld()
  const s = section(await t.m.paneData(t.w.ports, NO_VIEW), 'processes')
  expect(s.rows.map(r => r.id)).toEqual(['bg:1', 'docker:db', 'pid:77'])
  const rows = s.rows.map(r => [
    cell(r, 'name').text,
    cell(r, 'description').text,
    cell(r, 'type').text,
    cell(r, 'status'),
  ])
  expect(rows).toEqual([
    ['bg', 'npm run dev', 'background task', { text: 'running', fg: 'success' }],
    ['docker', 'db', 'docker container', { text: 'up', fg: 'success' }],
    ['pid', 'worker', 'detached process', { text: 'failed', fg: 'error' }],
  ])
  expect(s.band).toEqual({ label: 'Processes', count: 3, failing: 1, rank: 10 })
})

test('the processes note is the docker issue when there is one, else the count', async () => {
  const t = await paneWorld()
  const note = async () => section(await t.m.paneData(t.w.ports, NO_VIEW), 'processes').note?.text
  expect(await note()).toBe('docker: daemon not running')
  t.m.facts.publish('processes.ui', { ...WORLD_PROCESS_UI, dockerIssue: undefined } as unknown as Json)
  expect(await note()).toBe('3 tracked')
})

test('the processes section needs a row or a docker issue; with only the issue it has a note and no row', async () => {
  const t = await paneWorld()
  t.w.state.set('processes', [] as unknown as Json)
  const s = section(await t.m.paneData(t.w.ports, NO_VIEW), 'processes')
  expect(s.rows).toEqual([])
  expect(s.note?.text).toBe('docker: daemon not running')
  expect(s.band).toEqual({ label: 'Processes', count: 0, failing: 0, rank: 10 })
  t.m.facts.publish('processes.ui', { breaker: 'closed' })
  expect(ids(await t.m.paneData(t.w.ports, NO_VIEW))).not.toContain('processes')
})

test('every process state has its tone: the bad ones red, running and up green, the rest plain', async () => {
  const t = await paneWorld()
  // `unknown` (#56): a detached process with a variable the mod cannot read, and no process found. It is no failure.
  const states = ['running', 'up', 'completed', 'failed', 'killed', 'exited', 'unhealthy', 'unknown'] as const
  const rows = states.map((state, i) => ({ ...WORLD_PROCESSES[0]!, id: `bg:${i}`, state }))
  t.w.state.set('processes', rows as unknown as Json)
  const s = section(await t.m.paneData(t.w.ports, NO_VIEW), 'processes')
  expect(s.rows.map(r => cell(r, 'status'))).toEqual([
    { text: 'running', fg: 'success' },
    { text: 'up', fg: 'success' },
    { text: 'completed' },
    { text: 'failed', fg: 'error' },
    { text: 'killed', fg: 'error' },
    { text: 'exited', fg: 'error' },
    { text: 'unhealthy', fg: 'error' },
    { text: 'unknown' },
  ])
  expect(s.band?.failing).toBe(4) // failed, killed, exited and unhealthy; `unknown` is not counted
})

test('a process row cannot be dismissed or prioritised', async () => {
  const t = await paneWorld()
  const s = section(await t.m.paneData(t.w.ports, NO_VIEW), 'processes')
  for (const r of s.rows) {
    expect(r.can).toEqual({ dismiss: false, priority: false })
    expect(r.owner).toBe('processes')
    expect(r.cells.control).toBeUndefined()
  }
})

test('the owner of every row is its tracker', async () => {
  const t = await paneWorld()
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  const owners = (id: string): string[] => [
    ...new Set(flat(section(sections, id).rows).map(([rowId]) => find(section(sections, id).rows, rowId)!.owner)),
  ]
  expect(owners('worktrees')).toEqual(['auto'])
  expect(owners('agents')).toEqual(['auto'])
  expect(owners('repos')).toEqual(['repos'])
})

test('the sections of a tracker that is off are gone; the others stay', async () => {
  const t = await paneWorld({ off: ['auto', 'processes'] })
  expect(ids(await t.m.paneData(t.w.ports, NO_VIEW))).toEqual([
    'prs',
    'jira',
    'github',
    'artifact',
    'repos',
    'web',
    'file',
  ])
  expect((await t.m.bandData(t.w.ports)).map(s => s.band?.label)).toEqual([
    'Jira',
    'GitHub',
    'Artifacts',
    'Links',
    'Files',
    'Repos',
    'PRs',
  ])
})
