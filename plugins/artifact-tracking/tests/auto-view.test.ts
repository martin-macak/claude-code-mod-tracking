// Auto sections, cells, text rules, band parts and composers. Pure.
import { expect, test } from 'claude-code/testing'
import type {
  AgentRow,
  AutoSnapshot,
  AutoState,
  GitHubRecord,
  ItemRecord,
  ToolStatus,
  WebRecord,
  WorktreeRow,
} from '../hooks/contracts'
import {
  autoBandParts,
  buildAutoSections,
  compactIds,
  composeBand,
  composeCommandText,
  composePane,
} from '../hooks/ui/auto-view'
import { cellsFor, type Layout, textOf, type ViewContext } from '../hooks/ui/view'

const NOW = 1_000_000

const tool = (name: 'gh' | 'acli', over: Partial<ToolStatus> = {}): ToolStatus => ({
  name,
  available: true,
  loggedIn: true,
  breaker: 'closed',
  ...over,
})
const wt = (name: string, depth: 0 | 1, over: Partial<WorktreeRow> = {}): WorktreeRow => ({
  id: `wt:/r/${name}`,
  path: `/r/${name}`,
  name,
  branch: `b-${name}`,
  detached: false,
  state: 'live',
  depth,
  ...over,
})
const ag = (id: string, over: Partial<AgentRow> = {}): AgentRow => ({
  id: `ag:${id}`,
  kind: 'subagent',
  label: id,
  depth: 1,
  worktreeLive: true,
  state: 'running',
  ...over,
})
const MASTER = ag('master', {
  kind: 'master',
  label: 'this session',
  depth: 0,
  branch: 'feat/auto-tracking',
  worktree: 'auto-tracking',
})

const snapshot = (over: Partial<AutoSnapshot> = {}): AutoSnapshot => ({
  at: NOW - 12_000,
  worktrees: [wt('repo', 0, { id: 'wt:/r', path: '/r', branch: 'main' }), wt('probe-wt', 1)],
  agents: [MASTER, ag('explore', { branch: 'worktree-agent-a94bdd45b56e2c631', worktree: 'agent-a94bdd45b56e2c631' })],
  branches: ['main', 'b-probe-wt'],
  overflow: 0,
  git: { ok: true, at: NOW },
  agentList: { ok: true, at: NOW },
  prs: { ok: true },
  defaultBranch: 'main',
  ...over,
})
const auto = (snap: Partial<AutoSnapshot> | null = {}, top: string | null = '/r'): AutoState => ({
  root: { cwd: '/r', at: 1, top },
  worktrees: [],
  agents: [],
  dismissed: [],
  snapshot: snap === null ? null : snapshot(snap),
})

const ctx = (over: Partial<ViewContext> = {}): ViewContext => ({
  now: NOW,
  folded: [],
  tools: { gh: tool('gh'), acli: tool('acli', { site: 'acme.atlassian.net' }) },
  sessionRepo: { host: 'github.com', owner: 'acme', repo: 'web' },
  ...over,
})

const pr = (n: number, over: Partial<GitHubRecord> = {}): GitHubRecord => ({
  key: `gh:github.com/acme/web#${n}`,
  category: 'github',
  url: `https://github.com/acme/web/pull/${n}`,
  label: `acme/web#${n}`,
  sources: ['auto'],
  firstSeen: n,
  lastSeen: n,
  seenCount: 0,
  refreshedAt: NOW - 20_000,
  host: 'github.com',
  owner: 'acme',
  repo: 'web',
  number: n,
  type: 'pr',
  title: `PR ${n}`,
  state: 'open',
  checks: 'failure',
  headRefName: 'feat/auto-tracking',
  baseRefName: 'main',
  ...over,
})
const web = (url: string, over: Partial<WebRecord> = {}): WebRecord => ({
  key: `web:${url}`,
  category: 'web',
  url,
  label: url,
  sources: ['response'],
  firstSeen: 1,
  lastSeen: 1,
  seenCount: 1,
  ...over,
})
const byId = (sections: ReturnType<typeof buildAutoSections>, id: string) => sections.find(s => s.id === id)

// ---------------------------------------------------------------- cellsFor

const LAYOUTS: Layout[] = ['worktrees', 'agents', 'prs', 'items']

