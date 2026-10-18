import { expect, test } from 'claude-code/testing'
import type { RepoRecord, RepoRef, RunInit, RunResult } from '../hooks/contracts'
import { LIMITS } from '../hooks/contracts'
import { resolvePath } from '../hooks/process/shell'
import { extractRepoPathsFromTool, PATH_TOOLS, parseRepoHintsFromBash, repoBaseDir } from '../hooks/repos/hints'
import { isNoisePath, normalizeRemoteUrl } from '../hooks/repos/identity'
import { capRepoRows, mergeRepoRows, upsertRepoRows } from '../hooks/repos/rows'
import { RepoTracker } from '../hooks/repos/tracker'

const ROOT: RepoRef = { host: 'github.com', owner: 'acme', repo: 'web' }

const hit = (path: string, mode: 'read' | 'edit' = 'read') => ({ path, mode })
const moved = (path: string) => ({ path, mode: 'edit' as const, branchMayChange: true as const })

test('extractRepoPathsFromTool: a Glob with no path takes the literal prefix of an absolute pattern', () => {
  expect(extractRepoPathsFromTool('Glob', { pattern: '/x/sdk/**/*.ts' })).toEqual([hit('/x/sdk')])
  expect(extractRepoPathsFromTool('Glob', { pattern: '/x/sdk/src/*.ts' })).toEqual([hit('/x/sdk/src')])
  expect(extractRepoPathsFromTool('Glob', { pattern: '~/sdk/{a,b}/*.ts' })).toEqual([hit('~/sdk')])
  expect(extractRepoPathsFromTool('Glob', { pattern: '/**/*.ts' })).toEqual([])
  expect(extractRepoPathsFromTool('Glob', { pattern: '/*.ts' })).toEqual([])
  expect(extractRepoPathsFromTool('Glob', { pattern: '**/*.ts' })).toEqual([])
  expect(extractRepoPathsFromTool('Glob', { pattern: '/x/sdk/**/*.ts', path: '/x/lib' })).toEqual([hit('/x/lib')])
  expect(extractRepoPathsFromTool('Glob', { pattern: '/x/sdk/**/*.ts', path: '' })).toEqual([hit('/x/sdk')])
})

test('extractRepoPathsFromTool resolves a relative path from the base and leaves it alone with no base', () => {
  expect(extractRepoPathsFromTool('Read', { file_path: 'src/a.ts' }, '/x/sdk')).toEqual([hit('/x/sdk/src/a.ts')])
  expect(extractRepoPathsFromTool('Grep', { pattern: 'x', path: '../lib' }, '/x/sdk')).toEqual([hit('/x/lib')])
  expect(extractRepoPathsFromTool('Read', { file_path: '/x/other/a.ts' }, '/x/sdk')).toEqual([hit('/x/other/a.ts')])
  expect(extractRepoPathsFromTool('Read', { file_path: 'src/a.ts' })).toEqual([hit('src/a.ts')])
})

test('extractRepoPathsFromTool reads the path fields that each tool really has', () => {
  expect(extractRepoPathsFromTool('Read', { file_path: '/x/other/a.ts' })).toEqual([hit('/x/other/a.ts')])
  expect(extractRepoPathsFromTool('Edit', { file_path: '/x/other/b.ts', old_string: 'a', new_string: 'b' })).toEqual([
    hit('/x/other/b.ts', 'edit'),
  ])
  expect(extractRepoPathsFromTool('Edit', { path: '/x/other/b.ts' })).toEqual([])
  expect(extractRepoPathsFromTool('Write', { file_path: '/x/other/c.ts' })).toEqual([hit('/x/other/c.ts', 'edit')])
  expect(extractRepoPathsFromTool('Grep', { pattern: 'x', path: '/x/other' })).toEqual([hit('/x/other')])
  expect(extractRepoPathsFromTool('Glob', { pattern: '**/*.ts', path: '/x/other' })).toEqual([hit('/x/other')])
  expect(extractRepoPathsFromTool('Glob', { pattern: '**/*.ts' })).toEqual([])
  expect(extractRepoPathsFromTool('Glob', { paths: ['/x/other', '/x/third'] })).toEqual([])
  expect(extractRepoPathsFromTool('NotebookEdit', { notebook_path: '/x/other/n.ipynb' })).toEqual([
    hit('/x/other/n.ipynb', 'edit'),
  ])
  expect(extractRepoPathsFromTool('LSP', { filePath: '/x/a.ts' })).toEqual([])
  expect(extractRepoPathsFromTool('Bash', { path: '/x/other' })).toEqual([])
  expect(extractRepoPathsFromTool('Read', { file_path: '' })).toEqual([])
  expect(extractRepoPathsFromTool('constructor', { file_path: '/x/a' })).toEqual([])
})

test('PATH_TOOLS lists the tools that carry a path, NotebookEdit included', () => {
  expect(PATH_TOOLS).toContain('NotebookEdit')
  expect([...PATH_TOOLS].sort()).toEqual(['Edit', 'Glob', 'Grep', 'NotebookEdit', 'Read', 'Write'])
})

test('resolvePath folds paths like a shell', () => {
  const rows: [string | undefined, string, string][] = [
    ['/a/b', '../c', '/a/c'],
    ['/a/b', '/x/./y/', '/x/y'],
    ['~/x', 'sub', '~/x/sub'],
    ['~/x', '..', '~'],
    ['/w', 'rel', '/w/rel'],
    [undefined, 'rel/../a', 'a'],
    [undefined, '../a', '../a'],
    ['/', '../x', '/x'],
    [undefined, '/../x', '/x'],
  ]
  for (const [base, p, want] of rows) expect(resolvePath(base, p)).toBe(want)
})

