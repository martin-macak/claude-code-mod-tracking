// The status token and the facets of every row (issue #63, L2): the closed token set, its color map, the status cell that
// takes its color from the token, and what each tracker puts on `TreeRow.facets`. The token maps are the table of the
// design study, section 5.4. Pure rows from the builders, and the sections of the pane world for the slot trackers.
import { expect, test } from 'claude-code/testing'
import { NO_VIEW } from '../core/infra/views'
import type { Json } from '../core/interfaces/items'
import type { Facets, SectionSpec, StatusToken, TreeRow } from '../core/interfaces/view'
import { listGroups } from '../core/lib/grouping'
import { itemRow } from '../core/lib/rows'
import { countFailed, STATUS_COLOR, statusCell } from '../core/lib/status'
import type { AgentProof, WorktreeProof } from '../trackers/auto/types'
import { githubRow, prRow } from '../trackers/github/rows'
import { jiraRow, trackedOf } from '../trackers/jira/rows'
import type { GitHubRecord, JiraRecord } from './fixtures/contracts'
import { NOW, paneWorld, WORLD_AUTO, WORLD_PROCESSES, WORLD_SNAPSHOT } from './fixtures/pane-world'
import { MENTIONED } from './fixtures/reasons'

const section = (sections: readonly SectionSpec[], id: string): SectionSpec => sections.find(s => s.id === id)!
const find = (rows: readonly TreeRow[], id: string): TreeRow | undefined => {
  for (const r of rows) {
    if (r.id === id) return r
    const deeper = find(r.children ?? [], id)
    if (deeper) return deeper
  }
  return undefined
}
const tokenOf = (row: TreeRow | undefined): StatusToken | undefined => row?.facets?.status?.token

// ---------------------------------------------------------------- the token set and its colors

test('each token has one color token: failed error, waiting warning, active success, done and gone inactive, none no color', () => {
  expect(STATUS_COLOR).toEqual({
    failed: 'error',
    waiting: 'warning',
    active: 'success',
    done: 'inactive',
    gone: 'inactive',
    none: undefined,
  })
})

test('the status cell takes its color from the token, and a token with no color leaves the cell plain', () => {
  expect(statusCell({ label: 'open', token: 'active' })).toEqual({ text: 'open', fg: 'success' })
  expect(statusCell({ label: 'open', token: 'failed' })).toEqual({ text: 'open', fg: 'error' })
  expect(statusCell({ label: 'To Do', token: 'waiting' })).toEqual({ text: 'To Do', fg: 'warning' })
  expect(statusCell({ label: 'merged', token: 'done' })).toEqual({ text: 'merged', fg: 'inactive' })
  expect(statusCell({ label: 'removed', token: 'gone' })).toEqual({ text: 'removed', fg: 'inactive' })
  expect(statusCell({ label: 'read', token: 'none' })).toEqual({ text: 'read' })
  expect(statusCell({ label: '', token: 'none' })).toEqual({ text: '' })
})

test('countFailed counts the rows with the token failed at every depth, and reads no cell text', () => {
  const row = (id: string, token: StatusToken | undefined, children?: TreeRow[]): TreeRow => ({
    id,
    owner: 't',
    // The cell says "failed" on every row: only the facet counts.
    cells: { status: { text: 'failed', fg: 'error' } },
    ...(token !== undefined ? { facets: { status: { label: 'x', token } } } : {}),
    ...(children ? { children } : {}),
  })
  expect(countFailed([])).toBe(0)
  expect(countFailed([row('a', 'failed'), row('b', 'active'), row('c', undefined), row('d', 'none')])).toBe(1)
  // A failed row whose child failed too counts once: a summary row (a folded run) is failed because of its child, and
  // counting both would count one failure twice. The failed row at the bottom of the chain is the one that counts.
  expect(countFailed([row('a', 'active', [row('b', 'failed', [row('c', 'failed')]), row('d', 'done')])])).toBe(1)
  // Failed rows side by side each count, at any depth.
  expect(countFailed([row('a', 'active', [row('b', 'failed'), row('c', 'active', [row('d', 'failed')])])])).toBe(2)
  expect(countFailed([row('a', 'failed', [row('b', 'failed'), row('c', 'failed')])])).toBe(2)
})