test('cellsFor at 62 columns: the narrow cells of spec 10.1', () => {
  const names = (l: Layout, x: boolean) => cellsFor(62, l, x).map(c => [c.name, c.width])
  expect(names('worktrees', true)).toEqual([
    ['key', 24],
    ['title', undefined],
    ['status', 8],
    ['x', 2],
  ])
  expect(names('agents', true)).toEqual([
    ['key', 20],
    ['title', undefined],
    ['type', 14],
    ['x', 2],
  ])
  expect(names('prs', true)).toEqual([
    ['key', 8],
    ['title', undefined],
    ['type', 20],
    ['status', 8],
    ['x', 2],
  ])
  expect(names('items', true)).toEqual([
    ['key', 16],
    ['title', undefined],
    ['type', 6],
    ['status', 13],
    ['x', 2],
  ])
})

test('cellsFor at 100 columns: the wide cells', () => {
  const names = (l: Layout) => cellsFor(100, l, true).map(c => [c.name, c.width])
  expect(names('worktrees')).toEqual([
    ['key', 30],
    ['title', undefined],
    ['status', 9],
    ['x', 2],
  ])
  expect(names('agents')).toEqual([
    ['key', 24],
    ['title', undefined],
    ['type', 20],
    ['x', 2],
  ])
  expect(names('prs')).toEqual([
    ['key', 8],
    ['title', undefined],
    ['type', 26],
    ['status', 8],
    ['extra', 10],
    ['x', 2],
  ])
  expect(names('items')).toEqual([
    ['key', 16],
    ['title', undefined],
    ['type', 9],
    ['status', 13],
    ['extra', 10],
    ['x', 2],
  ])
})

test('cellsFor: a hidden cell is not in the list, and x only when dismissable', () => {
  expect(cellsFor(62, 'prs', false).map(c => c.name)).toEqual(['key', 'title', 'type', 'status'])
  expect(cellsFor(62, 'items', false).some(c => c.name === 'extra')).toBe(false)
  expect(cellsFor(100, 'worktrees', false).some(c => c.name === 'x')).toBe(false)
})

test('cellsFor leaves the title at least 12 columns for every layout, at 62 and at 100', () => {
  for (const cols of [62, 100]) {
    for (const layout of LAYOUTS) {
      for (const x of [false, true]) {
        const cells = cellsFor(cols, layout, x)
        const fixed = cells.reduce((sum, c) => sum + (c.width ?? 0), 0)
        const room = cols - fixed - (cells.length - 1)
        expect(room).toBeGreaterThan(11)
        expect(cells.filter(c => c.width === undefined).map(c => c.name)).toEqual(['title'])
      }
    }
  }
})

test('cellsFor wrap modes: branches cut in the middle, titles at the end', () => {
  const wrap = (l: Layout, n: string) => cellsFor(62, l, true).find(c => c.name === n)?.wrap
  expect(wrap('worktrees', 'title')).toBe('truncate-middle')
  expect(wrap('agents', 'title')).toBe('truncate-middle')
  expect(wrap('agents', 'type')).toBe('truncate-middle')
  expect(wrap('prs', 'title')).toBe('truncate-end')
  expect(wrap('prs', 'type')).toBe('truncate-middle')
})

test('cellsFor items without x: literal widths, narrow below 70 and wide from 70', () => {
  const widths = (c: number | undefined) =>
    cellsFor(c, 'items', false).map(x => [x.name, x.width] as [string, number | undefined])
  const narrow = [
    ['key', 16],
    ['title', undefined],
    ['type', 6],
    ['status', 13],
  ]
  const wide = [
    ['key', 16],
    ['title', undefined],
    ['type', 9],
    ['status', 13],
    ['extra', 10],
  ]
  expect(widths(62)).toEqual(narrow)
  expect(widths(69)).toEqual(narrow)
  expect(widths(70)).toEqual(wide)
  expect(widths(100)).toEqual(wide)
  expect(widths(undefined)).toEqual(wide)
})

// ---------------------------------------------------------------- compactIds

test('compactIds: an agent id compacts to 8 hex, in names, branches and worktrees', () => {
  expect(compactIds('agent-a94bdd45b56e2c631')).toBe('agent-a94bdd45')
  expect(compactIds('worktree-agent-a94bdd45b56e2c631')).toBe('worktree-agent-a94bdd45')
  expect(compactIds('agent-a94bdd45')).toBe('agent-a94bdd45')
})

test('compactIds: a workflow run id keeps 6 characters before the last -digits', () => {
  expect(compactIds('wf_a35565d1-fd4-21')).toBe('wf_a35565-21')
  expect(compactIds('wf_abc-1')).toBe('wf_abc-1')
})