test('parseRepoHintsFromBash reads cd, git -C and gh -R in one command', () => {
  const out = parseRepoHintsFromBash(
    'cd ../sdk && git -C ../docs status && gh pr view -R ghe.corp/acme/docs',
    '/x/repo',
  )
  expect(out.paths).toEqual([hit('/x/sdk'), hit('/x/docs')])
  expect(out.repos).toEqual([{ host: 'ghe.corp', owner: 'acme', repo: 'docs' }])
})

// Most rows pin behavior that already worked. Rows marked NEW failed before the shell-like parsing.
const BASH_HINT_ROWS: { cmd: string; cwd?: string; paths?: string[]; repos?: RepoRef[]; note?: string }[] = [
  { cmd: 'cd /abs/dir', paths: ['/abs/dir'] },
  { cmd: 'cd ~/proj', paths: ['~/proj'] },
  { cmd: 'cd ~', paths: [] },
  { cmd: 'cd rel', paths: [] },
  { cmd: 'git -C/abs/x status', paths: ['/abs/x'] },
  { cmd: 'git -C rel status', cwd: '/w', paths: ['/w/rel'] },
  { cmd: 'gh pr view -R acme/sdk', repos: [{ host: 'github.com', owner: 'acme', repo: 'sdk' }] },
  { cmd: 'gh pr view --repo=acme/sdk', repos: [{ host: 'github.com', owner: 'acme', repo: 'sdk' }] },
  { cmd: 'gh pr view -Racme/sdk', repos: [{ host: 'github.com', owner: 'acme', repo: 'sdk' }] },
  {
    cmd: 'gh pr view -R https://ghe.corp/acme/sdk.git/pull/1',
    repos: [{ host: 'ghe.corp', owner: 'acme', repo: 'sdk' }],
  },
  { cmd: 'ls -R foo', repos: [] },
  { cmd: 'gh pr list', repos: [] },
  { cmd: 'gh pr view -R', repos: [] },
  { cmd: 'cd ~/x && cd sub', paths: ['~/x', '~/x/sub'], note: 'NEW' },
  { cmd: 'cd ~/x && git -C y status', paths: ['~/x', '~/x/y'], note: 'NEW' },
  { cmd: 'cd $HOME/x && git -C y status', cwd: '/x/repo', paths: [], note: 'NEW' },
  { cmd: 'cd "$DIR" && ls', cwd: '/x/repo', paths: [], note: 'NEW' },
  { cmd: 'cd && git -C y status', cwd: '/x/repo', paths: [], note: 'NEW' },
  { cmd: 'cd - && git -C y status', cwd: '/x/repo', paths: [], note: 'NEW' },
  { cmd: 'cd ~bob && git -C y status', cwd: '/x/repo', paths: [], note: 'NEW' },
  { cmd: 'cd /a/* && git -C y status', cwd: '/x/repo', paths: [], note: 'NEW' },
  { cmd: 'git -C $D status', cwd: '/x/repo', paths: [], note: 'NEW' },
  { cmd: 'cd -P /abs/dir', paths: ['/abs/dir'], note: 'NEW' },
  { cmd: 'pushd /a/x; popd; git -C y status', paths: ['/a/x'], note: 'NEW' },
  { cmd: 'git grep -C3 foo', cwd: '/w/repo', paths: [], note: 'NEW' },
  { cmd: 'git diff -C HEAD~1', cwd: '/w/repo', paths: [], note: 'NEW' },
  { cmd: 'git commit -C HEAD', cwd: '/w/repo', paths: [], note: 'NEW' },
  { cmd: 'git -c a=b -C ../sdk status', cwd: '/x/repo', paths: ['/x/sdk'], note: 'NEW' },
  { cmd: 'git --no-pager -C /abs/x log', paths: ['/abs/x'], note: 'NEW' },
  { cmd: 'git --git-dir /g -C /abs/x log', paths: ['/abs/x'], note: 'NEW' },
  { cmd: 'cd /../x', paths: ['/x'], note: 'NEW' },
]

test('parseRepoHintsFromBash table: cd, pushd, popd, git -C and gh -R', () => {
  for (const row of BASH_HINT_ROWS) {
    const out = parseRepoHintsFromBash(row.cmd, row.cwd)
    if (row.paths)
      expect({ cmd: row.cmd, paths: out.paths.map(h => h.path) }).toEqual({ cmd: row.cmd, paths: row.paths })
    if (row.repos) expect({ cmd: row.cmd, repos: out.repos }).toEqual({ cmd: row.cmd, repos: row.repos })
  }
})