// ---------------------------------------------------------------- itemRow writes the facets

test('itemRow: the facets hold the status, the level and the first sighting; a row with no status has the token none', () => {
  const row = itemRow({
    id: 'a',
    owner: 'o',
    level: { level: 'high' },
    firstSeen: 42,
    kind: 'pr',
    dismiss: true,
    text: { key: 'a', title: 'A', status: { label: 'open', token: 'active' } },
  })
  expect(row.facets).toEqual({
    status: { label: 'open', token: 'active' },
    level: { level: 'high' },
    firstSeen: 42,
    kind: 'pr',
  })
  expect(row.cells.status).toEqual({ text: 'open', fg: 'success' })
  const bare = itemRow({ id: 'b', owner: 'o', level: {}, dismiss: true, text: { key: 'b', title: 'B' } })
  expect(bare.facets).toEqual({ status: { label: '', token: 'none' }, level: {} })
  expect(bare.cells).not.toHaveProperty('status')
})

// ---------------------------------------------------------------- github (PR, issue)

const gh = (over: Partial<GitHubRecord> = {}): GitHubRecord => ({
  key: 'gh:github.com/o/r#1',
  url: 'https://github.com/o/r/pull/1',
  label: '#1',
  sources: ['prompt'],
  reasons: MENTIONED,
  firstSeen: 20,
  lastSeen: 20,
  seenCount: 1,
  category: 'github',
  host: 'github.com',
  owner: 'o',
  repo: 'r',
  number: 1,
  type: 'pr',
  ...over,
})
const merge = (fresh = true) => ({ fresh, notes: {}, now: NOW })
const ghEnv = (m?: ReturnType<typeof merge>, levels: Record<string, { level: 'top' | 'high' }> = {}) =>
  ({
    facts: { read: () => undefined },
    levelOf: (k: string) => levels[k] ?? {},
    ...(m ? { merge: m } : {}),
  }) as unknown as Parameters<typeof githubRow>[1]

test('github: open with failing checks or a merge conflict is failed, open with pending checks is waiting, other open is active', () => {
  const tok = (over: Partial<GitHubRecord>, m = merge()) => tokenOf(githubRow(gh({ state: 'open', ...over }), ghEnv(m)))
  expect(tok({ checks: 'failure' })).toBe('failed')
  expect(tok({ checks: 'success', mergeable: 'CONFLICTING' })).toBe('failed')
  expect(tok({ checks: 'none', mergeable: 'CONFLICTING' })).toBe('failed')
  expect(tok({ checks: 'pending' })).toBe('waiting')
  expect(tok({ checks: 'success' })).toBe('active')
  expect(tok({ checks: 'none' })).toBe('active')
  expect(tok({})).toBe('active')
  expect(tok({ checks: 'success', mergeable: 'MERGEABLE' })).toBe('active')
  expect(tok({ checks: 'success', mergeable: 'UNKNOWN' })).toBe('active')
  // A conflict failed beats pending checks.
  expect(tok({ checks: 'pending', mergeable: 'CONFLICTING' })).toBe('failed')
  // An issue has no checks and no merge state.
  expect(tok({ type: 'issue' })).toBe('active')
})

test('github: a conflict counts only while the lane values are current, and only when a lane state is given', () => {
  const open = gh({ state: 'open', checks: 'success', mergeable: 'CONFLICTING' })
  expect(tokenOf(githubRow(open, ghEnv(merge(false))))).toBe('active') // gh logged out: the stored value is stale
  expect(tokenOf(githubRow(open, ghEnv(undefined)))).toBe('active') // no lane state: no conflict is known
  expect(tokenOf(githubRow(open, ghEnv(merge(true))))).toBe('failed')
})