test('compactIds leaves a long hex string that is not an agent id alone', () => {
  expect(compactIds('fix/deadbeefcafe1234')).toBe('fix/deadbeefcafe1234')
  expect(compactIds('abc1234567890abcdef')).toBe('abc1234567890abcdef')
  expect(compactIds('agent-a94bdd4')).toBe('agent-a94bdd4')
})

// ---------------------------------------------------------------- sections

test('buildAutoSections: order, and a hidden section when its rows are missing', () => {
  const all = buildAutoSections(auto(), [pr(7)], ctx())
  expect(all.map(s => s.id)).toEqual(['worktrees', 'agents', 'prs'])
  expect(buildAutoSections(null, [], ctx())).toEqual([])
  expect(buildAutoSections(auto(null), [], ctx())).toEqual([])
  const noKids = auto({ worktrees: [wt('repo', 0)] })
  expect(buildAutoSections(noKids, [], ctx()).map(s => s.id)).toEqual(['agents'])
  const onlyMaster = auto({ agents: [MASTER] })
  expect(buildAutoSections(onlyMaster, [], ctx()).map(s => s.id)).toEqual(['worktrees'])
  expect(buildAutoSections(auto({}, null), [], ctx()).map(s => s.id)).toEqual(['agents'])
})

test('Worktrees: root row, live child, dimmed removed child with a dismiss id; note counts and age', () => {
  const a = auto({
    worktrees: [
      wt('repo', 0, { id: 'wt:/r', path: '/r', branch: 'main' }),
      wt('live', 1),
      wt('gone', 1, { state: 'removed' }),
    ],
  })
  const s = byId(buildAutoSections(a, [], ctx()), 'worktrees')!
  expect(s.title).toBe('Worktrees')
  expect(s.layout).toBe('worktrees')
  expect(s.dismissable).toBe(true)
  expect(s.note).toBe('git · 1 live · 1 removed · checked 12s ago')
  expect(s.rows.map(r => [r.key, r.title, r.status, r.depth, r.dim ?? false, r.dismissId])).toEqual([
    ['repo', 'main', '', 0, false, undefined],
    ['live', 'b-live', '', 1, false, 'wt:/r/live'],
    ['gone', 'b-gone', 'removed', 1, true, 'wt:/r/gone'],
  ])
  expect(s.rows[0]).toMatchObject({ foldable: true, folded: false })
})

test('Worktrees: the age reads ctx.autoCheckedAt first; failed git replaces the note; folding the root hides children', () => {
  const a = auto()
  expect(byId(buildAutoSections(a, [], ctx({ autoCheckedAt: NOW - 3000 })), 'worktrees')!.note).toBe(
    'git · 1 live · checked 3s ago',
  )
  expect(byId(buildAutoSections(a, [], ctx({ autoCheckedAt: NOW })), 'worktrees')!.note).toBe(
    'git · 1 live · checked just now',
  )
  const failed = auto({ git: { ok: false, at: NOW, error: 'fatal: boom' } })
  expect(byId(buildAutoSections(failed, [], ctx()), 'worktrees')!.note).toBe('git failed: fatal: boom')
  const folded = byId(buildAutoSections(a, [], ctx({ folded: ['wt:/r'] })), 'worktrees')!
  expect(folded.rows).toHaveLength(1)
  expect(folded.rows[0]?.folded).toBe(true)
})

test('Worktrees: a detached child shows (detached) in the branch cell', () => {
  const a = auto({
    worktrees: [wt('repo', 0, { id: 'wt:/r', path: '/r' }), wt('d', 1, { branch: undefined, detached: true })],
  })
  expect(byId(buildAutoSections(a, [], ctx()), 'worktrees')!.rows[1]?.title).toBe('(detached)')
})

test('Agents: markers, workflow prefix, compact ids, dimmed ended and failed rows, dismiss ids', () => {
  const agents = [
    MASTER,
    ag('Explore code', { branch: 'worktree-agent-a94bdd45b56e2c631', worktree: 'agent-a94bdd45b56e2c631' }),
    ag('architect', { kind: 'workflow', workflow: { runId: 'wf_x', agentIndex: 3 }, depth: 1, state: 'waiting' }),
    ag('done', { state: 'ended', depth: 2 }),
    ag('bad', { state: 'failed', depth: 2 }),
  ]
  const s = byId(buildAutoSections(auto({ agents }), [], ctx()), 'agents')!
  expect(s.layout).toBe('agents')
  expect(s.rows.map(r => [r.key, r.depth, r.dim ?? false, r.dismissId])).toEqual([
    ['● this session', 0, false, undefined],
    ['● Explore code', 1, false, 'ag:Explore code'],
    ['● wf·3 architect', 1, false, 'ag:architect'],
    ['✓ done', 2, true, 'ag:done'],
    ['✗ bad', 2, true, 'ag:bad'],
  ])
  expect(s.rows[1]).toMatchObject({ title: 'worktree-agent-a94bdd45', type: 'agent-a94bdd45' })
  expect(s.rows[0]).toMatchObject({ title: 'feat/auto-tracking', type: 'auto-tracking', foldable: true })
  expect(s.note).toBe('2 running · 2 ended')
})

