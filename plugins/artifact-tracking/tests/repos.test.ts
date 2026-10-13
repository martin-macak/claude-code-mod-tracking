import { expect, test } from 'claude-code/testing'
import type { RepoRef } from '../hooks/contracts'
import {
  extractRepoPathsFromTool,
  isNoisePath,
  parseRepoHintsFromBash,
  RepoTracker,
  upsertRepoRows,
} from '../hooks/repos/tracker'

const ROOT: RepoRef = { host: 'github.com', owner: 'acme', repo: 'web' }

test('extractRepoPathsFromTool reads known path fields', () => {
  expect(extractRepoPathsFromTool('Read', { file_path: '/x/other/a.ts' })).toEqual(['/x/other/a.ts'])
  expect(extractRepoPathsFromTool('Edit', { path: '/x/other/b.ts' })).toEqual(['/x/other/b.ts'])
  expect(extractRepoPathsFromTool('Write', { file_path: '/x/other/c.ts' })).toEqual(['/x/other/c.ts'])
  expect(extractRepoPathsFromTool('Grep', { path: '/x/other' })).toEqual(['/x/other'])
  expect(extractRepoPathsFromTool('Glob', { paths: ['/x/other', '/x/third'] })).toEqual(['/x/other', '/x/third'])
  expect(extractRepoPathsFromTool('Bash', { path: '/x/other' })).toEqual([])
})

test('parseRepoHintsFromBash reads cd, git -C and gh -R in one command', () => {
  const out = parseRepoHintsFromBash(
    'cd ../sdk && git -C ../docs status && gh pr view -R ghe.corp/acme/docs',
    '/x/repo',
  )
  expect(out.paths).toEqual(['/x/sdk', '/x/docs'])
  expect(out.repos).toEqual([{ host: 'ghe.corp', owner: 'acme', repo: 'docs' }])
})

test('isNoisePath filters tmp, scratchpad, node_modules and claude config paths', () => {
  for (const p of ['/tmp/x', '/private/tmp/x', '/w/node_modules/pkg/a.ts', '/x/scratchpad/run.md', '~/.claude/plugins'])
    expect(isNoisePath(p)).toBe(true)
  expect(isNoisePath('/work/other-repo/src/index.ts')).toBe(false)
})

test('upsertRepoRows groups by repo key and merges agents', () => {
  const at = 100
  const a = upsertRepoRows([], {
    key: 'remote:github.com/acme/sdk',
    name: 'acme/sdk',
    branch: 'main',
    touchedBy: 'main',
    at,
  })
  const b = upsertRepoRows(a, {
    key: 'remote:github.com/acme/sdk',
    name: 'acme/sdk',
    branch: 'feat/x',
    touchedBy: 'planner',
    at: at + 5,
  })
  expect(b).toHaveLength(1)
  expect(b[0]).toMatchObject({
    key: 'remote:github.com/acme/sdk',
    branch: 'feat/x',
    touchedBy: ['main', 'planner'],
    firstSeen: at,
    lastSeen: at + 5,
  })
})

test('RepoTracker resolves path repos, caches per directory, and groups worktrees by remote', async () => {
  const calls: string[] = []
  const run = async (argv: readonly string[], init?: { cwd?: string }) => {
    calls.push(`${argv.join(' ')} @ ${init?.cwd ?? ''}`)
    if (argv[0] === 'git' && argv[1] === '-C' && argv[3] === 'rev-parse') {
      if (argv[2] === '/x/sdk/src') return { exitCode: 0, stdout: '/x/sdk\n', stderr: '' }
      if (argv[2] === '/x/sdk/tests') return { exitCode: 0, stdout: '/x/sdk-wt\n', stderr: '' }
      return { exitCode: 128, stdout: '', stderr: 'not a git repository' }
    }
    if (argv[0] === 'git' && argv[1] === '-C' && argv[3] === 'remote') {
      if (argv[2] === '/x/sdk') return { exitCode: 0, stdout: 'git@github.com:acme/sdk.git\n', stderr: '' }
      if (argv[2] === '/x/sdk-wt') return { exitCode: 0, stdout: 'git@github.com:acme/sdk.git\n', stderr: '' }
      return { exitCode: 1, stdout: '', stderr: 'no origin' }
    }
    if (argv[0] === 'git' && argv[1] === '-C' && argv[3] === 'branch') {
      if (argv[2] === '/x/sdk') return { exitCode: 0, stdout: 'main\n', stderr: '' }
      if (argv[2] === '/x/sdk-wt') return { exitCode: 0, stdout: 'feat/wt\n', stderr: '' }
      return { exitCode: 1, stdout: '', stderr: '' }
    }
    return { exitCode: 1, stdout: '', stderr: 'unexpected' }
  }
  const t = new RepoTracker({ run, now: () => 1, rootPath: '/x/repo', rootRepo: ROOT })
  const a = await t.resolvePath('/x/sdk/src', 'main')
  const b = await t.resolvePath('/x/sdk/tests', 'helper')
  const c = await t.resolvePath('/x/not-a-repo', 'main')
  expect(a).toMatchObject({ key: 'remote:github.com/acme/sdk', name: 'acme/sdk', touchedBy: 'main' })
  expect(b).toMatchObject({ key: 'remote:github.com/acme/sdk', touchedBy: 'helper' })
  expect(c).toBeNull()
  await t.resolvePath('/x/sdk/src', 'main')
  // src, tests, not-a-repo and its parent (a path with no extension may be a file); the repeat of src is cached
  expect(calls.filter(x => x.includes('rev-parse')).length).toBe(4)
})