test('github: merged and closed are done, also with failing checks or a stored conflict; no state is none', () => {
  const tok = (over: Partial<GitHubRecord>) => tokenOf(githubRow(gh(over), ghEnv(merge())))
  expect(tok({ state: 'merged' })).toBe('done')
  expect(tok({ state: 'closed' })).toBe('done')
  expect(tok({ state: 'merged', checks: 'failure' })).toBe('done')
  expect(tok({ state: 'closed', mergeable: 'CONFLICTING' })).toBe('done')
  expect(tok({ state: 'closed', type: 'issue' })).toBe('done')
  expect(tok({})).toBe('none')
})

test('github: a draft reads draft and takes the token of an open PR; a record that was not found is failed', () => {
  const draft = (over: Partial<GitHubRecord>) =>
    githubRow(gh({ state: 'open', isDraft: true, ...over }), ghEnv(merge()))
  expect(draft({}).facets?.status).toEqual({ label: 'draft', token: 'active' })
  expect(draft({ checks: 'failure' }).facets?.status).toEqual({ label: 'draft', token: 'failed' })
  expect(draft({ checks: 'pending' }).facets?.status).toEqual({ label: 'draft', token: 'waiting' })
  const gone = githubRow(gh({ error: { kind: 'not-found', message: 'x', at: 1 } }), ghEnv(merge()))
  expect(gone.facets?.status).toEqual({ label: 'not found', token: 'failed' })
  expect(gone.cells.status).toEqual({ text: 'not found', fg: 'error' })
})

test('github: the status cell color is the color of the token', () => {
  const st = (over: Partial<GitHubRecord>) => githubRow(gh(over), ghEnv(merge())).cells.status
  expect(st({ state: 'open' })).toEqual({ text: 'open', fg: 'success' })
  expect(st({ state: 'open', checks: 'failure' })).toEqual({ text: 'open', fg: 'error' })
  expect(st({ state: 'open', checks: 'pending' })).toEqual({ text: 'open', fg: 'warning' })
  expect(st({ state: 'merged' })).toEqual({ text: 'merged', fg: 'inactive' })
  expect(st({ state: 'closed' })).toEqual({ text: 'closed', fg: 'inactive' })
  expect(st({ state: 'open', isDraft: true })).toEqual({ text: 'draft', fg: 'success' })
  expect(st({})).toEqual({ text: '' })
})

test('github: the first sighting, the level and the kind ride on the facets, also of a PR row of the lane', () => {
  const env = ghEnv(merge(), { 'gh:github.com/o/r#1': { level: 'top' } })
  const issue = githubRow(gh({ type: 'issue', state: 'open', firstSeen: 7 }), env)
  expect(issue.facets).toMatchObject({ firstSeen: 7, level: { level: 'top' }, kind: 'issue' })
  const pr = prRow(gh({ state: 'open', firstSeen: 9, headRefName: 'feat/x', baseRefName: 'main' }), env, 'main')
  expect(pr.facets).toMatchObject({ firstSeen: 9, level: { level: 'top' }, kind: 'pr', status: { token: 'active' } })
  // A bare `#N` has an unknown type: it has no kind.
  expect(githubRow(gh({ type: 'unknown' }), env).facets).not.toHaveProperty('kind')
})

// ---------------------------------------------------------------- jira

const jiraRec = (over: Partial<JiraRecord> = {}): JiraRecord => ({
  key: 'jira:acme.atlassian.net/ISS-1',
  url: 'https://acme.atlassian.net/browse/ISS-1',
  label: 'ISS-1',
  sources: ['prompt'],
  reasons: MENTIONED,
  firstSeen: 30,
  lastSeen: 30,
  seenCount: 1,
  category: 'jira',
  site: 'acme.atlassian.net',
  issueKey: 'ISS-1',
  trackOnly: false,
  children: [],
  ...over,
})
const jiraEnv = {
  tools: { acli: { name: 'acli', available: true, loggedIn: true, breaker: 'closed', site: 'acme.atlassian.net' } },
  levelOf: (k: string) => (k === 'jira:acme.atlassian.net/ISS-1' ? { level: 'high' as const } : {}),
} as unknown as Parameters<typeof jiraRow>[1]
const jira = (over: Partial<JiraRecord> = {}) => jiraRow(jiraRec(over), jiraEnv, trackedOf([], jiraEnv.levelOf))