test('Agents: zero parts are left out, a failed list is named, and folding the master hides the rest', () => {
  const only = auto({ agents: [MASTER, ag('a', { state: 'ended' })] })
  expect(byId(buildAutoSections(only, [], ctx()), 'agents')!.note).toBe('1 ended')
  const failed = auto({ agentList: { ok: false, at: NOW, error: 'x' } })
  expect(byId(buildAutoSections(failed, [], ctx()), 'agents')!.note).toBe('1 running · agent list failed')
  const folded = byId(buildAutoSections(auto(), [], ctx({ folded: ['ag:master'] })), 'agents')!
  expect(folded.rows.map(r => r.id)).toEqual(['ag:master'])
})

test('Pull requests: a discovered PR shows only here, never under GitHub', () => {
  const sections = composePane([pr(7)], ctx({ auto: auto() }))
  expect(sections.map(s => s.id)).toEqual(['worktrees', 'agents', 'prs'])
})

test('Pull requests: key, title, head branch, status with a checks glyph (narrow), dismiss id', () => {
  const s = byId(buildAutoSections(auto(), [pr(7)], ctx({ bodyColumns: 62 })), 'prs')!
  expect(s.layout).toBe('prs')
  expect(s.rows[0]).toMatchObject({
    key: '#7',
    title: 'PR 7',
    type: 'feat/auto-tracking',
    status: 'open ✗',
    tone: 'ok',
    extra: '✗ checks',
    dismissId: 'gh:github.com/acme/web#7',
  })
  expect(s.rows[0]?.typeWrap).toBeUndefined()
  expect(s.note).toBe('gh · refreshed 20s ago')
})

test('Pull requests: at 100 columns the checks sit in the extra cell only, not in the status as well', () => {
  const row = byId(buildAutoSections(auto(), [pr(7)], ctx({ bodyColumns: 100 })), 'prs')!.rows[0]!
  expect(row.status).toBe('open')
  expect(row.extra).toBe('✗ checks')
  expect(cellsFor(100, 'prs', true).some(c => c.name === 'extra')).toBe(true)
  // At 70 columns, the first wide width, the same. At 69 the extra cell is gone and the glyph joins the status.
  expect(byId(buildAutoSections(auto(), [pr(7)], ctx({ bodyColumns: 70 })), 'prs')!.rows[0]?.status).toBe('open')
  expect(byId(buildAutoSections(auto(), [pr(7)], ctx({ bodyColumns: 69 })), 'prs')!.rows[0]?.status).toBe('open ✗')
  expect(cellsFor(69, 'prs', true).some(c => c.name === 'extra')).toBe(false)
  // The /track text has no width: the checks show once.
  expect(textOf(buildAutoSections(auto(), [pr(7)], ctx()))).not.toContain('✗ ✗')
})

test('Pull requests: a PR on a non-default base is stacked: arrow and base, cut at the end', () => {
  const s = byId(
    buildAutoSections(auto(), [pr(9, { baseRefName: 'feat/auto-tracking', headRefName: 'feat/band' })], ctx()),
    'prs',
  )!
  expect(s.rows[0]).toMatchObject({ type: '→feat/auto-tracking', typeWrap: 'truncate-end' })
})

test('Pull requests: draft, pending and success glyphs; merged and closed rows are dimmed; other repo keeps o/r', () => {
  const rows = byId(
    buildAutoSections(
      auto(),
      [
        pr(1, { isDraft: true, checks: 'pending' }),
        pr(2, { state: 'merged', checks: 'success' }),
        pr(3, { state: 'closed', checks: 'none' }),
        pr(4, { owner: 'other', repo: 'repo', key: 'gh:github.com/other/repo#4' }),
      ],
      ctx({ bodyColumns: 62 }),
    ),
    'prs',
  )!.rows
  expect(rows.map(r => [r.key, r.status, r.dim ?? false])).toEqual([
    ['#1', 'draft …', false],
    ['#2', 'merged ✓', true],
    ['#3', 'closed', true],
    ['other/repo#4', 'open ✗', false],
  ])
})

