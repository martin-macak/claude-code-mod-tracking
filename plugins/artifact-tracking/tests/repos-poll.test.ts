// Issue #195: the two git calls that the repos tracker makes to poll a foreign repo. `commonDir` finds the git common dir of a
// repo from the toplevels the session visited (the lookup cache first, else one rev-parse) and keeps it for the load.
// `worktreeList` runs `git -C <common dir> worktree list --porcelain`. Both run in `/`, in English, with the git timeout and
// the breaker.
import { expect, test } from 'claude-code/testing'
import { RepoTracker } from '../trackers/repos/tracker'
import type { RepoRef, RunInit, RunResult } from './fixtures/contracts'
import { LIMITS } from './fixtures/limits'

const ROOT: RepoRef = { host: 'github.com', owner: 'acme', repo: 'web' }
const ok = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: '' })
const notRepo: RunResult = { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }
const gone = (d: string): RunResult => ({
  exitCode: 128,
  stdout: '',
  stderr: `fatal: cannot change to '${d}': No such file or directory`,
})
const SH = ok('/home/me\n\n\n')
const PORCELAIN =
  'worktree /x/sdk\nHEAD abc\nbranch refs/heads/main\n\nworktree /x/sdk-wt\nHEAD def\nbranch refs/heads/feat/wt\n'

type Call = { argv: string; init: RunInit | undefined }

/** A runner for the poll: the lookup calls of two toplevels of one repo, and `worktree list`. */
function pollRunner(calls: Call[], list: () => RunResult | Promise<RunResult>) {
  return async (argv: readonly string[], init?: RunInit): Promise<RunResult> => {
    calls.push({ argv: argv.join(' '), init })
    if (argv[0] === 'sh') return SH
    if (argv[3] === 'worktree') return list()
    if (argv[3] === 'rev-parse') {
      if (argv[2]?.startsWith('/x/sdk')) return ok('/x/sdk\n/x/sdk/.git\n')
      return argv[2] === '/x/gone' ? gone('/x/gone') : notRepo
    }
    if (argv[3] === 'remote') return ok('git@github.com:acme/sdk.git\n')
    return ok('main\n')
  }
}

const tracker = (run: ReturnType<typeof pollRunner>) =>
  new RepoTracker({ run, now: () => 1, rootPath: '/x/repo', rootRepo: ROOT })

test('worktreeList: git -C <common dir> worktree list --porcelain, in /, in English, with the git timeout', async () => {
  const calls: Call[] = []
  const list = await tracker(pollRunner(calls, () => ok(PORCELAIN))).worktreeList('/x/sdk/.git')
  expect(list?.map(w => [w.path, w.branch])).toEqual([
    ['/x/sdk', 'main'],
    ['/x/sdk-wt', 'feat/wt'],
  ])
  expect(calls).toHaveLength(1)
  expect(calls[0]!.argv).toBe('git -C /x/sdk/.git worktree list --porcelain')
  expect(calls[0]!.init).toMatchObject({ cwd: '/', timeoutMs: LIMITS.gitTimeoutMs, env: { LC_ALL: 'C' } })
})

test('worktreeList: a repo that git cannot read gives null and never opens the breaker', async () => {
  const calls: Call[] = []
  const t = tracker(pollRunner(calls, () => gone('/x/sdk/.git')))
  for (let i = 0; i < LIMITS.breakerThreshold + 2; i++) expect(await t.worktreeList('/x/sdk/.git')).toBeNull()
  expect(calls).toHaveLength(LIMITS.breakerThreshold + 2)
})

test('worktreeList: faults open the breaker, and an open breaker makes no call', async () => {
  const calls: Call[] = []
  const boom = () => {
    throw new Error('timeout')
  }
  const t = tracker(pollRunner(calls, boom))
  for (let i = 0; i < LIMITS.breakerThreshold; i++) expect(await t.worktreeList('/x/sdk/.git')).toBeNull()
  const before = calls.length
  expect(await t.worktreeList('/x/sdk/.git')).toBeNull()
  expect(calls.length).toBe(before)
})

const KEY = 'remote:github.com/acme/sdk'
const at = (...paths: string[]) => paths.map(path => ({ path }))