test('jira: the status category gives the token: new waiting, indeterminate active, done done, none when absent', () => {
  const tok = (statusCategory: string | undefined) => tokenOf(jira({ status: 'X', statusCategory }))
  expect(tok('new')).toBe('waiting')
  expect(tok('indeterminate')).toBe('active')
  expect(tok('done')).toBe('done')
  expect(tok(undefined)).toBe('none')
  expect(tok('something-new')).toBe('none') // no guess from a word that the map does not know
  // The status word alone decides nothing: a name that sounds done with no category is none.
  expect(tokenOf(jira({ status: 'Done' }))).toBe('none')
})

test('jira: the color follows the token, and a track-only or a not-found row is none and failed', () => {
  const st = (over: Partial<JiraRecord>) => jira(over).cells.status
  expect(st({ status: 'To Do', statusCategory: 'new' })).toEqual({ text: 'To Do', fg: 'warning' })
  expect(st({ status: 'In Progress', statusCategory: 'indeterminate' })).toEqual({ text: 'In Progress', fg: 'success' })
  expect(st({ status: 'Done', statusCategory: 'done' })).toEqual({ text: 'Done', fg: 'inactive' })
  expect(st({ status: 'Open' })).toEqual({ text: 'Open' })
  const trackOnly = jira({ trackOnly: true, status: 'Open', statusCategory: 'new' })
  expect(trackOnly.facets?.status).toEqual({ label: 'track-only', token: 'none' })
  expect(trackOnly.cells.status).toEqual({ text: 'track-only' })
  const gone = jira({ error: { kind: 'not-found', message: 'x', at: 1 } })
  expect(gone.facets?.status).toEqual({ label: 'not found', token: 'failed' })
  expect(gone.cells.status).toEqual({ text: 'not found', fg: 'error' })
})

test('jira: the child nodes have a token too; the root has the first sighting, the level and the issue type as kind', () => {
  const row = jira({
    status: 'In Progress',
    statusCategory: 'indeterminate',
    issueType: 'Epic',
    firstSeen: 31,
    children: [
      {
        key: 'PROJ-1',
        summary: 'S',
        issueType: 'Task',
        status: 'To Do',
        statusCategory: 'new',
        children: [
          { key: 'PROJ-2', summary: 'S', issueType: 'Sub-task', status: 'Done', statusCategory: 'done', children: [] },
        ],
      },
    ],
  })
  expect(row.facets).toMatchObject({
    firstSeen: 31,
    level: { level: 'high' },
    kind: 'Epic',
    status: { label: 'In Progress', token: 'active' },
  })
  const child = row.children?.[0]
  expect(child?.facets).toMatchObject({ kind: 'Task', status: { label: 'To Do', token: 'waiting' }, level: {} })
  expect(child?.facets).not.toHaveProperty('firstSeen') // a node of an issue has no first sighting of its own
  expect(child?.cells.status).toEqual({ text: 'To Do', fg: 'warning' })
  expect(tokenOf(child?.children?.[0])).toBe('done')
})

// ---------------------------------------------------------------- the other item trackers