// ---------------------------------------------------------------- review fixes (PR #42)

const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '' })
const notRepo = { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }

test('RepoTracker: non-repo paths are an expected answer and never open the breaker', async () => {
  const run = async (argv: readonly string[]) => {
    if (argv[3] === 'rev-parse') return argv[2] === '/x/sdk/src' ? ok('/x/sdk\n') : notRepo
    if (argv[3] === 'remote') return ok('git@github.com:acme/sdk.git\n')
    return ok('main\n')
  }
  const t = new RepoTracker({ run, now: () => 1, rootPath: '/x/repo', rootRepo: ROOT })
  for (const p of ['/n/a', '/n/b', '/n/c', '/n/d']) expect(await t.resolvePath(p, 'main')).toBeNull()
  expect(await t.resolvePath('/x/sdk/src', 'main')).toMatchObject({ key: 'remote:github.com/acme/sdk' })
})

test('RepoTracker: a path skipped while the breaker is open is looked up again after it closes', async () => {
  let now = 1
  let broken = true
  const run = async (argv: readonly string[]) => {
    if (argv[3] === 'rev-parse') {
      if (broken) throw new Error('spawn failed')
      return argv[2] === '/x/sdk/src' ? ok('/x/sdk\n') : notRepo
    }
    if (argv[3] === 'remote') return ok('git@github.com:acme/sdk.git\n')
    return ok('main\n')
  }
  const t = new RepoTracker({ run, now: () => now, rootPath: '/x/repo', rootRepo: ROOT })
  for (const p of ['/e/a', '/e/b', '/e/c']) expect(await t.resolvePath(p, 'main')).toBeNull() // three faults open it
  expect(await t.resolvePath('/x/sdk/src', 'main')).toBeNull() // blocked, not a verdict
  broken = false
  now += 10 * 60_000
  expect(await t.resolvePath('/x/sdk/src', 'main')).toMatchObject({ key: 'remote:github.com/acme/sdk' })
})

test('RepoTracker: an extensionless file (README, Makefile) resolves through its parent directory', async () => {
  const run = async (argv: readonly string[]) => {
    if (argv[3] === 'rev-parse') return argv[2] === '/x/sdk' ? ok('/x/sdk\n') : notRepo // git -C <file> fails
    if (argv[3] === 'remote') return ok('git@github.com:acme/sdk.git\n')
    return ok('main\n')
  }
  const t = new RepoTracker({ run, now: () => 1, rootPath: '/x/repo', rootRepo: ROOT })
  expect(await t.resolvePath('/x/sdk/README', 'main')).toMatchObject({ key: 'remote:github.com/acme/sdk' })
})

test('RepoTracker: a ~/ path is expanded to the home directory before git sees it', async () => {
  const seen: string[] = []
  const run = async (argv: readonly string[]) => {
    seen.push(argv.join(' '))
    if (argv[0] === 'sh') return ok('/home/me')
    if (argv[3] === 'rev-parse') return argv[2] === '/home/me/sdk' ? ok('/home/me/sdk\n') : notRepo
    if (argv[3] === 'remote') return ok('git@github.com:acme/sdk.git\n')
    return ok('main\n')
  }
  const t = new RepoTracker({ run, now: () => 1, rootPath: '/x/repo', rootRepo: ROOT })
  expect(await t.resolvePath('~/sdk', 'main')).toMatchObject({
    key: 'remote:github.com/acme/sdk',
    root: '/home/me/sdk',
  })
  expect(seen.some(s => s.includes('~'))).toBe(false)
})
