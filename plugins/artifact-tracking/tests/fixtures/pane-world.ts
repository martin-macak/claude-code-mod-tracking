// A started manager over fakePorts with one record of every row shape of the pane, for the tests of the sections. The item
// trackers' half (plan L5, Task 13): an issue and a PR of the session repo, an issue of another repo, a bare `#N`, PRs the
// PR lane found (one with failed checks on the session branch, a stacked one, a merged one), a Jira item with a child
// tree that is also tracked, a track-only and a not-found Jira item, a published, a deleted and a mentioned artifact, web
// links, and a created, an edited and a viewed file. `gh` is ready and `acli` has the site `acme.atlassian.net`.
// The other half (plan L5, Task 14): an auto snapshot with the root, a live and a removed child, the master agent on the
// session branch, a running agent with an ended child, and a workflow agent; two repos; three processes (one failed) and a
// docker issue.
import type { LifecycleManager } from '../../core/infra/lifecycle'
import type { Json, JsonObject, StoredItem } from '../../core/interfaces/items'
import { addReason, reasonSet } from '../../core/lib/reasons'
import type { AgentRow, AutoSnapshot, AutoState, WorktreeRow } from '../../trackers/auto/types'
import type { ProcessRecord, ProcessUiState } from '../../trackers/processes/types'
import type { RepoRecord } from '../../trackers/repos/types'
import type { ToolStatus } from '../../types'
import { fakeConfig } from './config-fs'
import { managerWorld } from './manager'
import { DISCOVERED, fileReasons, reasonsOfSources } from './reasons'

/** The wall clock of the world. The notes say `refreshed 2m ago` against it. */
export const NOW = 1_000_000

export const SESSION_REPO = { host: 'github.com', owner: 'acme', repo: 'web' }

/** The keys the world's lists are about. */
export const KEYS = {
  issue: 'gh:github.com/acme/web#5',
  pr: 'gh:github.com/acme/web#9',
  other: 'gh:github.com/cli/cli#14640',
  bare: 'gh:?#7',
  viaIssue: 'gh:github.com/acme/web#12',
  gone: 'gh:github.com/acme/web#404',
  draft: 'gh:github.com/acme/web#15',
  head: 'gh:github.com/acme/web#21',
  stacked: 'gh:github.com/acme/web#22',
  merged: 'gh:github.com/acme/web#23',
  named: 'gh:github.com/acme/web#24',
  jira: 'jira:acme.atlassian.net/ISS-1',
  jiraNested: 'jira:acme.atlassian.net/PROJ-201',
  jiraTrackOnly: 'jira:other.example.com/XX-1',
  jiraGone: 'jira:acme.atlassian.net/GONE-1',
  published: 'art:11111111-1111-4111-8111-111111111111',
  deleted: 'art:22222222-2222-4222-8222-222222222222',
  mentioned: 'art:33333333-3333-4333-8333-333333333333',
  web: 'web:https://docs.example/a',
  web2: 'web:https://docs.example/b',
  created: 'file:/work/plan.md',
  edited: 'file:/work/docs/spec.md',
  viewed: 'file:/work/README.md',
} as const

type Fields = Record<string, Json | undefined>

const rec = (key: string, category: string, url: string, label: string, f: Fields = {}): StoredItem =>
  ({
    key,
    category,
    url,
    label,
    sources: ['prompt'],
    reasons: reasonsOfSources((f.sources as string[] | undefined) ?? ['prompt']),
    firstSeen: 10,
    lastSeen: 10,
    seenCount: 1,
    ...f,
  }) as unknown as StoredItem

const GH = 'https://github.com/acme/web'
const issue = (n: number, f: Fields = {}): StoredItem =>
  rec(`gh:github.com/acme/web#${n}`, 'github', `${GH}/issues/${n}`, `acme/web#${n}`, {
    host: 'github.com',
    owner: 'acme',
    repo: 'web',
    number: n,
    type: 'issue',
    state: 'open',
    title: `Issue ${n}`,
    refreshedAt: NOW - 120_000,
    ...f,
  })
const pr = (n: number, f: Fields = {}): StoredItem =>
  issue(n, { type: 'pr', title: `PR ${n}`, url: `${GH}/pull/${n}`, checks: 'none', ...f })

const art = (uuid: string, label: string, f: Fields = {}): StoredItem =>
  rec(`art:${uuid}`, 'artifact', `https://claude.ai/artifact/${uuid}`, label, f)