test('web, file, artifact and repos rows: token none, except a deleted artifact (gone) and a repo in edit mode (active); the first sighting rides along', async () => {
  const t = await paneWorld()
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  const web = section(sections, 'web').rows[0]
  expect(web?.facets).toMatchObject({ status: { label: '', token: 'none' }, firstSeen: 50 })
  expect(web?.cells).not.toHaveProperty('status')
  for (const r of section(sections, 'file').rows) expect(tokenOf(r), r.id).toBe('none')
  const files = Object.fromEntries(section(sections, 'file').rows.map(r => [r.id, r.facets?.firstSeen]))
  expect(files).toEqual({ 'file:/work/plan.md': 60, 'file:/work/docs/spec.md': 61, 'file:/work/README.md': 62 })
  const art = Object.fromEntries(section(sections, 'artifact').rows.map(r => [r.id, r.facets]))
  expect(art['art:11111111-1111-4111-8111-111111111111']).toMatchObject({
    status: { label: '', token: 'none' },
    firstSeen: 40,
  })
  expect(art['art:22222222-2222-4222-8222-222222222222']).toMatchObject({
    status: { label: 'deleted', token: 'gone' },
    firstSeen: 41,
  })
  const deleted = section(sections, 'artifact').rows.find(r => r.facets?.status?.token === 'gone')
  expect(deleted?.cells.status).toEqual({ text: 'deleted', fg: 'inactive' })
  // Repos (owner decision, comment 6321134636): edit is active and draws green, read is none and draws plain; the first
  // sighting is the record's.
  const repos = section(sections, 'repos').rows
  expect(repos.map(r => [r.facets?.status, r.facets?.firstSeen])).toEqual([
    [{ label: 'read', token: 'none' }, 2],
    [{ label: 'edit', token: 'active' }, 9],
  ])
  expect(repos.map(r => r.cells.status)).toEqual([{ text: 'read' }, { text: 'edit', fg: 'success' }])
})

test('an item row carries the level that the person or a rule gave it', async () => {
  const t = await paneWorld()
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  const prs = section(sections, 'prs').rows
  // #21 is on the session branch: the rule R7 makes it top, by a rule.
  expect(find(prs, 'gh:github.com/acme/web#21')?.facets?.level).toEqual({ level: 'top', auto: true })
  const github = section(sections, 'github').rows
  expect(find(github, 'gh:github.com/acme/web#12')?.facets?.level).toEqual({ level: 'high' })
  expect(find(github, 'gh:github.com/acme/web#15')?.facets?.level).toEqual({})
})

// ---------------------------------------------------------------- processes

test('processes: running and up active; failed, killed, exited and unhealthy failed; completed done; unknown gone', async () => {
  const t = await paneWorld()
  const states = ['running', 'up', 'completed', 'failed', 'killed', 'exited', 'unhealthy', 'unknown'] as const
  const rows = states.map((state, i) => ({ ...WORLD_PROCESSES[0]!, id: `bg:${i}`, state }))
  t.w.state.set('processes', rows as unknown as Json)
  const s = section(await t.m.paneData(t.w.ports, NO_VIEW), 'processes')
  expect(s.rows.map(r => [r.facets?.status?.label, tokenOf(r)])).toEqual([
    ['running', 'active'],
    ['up', 'active'],
    ['completed', 'done'],
    ['failed', 'failed'],
    ['killed', 'failed'],
    ['exited', 'failed'],
    ['unhealthy', 'failed'],
    ['unknown', 'gone'],
  ])
  expect(s.rows.map(r => r.cells.status)).toEqual([
    { text: 'running', fg: 'success' },
    { text: 'up', fg: 'success' },
    { text: 'completed', fg: 'inactive' },
    { text: 'failed', fg: 'error' },
    { text: 'killed', fg: 'error' },
    { text: 'exited', fg: 'error' },
    { text: 'unhealthy', fg: 'error' },
    { text: 'unknown', fg: 'inactive' },
  ])
  // The band counts the same four states as before.
  expect(s.band?.failing).toBe(4)
})

test('processes: the first sighting and the kind of the record ride on the facets; the row has no level', async () => {
  const t = await paneWorld()
  const rows = [
    { ...WORLD_PROCESSES[0]!, firstSeen: 111 },
    { ...WORLD_PROCESSES[1]!, firstSeen: 222 },
  ]
  t.w.state.set('processes', rows as unknown as Json)
  const s = section(await t.m.paneData(t.w.ports, NO_VIEW), 'processes')
  expect(s.rows.map(r => [r.facets?.firstSeen, r.facets?.kind])).toEqual([
    [111, 'background-task'],
    [222, 'docker-container'],
  ])
  for (const r of s.rows) expect(r.facets).not.toHaveProperty('level')
})

// ---------------------------------------------------------------- worktrees and agents

