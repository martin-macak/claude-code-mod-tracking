import { expect, test } from 'claude-code/testing'
import type { RepoRef, RunInit, RunResult } from '../hooks/contracts'
import { LIMITS } from '../hooks/contracts'
import {
  extractRepoPathsFromTool,
  isNoisePath,
  normalizeRemoteUrl,
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

function worktreeRunner(calls: string[] = []) {
  return async (argv: readonly string[], init?: RunInit): Promise<RunResult> => {
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
}

test('RepoTracker groups two worktrees of one remote into one key', async () => {
  const t = new RepoTracker({ run: worktreeRunner(), now: () => 1, rootPath: '/x/repo', rootRepo: ROOT })
  const a = await t.resolvePath('/x/sdk/src', 'main')
  const b = await t.resolvePath('/x/sdk/tests', 'helper')
  const c = await t.resolvePath('/x/not-a-repo', 'main')
  expect(a).toMatchObject({ key: 'remote:github.com/acme/sdk', name: 'acme/sdk', touchedBy: 'main' })
  expect(b).toMatchObject({ key: 'remote:github.com/acme/sdk', touchedBy: 'helper' })
  expect(c).toBeNull()
})

test('RepoTracker caches per directory', async () => {
  const calls: string[] = []
  const t = new RepoTracker({ run: worktreeRunner(calls), now: () => 1, rootPath: '/x/repo', rootRepo: ROOT })
  await t.resolvePath('/x/sdk/src', 'main')
  await t.resolvePath('/x/not-a-repo', 'main')
  const before = calls.filter(x => x.includes('rev-parse')).length
  await t.resolvePath('/x/sdk/src', 'main')
  await t.resolvePath('/x/not-a-repo', 'main')
  expect(calls.filter(x => x.includes('rev-parse')).length).toBe(before)
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
    if (argv[3] === 'rev-parse')
      return argv[2] === '/x/sdk'
        ? ok('/x/sdk\n')
        : { exitCode: 128, stdout: '', stderr: `fatal: cannot change to '${argv[2]}': Not a directory` } // git -C <file>
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

// ---------------------------------------------------------------- P1: safe git calls, noise, cache

const gone = (d: string) => ({
  exitCode: 128,
  stdout: '',
  stderr: `fatal: cannot change to '${d}': No such file or directory`,
})
const SH = ok('/home/me\n\n\n')

test('RepoTracker: every runner call runs in / with the git timeout', async () => {
  const inits: Array<[string, RunInit | undefined]> = []
  const run = async (argv: readonly string[], init?: RunInit) => {
    inits.push([argv[0]!, init])
    if (argv[0] === 'sh') return SH
    if (argv[3] === 'rev-parse') return ok('/home/me/sdk\n')
    if (argv[3] === 'remote') return ok('git@github.com:acme/sdk.git\n')
    return ok('main\n')
  }
  const t = new RepoTracker({ run, now: () => 1, rootPath: '/x/repo', rootRepo: ROOT })
  expect(await t.resolvePath('~/sdk/a.ts', 'main')).not.toBeNull()
  expect(inits.map(i => i[0])).toContain('sh')
  expect(inits.map(i => i[0])).toContain('git')
  for (const [, init] of inits) {
    expect(init?.cwd).toBe('/')
    expect(init?.timeoutMs).toBe(LIMITS.gitTimeoutMs)
  }
})

test('RepoTracker: missing paths walk up to the repo and never open the breaker', async () => {
  const dirs = new Set(['/', '/x/sdk', '/x/sdk/src'])
  const run = async (argv: readonly string[], init?: RunInit) => {
    if (!dirs.has(init?.cwd ?? '')) throw Object.assign(new Error('spawn ENOTDIR'), { code: 'ENOTDIR' })
    if (argv[0] === 'sh') return SH
    const d = argv[2]!
    if (argv[3] === 'rev-parse') {
      if (!dirs.has(d)) return gone(d)
      return d.startsWith('/x/sdk') ? ok('/x/sdk\n') : notRepo
    }
    if (argv[3] === 'remote') return ok('git@github.com:acme/sdk.git\n')
    return ok('main\n')
  }
  const t = new RepoTracker({ run, now: () => 1, rootPath: '/x/repo', rootRepo: ROOT })
  expect(await t.resolvePath('/x/sdk/README', 'main')).toMatchObject({ key: 'remote:github.com/acme/sdk' })
  expect(await t.resolvePath('/x/sdk/new/deeper/a.ts', 'main')).toMatchObject({ key: 'remote:github.com/acme/sdk' })
  expect(await t.resolvePath('/y/gone/file', 'main')).toBeNull()
  expect(await t.resolvePath('/x/sdk/src/a.ts', 'main')).toMatchObject({ key: 'remote:github.com/acme/sdk' })
})

function repoRunner(over: { remote?: () => RunResult; branch?: () => RunResult }, calls: string[] = []) {
  return async (argv: readonly string[]): Promise<RunResult> => {
    calls.push(argv.join(' '))
    if (argv[0] === 'sh') return SH
    if (argv[3] === 'rev-parse') return ok(`${argv[2]!.replace(/\/src$/, '')}\n`)
    if (argv[3] === 'remote') return over.remote ? over.remote() : ok('git@github.com:acme/sdk.git\n')
    return over.branch ? over.branch() : ok('main\n')
  }
}

test('RepoTracker: a remote fault is retried and never caches a local identity', async () => {
  let n = 0
  const run = repoRunner({
    remote: () => {
      if (n++ === 0) throw new Error('timeout')
      return ok('git@github.com:acme/sdk.git\n')
    },
  })
  const t = new RepoTracker({ run, now: () => 1, rootPath: '/x/repo', rootRepo: ROOT })
  expect(await t.resolvePath('/x/sdk/src/a.ts', 'main')).toBeNull()
  expect(await t.resolvePath('/x/sdk/src/a.ts', 'main')).toMatchObject({ key: 'remote:github.com/acme/sdk' })
})

test('RepoTracker: three remote faults open the breaker and the next lookup makes no call', async () => {
  const calls: string[] = []
  const run = repoRunner(
    {
      remote: () => {
        throw new Error('timeout')
      },
    },
    calls,
  )
  const t = new RepoTracker({ run, now: () => 1, rootPath: '/x/repo', rootRepo: ROOT })
  for (const p of ['/x/a/src/f.ts', '/x/b/src/f.ts', '/x/c/src/f.ts']) expect(await t.resolvePath(p, 'main')).toBeNull()
  const before = calls.length
  expect(await t.resolvePath('/x/d/src/f.ts', 'main')).toBeNull()
  expect(calls.length).toBe(before)
})

test('RepoTracker: no origin gives a local key, a branch fault gives a row without branch', async () => {
  const noOrigin = repoRunner({ remote: () => ({ exitCode: 1, stdout: '', stderr: '' }) })
  const t = new RepoTracker({ run: noOrigin, now: () => 1, rootPath: '/x/repo', rootRepo: ROOT })
  expect(await t.resolvePath('/x/lib/src/a.ts', 'main')).toMatchObject({ key: 'local:/x/lib', name: 'lib' })

  const noBranch = repoRunner({
    branch: () => {
      throw new Error('timeout')
    },
  })
  const u = new RepoTracker({ run: noBranch, now: () => 1, rootPath: '/x/repo', rootRepo: ROOT })
  const r = await u.resolvePath('/x/sdk/src/a.ts', 'main')
  expect(r).toMatchObject({ key: 'remote:github.com/acme/sdk' })
  expect(r?.branch).toBeUndefined()
})

test('RepoTracker: a failed env probe is retried on the next call', async () => {
  let probes = 0
  const run = async (argv: readonly string[]) => {
    if (argv[0] === 'sh') {
      if (probes++ === 0) throw new Error('spawn failed')
      return SH
    }
    if (argv[3] === 'rev-parse') return argv[2] === '/home/me/sdk' ? ok('/home/me/sdk\n') : notRepo
    if (argv[3] === 'remote') return ok('git@github.com:acme/sdk.git\n')
    return ok('main\n')
  }
  const t = new RepoTracker({ run, now: () => 1, rootPath: '/x/repo', rootRepo: ROOT })
  expect(await t.resolvePath('~/sdk/a.ts', 'main')).toBeNull()
  expect(await t.resolvePath('~/sdk/a.ts', 'main')).toMatchObject({ key: 'remote:github.com/acme/sdk' })
})

test('isNoisePath matches whole segments of tmp, Claude config, node_modules and scratchpad', () => {
  const yes = [
    '/Users/me/.claude/skills/x',
    '/Users/me/.claude-work/projects/x',
    '/home/me/.claude-personal/x',
    '/var/folders/ab/T/x',
    '/private/tmp',
    '/private/var/folders/x',
    '/home/me/.local/share/claude/x',
    '~/.local/share/claude/x',
    '~/.claude/x',
    '/w/node_modules/p',
    '/a/scratchpad/x',
  ]
  for (const p of yes) expect(isNoisePath(p)).toBe(true)
  expect(isNoisePath('/custom/tmp/x', { home: '/h', tmpdir: '/custom/tmp' })).toBe(true)
  expect(isNoisePath('/cfg/x', { home: '/h', configDir: '/cfg' })).toBe(true)
  for (const p of ['/work/scratchpad-tool/x.ts', '/work/.claudette/x', '/x/sdk/.claude/settings.json'])
    expect(isNoisePath(p)).toBe(false)
  expect(isNoisePath('/Users/me/projects/a.ts')).toBe(false)
})

test('RepoTracker: Claude config paths make no git call, even with a custom home', async () => {
  const calls: string[] = []
  const run = async (argv: readonly string[]) => {
    calls.push(argv.join(' '))
    return argv[0] === 'sh' ? ok('/h/me\n\n\n') : notRepo
  }
  const t = new RepoTracker({ run, now: () => 1, rootPath: '/x/repo', rootRepo: ROOT })
  expect(await t.resolvePath('/Users/me/.claude-work/plugins/marketplaces/m/a.md', 'main')).toBeNull()
  expect(await t.resolvePath('/h/me/.claude-x/a.md', 'main')).toBeNull()
  expect(calls.filter(c => c.startsWith('git'))).toEqual([])
})

test('RepoTracker: a toplevel in a noise directory gives null', async () => {
  for (const top of ['/private/tmp/x', '/w/node_modules/p']) {
    const run = async (argv: readonly string[]) => (argv[3] === 'rev-parse' ? ok(`${top}\n`) : ok('x\n'))
    const t = new RepoTracker({ run, now: () => 1, rootPath: '/x/repo', rootRepo: ROOT })
    expect(await t.resolvePath('/x/link/a.ts', 'main')).toBeNull()
  }
})

test('RepoTracker: parallel lookups of one directory run rev-parse once', async () => {
  let revParses = 0
  const run = async (argv: readonly string[]) => {
    for (let i = 0; i < 5; i++) await null // yield, so the second lookup starts while the first is in flight
    if (argv[0] === 'sh') return SH
    if (argv[3] === 'rev-parse') {
      revParses++
      return ok('/x/sdk\n')
    }
    if (argv[3] === 'remote') return ok('git@github.com:acme/sdk.git\n')
    return ok('main\n')
  }
  const t = new RepoTracker({ run, now: () => 1, rootPath: '/x/repo', rootRepo: ROOT })
  const [a, b] = await Promise.all([
    t.resolvePath('/x/sdk/src/a.ts', 'main'),
    t.resolvePath('/x/sdk/src/b.ts', 'helper'),
  ])
  expect(revParses).toBe(1)
  expect(a?.key).toBe('remote:github.com/acme/sdk')
  expect(b?.key).toBe(a?.key)
})

test('RepoTracker: a negative answer expires after one tick', async () => {
  let now = 1000
  let revParses = 0
  const run = async (argv: readonly string[]) => {
    if (argv[0] === 'sh') return SH
    if (argv[3] === 'rev-parse') return revParses++ === 0 ? notRepo : ok('/x/sdk\n')
    if (argv[3] === 'remote') return ok('git@github.com:acme/sdk.git\n')
    return ok('main\n')
  }
  const t = new RepoTracker({ run, now: () => now, rootPath: '/x/repo', rootRepo: ROOT })
  expect(await t.resolvePath('/x/sdk/src/a.ts', 'main')).toBeNull()
  now += LIMITS.tickMs - 1
  expect(await t.resolvePath('/x/sdk/src/a.ts', 'main')).toBeNull()
  expect(revParses).toBe(1)
  now += 2
  expect(await t.resolvePath('/x/sdk/src/a.ts', 'main')).toMatchObject({ key: 'remote:github.com/acme/sdk' })
  expect(revParses).toBe(2)
})

test('normalizeRemoteUrl: scp and https remotes give one credential-free key', () => {
  const a = normalizeRemoteUrl('git@gitlab.com:grp/sub/repo.git')
  const b = normalizeRemoteUrl('https://u:tok@gitlab.com/grp/sub/repo.git')
  expect(a.key).toBe(b.key)
  expect(a.key).toBe('remote:gitlab.com/grp/sub/repo')
  expect(b.key).not.toContain('tok')
  expect(b.key).not.toContain('@')
  expect(b.name).toBe('grp/sub/repo')
  expect(normalizeRemoteUrl('https://dev.azure.com/org/proj/_git/repo').key).toBe(
    'remote:dev.azure.com/org/proj/_git/repo',
  )
  expect(normalizeRemoteUrl('ssh://git@host.example:2222/a/b/c.git/').key).toBe('remote:host.example/a/b/c')
  expect(normalizeRemoteUrl('/srv/git/lib').key).toBe('remote:file:/srv/git/lib')
  expect(normalizeRemoteUrl('file:///srv/git/lib').key).toBe('remote:file:/srv/git/lib')
  expect(normalizeRemoteUrl('/srv/git/lib.git').name).toBe('lib')
})