test('commonDir: the common dir that the visit lookup cached costs no call', async () => {
  const calls: Call[] = []
  const t = tracker(pollRunner(calls, () => ok(PORCELAIN)))
  expect(await t.resolvePath('/x/sdk/src/a.ts', 'main')).toMatchObject({ root: '/x/sdk' })
  calls.length = 0
  expect(await t.commonDir(KEY, at('/x/sdk'))).toBe('/x/sdk/.git')
  expect(calls).toEqual([])
})

test('commonDir: a root the lookup never saw costs one rev-parse, once for the load', async () => {
  const calls: Call[] = []
  const t = tracker(pollRunner(calls, () => ok(PORCELAIN)))
  expect(await t.commonDir(KEY, at('/x/sdk-wt'))).toBe('/x/sdk/.git')
  expect(await t.commonDir(KEY, at('/x/sdk-wt'))).toBe('/x/sdk/.git')
  expect(calls.map(c => c.argv)).toEqual([
    'git -C /x/sdk-wt rev-parse --path-format=absolute --show-toplevel --git-common-dir',
  ])
  expect(calls[0]!.init).toMatchObject({ cwd: '/', timeoutMs: LIMITS.gitTimeoutMs, env: { LC_ALL: 'C' } })
})

test('commonDir: a root that is gone costs one lookup, the next root gives the dir, and the dir is kept for the load', async () => {
  const calls: Call[] = []
  const t = tracker(pollRunner(calls, () => ok(PORCELAIN)))
  expect(await t.commonDir(KEY, at('/x/gone', '/x/sdk-wt'))).toBe('/x/sdk/.git')
  expect(calls.map(c => c.argv.split(' ')[2])).toEqual(['/x/gone', '/x/sdk-wt'])
  expect(await t.commonDir(KEY, at('/x/gone', '/x/sdk-wt'))).toBe('/x/sdk/.git')
  expect(calls).toHaveLength(2)
})

test('commonDir: a repo with no root that git can enter gives null and is asked again; an old git joins the root', async () => {
  const calls: Call[] = []
  const t = tracker(pollRunner(calls, () => ok(PORCELAIN)))
  expect(await t.commonDir(KEY, at('/x/gone'))).toBeNull()
  expect(await t.commonDir(KEY, at('/x/gone'))).toBeNull()
  expect(await t.commonDir(KEY, at('/x/plain'))).toBeNull()
  expect(calls).toHaveLength(3)
  // git older than 2.31 echoes the option and gives the common dir relative to the folder.
  const old = new RepoTracker({
    run: async argv =>
      ok(argv.includes('--path-format=absolute') ? '--path-format=absolute\n/x/oldgit\n.git\n' : '/x/oldgit\n.git\n'),
    now: () => 1,
    rootPath: '/x/repo',
    rootRepo: ROOT,
  })
  expect(await old.commonDir(KEY, at('/x/oldgit'))).toBe('/x/oldgit/.git')
})

test('commonDir: a list that fails forgets the common dir of its repo: the next round asks git again', async () => {
  const calls: Call[] = []
  let answer: RunResult = ok(PORCELAIN)
  const t = tracker(pollRunner(calls, () => answer))
  expect(await t.commonDir(KEY, at('/x/sdk-wt'))).toBe('/x/sdk/.git')
  expect(await t.worktreeList('/x/sdk/.git')).not.toBeNull()
  expect(await t.commonDir(KEY, at('/x/sdk-wt'))).toBe('/x/sdk/.git') // kept: a good list
  const lookups = () => calls.filter(c => c.argv.includes('rev-parse')).length
  expect(lookups()).toBe(1)
  answer = gone('/x/sdk/.git')
  expect(await t.worktreeList('/x/sdk/.git')).toBeNull()
  expect(await t.commonDir(KEY, at('/x/sdk-wt'))).toBe('/x/sdk/.git')
  expect(lookups()).toBe(2)
})

test('commonDir: a fault gives null and counts against the breaker', async () => {
  let calls = 0
  const run = async (): Promise<RunResult> => {
    calls++
    throw new Error('timeout')
  }
  const t = new RepoTracker({ run, now: () => 1, rootPath: '/x/repo', rootRepo: ROOT })
  for (let i = 0; i < LIMITS.breakerThreshold; i++) expect(await t.commonDir(KEY, at(`/x/r${i}`))).toBeNull()
  const before = calls
  expect(await t.commonDir(KEY, at('/x/other'))).toBeNull()
  expect(calls).toBe(before)
})