test('worktrees: live is active and removed is gone; the first sighting is the proof of the child, the root has none', async () => {
  const t = await paneWorld()
  const proofs: WorktreeProof[] = [
    { path: '/work/feat-x', origin: 'agent', provenAt: 5_000 },
    { path: '/work/old-wt', origin: 'enter', provenAt: 6_000 },
  ]
  t.w.state.set('auto', { ...WORLD_AUTO, worktrees: proofs } as unknown as Json)
  const rows = section(await t.m.paneData(t.w.ports, NO_VIEW), 'worktrees').rows
  const at = (id: string) => find(rows, id)
  expect(at('wt:/work')?.facets).toEqual({ status: { label: '', token: 'active' } })
  expect(at('wt:/work/feat-x')?.facets).toEqual({ status: { label: '', token: 'active' }, firstSeen: 5_000 })
  expect(at('wt:/work/old-wt')?.facets).toEqual({ status: { label: 'removed', token: 'gone' }, firstSeen: 6_000 })
  expect(at('wt:/work/detached-wt')?.facets).toEqual({ status: { label: '', token: 'active' } })
  expect(at('wt:/work/old-wt')?.cells.status).toEqual({ text: 'removed', fg: 'inactive' })
})

test('agents: running active, waiting waiting, ended done, failed failed; the state is the label of a new status cell', async () => {
  const t = await paneWorld()
  const proofs: AgentProof[] = [
    { id: 'explore', kind: 'subagent', label: 'explore', spawnedAt: 7_000 },
    { id: 'review', kind: 'subagent', label: 'review', spawnedAt: 8_000 },
  ]
  t.w.state.set('auto', { ...WORLD_AUTO, agents: proofs } as unknown as Json)
  const rows = section(await t.m.paneData(t.w.ports, NO_VIEW), 'agents').rows
  const at = (id: string) => find(rows, id)
  expect(
    ['ag:master', 'ag:explore', 'ag:review', 'ag:build', 'ag:lint'].map(id => [id, at(id)?.facets?.status]),
  ).toEqual([
    ['ag:master', { label: 'running', token: 'active' }],
    ['ag:explore', { label: 'running', token: 'active' }],
    ['ag:review', { label: 'ended', token: 'done' }],
    ['ag:build', { label: 'waiting', token: 'waiting' }],
    ['ag:lint', { label: 'failed', token: 'failed' }],
  ])
  expect(at('ag:lint')?.cells.status).toEqual({ text: 'failed', fg: 'error' })
  expect(at('ag:build')?.cells.status).toEqual({ text: 'waiting', fg: 'warning' })
  expect(at('ag:review')?.cells.status).toEqual({ text: 'ended', fg: 'inactive' })
  // The first sighting is the spawn time of the proof; the master and an agent with no proof have none.
  expect(at('ag:explore')?.facets?.firstSeen).toBe(7_000)
  expect(at('ag:review')?.facets?.firstSeen).toBe(8_000)
  expect(at('ag:master')?.facets).not.toHaveProperty('firstSeen')
  expect(at('ag:lint')?.facets).not.toHaveProperty('firstSeen')
  // The kind of the agent row.
  expect(at('ag:explore')?.facets?.kind).toBe('subagent')
  expect(at('ag:build')?.facets?.kind).toBe('workflow')
  expect(at('ag:master')?.facets?.kind).toBe('master')
})