/** A file record: its reasons follow the counters it holds, as the file kind makes them. */
const file = (path: string, f: Fields): StoredItem => {
  const n = { created: false, edits: 0, views: 0, mentions: 0, ...f }
  return rec(`file:${path}`, 'file', path, path, { ...n, reasons: fileReasons(n) as unknown as Json })
}

/** The Jira issue with a child tree of two levels. PROJ-201 is a child of ISS-1 and a tracked issue of its own. */
const jira = (issueKey: string, f: Fields = {}): StoredItem =>
  rec(`jira:acme.atlassian.net/${issueKey}`, 'jira', `https://acme.atlassian.net/browse/${issueKey}`, issueKey, {
    site: 'acme.atlassian.net',
    issueKey,
    trackOnly: false,
    children: [],
    ...f,
  })

/** What a PR that only the PR lane found carries: no channel, the reason `discovered` and the `lane` marker. */
const FOUND: Fields = { sources: [], reasons: DISCOVERED as unknown as Json, lane: true }

/** Every record of the world. The PR lane's findings carry the `lane` marker and the reason `discovered`. */
export function paneItems(): StoredItem[] {
  return [
    // GitHub: the conversation named these
    issue(5, { firstSeen: 11 }),
    pr(9, { firstSeen: 12, checks: 'pending' }),
    rec(KEYS.other, 'github', 'https://github.com/cli/cli/issues/14640', 'cli/cli#14640', {
      host: 'github.com',
      owner: 'cli',
      repo: 'cli',
      number: 14640,
      type: 'issue',
      state: 'closed',
      title: 'Crash on exit',
      firstSeen: 13,
    }),
    rec(KEYS.bare, 'github', '', '#7', { host: 'github.com', number: 7, type: 'unknown', firstSeen: 14 }),
    issue(12, { firstSeen: 15, priority: 'high', via: [KEYS.head], title: 'Name the lane' }),
    issue(404, {
      firstSeen: 16,
      state: undefined,
      title: undefined,
      error: { kind: 'not-found', message: 'x', at: 1 },
    }),
    pr(15, { firstSeen: 17, isDraft: true, state: 'open' }),
    // GitHub: the PR lane found these
    pr(21, {
      firstSeen: 20,
      ...FOUND,
      title: 'Rework the capture scan',
      headRefName: 'feat/x',
      baseRefName: 'main',
      checks: 'failure',
      closes: [KEYS.issue],
    }),
    pr(22, {
      firstSeen: 21,
      ...FOUND,
      title: 'Stacked on the scan',
      headRefName: 'feat/y',
      baseRefName: 'feat/x',
      checks: 'pending',
    }),
    pr(23, {
      firstSeen: 22,
      ...FOUND,
      title: 'Old work',
      headRefName: 'feat/old',
      baseRefName: 'main',
      checks: 'success',
      state: 'merged',
    }),
    pr(24, {
      firstSeen: 23,
      sources: ['prompt'],
      reasons: addReason(reasonSet('mentioned'), 'discovered') as unknown as Json,
      lane: true,
      title: 'Named and found',
      headRefName: 'feat/z',
      baseRefName: 'main',
      checks: 'success',
    }),
    // Jira
    jira('ISS-1', {
      firstSeen: 30,
      summary: 'The epic',
      issueType: 'Epic',
      status: 'In Progress',
      statusCategory: 'indeterminate',
      refreshedAt: NOW - 60_000,
      via: [KEYS.head],
      children: [
        {
          key: 'PROJ-201',
          summary: 'The task',
          issueType: 'Task',
          status: 'To Do',
          statusCategory: 'new',
          children: [
            {
              key: 'PROJ-301',
              summary: 'The subtask',
              issueType: 'Sub-task',
              status: 'Done',
              statusCategory: 'done',
              priority: 'high',
              children: [],
            },
          ],
        },
        {
          key: 'PROJ-202',
          summary: 'The marked task',
          issueType: 'Task',
          status: 'To Do',
          statusCategory: 'new',
          priority: 'low',
          children: [],
        },
      ],
    }),
    jira('PROJ-201', { firstSeen: 31, summary: 'The task', priority: 'low', via: [KEYS.stacked] }),
    jira('XX-1', {
      firstSeen: 32,
      key: KEYS.jiraTrackOnly,
      site: 'other.example.com',
      url: 'https://other.example.com/browse/XX-1',
      trackOnly: true,
    }),
    jira('GONE-1', { firstSeen: 33, error: { kind: 'not-found', message: 'x', at: 1 } }),
    // Artifacts
    art('11111111-1111-4111-8111-111111111111', 'Design notes', {
      sources: ['tool'],
      reasons: reasonSet('published') as unknown as Json,
      firstSeen: 40,
    }),
    art('22222222-2222-4222-8222-222222222222', 'Old draft', {
      sources: ['tool'],
      reasons: addReason(reasonSet('published'), 'deleted') as unknown as Json,
      deleted: true,
      firstSeen: 41,
    }),
    art('33333333-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333333', { firstSeen: 42 }),
    // Web
    rec(KEYS.web, 'web', 'https://docs.example/a?x=1', 'docs.example/a', { firstSeen: 50, via: [KEYS.head] }),
    rec(KEYS.web2, 'web', 'https://docs.example/b/', 'The B page', { firstSeen: 51 }),
    // Files
    file('/work/plan.md', { created: true, firstSeen: 60 }),
    file('/work/docs/spec.md', { edits: 2, views: 1, firstSeen: 61 }),
    file('/work/README.md', { views: 3, bySubagent: true, firstSeen: 62 }),
  ]
}