test('parseRepoHintsFromBash marks a git write subcommand as edit and anything else as read', () => {
  const modes = (cmd: string, cwd?: string) => parseRepoHintsFromBash(cmd, cwd).paths
  expect(modes('git -C /x/sdk commit -m m')).toEqual([hit('/x/sdk', 'edit')])
  expect(modes('git -C /x/sdk log')).toEqual([hit('/x/sdk')])
  expect(modes('git -c a=b -C /x/sdk push')).toEqual([hit('/x/sdk', 'edit')])
  expect(modes('git --no-pager -C /x/sdk checkout main')).toEqual([moved('/x/sdk')])
  expect(modes('git -C /x/sdk')).toEqual([hit('/x/sdk')])
  expect(modes('git commit -C HEAD', '/w')).toEqual([])
  expect(modes('cd /x/sdk && ls')).toEqual([hit('/x/sdk')])
  expect(modes('cd /x/sdk && git status', '/w')).toEqual([hit('/x/sdk')])
  expect(modes('cd /x/sdk && git push', '/w')).toEqual([hit('/x/sdk'), hit('/x/sdk', 'edit')])
  expect(modes('cd /x/sdk && git push', undefined)).toEqual([hit('/x/sdk'), hit('/x/sdk', 'edit')])
  expect(modes('cd sub && git commit', '/w')).toEqual([hit('/w/sub'), hit('/w/sub', 'edit')])
  expect(modes('git commit -m m', '/w')).toEqual([])
  expect(modes('cd /w && git commit', '/w')).toEqual([hit('/w')])
  expect(modes('cd $D && git commit', '/w')).toEqual([])
  expect(parseRepoHintsFromBash('gh pr create -R acme/sdk').repos).toHaveLength(1)
})

test('parseRepoHintsFromBash flags only checkout and switch as able to change the branch', () => {
  const hits = (cmd: string, cwd?: string) => parseRepoHintsFromBash(cmd, cwd).paths
  expect(hits('git -C /x/sdk checkout feat')).toEqual([moved('/x/sdk')])
  expect(hits('git -C /x/sdk switch -c feat')).toEqual([moved('/x/sdk')])
  expect(hits('cd /x/sdk && git switch feat', '/w')).toEqual([hit('/x/sdk'), moved('/x/sdk')])
  expect(hits('git -C /x/sdk status')).toEqual([hit('/x/sdk')])
  expect(hits('git -C /x/sdk commit -m m')).toEqual([hit('/x/sdk', 'edit')])
  expect(hits('git -C /x/sdk push')).toEqual([hit('/x/sdk', 'edit')])
})

test('parseRepoHintsFromBash keeps a cd inside a subshell out of later commands', () => {
  const paths = (cmd: string, cwd?: string) => parseRepoHintsFromBash(cmd, cwd).paths.map(h => h.path)
  const sub = paths('(cd /a/sdk && make); git -C rel status', '/work')
  expect(sub).toContain('/work/rel')
  expect(sub).not.toContain('/a/sdk/rel')
  expect(paths('(cd /a); (git -C rel status)', '/work')).toEqual(['/a', '/work/rel'])
  expect(paths('x=$(cd /a && pwd); git -C rel status', '/work')).toEqual(['/a', '/work/rel'])
  expect(paths('{ cd /a/sdk; }; git -C rel status', '/work')).toEqual(['/a/sdk', '/a/sdk/rel'])
  expect(paths('cd /a && (cd b) && git -C c status', '/work')).toEqual(['/a', '/a/b', '/a/c'])
  expect(paths('cd /a && (cd b && (cd c); git -C d status)', '/work')).toEqual(['/a', '/a/b', '/a/b/c', '/a/b/d'])
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
    mode: 'read',
    at,
  })
  const b = upsertRepoRows(a, {
    key: 'remote:github.com/acme/sdk',
    name: 'acme/sdk',
    branch: 'feat/x',
    touchedBy: 'planner',
    mode: 'read',
    at: at + LIMITS.tickMs,
  })
  expect(b).toHaveLength(1)
  expect(b[0]).toMatchObject({
    key: 'remote:github.com/acme/sdk',
    branch: 'feat/x',
    touchedBy: ['main', 'planner'],
    firstSeen: at,
    lastSeen: at + LIMITS.tickMs,
  })
})

const SDK = 'remote:github.com/acme/sdk'
const row = (over: Partial<RepoRecord> = {}): RepoRecord => ({
  key: SDK,
  name: 'acme/sdk',
  touchedBy: ['main'],
  firstSeen: 10,
  lastSeen: 50,
  ...over,
})

test('mergeRepoRows keeps the oldest firstSeen and the newest lastSeen and branch, in both orders', () => {
  const stored = row({ firstSeen: 10, lastSeen: 50, branch: 'old', root: '/old', touchedBy: ['main', 'planner'] })
  const live = row({ firstSeen: 60, lastSeen: 90, branch: 'new', touchedBy: ['main'] })
  for (const [a, b] of [
    [[stored], [live]],
    [[live], [stored]],
  ] as const) {
    const out = mergeRepoRows([...a], [...b])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ firstSeen: 10, lastSeen: 90, branch: 'new', root: '/old' })
    expect([...out[0]!.touchedBy].sort()).toEqual(['main', 'planner'])
  }
  expect(mergeRepoRows([stored], [live])[0]!.touchedBy).toEqual(['main', 'planner'])
})

test('mergeRepoRows appends a new key with its own firstSeen and returns cur for an empty or unchanged merge', () => {
  const cur = [row()]
  const other = row({ key: 'remote:github.com/acme/web', name: 'acme/web', firstSeen: 7, lastSeen: 8 })
  expect(mergeRepoRows(cur, [other])).toEqual([cur[0], other])
  expect(mergeRepoRows(cur, [])).toBe(cur)
  expect(mergeRepoRows([], [])).toEqual([])
  const empty: RepoRecord[] = []
  expect(mergeRepoRows(empty, [])).toBe(empty)
  expect(mergeRepoRows(cur, [{ ...cur[0]!, touchedBy: ['main'] }])).toBe(cur)
})