test('Pull requests: the note names overflow and untracked items', () => {
  const a = auto({ overflow: 2, prs: { ok: true, untracked: 3 } })
  expect(byId(buildAutoSections(a, [pr(7)], ctx()), 'prs')!.note).toBe(
    'gh · refreshed 20s ago · +2 branches not polled · +3 not tracked',
  )
})

test('Pull requests: with no PR, only a skip or an error shows a header', () => {
  const skipped = (prs: AutoSnapshot['prs']) => byId(buildAutoSections(auto({ prs }), [], ctx()), 'prs')
  expect(skipped({ ok: true })).toBeUndefined()
  expect(skipped({ ok: false, skipped: 'no-branches' })).toBeUndefined()
  expect(skipped({ ok: false, skipped: 'no-gh' })?.note).toBe('gh not installed')
  expect(skipped({ ok: false, skipped: 'not-logged-in' })?.note).toBe('gh not logged in to github.com')
  expect(skipped({ ok: false, skipped: 'host-not-authed' })?.note).toBe('gh not logged in to github.com')
  expect(skipped({ ok: false, skipped: 'paused' })?.note).toContain('gh · ')
  expect(skipped({ ok: false, error: 'reply over 4 MiB' })?.note).toBe('gh · discovery failed: reply over 4 MiB')
  expect(skipped({ ok: false, skipped: 'no-gh' })?.rows).toEqual([])
  expect(skipped({ ok: false, skipped: 'no-repo' })).toBeUndefined()
  const withPr = buildAutoSections(auto({ prs: { ok: false, skipped: 'no-repo' } }), [pr(7)], ctx())
  expect(byId(withPr, 'prs')?.note).toBe('no GitHub repo')
})

// ---------------------------------------------------------------- band and composers

test('autoBandParts counts live children, running agents and open PRs with failing checks', () => {
  const a = auto({
    worktrees: [wt('repo', 0), wt('a', 1), wt('b', 1), wt('c', 1, { state: 'removed' })],
    agents: [MASTER, ag('x'), ag('y', { state: 'waiting' }), ag('z', { state: 'ended' })],
  })
  const items = [pr(1), pr(2, { checks: 'success' }), pr(3, { state: 'merged' })]
  expect(autoBandParts(a, items)).toEqual(['Worktrees 2', 'Agents 2', 'PRs 2 (1 ✗)'])
  expect(autoBandParts(null, [])).toEqual([])
  expect(autoBandParts(null, [pr(1, { checks: 'success' })])).toEqual(['PRs 1'])
})

test('composeBand joins the item parts and the auto parts; nothing at all is null', () => {
  const a = auto({ worktrees: [wt('repo', 0), wt('a', 1)], agents: [MASTER] })
  expect(composeBand([web('https://x.example/')], a)).toBe('Links 1 · Worktrees 1')
  expect(composeBand([], a)).toBe('Worktrees 1')
  expect(composeBand([], null)).toBeNull()
  expect(composeBand([], auto({ worktrees: [wt('repo', 0)], agents: [MASTER] }))).toBeNull()
})

test('composePane puts the auto sections first, then Jira, GitHub, Web links', () => {
  const sections = composePane([web('https://x.example/'), { ...pr(1), sources: ['prompt'] }], ctx({ auto: auto() }))
  expect(sections.map(s => s.id)).toEqual(['worktrees', 'agents', 'github', 'web'])
})

test('composeCommandText lists the auto sections as text; empty is the old message', () => {
  const text = composeCommandText([pr(7)], ctx({ auto: auto() }))
  expect(text).toContain('Worktrees  git · 1 live')
  expect(text).toContain('Agents  1 running')
  expect(text).toContain('Pull requests  gh · refreshed 20s ago')
  expect(text).toContain('#7  PR 7')
  expect(composeCommandText([], ctx())).toBe('No tracked items yet.')
})

test('a body ref shows in its own section with the via prefix, and an auto-only one can be dismissed', () => {
  const ref: ItemRecord = {
    ...web('https://x.example/spec'),
    sources: ['pr-body'],
    via: ['gh:github.com/acme/web#7', 'gh:github.com/acme/web#9'],
    seenCount: 0,
  }
  const sections = composePane([ref], ctx({ auto: auto() }))
  const row = sections.find(s => s.id === 'web')!.rows[0]!
  expect(row.title.startsWith('↳#7,#9 ')).toBe(true)
  expect(row.dismissId).toBe(ref.key)
})