test('a folded workflow run is failed when an agent of it failed, else done; its first sighting is the first spawn', async () => {
  const t = await paneWorld()
  const wf = (index: number) => ({ runId: 'wf_aaaaaaaa-1111', agentIndex: index })
  const agent = (id: string, state: 'ended' | 'failed', index: number) => ({
    id: `ag:${id}`,
    kind: 'workflow' as const,
    label: id,
    depth: 1,
    worktreeLive: false,
    state,
    workflow: wf(index),
  })
  const snapshot = {
    ...WORLD_SNAPSHOT,
    agents: [WORLD_SNAPSHOT.agents[0]!, agent('a', 'ended', 1), agent('b', 'failed', 2)],
  }
  const proofs: AgentProof[] = [
    { id: 'a', kind: 'workflow', label: 'a', spawnedAt: 900, workflow: wf(1) },
    { id: 'b', kind: 'workflow', label: 'b', spawnedAt: 800, workflow: wf(2) },
  ]
  t.w.state.set('auto', { ...WORLD_AUTO, snapshot, agents: proofs } as unknown as Json)
  const rows = section(await t.m.paneData(t.w.ports, NO_VIEW), 'agents').rows
  const run = find(rows, 'ag:wf:wf_aaaaaaaa-1111')
  expect(run?.facets).toMatchObject({ status: { label: 'failed', token: 'failed' }, firstSeen: 800 })
  expect(run?.cells.status).toEqual({ text: 'failed', fg: 'error' })
  // A run with no failure is done. It has 2 agents: a run of 1 does not fold (issue #146).
  const ok = { ...snapshot, agents: [snapshot.agents[0]!, agent('a', 'ended', 1), agent('b', 'ended', 2)] }
  t.w.state.set('auto', { ...WORLD_AUTO, snapshot: ok, agents: proofs } as unknown as Json)
  const done = find(section(await t.m.paneData(t.w.ports, NO_VIEW), 'agents').rows, 'ag:wf:wf_aaaaaaaa-1111')
  expect(done?.facets?.status).toEqual({ label: 'ended', token: 'done' })
})

test('a folded workflow run counts its failed agents in the group title, not itself (R4f)', async () => {
  const t = await paneWorld()
  const wf = (index: number) => ({ runId: 'wf_aaaaaaaa-1111', agentIndex: index })
  const agent = (id: string, state: 'ended' | 'failed', index: number) => ({
    id: `ag:${id}`,
    kind: 'workflow' as const,
    label: id,
    depth: 1,
    worktreeLive: false,
    state,
    workflow: wf(index),
  })
  const proofs: AgentProof[] = [
    { id: 'a', kind: 'workflow', label: 'a', spawnedAt: 900, workflow: wf(1) },
    { id: 'b', kind: 'workflow', label: 'b', spawnedAt: 800, workflow: wf(2) },
  ]
  const failing = async (members: readonly ReturnType<typeof agent>[]): Promise<number | undefined> => {
    const snapshot = { ...WORLD_SNAPSHOT, agents: [WORLD_SNAPSHOT.agents[0]!, ...members] }
    t.w.state.set('auto', { ...WORLD_AUTO, snapshot, agents: proofs } as unknown as Json)
    const sections = await t.m.paneData(t.w.ports, NO_VIEW)
    // The agents fold into one run row (the case that counted twice), so the run row is there.
    expect(find(section(sections, 'agents').rows, 'ag:wf:wf_aaaaaaaa-1111')).toBeDefined()
    return listGroups(sections).find(g => g.id === 'list:agents')?.failing
  }
  // One of two failed: the run row is failed because of its failed agent, and that is one failure, not two.
  expect(await failing([agent('a', 'ended', 1), agent('b', 'failed', 2)])).toBe(1)
  // Both failed: each agent counts, the run row does not.
  expect(await failing([agent('a', 'failed', 1), agent('b', 'failed', 2)])).toBe(2)
  // None failed: the run is done.
  expect(await failing([agent('a', 'ended', 1), agent('b', 'ended', 2)])).toBe(0)
})

// ---------------------------------------------------------------- every row has a token

test('every top-level row of the pane world has a status token of the closed set', async () => {
  const t = await paneWorld()
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  const set = new Set<string>(['failed', 'waiting', 'active', 'done', 'gone', 'none'])
  const missing: string[] = []
  for (const s of sections)
    for (const r of s.rows) {
      const token = tokenOf(r)
      if (token === undefined || !set.has(token)) missing.push(`${s.id}/${r.id}`)
    }
  expect(missing).toEqual([])
  // The facets of a row are a plain object that holds nothing but the four keys.
  const keys = new Set<string>()
  for (const s of sections) for (const r of s.rows) for (const k of Object.keys(r.facets ?? {})) keys.add(k)
  expect([...keys].sort()).toEqual(['firstSeen', 'kind', 'level', 'status'] satisfies (keyof Facets)[])
})