test('upsertRepoRows: an older visit keeps the newer branch, root, name and lastSeen', () => {
  const cur = [row({ branch: 'new', root: '/x/new', lastSeen: 500_000 })]
  const out = upsertRepoRows(cur, {
    key: SDK,
    name: 'acme/old',
    root: '/x/old',
    branch: 'old',
    touchedBy: 'planner',
    mode: 'read',
    at: 100,
  })
  expect(out[0]).toMatchObject({ name: 'acme/sdk', branch: 'new', root: '/x/new', lastSeen: 500_000, firstSeen: 10 })
  expect(out[0]!.touchedBy).toEqual(['main', 'planner'])
})

test('upsertRepoRows: a repeat visit inside tickMs returns the same array, one after tickMs moves lastSeen', () => {
  const cur = [row({ branch: 'main', root: '/x/sdk', lastSeen: 1_000_000 })]
  const visit = { key: SDK, name: 'acme/sdk', root: '/x/sdk', branch: 'main', touchedBy: 'main', mode: 'read' as const }
  expect(upsertRepoRows(cur, { ...visit, at: 1_000_000 + LIMITS.tickMs - 1 })).toBe(cur)
  const later = upsertRepoRows(cur, { ...visit, at: 1_000_000 + LIMITS.tickMs })
  expect(later).not.toBe(cur)
  expect(later[0]!.lastSeen).toBe(1_000_000 + LIMITS.tickMs)
})

test('upsertRepoRows: a ref visit keeps the name case and a visit without a branch keeps the branch', () => {
  const cur = [row({ branch: 'main', root: '/x/sdk', lastSeen: 1_000_000 })]
  const ref = upsertRepoRows(cur, { key: SDK, name: 'Acme/SDK', touchedBy: 'main', mode: 'read', at: 1_000_001 })
  expect(ref).toBe(cur)
  const noBranch = upsertRepoRows(cur, {
    key: SDK,
    name: 'acme/sdk',
    root: '/x/sdk',
    touchedBy: 'planner',
    mode: 'read',
    at: 1_000_002,
  })
  expect(noBranch[0]!.branch).toBe('main')
  const resolved = upsertRepoRows(cur, {
    key: SDK,
    name: 'Acme/SDK',
    root: '/x/sdk',
    touchedBy: 'main',
    mode: 'read',
    at: 1_000_003,
  })
  expect(resolved[0]!.name).toBe('Acme/SDK')
})

test('upsertRepoRows: an earlier visit lowers firstSeen', () => {
  const out = upsertRepoRows([row({ firstSeen: 100, lastSeen: 200 })], {
    key: SDK,
    name: 'acme/sdk',
    touchedBy: 'main',
    mode: 'read',
    at: 40,
  })
  expect(out[0]!.firstSeen).toBe(40)
  expect(out[0]!.lastSeen).toBe(200)
})

test('upsertRepoRows: a new row takes the visit mode, and edit wins over read in both orders', () => {
  const visit = { key: SDK, name: 'acme/sdk', touchedBy: 'main' }
  const read = upsertRepoRows([], { ...visit, mode: 'read', at: 100 })
  expect(read[0]!.mode).toBe('read')
  const edited = upsertRepoRows(read, { ...visit, mode: 'edit', at: 101 })
  expect(edited).not.toBe(read)
  expect(edited[0]!.mode).toBe('edit')
  const kept = upsertRepoRows(edited, { ...visit, mode: 'read', at: 102 })
  expect(kept).toBe(edited)
  const first = upsertRepoRows([], { ...visit, mode: 'edit', at: 100 })
  expect(first[0]!.mode).toBe('edit')
  expect(upsertRepoRows(first, { ...visit, mode: 'read', at: 100 + LIMITS.tickMs })[0]!.mode).toBe('edit')
})

test('upsertRepoRows: a stored row without mode reads as read; an older edit visit still upgrades it', () => {
  const cur = [row({ lastSeen: 1_000_000 })]
  const visit = { key: SDK, name: 'acme/sdk', touchedBy: 'main' }
  expect(upsertRepoRows(cur, { ...visit, mode: 'read', at: 1_000_001 })).toBe(cur)
  const up = upsertRepoRows(cur, { ...visit, mode: 'edit', at: 1_000_001 })
  expect(up).not.toBe(cur)
  expect(up[0]!.mode).toBe('edit')
  expect(upsertRepoRows(cur, { ...visit, mode: 'edit', at: 5 })[0]!.mode).toBe('edit')
})

test('mergeRepoRows: edit wins in both orders and a missing mode reads as read', () => {
  const edit = row({ mode: 'edit', lastSeen: 50 })
  const newerRead = row({ mode: 'read', lastSeen: 90 })
  expect(mergeRepoRows([edit], [newerRead])[0]!.mode).toBe('edit')
  expect(mergeRepoRows([newerRead], [edit])[0]!.mode).toBe('edit')
  const olderNone = row({ lastSeen: 40 })
  expect(mergeRepoRows([olderNone], [edit])[0]!.mode).toBe('edit')
  expect(mergeRepoRows([edit], [olderNone])[0]!.mode).toBe('edit')
  const none = row({ lastSeen: 40 })
  const cur = [none]
  expect(mergeRepoRows(cur, [row({ lastSeen: 40 })])).toBe(cur)
  expect(mergeRepoRows([none], [newerRead])[0]!.mode ?? 'read').toBe('read')
})

