// Issue #195: the branches of the foreign repos that the PR lane polls. The pure part (`trackers/repos/foreign.ts`): which
// rows are polled, which branches the session proved, the fact the repos tracker publishes and one poll round over a fake
// git. The tracker wiring (tick, queue, publish points) is in `repos-tracker.test.ts`.
import { expect, test } from 'claude-code/testing'
import type { GitWorktree } from '../core/lib/porcelain'
import {
  FACT_REPO_BRANCHES,
  githubRefOf,
  type PollGit,
  pollForeign,
  pollKey,
  pollTargets,
  provenBranches,
  reposOfFact,
  storedFact,
} from '../trackers/repos/foreign'
import type { RepoRecord } from './fixtures/contracts'

const FOREIGN_KEY = 'remote:github.com/acme-org/foreign-repo'
const row = (over: Partial<RepoRecord> = {}): RepoRecord => ({
  key: FOREIGN_KEY,
  name: 'Acme-Org/Foreign-Repo',
  mode: 'edit',
  touchedBy: ['main'],
  firstSeen: 1,
  lastSeen: 1,
  ...over,
})
const wt = (path: string, branch?: string, over: Partial<GitWorktree> = {}): GitWorktree => ({
  path,
  detached: branch === undefined,
  bare: false,
  ...(branch !== undefined ? { branch } : {}),
  ...over,
})

test('the fact is named repos.branches', () => {
  expect(FACT_REPO_BRANCHES).toBe('repos.branches')
})

test('githubRefOf: a remote:<host>/<owner>/<repo> key, in the case of the name; no other key is a GitHub repo', () => {
  expect(githubRefOf(row())).toEqual({ host: 'github.com', owner: 'Acme-Org', repo: 'Foreign-Repo' })
  expect(githubRefOf(row({ name: 'other/name' }))).toEqual({
    host: 'github.com',
    owner: 'acme-org',
    repo: 'foreign-repo',
  })
  expect(githubRefOf(row({ key: 'remote:ghe.corp/team/svc', name: 'team/svc' }))).toEqual({
    host: 'ghe.corp',
    owner: 'team',
    repo: 'svc',
  })
  for (const key of [
    'remote:gitlab.com/g/sub/r',
    'remote:file:/srv/r',
    'remote:example.org/8080/o/r', // the key of the scp remote `git@example.org:8080/o/r`
    'local:/x/.git',
    'remote:github.com/only',
  ])
    expect(githubRefOf(row({ key, name: 'x/y' }))).toBeNull()
})

test('githubRefOf: an ssh host alias or a URL with a port is polled, and held at the lane when gh refuses its host', () => {
  // `git@github-work:o/r` gives the key `remote:github-work/o/r`, and `https://ghe.corp:8443/o/r` gives `remote:ghe.corp/o/r`
  // (the port is dropped). Neither can be told from a GitHub Enterprise host here, so the lane asks `gh` about the host once.
  expect(githubRefOf({ key: 'remote:github-work/o/r', name: 'o/r' })).toEqual({
    host: 'github-work',
    owner: 'o',
    repo: 'r',
  })
  expect(githubRefOf({ key: 'remote:ghe.corp/o/r', name: 'o/r' })).toEqual({ host: 'ghe.corp', owner: 'o', repo: 'r' })
})

test('pollTargets: a GitHub repo with a root only, edit before read, newest first, at most the cap', () => {
  const at = (repo: string, over: Partial<RepoRecord>) =>
    row({ key: `remote:github.com/a/${repo}`, name: `a/${repo}`, root: `/r/${repo}`, ...over })
  const rows = [
    at('read-old', { mode: 'read', lastSeen: 1 }),
    at('edit-old', { lastSeen: 2 }),
    at('ref-only', { lastSeen: 9, root: undefined }),
    at('read-new', { mode: 'read', lastSeen: 8 }),
    at('edit-new', { lastSeen: 7 }),
    row({ key: 'local:/x/.git', name: 'x', root: '/x', lastSeen: 99 }),
  ]
  const { targets, overflow } = pollTargets(rows, 3)
  expect(targets.map(t => t.ref.repo)).toEqual(['edit-new', 'edit-old', 'read-new'])
  expect(overflow).toBe(1)
  expect(pollTargets(rows, 0)).toEqual({ targets: [], overflow: 0 })
  expect(pollTargets([], 3)).toEqual({ targets: [], overflow: 0 })
})