// ---------------------------------------------------------------- G9: the cells that changed meaning under a shared header

test('G9 processes: the Name cell holds the name of the process, the Type cell its kind, and no cell holds the short kind word', async () => {
  const t = await paneWorld()
  const rows = [
    { ...WORLD_PROCESSES[0]!, name: 'npm run dev' },
    { ...WORLD_PROCESSES[1]!, name: 'db' },
    { ...WORLD_PROCESSES[2]!, name: '/work/scripts/worker.sh --fast' },
  ]
  t.w.state.set('processes', rows as unknown as Json)
  const s = section(await t.m.paneData(t.w.ports, NO_VIEW), 'processes')
  expect(s.rows.map(r => [r.cells.name?.text, r.cells.description?.text, r.cells.type?.text])).toEqual([
    ['npm run dev', '', 'background task'],
    ['db', '', 'docker container'],
    ['./scripts/worker.sh --fast', '', 'detached process'], // a path under the session root reads from ./
  ])
  // A long name keeps both ends, as the description did.
  expect(s.rows[0]?.cells.name).toEqual({ text: 'npm run dev', clip: 'middle' })
  const words = JSON.stringify(s.rows.map(r => r.cells))
  for (const kindWord of ['"bg"', '"docker"', '"pid"']) expect(words).not.toContain(kindWord)
})

test('G9 files: the Name cell holds the file name and the Description its folder below the root, empty at the root', async () => {
  const t = await paneWorld()
  const rows = section(await t.m.paneData(t.w.ports, NO_VIEW), 'file').rows
  expect(
    rows.map(r => [r.cells.name?.text, r.cells.description?.text, r.cells.type?.text, r.cells.status?.text]),
  ).toEqual([
    ['plan.md', '', 'created', ''],
    ['spec.md', 'docs', '', 'edited 2'],
    ['README.md', '', '', ''],
  ])
  // A file name and a folder keep both ends.
  expect(rows[1]?.cells.name).toEqual({ text: 'spec.md', clip: 'middle' })
  expect(rows[1]?.cells.description).toEqual({ text: 'docs', clip: 'middle' })
})

// ---------------------------------------------------------------- the failing count of a group

test('the title line of a group counts the rows with the token failed: the band of the section keeps its own count', async () => {
  const t = await paneWorld()
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  const groups = listGroups(sections)
  // Failed rows: PR #21 (checks fail), the not-found Jira key, the not-found GitHub ref, the failed agent, the failed process.
  expect(Object.fromEntries(groups.map(g => [g.id, g.failing]))).toEqual({
    'list:worktrees': 0,
    'list:agents': 1,
    'list:prs': 1,
    'list:jira': 1,
    'list:github': 1,
    'list:artifact': 0,
    'list:repos': 0,
    'list:web': 0,
    'list:file': 0,
    'list:processes': 1,
  })
  // The band above the prompt is unchanged: it counts failing checks, and failing processes, and no agent.
  expect(Object.fromEntries(sections.map(s => [s.id, s.band?.failing]))).toMatchObject({
    agents: 0,
    prs: 1,
    jira: 0,
    github: 0,
    processes: 1,
  })
})

test('a conflicted PR with passing checks fails in the group and is counted apart in the band', async () => {
  const t = await paneWorld()
  const items = (t.w.state.get('items') as unknown as { key: string }[]).map(i =>
    i.key === 'gh:github.com/acme/web#24' ? { ...i, mergeable: 'CONFLICTING' } : i,
  )
  t.w.state.set('items', items as unknown as Json)
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  const prs = section(sections, 'prs')
  expect(tokenOf(find(prs.rows, 'gh:github.com/acme/web#24'))).toBe('failed')
  expect(listGroups(sections).find(g => g.id === 'list:prs')?.failing).toBe(2)
  expect(prs.band).toMatchObject({ failing: 1, conflicts: 1 })
})