test('RepoTracker: resolvePath and fromRepoRef put the mode in the visit, and read is the default', async () => {
  const t = new RepoTracker({ run: worktreeRunner(), now: () => 0, rootPath: '/x/repo', rootRepo: ROOT })
  expect(await t.resolvePath('/x/sdk/src', 'main', 'edit')).toMatchObject({ mode: 'edit' })
  expect(await t.resolvePath('/x/sdk/src', 'main', 'read')).toMatchObject({ mode: 'read' })
  expect(await t.resolvePath('/x/sdk/src', 'main')).toMatchObject({ mode: 'read' })
  const ref = { host: 'github.com', owner: 'acme', repo: 'docs' }
  expect(await t.fromRepoRef(ref, 'main')).toMatchObject({ mode: 'read' })
  expect(await t.fromRepoRef(ref, 'main', 'edit')).toMatchObject({ mode: 'edit' })
})

test('capRepoRows keeps the maxRepos newest rows in order and the first maxRepoAgents agents', () => {
  const many = Array.from({ length: LIMITS.maxRepos + 1 }, (_, i) =>
    row({ key: `local:/r${i}`, name: `r${i}`, lastSeen: 1000 + ((i + 7) % (LIMITS.maxRepos + 1)) }),
  )
  const oldest = many.reduce((a, b) => (b.lastSeen < a.lastSeen ? b : a))
  const out = capRepoRows(many)
  expect(out).toHaveLength(LIMITS.maxRepos)
  expect(out.map(r => r.key)).not.toContain(oldest.key)
  expect(out.map(r => r.key)).toEqual(many.filter(r => r.key !== oldest.key).map(r => r.key))
  const agents = Array.from({ length: LIMITS.maxRepoAgents + 2 }, (_, i) => `a${i}`)
  expect(capRepoRows([row({ touchedBy: agents })])[0]!.touchedBy).toEqual(agents.slice(0, LIMITS.maxRepoAgents))
  const small = [row()]
  expect(capRepoRows(small)).toBe(small)
})