test('pollTargets: a row with no list reads as its one root; the roots come in the order of the row', () => {
  const legacy = row({ root: '/r/legacy', branch: 'feat/legacy' })
  expect(pollTargets([legacy], 3).targets[0]!.roots).toEqual([{ path: '/r/legacy', branch: 'feat/legacy' }])
  const listed = row({ root: '/r/b', roots: [{ path: '/r/b', branch: 'feat/b' }, { path: '/r/a' }] })
  expect(pollTargets([listed], 3).targets[0]!.roots).toEqual([{ path: '/r/b', branch: 'feat/b' }, { path: '/r/a' }])
})

test('provenBranches: the branch of each live root first, then the last branch of each gone root', () => {
  const list = [
    wt('/m', 'main'),
    wt('/w1', 'feat/one'),
    wt('/w2'),
    wt('/w3', 'feat/gone', { prunable: 'gitdir file points to non-existent location' }),
  ]
  const roots = [
    { path: '/w3', branch: 'feat/gone' },
    { path: '/w1', branch: 'feat/old-name' },
    { path: '/w2', branch: 'feat/was' },
    { path: '/w9', branch: 'feat/missing' },
  ]
  // /w1 is live and has feat/one now. /w2 is detached now: it adds none. /w3 is prunable and /w9 is not listed: their last branch.
  expect(provenBranches(roots, list)).toEqual(['feat/one', 'feat/gone', 'feat/missing'])
  // No list (git could not say): the last branch of every root.
  expect(provenBranches(roots, null)).toEqual(['feat/gone', 'feat/old-name', 'feat/was', 'feat/missing'])
  expect(provenBranches([{ path: '/w1' }], list)).toEqual(['feat/one'])
  expect(provenBranches([{ path: '/gone' }], list)).toEqual([])
  expect(provenBranches([{ path: '/b' }], [{ path: '/b', detached: false, bare: true }])).toEqual([])
})

test('storedFact: sorted by repo and by branch, so a reorder of rows or roots is the same text', () => {
  const a = row({
    key: 'remote:github.com/zed/last',
    name: 'Zed/Last',
    root: '/z',
    roots: [{ path: '/z', branch: 'feat/z' }],
  })
  const b = row({
    roots: [
      { path: '/f2', branch: 'feat/two' },
      { path: '/f1', branch: 'feat/one' },
    ],
    root: '/f2',
  })
  const text = JSON.stringify(storedFact([a, b], 3))
  expect(JSON.parse(text)).toEqual({
    repos: [
      { host: 'github.com', owner: 'Acme-Org', repo: 'Foreign-Repo', branches: ['feat/one', 'feat/two'] },
      { host: 'github.com', owner: 'Zed', repo: 'Last', branches: ['feat/z'] },
    ],
    overflow: 0,
  })
  const reordered = row({ ...b, roots: [...b.roots!].reverse() })
  expect(JSON.stringify(storedFact([reordered, a], 3))).toBe(text)
})

test('storedFact: overflow counts the rows over the cap, and no root or branch means no entry', () => {
  const rows = ['a', 'b', 'c'].map((n, i) =>
    row({ key: `remote:github.com/o/${n}`, name: `o/${n}`, root: `/r/${n}`, branch: `feat/${n}`, lastSeen: 10 - i }),
  )
  expect(storedFact(rows, 2)).toEqual({
    repos: [
      { host: 'github.com', owner: 'o', repo: 'a', branches: ['feat/a'] },
      { host: 'github.com', owner: 'o', repo: 'b', branches: ['feat/b'] },
    ],
    overflow: 1,
  })
  expect(storedFact([row({ root: '/r/x' })], 3)).toEqual({ repos: [], overflow: 0 })
})

test('pollKey: the proofs of the polled rows, and nothing else', () => {
  const a = row({ root: '/r/a', branch: 'feat/a' })
  const same = row({ root: '/r/a', branch: 'feat/a', lastSeen: 99, touchedBy: ['main', 'planner'] })
  expect(pollKey([a], 3)).toBe(pollKey([same], 3))
  expect(pollKey([a], 3)).not.toBe(pollKey([row({ root: '/r/a', branch: 'feat/b' })], 3))
  expect(pollKey([a], 3)).not.toBe(pollKey([row({ root: '/r/b', branch: 'feat/a' })], 3))
  expect(pollKey([a], 3)).not.toBe(pollKey([], 3))
})

