// The merge chip, the hint and the file rows of a PR in the Pull requests and GitHub sections, and the PR band part
// (issue #50). Pure: the rows and `sections` read a view context that the test builds. The chip, the checks and the hint
// are the badges of the extras column, in that order (issue #63, L1).
import { expect, test } from 'claude-code/testing'
import type { StoredItem } from '../core/interfaces/items'
import type { Cell, ViewContext } from '../core/interfaces/view'
import { GLOBAL_DEFAULTS } from '../core/lib/global-config'
import { listGroups } from '../core/lib/grouping'
import { GITHUB_DEFAULTS } from '../trackers/github/config'
import { UNKNOWN_SPENT } from '../trackers/github/merge'
import { HINT } from '../trackers/github/resolve'
import { githubRow, prKeyOfRow, prRow } from '../trackers/github/rows'
import { sections } from '../trackers/github/sections'
import type { GitHubRecord, LaneState, MergeNote } from '../trackers/github/types'
import type { ToolStatus } from '../types'
import { bandText } from '../ux/band'
import { SHARED_COLUMNS, solveColumns } from '../ux/tree-data-table/columns'
import { groupsText } from '../ux/tree-data-table/text'
import { LANE, named } from './fixtures/reasons'

const NOW = 5_000_000
const GH = 'https://github.com/acme/web'

const pr = (n: number, over: Partial<GitHubRecord> = {}): GitHubRecord => ({
  key: `gh:github.com/acme/web#${n}`,
  category: 'github',
  url: `${GH}/pull/${n}`,
  label: `acme/web#${n}`,
  ...LANE,
  firstSeen: n,
  lastSeen: n,
  seenCount: 0,
  host: 'github.com',
  owner: 'acme',
  repo: 'web',
  number: n,
  type: 'pr',
  title: `PR ${n}`,
  state: 'open',
  checks: 'success',
  headRefName: `feat/p${n}`,
  baseRefName: 'main',
  ...over,
})

const GH_OK: ToolStatus = { name: 'gh', available: true, loggedIn: true, breaker: 'closed' }

function view(items: GitHubRecord[], lane: Partial<LaneState> = {}, gh: ToolStatus | undefined = GH_OK) {
  const ctx: ViewContext<typeof GITHUB_DEFAULTS, LaneState> = {
    now: NOW,
    config: { slice: () => GITHUB_DEFAULTS, global: () => GLOBAL_DEFAULTS },
    data: { prs: { ok: true }, defaultBranch: 'main', ...lane },
    items: items as unknown as readonly StoredItem[],
    facts: { read: () => undefined },
    tools: gh === undefined ? {} : { gh },
    selected: null,
    expanded: new Set(),
    root: undefined,
    hidden: { showAll: false },
    isDismissed: () => false,
    levelOf: () => ({}),
  }
  return ctx
}

const prsSection = (ctx: ReturnType<typeof view>) => sections(ctx).find(s => s.id === 'prs')!
const rowOf = (ctx: ReturnType<typeof view>, n: number) => prsSection(ctx).rows.find(r => r.id.endsWith(`#${n}`))!
/** The badges of the row of PR `n`, in the order they draw. */
const badges = (ctx: ReturnType<typeof view>, n: number): readonly Cell[] => rowOf(ctx, n).extras ?? []
const texts = (ctx: ReturnType<typeof view>, n: number): string[] => badges(ctx, n).map(b => b.text)
/** The `success` checks that every PR of these tests has: the badge after the chip. */
const OK: Cell = { text: '✓ checks', fg: 'success' }
const K = (n: number) => `gh:github.com/acme/web#${n}`
/** The /track text of the sections of the view. */
const text = (ctx: ReturnType<typeof view>): string => groupsText(listGroups(sections(ctx)))

// ---------------------------------------------------------------- the chip in the row

test('AC1: a CONFLICTING open PR row has the red ✗ conflicts chip, the first badge of the extras', () => {
  const ctx = view([pr(7, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })])
  expect(badges(ctx, 7)).toEqual([{ text: '✗ conflicts', fg: 'error' }, OK])
})