function worktreeRunner(calls: string[] = []) {
  return async (argv: readonly string[], init?: RunInit): Promise<RunResult> => {
    calls.push(`${argv.join(' ')} @ ${init?.cwd ?? ''}`)
    if (argv[0] === 'git' && argv[1] === '-C' && argv[3] === 'rev-parse') {
      if (argv[2] === '/x/sdk/src') return { exitCode: 0, stdout: '/x/sdk\n/x/sdk/.git\n', stderr: '' }
      if (argv[2] === '/x/sdk/tests') return { exitCode: 0, stdout: '/x/sdk-wt\n/x/sdk/.git\n', stderr: '' }
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
/** What `rev-parse --path-format=absolute --show-toplevel --git-common-dir` prints: the toplevel, then the common dir. */
const GIT_SDK = '/x/sdk\n/x/sdk/.git\n'

test('RepoTracker: non-repo paths are an expected answer and never open the breaker', async () => {
  const run = async (argv: readonly string[]) => {
    if (argv[3] === 'rev-parse') return argv[2] === '/x/sdk/src' ? ok(GIT_SDK) : notRepo
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
      return argv[2] === '/x/sdk/src' ? ok(GIT_SDK) : notRepo
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
        ? ok(GIT_SDK)
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
    if (argv[3] === 'rev-parse') return argv[2] === '/home/me/sdk' ? ok('/home/me/sdk\n/home/me/sdk/.git\n') : notRepo
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
    if (argv[3] === 'rev-parse') return argv[2] === '/x/repo' ? notRepo : ok('/home/me/sdk\n/home/me/sdk/.git\n')
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
      return d.startsWith('/x/sdk') ? ok(GIT_SDK) : notRepo
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
    if (argv[3] === 'rev-parse') {
      if (argv[2] === '/x/repo') return notRepo // the session root
      const top = argv[2]!.replace(/\/src$/, '')
      return ok(`${top}\n${top}/.git\n`)
    }
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
  expect(await t.resolvePath('/x/lib/src/a.ts', 'main')).toMatchObject({ key: 'local:/x/lib/.git', name: 'lib' })

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
    if (argv[3] === 'rev-parse') return argv[2] === '/home/me/sdk' ? ok('/home/me/sdk\n/home/me/sdk/.git\n') : notRepo
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

test('RepoTracker: a toplevel in a noise directory that is not the own repo gives null', async () => {
  const noisy = '/home/me/.claude-x/plugins/marketplaces/foo'
  const run = async (argv: readonly string[]) => {
    if (argv[0] === 'sh') return SH
    if (argv[3] === 'rev-parse')
      return argv[2] === '/x/repo' ? ok('/x/repo\n/x/repo/.git\n') : ok(`${noisy}\n${noisy}/.git\n`)
    if (argv[3] === 'remote')
      return ok(argv[2] === '/x/repo' ? 'git@github.com:acme/web.git\n' : 'git@github.com:acme/foo.git\n')
    return ok('main\n')
  }
  const t = new RepoTracker({ run, now: () => 1, rootPath: '/x/repo', rootRepo: ROOT })
  expect(await t.resolvePath('/x/link/a.ts', 'main')).toBeNull()
})

test('RepoTracker: every git call asks for English messages with LC_ALL=C', async () => {
  const inits: Array<[string, RunInit | undefined]> = []
  const run = async (argv: readonly string[], init?: RunInit) => {
    inits.push([argv[0]!, init])
    if (argv[0] === 'sh') return SH
    if (argv[3] === 'rev-parse') return argv[2] === '/x/repo' ? notRepo : ok(GIT_SDK)
    if (argv[3] === 'remote') return ok('git@github.com:acme/sdk.git\n')
    return ok('main\n')
  }
  const t = new RepoTracker({ run, now: () => 1, rootPath: '/x/repo', rootRepo: ROOT })
  expect(await t.resolvePath('/x/sdk/a.ts', 'main')).not.toBeNull()
  const git = inits.filter(i => i[0] === 'git')
  expect(git.length).toBeGreaterThan(0)
  for (const [, init] of inits) expect(init?.env).toEqual({ LC_ALL: 'C' })
})

test('RepoTracker: parallel lookups of one directory run rev-parse once', async () => {
  let revParses = 0
  const run = async (argv: readonly string[]) => {
    for (let i = 0; i < 5; i++) await null // yield, so the second lookup starts while the first is in flight
    if (argv[0] === 'sh') return SH
    if (argv[3] === 'rev-parse') {
      if (argv[2] === '/x/repo') return notRepo // the session root
      revParses++
      return ok(GIT_SDK)
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
    if (argv[3] === 'rev-parse') {
      if (argv[2] === '/x/repo') return notRepo // the session root
      return revParses++ === 0 ? notRepo : ok(GIT_SDK)
    }
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

// ---------------------------------------------------------------- P2: own repo by git identity

type FakeRepo = { top: string; common: string; origin?: string }

/** Maps a directory to its repo by longest toplevel prefix. Counts every git call in `calls`. */
function identityRunner(repos: readonly FakeRepo[], calls: string[] = []) {
  const byTop = (dir: string) =>
    repos.filter(r => dir === r.top || dir.startsWith(`${r.top}/`)).sort((a, b) => b.top.length - a.top.length)[0]
  return async (argv: readonly string[]): Promise<RunResult> => {
    if (argv[0] === 'sh') return SH
    calls.push(argv.join(' '))
    const r = byTop(argv[2]!)
    if (argv[3] === 'rev-parse') return r ? ok(`${r.top}\n${r.common}\n`) : notRepo
    if (argv[3] === 'remote') return r?.origin ? ok(`${r.origin}\n`) : { exitCode: 2, stdout: '', stderr: 'no origin' }
    return ok('main\n')
  }
}

const REPOS: FakeRepo[] = [
  { top: '/x/repo', common: '/x/repo/.git' },
  { top: '/x/repo-wt', common: '/x/repo/.git' },
  { top: '/x/clone', common: '/x/clone/.git', origin: 'git@gitlab.com:grp/app.git' },
  { top: '/x/sdk', common: '/x/sdk/.git', origin: 'git@github.com:acme/sdk.git' },
]
const GITLAB_ROOT: FakeRepo = { top: '/x/repo', common: '/x/repo/.git', origin: 'git@gitlab.com:grp/app.git' }

test('own repo: a sibling worktree of a root without a remote is not a foreign row', async () => {
  const run = identityRunner(REPOS)
  const t = new RepoTracker({ run, now: () => 1, rootPath: '/x/repo', rootRepo: null })
  expect(await t.resolvePath('/x/repo-wt/a.ts', 'main')).toBeNull()
  expect(await t.resolvePath('/x/sdk/a.ts', 'main')).toMatchObject({ key: 'remote:github.com/acme/sdk' })
})

test('own repo: a path under the root toplevel makes no git call once the identity is known', async () => {
  const calls: string[] = []
  const t = new RepoTracker({ run: identityRunner(REPOS, calls), now: () => 1, rootPath: '/x/repo', rootRepo: null })
  expect(await t.resolvePath('/x/repo/src/a.ts', 'main')).toBeNull()
  const before = calls.length
  expect(before).toBeGreaterThan(0) // the identity probe
  expect(await t.resolvePath('/x/repo/src/deep/b.ts', 'main')).toBeNull()
  expect(await t.resolvePath('/x/repo/other/c.ts', 'helper')).toBeNull()
  expect(calls.length).toBe(before)
})

test('own repo: a root on GitLab (no rootRepo) still excludes its worktree and a clone with the same origin', async () => {
  const repos = [GITLAB_ROOT, ...REPOS.slice(1)]
  const t = new RepoTracker({ run: identityRunner(repos), now: () => 1, rootPath: '/x/repo', rootRepo: null })
  expect(await t.resolvePath('/x/repo-wt/a.ts', 'main')).toBeNull()
  expect(await t.resolvePath('/x/clone/a.ts', 'main')).toBeNull()
})

test('own repo: an unknown root is no answer, and nothing is cached as foreign', async () => {
  const deps: { run: ReturnType<typeof identityRunner>; now: () => number; rootPath?: string; rootRepo: null } = {
    run: identityRunner(REPOS),
    now: () => 1,
    rootRepo: null,
  }
  const t = new RepoTracker(deps)
  expect(await t.resolvePath('/x/repo/src/a.ts', 'main')).toBeNull()
  expect(await t.resolvePath('/x/sdk/a.ts', 'main')).toBeNull()
  deps.rootPath = '/x/repo'
  expect(await t.resolvePath('/x/repo/src/a.ts', 'main')).toBeNull()
  expect(await t.resolvePath('/x/sdk/a.ts', 'main')).toMatchObject({ key: 'remote:github.com/acme/sdk' })
})

test('own repo: fromRepoRef drops the root remote, the origin of a GitLab root and keeps a foreign ref', async () => {
  const gh = new RepoTracker({
    run: identityRunner([{ ...GITLAB_ROOT, origin: 'git@github.com:acme/web.git' }]),
    now: () => 1,
    rootPath: '/x/repo',
    rootRepo: ROOT,
  })
  expect(await gh.fromRepoRef(ROOT, 'main')).toBeNull()
  expect(await gh.fromRepoRef({ host: 'github.com', owner: 'acme', repo: 'docs' }, 'main')).toMatchObject({
    key: 'remote:github.com/acme/docs',
    name: 'acme/docs',
    touchedBy: 'main',
  })

  const gl = new RepoTracker({ run: identityRunner([GITLAB_ROOT]), now: () => 1, rootPath: '/x/repo', rootRepo: null })
  const ref = { host: 'gitlab.com', owner: 'grp', repo: 'app' }
  expect(await gl.fromRepoRef(ref, 'main')).toBeNull() // only own.key matches
  expect(await gl.fromRepoRef({ ...ref, repo: 'other' }, 'main')).not.toBeNull()

  const unknown = new RepoTracker({ run: identityRunner([GITLAB_ROOT]), now: () => 1, rootRepo: null })
  expect(await unknown.fromRepoRef({ host: 'github.com', owner: 'acme', repo: 'docs' }, 'main')).toBeNull()
})

test('own repo: a root in a subfolder of its repo excludes the whole repo', async () => {
  const calls: string[] = []
  const t = new RepoTracker({
    run: identityRunner(REPOS, calls),
    now: () => 1,
    rootPath: '/x/repo/pkg',
    rootRepo: null,
  })
  expect(await t.resolvePath('/x/repo/a.ts', 'main')).toBeNull()
  expect(await t.resolvePath('/x/repo/other/new/file.ts', 'main')).toBeNull()
})

test('own repo: a clone of the rootRepo remote is the same repo', async () => {
  const repos = [
    { top: '/x/repo', common: '/x/repo/.git' },
    { top: '/x/clone', common: '/x/clone/.git', origin: 'git@github.com:acme/web.git' },
  ]
  const t = new RepoTracker({ run: identityRunner(repos), now: () => 1, rootPath: '/x/repo', rootRepo: ROOT })
  expect(await t.resolvePath('/x/clone/a.ts', 'main')).toBeNull()
})

test('local repos are keyed by their git common dir, so worktrees share one row', async () => {
  const repos = [
    { top: '/x/lib', common: '/x/lib/.git' },
    { top: '/x/lib-wt', common: '/x/lib/.git' },
    { top: '/x/bare-wt', common: '/srv/lib.git' },
  ]
  const t = new RepoTracker({ run: identityRunner(repos), now: () => 1, rootPath: '/x/repo', rootRepo: null })
  expect(await t.resolvePath('/x/lib/a.ts', 'main')).toMatchObject({ key: 'local:/x/lib/.git', name: 'lib' })
  expect(await t.resolvePath('/x/lib-wt/a.ts', 'main')).toMatchObject({ key: 'local:/x/lib/.git', name: 'lib' })
  expect(await t.resolvePath('/x/bare-wt/a.ts', 'main')).toMatchObject({ key: 'local:/srv/lib.git', name: 'lib' })
})

test('the common dir is not stored in a repo row', async () => {
  const t = new RepoTracker({ run: identityRunner(REPOS), now: () => 1, rootPath: '/x/repo', rootRepo: null })
  const v = await t.resolvePath('/x/sdk/a.ts', 'main')
  expect(v).not.toBeNull()
  expect('common' in v!).toBe(false)
  expect(JSON.stringify(upsertRepoRows([], { ...v!, at: 5 }))).not.toContain('.git"')
})

test('an old git that echoes --path-format is probed again without it, with a relative common dir', async () => {
  const calls: string[] = []
  const run = async (argv: readonly string[]): Promise<RunResult> => {
    if (argv[0] === 'sh') return SH
    calls.push(argv.join(' '))
    if (argv[3] === 'rev-parse') {
      if (argv[2] === '/x/repo') return notRepo
      return argv.includes('--path-format=absolute')
        ? ok('--path-format=absolute\n/x/lib\n.git\n')
        : ok('/x/lib\n.git\n')
    }
    if (argv[3] === 'remote') return { exitCode: 2, stdout: '', stderr: '' }
    return ok('main\n')
  }
  const t = new RepoTracker({ run, now: () => 1, rootPath: '/x/repo', rootRepo: null })
  expect(await t.resolvePath('/x/lib/a.ts', 'main')).toMatchObject({ key: 'local:/x/lib/.git', name: 'lib' })
  expect(calls.some(c => c.includes('rev-parse') && !c.includes('--path-format'))).toBe(true)
})

test('repoBaseDir: the session cwd for the main loop, none for a subagent', () => {
  expect(repoBaseDir('/w', undefined)).toBe('/w')
  expect(repoBaseDir('/w', 'a1')).toBeUndefined()
  expect(repoBaseDir(undefined, undefined)).toBeUndefined()
})

// ---------------------------------------------------------------- branch refresh (m12)

test('RepoTracker: the branch of a known repo is re-read after one tick, off the cached lookup', async () => {
  let now = 5_000
  let branch: string | Error = 'main'
  const calls: string[] = []
  const run = async (argv: readonly string[]): Promise<RunResult> => {
    if (argv[0] === 'sh') return SH
    calls.push(`${argv[2]} ${argv.slice(3).join(' ')}`)
    if (argv[3] === 'rev-parse') return argv[2] === '/x/repo' ? ok('/x/repo\n/x/repo/.git\n') : ok(GIT_SDK)
    if (argv[3] === 'remote')
      return ok(argv[2] === '/x/repo' ? 'git@github.com:acme/web.git\n' : 'git@github.com:acme/sdk.git\n')
    if (branch instanceof Error) throw branch
    return ok(`${branch}\n`)
  }
  // Only the calls for the sdk repo. The session root is a repo too, so its identity stays cached.
  const count = (what: string) => calls.filter(c => c.startsWith(`/x/sdk ${what}`)).length
  const t = new RepoTracker({ run, now: () => now, rootPath: '/x/repo', rootRepo: ROOT })
  const start = now
  expect(await t.resolvePath('/x/sdk/a.ts', 'main')).toMatchObject({ branch: 'main' })
  const revParses = count('rev-parse')
  const remotes = count('remote')
  expect(count('branch --show-current')).toBe(1)

  branch = 'feat'
  now = start + LIMITS.tickMs - 1
  expect(await t.resolvePath('/x/sdk/a.ts', 'main')).toMatchObject({ branch: 'main' })
  expect(count('branch --show-current')).toBe(1)

  now = start + LIMITS.tickMs
  expect(await t.resolvePath('/x/sdk/a.ts', 'main')).toMatchObject({ branch: 'feat' })
  expect(count('branch --show-current')).toBe(2)
  expect(count('rev-parse')).toBe(revParses)
  expect(count('remote')).toBe(remotes)

  // Inside the new tick no call. After it, a fault keeps the old branch and counts against the breaker.
  now += LIMITS.tickMs - 1
  expect(await t.resolvePath('/x/sdk/a.ts', 'main')).toMatchObject({ branch: 'feat' })
  expect(count('branch --show-current')).toBe(2)
  branch = new Error('timeout')
  for (let i = 0; i < LIMITS.breakerThreshold; i++) {
    now += LIMITS.tickMs
    expect(await t.resolvePath('/x/sdk/a.ts', 'main')).toMatchObject({ branch: 'feat' })
  }
  expect(count('branch --show-current')).toBe(2 + LIMITS.breakerThreshold)
  now += 1 // the old branch is still stale, but the open breaker allows no call
  expect(await t.resolvePath('/x/sdk/a.ts', 'main')).toMatchObject({ branch: 'feat' })
  expect(count('branch --show-current')).toBe(2 + LIMITS.breakerThreshold)
})

test('RepoTracker: a branch change hint re-reads the branch at once, a plain visit still uses the cache', async () => {
  let now = 5_000
  let branch = 'main'
  const calls: string[] = []
  const run = async (argv: readonly string[]): Promise<RunResult> => {
    if (argv[0] === 'sh') return SH
    calls.push(`${argv[2]} ${argv.slice(3).join(' ')}`)
    if (argv[3] === 'rev-parse') return argv[2] === '/x/repo' ? ok('/x/repo\n/x/repo/.git\n') : ok(GIT_SDK)
    if (argv[3] === 'remote')
      return ok(argv[2] === '/x/repo' ? 'git@github.com:acme/web.git\n' : 'git@github.com:acme/sdk.git\n')
    return ok(`${branch}\n`)
  }
  const count = () => calls.filter(c => c.startsWith('/x/sdk branch --show-current')).length
  const t = new RepoTracker({ run, now: () => now, rootPath: '/x/repo', rootRepo: ROOT })
  const start = now
  expect(await t.resolvePath('/x/sdk', 'main')).toMatchObject({ branch: 'main' })
  expect(count()).toBe(1)

  branch = 'feat'
  now = start + 10_000
  expect(await t.resolvePath('/x/sdk', 'main', 'read')).toMatchObject({ branch: 'main' })
  expect(count()).toBe(1)
  expect(await t.resolvePath('/x/sdk', 'main', 'edit', { branchMayChange: true })).toMatchObject({ branch: 'feat' })
  expect(count()).toBe(2)
  // The forced read restarts the tick: the next plain visit uses the new value.
  expect(await t.resolvePath('/x/sdk', 'main')).toMatchObject({ branch: 'feat' })
  expect(count()).toBe(2)
})

test('RepoTracker: parallel visits after a tick share one branch call', async () => {
  let now = 1
  let branch = 'main'
  let branchCalls = 0
  const run = async (argv: readonly string[]): Promise<RunResult> => {
    if (argv[0] === 'sh') return SH
    if (argv[3] === 'rev-parse') return argv[2] === '/x/repo' ? notRepo : ok(GIT_SDK)
    if (argv[3] === 'remote') return ok('git@github.com:acme/sdk.git\n')
    branchCalls++
    return ok(`${branch}\n`)
  }
  const t = new RepoTracker({ run, now: () => now, rootPath: '/x/repo', rootRepo: ROOT })
  await t.resolvePath('/x/sdk/a.ts', 'main')
  branch = 'feat'
  now += LIMITS.tickMs
  const out = await Promise.all([t.resolvePath('/x/sdk/a.ts', 'main'), t.resolvePath('/x/sdk/b.ts', 'helper')])
  expect(out.map(v => v?.branch)).toEqual(['feat', 'feat'])
  expect(branchCalls).toBe(2)
})