/**
 * A fake git. `lists` is the answer of `worktree list` by common dir; `commons` the common dir by root. `commonDir` asks the
 * roots of the repo in order and answers with the first common dir that one gives: the real tracker keeps it for the load.
 */
function fakeGit(commons: Record<string, string>, lists: Record<string, GitWorktree[] | null | Error>) {
  const calls: string[] = []
  const git: PollGit = {
    commonDir: async (_key, roots) => {
      for (const root of roots) {
        calls.push(`common ${root.path}`)
        const dir = commons[root.path]
        if (dir !== undefined) return dir
      }
      return null
    },
    worktreeList: async dir => {
      calls.push(`list ${dir}`)
      const answer = lists[dir] ?? null
      if (answer instanceof Error) throw answer
      return answer
    },
  }
  return { git, calls }
}

test('pollForeign: one worktree list per polled repo and round, in its common dir', async () => {
  const f = fakeGit(
    { '/r/f2': '/r/f/.git', '/r/g': '/r/g/.git' },
    { '/r/f/.git': [wt('/r/f', 'main'), wt('/r/f2', 'feat/two')], '/r/g/.git': [wt('/r/g', 'feat/g')] },
  )
  const rows = [
    row({ root: '/r/f2', roots: [{ path: '/r/f2', branch: 'feat/two' }] }),
    row({ key: 'remote:github.com/o/g', name: 'o/g', root: '/r/g', branch: 'feat/g', lastSeen: 0 }),
  ]
  const out = await pollForeign(f.git, rows, 3)
  expect(out.repos.map(r => [r.repo, r.branches])).toEqual([
    ['Foreign-Repo', ['feat/two']],
    ['g', ['feat/g']],
  ])
  expect(f.calls).toEqual(['common /r/f2', 'list /r/f/.git', 'common /r/g', 'list /r/g/.git'])
})

test('pollForeign: the roots of a repo ask for the common dir in order: a root that is gone costs one more lookup', async () => {
  const f = fakeGit({ '/r/live': '/r/f/.git' }, { '/r/f/.git': [wt('/r/f', 'main'), wt('/r/live', 'feat/live')] })
  const gone = row({
    root: '/r/gone',
    roots: [
      { path: '/r/gone', branch: 'feat/gone' },
      { path: '/r/live', branch: 'feat/live' },
    ],
  })
  const out = await pollForeign(f.git, [gone], 3)
  expect(f.calls).toEqual(['common /r/gone', 'common /r/live', 'list /r/f/.git'])
  expect(out.repos[0]!.branches).toEqual(['feat/gone', 'feat/live'])
})

test('pollForeign: a repo that git cannot read keeps its stored branches, the others go on, the round does not fail', async () => {
  const f = fakeGit(
    { '/r/ok': '/r/ok/.git', '/r/dead': '/r/dead/.git', '/r/boom': '/r/boom/.git' },
    { '/r/ok/.git': [wt('/r/ok', 'feat/ok')], '/r/dead/.git': null, '/r/boom/.git': new Error('git could not run') },
  )
  const at = (n: string, root: string, branch: string, lastSeen: number) =>
    row({ key: `remote:github.com/o/${n}`, name: `o/${n}`, root, branch, lastSeen })
  const out = await pollForeign(
    f.git,
    [at('ok', '/r/ok', 'feat/ok', 3), at('dead', '/r/dead', 'feat/dead', 2), at('boom', '/r/boom', 'feat/boom', 1)],
    3,
  )
  expect(out.repos.map(r => [r.repo, r.branches])).toEqual([
    ['boom', ['feat/boom']],
    ['dead', ['feat/dead']],
    ['ok', ['feat/ok']],
  ])
})

const FOREIGN_REF = { host: 'github.com', owner: 'Acme-Org', repo: 'Foreign-Repo' }