const tool = (name: string, f: Partial<ToolStatus> = {}): ToolStatus => ({
  name,
  available: true,
  loggedIn: true,
  breaker: 'closed',
  ...f,
})

export type PaneWorldOpts = {
  /** Tracker ids the config turns off. */
  off?: readonly string[]
  /** Keys of the tracker slices in config.json, by tracker id: `{ auto: { endedTtlMs: 1000 } }`. */
  config?: Readonly<Record<string, JsonObject>>
}

/**
 * The world: a manager with all eight trackers, started, with the item records of `paneItems()`, the tool statuses,
 * the lane state and the facts that the sections read. Nothing is written after the seed: a test that reads the sections
 * can count the state writes from here (`stateSets`).
 */
export async function paneWorld(o: PaneWorldOpts = {}) {
  const trackers: Record<string, JsonObject> = Object.fromEntries((o.off ?? []).map(id => [id, { enabled: false }]))
  for (const [id, slice] of Object.entries(o.config ?? {})) trackers[id] = { ...trackers[id], ...slice }
  const file: JsonObject = { trackers }
  const t = managerWorld({ fake: { now: NOW }, config: specs => fakeConfig({ specs, file }) })
  await t.m.ensureStarted(t.w.ports)
  seedPaneWorld(t.w.state, t.m)
  t.w.stateSets = {}
  return t
}

const wt = (name: string, depth: 0 | 1, f: Partial<WorktreeRow> = {}): WorktreeRow => ({
  id: `wt:/work/${name}`,
  path: `/work/${name}`,
  name,
  branch: `b-${name}`,
  detached: false,
  state: 'live',
  depth,
  ...f,
})

const ag = (id: string, f: Partial<AgentRow> = {}): AgentRow => ({
  id: `ag:${id}`,
  kind: 'subagent',
  label: id,
  depth: 1,
  worktreeLive: true,
  state: 'running',
  ...f,
})

/** The branches the world's round polled, root first. The fact `auto.branches` lists the same ones. */
export const WORLD_BRANCHES = ['main', 'feat/x', 'feat/y'] as const

/**
 * What the last round computed. The master agent is on `feat/x`, the branch of the fact `auto.branches`, so the PR on it
 * gets the level `top` (R7). `at` is older than the fact `auto.checkedAt`, so a note that
 * reads `snapshot.at` instead of the fact says another age.
 */