test('AC2: a MERGEABLE and BEHIND PR row has the yellow ↓ behind chip and no conflict chip', () => {
  const ctx = view([pr(7, { mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' })])
  expect(badges(ctx, 7)).toEqual([{ text: '↓ behind', fg: 'warning' }, OK])
})

test('AC3: a stacked PR keeps →<base> in the type cell and shows the chip on the same row', () => {
  const ctx = view([pr(7, { baseRefName: 'fix/stack-base', mergeable: 'CONFLICTING' })])
  expect(rowOf(ctx, 7).cells.type?.text).toBe('→fix/stack-base')
  expect(badges(ctx, 7)).toEqual([{ text: '✗ conflicts', fg: 'error' }, OK])
})

test('the checks badge stays beside the chip: a conflict hides no checks glyph', () => {
  const ctx = view([pr(7, { checks: 'failure', mergeable: 'CONFLICTING' })])
  expect(badges(ctx, 7)).toEqual([
    { text: '✗ conflicts', fg: 'error' },
    { text: '✗ checks', fg: 'error' },
  ])
})

test('AC6: a draft PR with CONFLICTING and DRAFT shows the chip; its state cell still says draft', () => {
  const ctx = view([pr(7, { isDraft: true, mergeable: 'CONFLICTING', mergeStateStatus: 'DRAFT' })])
  expect(texts(ctx, 7)[0]).toBe('✗ conflicts')
  // The word stays `draft`. A draft takes the token of an open PR, and a conflict is a failure: the word draws red.
  expect(rowOf(ctx, 7).cells.status).toEqual({ text: 'draft', fg: 'error' })
})

test('AC4: an UNKNOWN PR shows no chip until the retries are spent, then the dim ? merge', () => {
  const unknown = pr(7, { mergeable: 'UNKNOWN' })
  expect(badges(view([unknown]), 7)).toEqual([OK])
  const waiting: Record<string, MergeNote> = { [K(7)]: { unknown: UNKNOWN_SPENT - 1 } }
  expect(badges(view([unknown], { merge: waiting }), 7)).toEqual([OK])
  const spent: Record<string, MergeNote> = { [K(7)]: { unknown: UNKNOWN_SPENT } }
  expect(badges(view([unknown], { merge: spent }), 7)).toEqual([{ text: '? merge', dim: true }, OK])
})

test('AC11: with gh logged out, or its breaker open, no merge chip shows and the band counts no conflict', () => {
  const items = [pr(7, { mergeable: 'CONFLICTING' }), pr(8, { mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' })]
  for (const gh of [
    { ...GH_OK, loggedIn: false },
    { ...GH_OK, breaker: 'open' as const },
  ]) {
    const ctx = view(items, {}, gh)
    expect(badges(ctx, 7)).toEqual([OK])
    expect(badges(ctx, 8)).toEqual([OK])
    expect(prsSection(ctx).band?.conflicts).toBeUndefined()
  }
  expect(texts(view(items, {}, GH_OK), 7)[0]).toBe('✗ conflicts') // the same rows with a working gh
})

test('a PR with no merge value, a merged PR and an issue draw no merge chip', () => {
  const ctx = view([pr(7), pr(8, { state: 'merged', mergeable: 'CONFLICTING' })])
  expect(badges(ctx, 7)).toEqual([OK])
  expect(badges(ctx, 8)).toEqual([OK])
  const issue = githubRow(pr(9, { type: 'issue', mergeable: 'CONFLICTING' }), {
    facts: { read: () => undefined },
    levelOf: () => ({}),
  })
  expect(issue.extras).toEqual([OK])
})

test('the GitHub section shows the chip of a PR the conversation named, from the same refresh fields', () => {
  const fromChat = named(pr(9, { mergeable: 'CONFLICTING' }))
  const github = sections(view([fromChat])).find(s => s.id === 'github')!
  expect(github.rows[0]?.extras?.[0]).toEqual({ text: '✗ conflicts', fg: 'error' })
})

// ---------------------------------------------------------------- the hint and the resolve state

test('AC10: a CONFLICTING PR with no local worktree has a dim hint; one with a worktree has none', () => {
  const conflicted = pr(7, { mergeable: 'CONFLICTING' })
  const noTree = view([conflicted], { merge: { [K(7)]: {} } })
  expect(badges(noTree, 7).at(-1)).toEqual({ text: 'no worktree', dim: true })
  const tree = view([conflicted], { merge: { [K(7)]: { worktree: '/w/p7' } } })
  expect(texts(tree, 7)).toEqual(['✗ conflicts', '✓ checks']) // no hint
  expect(texts(view([pr(8)]), 8)).toEqual(['✓ checks']) // not conflicting: nothing to say
})

test('m2: the hint says in a word why the resolve key is off: a fork, a name that is not put in a prompt, no default branch', () => {
  const note = { merge: { [K(7)]: { worktree: '/w/p7' } } }
  const mark = (rec: GitHubRecord, lane: Partial<LaneState> = note) => badges(view([rec], lane), 7).at(-1)
  expect(mark(pr(7, { mergeable: 'CONFLICTING', crossRepo: true }))).toEqual({ text: 'fork PR', dim: true })
  expect(mark(pr(7, { mergeable: 'CONFLICTING', headRefName: 'a b' }))).toEqual({ text: 'odd branch', dim: true })
  expect(mark(pr(7, { mergeable: 'CONFLICTING' }), { ...note, defaultBranch: undefined })).toEqual({
    text: 'no default',
    dim: true,
  })
})

test('m2: every hint word fits the width of the extras column, so a hint alone is not cut', () => {
  const extras = SHARED_COLUMNS.find(c => c.id === 'extras')!
  const max = extras.width.kind === 'content' ? (extras.width.max ?? 0) : 0
  expect(max).toBeGreaterThan(0)
  for (const word of Object.values(HINT)) expect(word.length, word).toBeLessThanOrEqual(max)
})

test('the no-worktree hint is off while gh is stale, for a queued PR and for a PR the lane has no note on', () => {
  const conflicted = pr(7, { mergeable: 'CONFLICTING' })
  expect(texts(view([conflicted], { merge: { [K(7)]: {} } }, { ...GH_OK, loggedIn: false }), 7)).toEqual(['✓ checks'])
  expect(texts(view([conflicted]), 7)).toEqual(['✗ conflicts', '✓ checks']) // the lane has not looked yet: no hint
  expect(texts(view([conflicted], { merge: { [K(7)]: { queuedAt: NOW - 1 } } }), 7)[0]).toBe('queued')
})

// ---------------------------------------------------------------- the file rows (P2)

test('n2: the id of a child row under a PR leads back to the PR; the id of a PR is left as it is', () => {
  expect(prKeyOfRow(`${K(7)}#files:0`)).toBe(K(7))
  expect(prKeyOfRow(`${K(7)}#files:12`)).toBe(K(7))
  expect(prKeyOfRow(K(7))).toBe(K(7))
  expect(prKeyOfRow('gh:github.com/acme/web#files:x')).toBe('gh:github.com/acme/web#files:x') // not a child id
})

test('m6: /track text shows the conflict chip, the hint and the conflicting files of a PR (issue #50)', () => {
  const files = { at: NOW - 5000, files: ['src/a.ts', 'src/b.ts'] }
  const ctx = view([pr(7, { mergeable: 'CONFLICTING' })], { merge: { [K(7)]: { files } } })
  // Byte for byte, as `main` printed it before the pane drew one table (issue #63, L1): the badges stay in the order merge, checks, hint.
  expect(text(ctx)).toBe(
    'Pull requests  gh · ready\n  acme/web#7  PR 7  feat/p7  open  ✗ conflicts  ✓ checks  no worktree\n    src/a.ts\n    src/b.ts',
  )
  const lines = text(ctx).split('\n')
  const prLine = lines.find(l => l.includes('#7'))!
  expect(prLine).toContain('✗ conflicts')
  expect(prLine).toContain('no worktree')
  expect(lines.filter(l => l.startsWith('    src/'))).toEqual(['    src/a.ts', '    src/b.ts']) // child rows, one level in
})

test('files found for a conflicted PR are child rows, open by default, one per file', () => {
  const files = { at: NOW - 5000, files: ['src/a.ts', 'src/b.ts'] }
  const ctx = view([pr(7, { mergeable: 'CONFLICTING' })], { merge: { [K(7)]: { worktree: '/w', files } } })
  const row = rowOf(ctx, 7)
  expect(row.expandedByDefault).toBe(true)
  expect(row.children?.map(c => c.cells.description?.text)).toEqual(['src/a.ts', 'src/b.ts'])
  expect(row.children?.every(c => c.owner === 'github' && c.can?.dismiss !== true)).toBe(true)
  expect(new Set(row.children?.map(c => c.id)).size).toBe(2)
})

test('files: the ones past the cap read +N more, a failed look reads its reason, a pending one says so', () => {
  const at = (files: object) =>
    view([pr(7, { mergeable: 'CONFLICTING' })], { merge: { [K(7)]: { files: { at: 1, ...files } } } })
  const titles = (ctx: ReturnType<typeof view>) => rowOf(ctx, 7).children?.map(c => c.cells.description?.text)
  expect(titles(at({ files: ['a'], more: 3 }))).toEqual(['a', '+3 more'])
  expect(titles(at({ error: 'git fetch failed: no remote' }))).toEqual(['files unknown: git fetch failed: no remote'])
  expect(titles(at({ pending: true }))).toEqual(['looking for the files…'])
  expect(titles(at({ files: [] }))).toEqual(['no conflicts found locally: the local refs may be behind GitHub'])
})

test('no file note, or a PR that is no longer CONFLICTING, gives no child rows', () => {
  expect(rowOf(view([pr(7, { mergeable: 'CONFLICTING' })]), 7).children).toBeUndefined()
  const stale = { [K(7)]: { files: { at: 1, files: ['a'] } } }
  expect(rowOf(view([pr(7, { mergeable: 'MERGEABLE' })], { merge: stale }), 7).children).toBeUndefined()
  const queued = { [K(7)]: { queuedAt: NOW, files: { at: 1, files: ['a'] } } }
  expect(rowOf(view([pr(7, { mergeable: 'CONFLICTING' })], { merge: queued }), 7).children?.length).toBe(1)
  expect(
    rowOf(view([pr(7, { mergeable: 'CONFLICTING' })], { merge: stale }, { ...GH_OK, loggedIn: false }), 7).children,
  ).toBeUndefined()
})

// ---------------------------------------------------------------- the band

test('AC7: two open conflicted PRs and one failing PR read PRs 3 (1 ✗ · 2 conflicts)', () => {
  const ctx = view([
    pr(1, { mergeable: 'CONFLICTING' }),
    pr(2, { mergeable: 'CONFLICTING', checks: 'success' }),
    pr(3, { checks: 'failure', mergeable: 'MERGEABLE' }),
    pr(4, { state: 'merged', mergeable: 'CONFLICTING' }),
  ])
  const prs = prsSection(ctx)
  expect(prs.band).toEqual({ label: 'PRs', count: 3, failing: 1, conflicts: 2, rank: 9 })
  expect(bandText([prs])).toBe('PRs 3 (1 ✗ · 2 conflicts)')
})

test('the band of a PR list with no conflict has no conflicts field', () => {
  expect(prsSection(view([pr(1), pr(2, { checks: 'failure' })])).band).toEqual({
    label: 'PRs',
    count: 2,
    failing: 1,
    rank: 9,
  })
})

// ---------------------------------------------------------------- the columns

test('the extras column holds the chip, the checks and the hint, and hides while no row has a badge', () => {
  const extras = (items: GitHubRecord[]) => {
    const rows = prsSection(view(items)).rows.map(row => ({ depth: 0, row }))
    return solveColumns('t1', SHARED_COLUMNS, rows, 120).columns.map(c => c.id)
  }
  expect(extras([pr(1, { checks: 'none' })])).not.toContain('extras') // no chip, no checks, no hint: an empty column is left out
  expect(extras([pr(1)])).toContain('extras') // the checks
  expect(extras([pr(1, { checks: 'none', mergeable: 'CONFLICTING' })])).toContain('extras') // the chip
})

test('AC1 narrow: the extras column outlives the type column, so a conflict stays on the row', () => {
  const items = [pr(1, { mergeable: 'CONFLICTING', checks: 'failure', baseRefName: 'fix/stack-base' })]
  const rows = prsSection(view(items)).rows.map(row => ({ depth: 0, row }))
  // The widest pane at which a column is already left out. The highest priority number goes first: the extras are after the type.
  const leftOutAt = (id: string): number => {
    for (let avail = 120; avail >= 10; avail--)
      if (solveColumns('t3', SHARED_COLUMNS, rows, avail).dropped.includes(id)) return avail
    return 0
  }
  expect(leftOutAt('type')).toBeGreaterThan(leftOutAt('extras'))
  expect(leftOutAt('extras')).toBeGreaterThan(0) // only a pane too small for the name, the description and the state loses it
})

test('prRow of a record with no merge env draws no merge cell and no hint (a caller with no lane state)', () => {
  const row = prRow(
    pr(7, { mergeable: 'CONFLICTING' }),
    { facts: { read: () => undefined }, levelOf: () => ({}) },
    'main',
  )
  expect(row.extras).toEqual([OK]) // the checks alone: no chip, no hint
})