test('pollForeign: a repo that git cannot read keeps the branches of the last good poll beside its stored branch', async () => {
  const f = fakeGit(
    { '/r/a': '/r/a/.git', '/r/b': '/r/b/.git' },
    { '/r/a/.git': null, '/r/b/.git': [wt('/r/b', 'feat/b')] },
  )
  const rows = [
    row({ root: '/r/a', branch: 'feat/visited', lastSeen: 2 }),
    row({ key: 'remote:github.com/o/b', name: 'o/b', root: '/r/b', branch: 'feat/b', lastSeen: 1 }),
  ]
  const previous = [
    { ...FOREIGN_REF, branches: ['feat/live'] },
    { host: 'github.com', owner: 'o', repo: 'b', branches: ['feat/not-now'] },
  ]
  const out = await pollForeign(f.git, rows, 3, previous)
  // The first repo: the person moved the toplevel to feat/live after the visit, and one poll proved it. Git fails now: the
  // PR of feat/live must not leave the lane for a round. The second repo answers: it takes nothing from the last poll.
  expect(out.repos.map(r => [r.repo, r.branches])).toEqual([
    ['Foreign-Repo', ['feat/live', 'feat/visited']],
    ['b', ['feat/b']],
  ])
})

test('pollForeign: the last good poll of another repo, or an empty one, adds nothing', async () => {
  const f = fakeGit({}, {})
  const rows = [row({ root: '/r/a', branch: 'feat/visited' })]
  const other = [{ host: 'github.com', owner: 'o', repo: 'other', branches: ['feat/x'] }]
  expect((await pollForeign(f.git, rows, 3, other)).repos[0]!.branches).toEqual(['feat/visited'])
  expect((await pollForeign(f.git, rows, 3, [])).repos[0]!.branches).toEqual(['feat/visited'])
  // The repo matches in lower case, as the fact sorts it.
  const cased = [{ host: 'GitHub.com', owner: 'ACME-ORG', repo: 'foreign-repo', branches: ['feat/live'] }]
  expect((await pollForeign(f.git, rows, 3, cased)).repos[0]!.branches).toEqual(['feat/live', 'feat/visited'])
})

test('reposOfFact: the repos of a published fact; a value that is not the fact reads as none', () => {
  const ok = { ...FOREIGN_REF, branches: ['feat/a', 'feat/b'] }
  expect(reposOfFact({ repos: [ok], overflow: 1 })).toEqual([ok])
  expect(
    reposOfFact({ repos: [null, 7, { ...ok, host: 3 }, { ...ok, branches: 'x' }, { ...ok, branches: ['a', 4] }, ok] }),
  ).toEqual([{ ...ok, branches: ['a'] }, ok])
  for (const v of [undefined, null, 'x', [], {}, { repos: 'x' }]) expect(reposOfFact(v)).toEqual([])
})

test('pollForeign: a repo with no common dir and no readable root holds its stored branches', async () => {
  const f = fakeGit({}, {})
  const out = await pollForeign(f.git, [row({ root: '/r/x', branch: 'feat/x' })], 3)
  expect(f.calls).toEqual(['common /r/x'])
  expect(out.repos).toEqual([{ host: 'github.com', owner: 'Acme-Org', repo: 'Foreign-Repo', branches: ['feat/x'] }])
})

test('pollForeign: a poll and a publish with no git give the same text when they find the same branches', async () => {
  const f = fakeGit(
    { '/r/b': '/r/f/.git' },
    { '/r/f/.git': [wt('/r/f', 'main'), wt('/r/a', 'feat/a'), wt('/r/b', 'feat/b')] },
  )
  const rows = [
    row({
      root: '/r/b',
      branch: 'feat/b',
      roots: [
        { path: '/r/b', branch: 'feat/b' },
        { path: '/r/a', branch: 'feat/a' },
      ],
    }),
  ]
  const polled = await pollForeign(f.git, rows, 3)
  expect(JSON.stringify(polled)).toBe(JSON.stringify(storedFact(rows, 3)))
})

test('pollForeign: pollRepos 0 makes no call and publishes an empty fact', async () => {
  const f = fakeGit({}, {})
  expect(await pollForeign(f.git, [row({ root: '/r/x' })], 0)).toEqual({ repos: [], overflow: 0 })
  expect(f.calls).toEqual([])
})