export const WORLD_SNAPSHOT: AutoSnapshot = {
  at: NOW - 300_000,
  worktrees: [
    wt('work', 0, { id: 'wt:/work', path: '/work', branch: 'main' }),
    wt('feat-x', 1, { branch: 'feat/x' }),
    wt('old-wt', 1, { branch: 'feat/old', state: 'removed' }),
    {
      id: 'wt:/work/detached-wt',
      path: '/work/detached-wt',
      name: 'detached-wt',
      detached: true,
      state: 'live',
      depth: 1,
    },
  ],
  agents: [
    ag('master', {
      kind: 'master',
      label: 'this session',
      depth: 0,
      branch: 'feat/x',
      worktree: 'feat-x',
    }),
    ag('explore', { branch: 'feat/y', worktree: 'agent-a94bdd45b56e2c631' }),
    ag('review', { depth: 2, state: 'ended', branch: 'feat/y', worktree: 'agent-a94bdd45b56e2c631' }),
    ag('build', { kind: 'workflow', state: 'waiting', workflow: { runId: 'wf_a35565d1-fd4', agentIndex: 2 } }),
    ag('lint', { state: 'failed', worktreeLive: false }),
  ],
  branches: [...WORLD_BRANCHES],
  overflow: 0,
  git: { ok: true, at: NOW },
  agentList: { ok: true, at: NOW },
}

export const WORLD_AUTO: AutoState = {
  root: { cwd: '/work', top: '/work', at: 1 },
  worktrees: [],
  agents: [],
  dismissed: [],
  snapshot: WORLD_SNAPSHOT,
}

const repo = (name: string, f: Partial<RepoRecord> = {}): RepoRecord => ({
  key: `remote:github.com/acme/${name}`,
  name: `acme/${name}`,
  branch: 'main',
  mode: 'read',
  touchedBy: ['main'],
  firstSeen: 5,
  lastSeen: 5,
  ...f,
})

/** Two repos, the later-seen one first in the slot: the section sorts by the first sighting. */
export const WORLD_REPOS: RepoRecord[] = [
  repo('sdk', { firstSeen: 9, lastSeen: 9, mode: 'edit', branch: 'dev', touchedBy: ['main', 'planner'] }),
  repo('web', { firstSeen: 2, lastSeen: 20, branch: undefined }),
]

const proc = (id: string, f: Partial<ProcessRecord> = {}): ProcessRecord => ({
  id,
  kind: 'background-task',
  name: id,
  state: 'running',
  firstSeen: 3,
  lastSeen: 3,
  ...f,
})

/** Three processes: a running task, a container that is up and a detached process that failed. */
export const WORLD_PROCESSES: ProcessRecord[] = [
  proc('bg:1', { name: 'npm run dev' }),
  proc('docker:db', { kind: 'docker-container', name: 'db', state: 'up' }),
  proc('pid:77', { kind: 'detached-process', name: 'worker', state: 'failed', pid: 77 }),
]

export const WORLD_PROCESS_UI: ProcessUiState = { breaker: 'closed', dockerIssue: 'docker: daemon not running' }

/** The seed of the world: the lists, the tool statuses, the slots and the facts the sections read. */
export function seedPaneWorld(state: Map<string, Json>, m: Pick<LifecycleManager, 'facts'>): void {
  state.set('items', paneItems() as unknown as Json)
  state.set('tools', {
    gh: tool('gh', { version: '2.102.0', lastRunAt: NOW - 120_000 }),
    acli: tool('acli', { site: 'acme.atlassian.net', lastRunAt: NOW - 60_000 }),
  } as unknown as Json)
  state.set('github', { prs: { ok: true, at: NOW - 30_000 }, defaultBranch: 'main' })
  state.set('auto', WORLD_AUTO as unknown as Json)
  state.set('repos', WORLD_REPOS as unknown as Json)
  state.set('processes', WORLD_PROCESSES as unknown as Json)
  m.facts.publish('session.repo', SESSION_REPO)
  m.facts.publish('auto.root', { cwd: '/work', top: '/work', at: 1 })
  m.facts.publish('auto.checkedAt', NOW - 30_000)
  m.facts.publish('processes.ui', WORLD_PROCESS_UI as unknown as Json)
  setBranches(m, { current: 'feat/x', branches: WORLD_BRANCHES })
}

/**
 * Publishes `auto.branches` with the round of the fact now, so the PR lane starts no step: a step would call `gh` and
 * write the item list while a test reads it. `branches` is the list the lane would poll.
 */
export function setBranches(
  m: Pick<LifecycleManager, 'facts'>,
  o: { current?: string; branches?: readonly string[]; overflow?: number } = {},
): void {
  const seq = (m.facts.read<{ seq: number }>('auto.branches') ?? { seq: 0 }).seq
  m.facts.publish('auto.branches', {
    seq,
    reasons: [],
    ...(o.current !== undefined ? { current: o.current } : {}),
    branches: o.branches ?? [],
    overflow: o.overflow ?? 0,
  } as unknown as Json)
}
