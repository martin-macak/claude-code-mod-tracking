// The repos tracker on fakePorts, through the LifecycleManager: the events it hears, the lookups it queues, the rows it
// keeps and how a switch or `/track clear` treats them. Each case mirrors the kit test of the same subject in
// register.test.tsx. The facts `auto.root` and `auto.agents` stand in for the auto tracker. Plan: L3 Task 9.
import { expect, test } from 'claude-code/testing'
import { LifecycleManager } from '../core/infra/lifecycle'
import type { ToolCallEvent } from '../core/interfaces/events'
import type { ItemsHost, Json } from '../core/interfaces/items'
import type { RunResult } from '../core/interfaces/ports'
import { asRepoRows, type ReposConfig, reposConfig, reposTracker, setRepos } from '../trackers/repos'
import { fakeConfig } from './fixtures/config-fs'
import type { AgentProof, RepoRecord } from './fixtures/contracts'
import { IDLE_ITEMS } from './fixtures/items-host'
import { LIMITS } from './fixtures/limits'
import { type FakeWorld, fakePorts } from './fixtures/ports'
import { hostWorld } from './fixtures/tracker-host'

declare function setTimeout(fn: () => void, ms: number): unknown
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const res = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '' })

const SDK_KEY = 'remote:github.com/acme/sdk'
const SDK_REMOTE = 'git@github.com:acme/sdk.git'
const LIB_KEY = 'remote:github.com/acme/lib'
const LIB_REMOTE = 'git@github.com:acme/lib.git'
const RAN = { result: { stdout: '', stderr: '', interrupted: false } }

const STORED_SDK: RepoRecord = {
  key: SDK_KEY,
  name: 'acme/sdk',
  root: '/x/sdk',
  branch: 'old',
  touchedBy: ['main', 'planner'],
  firstSeen: 10,
  lastSeen: 50,
}

/** An item host that holds nothing: this tracker never touches the item list. */
function stubHost(): ItemsHost {
  return {
    ...IDLE_ITEMS,
    slot: {
      id: 'items',
      persist: true,
      read: async () => [],
      empty: () => true,
      settle: async live => live,
      restore: async () => {},
    },
    start: async () => {},
    replay: async () => {},
    tick: async () => {},
    sessionChanged: async () => {},
    dispose: () => {},
    list: async () => [],
    update: async () => false,
    track: async () => {},
    refresh: () => {},
  }
}

function setup(o: { cwd?: string; repos?: Partial<ReposConfig> } = {}) {
  const w = fakePorts({ session: { cwd: o.cwd ?? '/work' } })
  const dismissed = new Set<string>()
  const trackers = [reposTracker()]
  const m = new LifecycleManager(
    {
      trackers,
      items: stubHost(),
      dismiss: () => ({
        list: async () => dismissed,
        add: async ids => {
          for (const id of ids) dismissed.add(id)
        },
      }),
      config: () =>
        fakeConfig({
          specs: trackers,
          ...(o.repos ? { file: { version: 1, trackers: { repos: o.repos } } } : {}),
        }),
      paneId: 'track',
    },
    w.ports,
  )
  // The auto tracker pins the root and keeps the ledger. These facts stand in for it.
  m.facts.publish('auto.root', { cwd: '/work', at: 0, top: '/work' })
  const agents = (list: Partial<AgentProof>[]) =>
    m.facts.publish(
      'auto.agents',
      list.map(a => ({ kind: 'workflow', label: '', spawnedAt: 0, ...a })) as unknown as Json,
    )
  const rows = () => (w.state.get('repos') ?? []) as unknown as RepoRecord[]
  const keys = () => rows().map(r => r.key)
  const call = (tool: string, input: Record<string, unknown>, extra: Partial<ToolCallEvent> = {}, result?: unknown) =>
    m.toolCall(w.ports, {
      tool,
      input: { tool, ...input } as Json,
      result: (result ?? RAN) as Json,
      ...extra,
    })
  const bash = (command: string, extra: Partial<ToolCallEvent> = {}, result?: unknown) =>
    call('Bash', { command }, extra, result)
  const spawn = (input: Record<string, unknown>, agentId: string) =>
    m.agentSpawn(w.ports, { input: input as Json, answer: { agentId } })
  return { w, m, dismissed, agents, rows, keys, call, bash, spawn }
}

/** Waits until the queue has run: no new git call comes for a while. */
async function drain(w: FakeWorld): Promise<void> {
  let last = -1
  for (let i = 0; i < 100; i++) {
    await sleep(8)
    if (w.calls.length === last && i >= 3) return
    last = w.calls.length
  }
}

/**
 * Git answers for repos at the given tops (top to remote). Every git call takes a few ms, so overlapping calls show in
 * `seen.peak`. `held` makes a rev-parse wait for a promise that the test releases.
 */
function gitAt(w: FakeWorld, tops: Record<string, string>, held?: Promise<undefined>) {
  const seen = {
    revParse: [] as string[],
    branchCalls: 0,
    branch: 'main',
    inFlight: 0,
    peak: 0,
    /** The argv of each `worktree list`, joined. The list of a repo is its top on `seen.branch`, and more worktrees from `extra`. */
    lists: [] as string[],
    extra: {} as Record<string, string>,
    /** Tops whose `worktree list` exits 128, as for a repo that git cannot read any more. */
    unreadable: new Set<string>(),
  }
  w.run = async argv => {
    if (argv[0] !== 'git' || argv[1] !== '-C') return undefined
    const dir = String(argv[2])
    const top = Object.keys(tops).find(t => dir === t || dir.startsWith(`${t}/`))
    if (top === undefined) return undefined
    if (argv[3] === 'worktree') {
      seen.lists.push(argv.join(' '))
      if (seen.unreadable.has(top)) return { exitCode: 128, stdout: '', stderr: `fatal: cannot change to '${dir}'` }
      return res(`worktree ${top}\nHEAD abc\nbranch refs/heads/${seen.branch}\n\n${seen.extra[top] ?? ''}`)
    }
    if (argv[3] === 'rev-parse') {
      seen.revParse.push(dir)
      if (held) await held
    }
    seen.inFlight++
    seen.peak = Math.max(seen.peak, seen.inFlight)
    try {
      await sleep(3)
    } finally {
      seen.inFlight--
    }
    if (argv[3] === 'rev-parse') return res(`${top}\n${top}/.git\n`)
    if (argv[3] === 'remote') return res(`${tops[top]}\n`)
    if (argv[3] === 'branch') seen.branchCalls++
    return res(`${seen.branch}\n`)
  }
  return seen
}

function holdOne() {
  let release: () => void = () => {}
  const held = new Promise<undefined>(resolve => {
    release = () => resolve(undefined)
  })
  return { held, release }
}

/** Makes `worktree list` wait for the test: `entered` settles when a poll is on git, `release` lets it go on. */
function holdList(w: FakeWorld) {
  const run = w.run
  const { held, release } = holdOne()
  let enter: () => void = () => {}
  const entered = new Promise<void>(resolve => {
    enter = resolve
  })
  w.run = async argv => {
    if (argv[3] === 'worktree') {
      enter()
      await held
    }
    return run?.(argv)
  }
  return { entered, release }
}

test('a Bash cd into another repo adds a row with the root, the branch and the main loop', async () => {
  const t = setup()
  gitAt(t.w, { '/x/sdk': SDK_REMOTE })
  await t.bash('cd /x/sdk && ls', { toolUseId: 'toolu_cd_1' })
  await drain(t.w)
  expect(t.rows()).toMatchObject([
    { key: SDK_KEY, name: 'acme/sdk', root: '/x/sdk', branch: 'main', mode: 'read', touchedBy: ['main'] },
  ])
})

test('a Bash cd inside the session root adds no row', async () => {
  const t = setup()
  gitAt(t.w, { '/work': 'git@gitlab.com:grp/app.git' })
  await t.bash('cd /work/src && ls')
  await drain(t.w)
  expect(t.rows()).toEqual([])
})

for (const [tool, field] of [
  ['Read', 'file_path'],
  ['Edit', 'file_path'],
  ['Write', 'file_path'],
  ['NotebookEdit', 'notebook_path'],
  ['Grep', 'path'],
  ['Glob', 'path'],
] as const) {
  test(`a ${tool} of a file in another repo adds the repo row`, async () => {
    const t = setup()
    gitAt(t.w, { '/x/sdk': SDK_REMOTE })
    await t.call(tool, { [field]: '/x/sdk/src/a.ts' })
    await drain(t.w)
    expect(t.keys()).toEqual([SDK_KEY])
    expect(t.rows()[0]?.touchedBy).toEqual(['main'])
  })
}

test('a main-loop Read with a relative file_path resolves from the cwd before the call', async () => {
  const t = setup()
  gitAt(t.w, { '/x/sdk': SDK_REMOTE })
  await t.call('Read', { file_path: 'src/a.ts' }, { cwdBefore: '/x/sdk' })
  await drain(t.w)
  expect(t.keys()).toEqual([SDK_KEY])
})

test('a subagent Read with a relative file_path adds no row and runs no rev-parse', async () => {
  const t = setup()
  const seen = gitAt(t.w, { '/x/sdk': SDK_REMOTE })
  await t.call('Read', { file_path: 'src/a.ts' }, { agentId: 'a1', cwdBefore: '/x/sdk' })
  await drain(t.w)
  expect(seen.revParse).toEqual([])
  expect(t.keys()).toEqual([])
})

test('a Read of a file in /tmp adds no row', async () => {
  const t = setup()
  gitAt(t.w, { '/tmp': SDK_REMOTE })
  await t.call('Read', { file_path: '/tmp/x' })
  await drain(t.w)
  expect(t.keys()).toEqual([])
})

test('two Reads at once in one repo look it up once, and the lookups of two repos never overlap', async () => {
  const t = setup()
  const seen = gitAt(t.w, { '/x/sdk': SDK_REMOTE, '/x/lib': LIB_REMOTE })
  await Promise.all([
    t.call('Read', { file_path: '/x/sdk/a.ts' }),
    t.call('Read', { file_path: '/x/sdk/a.ts' }),
    t.call('Read', { file_path: '/x/lib/b.ts' }),
  ])
  await drain(t.w)
  expect(seen.revParse.filter(d => d.startsWith('/x/sdk'))).toHaveLength(1)
  expect(seen.peak).toBe(1)
  expect(t.keys().sort()).toEqual([LIB_KEY, SDK_KEY])
})

test('a file tool returns before the repo lookup ends', async () => {
  const t = setup()
  const { held, release } = holdOne()
  gitAt(t.w, { '/x/sdk': SDK_REMOTE }, held)
  try {
    const out = await Promise.race([
      t.call('Read', { file_path: '/x/sdk/a.ts' }).then(() => 'returned'),
      sleep(200).then(() => 'blocked'),
    ])
    expect(out).toBe('returned')
  } finally {
    release()
  }
  await drain(t.w)
  expect(t.keys()).toEqual([SDK_KEY])
})

test('a denied or failed file tool adds no row', async () => {
  const t = setup()
  const seen = gitAt(t.w, { '/x/sdk': SDK_REMOTE })
  await t.call('Read', { file_path: '/x/sdk/a.ts' }, {}, { deny: 'no' })
  await t.call('Read', { file_path: '/x/sdk/b.ts' }, {}, { isError: true, result: 'ENOENT', text: 'ENOENT' })
  await drain(t.w)
  expect(seen.revParse).toEqual([])
  expect(t.keys()).toEqual([])
})

test('a denied Bash cd adds no row, a failing one does', async () => {
  const t = setup()
  const seen = gitAt(t.w, { '/x/sdk': SDK_REMOTE })
  await t.bash('cd /x/sdk', {}, { deny: 'no' })
  await drain(t.w)
  expect(seen.revParse).toEqual([])
  expect(t.keys()).toEqual([])
  await t.bash('cd /x/sdk && false', {}, { isError: true, result: 'exit 1', text: 'exit 1' })
  await drain(t.w)
  expect(t.keys()).toEqual([SDK_KEY])
})

test('a relative cd in Bash resolves from the cwd before the command', async () => {
  const t = setup()
  gitAt(t.w, { '/w/other/sdk': SDK_REMOTE })
  await t.bash('cd ../other/sdk && ls', { cwdBefore: '/w/repo' })
  await drain(t.w)
  expect(t.keys()).toEqual([SDK_KEY])
})

test('pushd and git -c .. -C with a relative path resolve from the cwd before the command', async () => {
  const t = setup()
  gitAt(t.w, { '/w/sdk': SDK_REMOTE, '/w/lib': LIB_REMOTE })
  await t.bash('pushd ../sdk', { cwdBefore: '/w/repo' })
  await t.bash('git -c a=b -C ../lib status', { cwdBefore: '/w/repo' })
  await drain(t.w)
  expect(t.keys().sort()).toEqual([LIB_KEY, SDK_KEY])
})

test('a gh command that names a foreign repo adds a row with no root; the session repo adds none', async () => {
  const t = setup()
  gitAt(t.w, {})
  t.m.facts.publish('session.repo', { host: 'github.com', owner: 'acme', repo: 'app' })
  await t.bash('gh pr view -R acme/app')
  await t.bash('gh pr view -R acme/lib')
  await drain(t.w)
  expect(t.rows()).toMatchObject([{ key: LIB_KEY, name: 'acme/lib', touchedBy: ['main'] }])
  expect(t.rows()[0]?.root).toBeUndefined()
})

test('a tool outside the path tools makes no git call', async () => {
  const t = setup()
  const seen = gitAt(t.w, { '/x/sdk': SDK_REMOTE })
  await t.call('Skill', { file_path: '/x/sdk/a' })
  await drain(t.w)
  expect(seen.revParse).toEqual([])
  expect(t.keys()).toEqual([])
})

test('a Read then an Edit in one repo store mode edit, and a later Read keeps it', async () => {
  const t = setup()
  gitAt(t.w, { '/x/sdk': SDK_REMOTE })
  await t.call('Read', { file_path: '/x/sdk/a.ts' })
  await drain(t.w)
  expect(t.rows()[0]?.mode).toBe('read')
  await t.call('Edit', { file_path: '/x/sdk/a.ts' })
  await drain(t.w)
  expect(t.rows()[0]?.mode).toBe('edit')
  await t.call('Read', { file_path: '/x/sdk/b.ts' })
  await drain(t.w)
  expect(t.rows()[0]?.mode).toBe('edit')
})

test('a second visit of the same repo a moment later makes no new repos write', async () => {
  const t = setup()
  gitAt(t.w, { '/x/sdk': SDK_REMOTE })
  await t.bash('cd /x/sdk && ls')
  await drain(t.w)
  const writes = t.w.stateSets.repos
  expect(writes).toBeGreaterThan(0)
  await t.bash('cd /x/sdk && ls')
  await drain(t.w)
  expect(t.w.stateSets.repos).toBe(writes)
})

test('a git checkout re-reads the branch at once, a git status keeps the cached one', async () => {
  const t = setup()
  const seen = gitAt(t.w, { '/x/sdk': SDK_REMOTE })
  await t.bash('git -C /x/sdk status')
  await drain(t.w)
  expect(t.rows()[0]?.branch).toBe('main')
  expect(seen.branchCalls).toBe(1)
  seen.branch = 'feat'
  await t.bash('git -C /x/sdk log')
  await drain(t.w)
  expect(t.rows()[0]?.branch).toBe('main')
  await t.bash('git -C /x/sdk checkout feat')
  await drain(t.w)
  expect(t.rows()[0]?.branch).toBe('feat')
  expect(seen.branchCalls).toBe(2)
})

// ---------------------------------------------------------------- issue #195: the fact repos.branches

const FACT = 'repos.branches'
const SDK_REF = { host: 'github.com', owner: 'acme', repo: 'sdk' }
const LIB_REF = { host: 'github.com', owner: 'acme', repo: 'lib' }
const SDK_LIST = 'git -C /x/sdk/.git worktree list --porcelain'
const LIB_LIST = 'git -C /x/lib/.git worktree list --porcelain'

test('a visit that adds a foreign repo polls it at once: one list in its common dir, and the fact holds the branch', async () => {
  const t = setup()
  const seen = gitAt(t.w, { '/x/sdk': SDK_REMOTE })
  expect(t.m.facts.read(FACT)).toBeUndefined()
  await t.call('Read', { file_path: '/x/sdk/a.ts' })
  await drain(t.w)
  expect(seen.lists).toEqual([SDK_LIST])
  expect(t.m.facts.read(FACT)).toEqual({ repos: [{ ...SDK_REF, branches: ['main'] }], overflow: 0 })
  expect(t.rows()[0]?.roots).toEqual([{ path: '/x/sdk', branch: 'main' }])
})

test('a visit that proves nothing new makes no poll; a checkout that moves the branch polls again', async () => {
  const t = setup()
  const seen = gitAt(t.w, { '/x/sdk': SDK_REMOTE })
  await t.call('Read', { file_path: '/x/sdk/a.ts' })
  await drain(t.w)
  await t.call('Read', { file_path: '/x/sdk/b.ts' })
  await t.bash('git -C /x/sdk status')
  await drain(t.w)
  expect(seen.lists).toEqual([SDK_LIST])
  seen.branch = 'feat'
  await t.bash('git -C /x/sdk checkout feat')
  await drain(t.w)
  expect(seen.lists).toEqual([SDK_LIST, SDK_LIST])
  expect(t.m.facts.read(FACT)).toEqual({ repos: [{ ...SDK_REF, branches: ['feat'] }], overflow: 0 })
})

test('a tick runs one worktree list per polled repo, in its common dir, and asks nothing else (AC4)', async () => {
  const t = setup()
  const seen = gitAt(t.w, { '/x/sdk': SDK_REMOTE, '/x/lib': LIB_REMOTE })
  await t.call('Read', { file_path: '/x/sdk/a.ts' })
  await t.call('Read', { file_path: '/x/lib/a.ts' })
  await drain(t.w)
  seen.lists.length = 0
  const lookups = seen.revParse.length
  const calls = t.w.calls.length
  await t.m.tick()
  await drain(t.w)
  expect([...seen.lists].sort()).toEqual([LIB_LIST, SDK_LIST])
  expect(seen.revParse).toHaveLength(lookups)
  expect(t.w.calls.length - calls).toBe(2)
})

test('a repo that git cannot read does not fail the round: it keeps its stored branch and the others publish (AC4)', async () => {
  const t = setup()
  const seen = gitAt(t.w, { '/x/sdk': SDK_REMOTE, '/x/lib': LIB_REMOTE })
  await t.call('Read', { file_path: '/x/sdk/a.ts' })
  await t.call('Read', { file_path: '/x/lib/a.ts' })
  await drain(t.w)
  seen.unreadable.add('/x/sdk')
  seen.branch = 'feat'
  await t.m.tick()
  await drain(t.w)
  expect(t.m.facts.read(FACT)).toEqual({
    repos: [
      { ...LIB_REF, branches: ['feat'] },
      { ...SDK_REF, branches: ['main'] },
    ],
    overflow: 0,
  })
})

test('a repo that git cannot read keeps the branch of the last good poll beside the stored one', async () => {
  const t = setup()
  const seen = gitAt(t.w, { '/x/sdk': SDK_REMOTE })
  await t.call('Read', { file_path: '/x/sdk/a.ts' }) // the visit stores main
  await drain(t.w)
  const poll = () => t.m.command(t.w.ports, { sub: 'refresh', args: '', wait: true })
  seen.branch = 'feat' // a checkout outside the session: no visit sees it, the next poll does
  await poll()
  expect(t.m.facts.read(FACT)).toEqual({ repos: [{ ...SDK_REF, branches: ['feat'] }], overflow: 0 })
  seen.unreadable.add('/x/sdk')
  await poll()
  // The PR of feat stays in the lane for the round that git cannot read, as the PR of main does.
  expect(t.m.facts.read(FACT)).toEqual({ repos: [{ ...SDK_REF, branches: ['feat', 'main'] }], overflow: 0 })
  seen.unreadable.delete('/x/sdk')
  await poll()
  expect(t.m.facts.read(FACT)).toEqual({ repos: [{ ...SDK_REF, branches: ['feat'] }], overflow: 0 }) // git reads it again
})

test('a worktree of the repo that the session never visited is no proof', async () => {
  const t = setup()
  const seen = gitAt(t.w, { '/x/sdk': SDK_REMOTE })
  seen.extra['/x/sdk'] = 'worktree /x/sdk-other\nHEAD def\nbranch refs/heads/feat/not-mine\n\n'
  await t.call('Read', { file_path: '/x/sdk/a.ts' })
  await drain(t.w)
  expect(t.m.facts.read(FACT)).toEqual({ repos: [{ ...SDK_REF, branches: ['main'] }], overflow: 0 })
})

test('pollRepos caps the polled repos, edit before read, and the fact counts the rest', async () => {
  const t = setup({ repos: { pollRepos: 1 } })
  const seen = gitAt(t.w, { '/x/sdk': SDK_REMOTE, '/x/lib': LIB_REMOTE })
  await t.call('Read', { file_path: '/x/sdk/a.ts' })
  await t.call('Read', { file_path: '/x/lib/a.ts' })
  await t.call('Edit', { file_path: '/x/lib/a.ts' })
  await drain(t.w)
  seen.lists.length = 0
  await t.m.tick()
  await drain(t.w)
  expect(seen.lists).toEqual([LIB_LIST])
  expect(t.m.facts.read(FACT)).toEqual({ repos: [{ ...LIB_REF, branches: ['main'] }], overflow: 1 })
})

test('pollRepos 0 turns the poll off: no list and an empty fact', async () => {
  const t = setup({ repos: { pollRepos: 0 } })
  const seen = gitAt(t.w, { '/x/sdk': SDK_REMOTE })
  await t.call('Read', { file_path: '/x/sdk/a.ts' })
  await drain(t.w)
  await t.m.tick()
  await drain(t.w)
  expect(seen.lists).toEqual([])
  expect(t.m.facts.read(FACT)).toEqual({ repos: [], overflow: 0 })
})

test('maxRepoRoots sets how many toplevels a row keeps: a cap above the default keeps them all', async () => {
  const t = setup({ repos: { maxRepoRoots: 6 } })
  const tops = ['/x/sdk', '/x/sdk-b', '/x/sdk-c', '/x/sdk-d', '/x/sdk-e']
  gitAt(t.w, Object.fromEntries(tops.map(top => [top, SDK_REMOTE])))
  for (const top of tops) {
    await t.call('Read', { file_path: `${top}/a.ts` })
    await drain(t.w)
  }
  expect(t.rows()[0]?.roots?.map(r => r.path)).toEqual([...tops].reverse())
})

const STORED_ROWS: RepoRecord[] = [
  {
    key: SDK_KEY,
    name: 'acme/sdk',
    root: '/x/sdk-b',
    branch: 'feat/b',
    roots: [
      { path: '/x/sdk-b', branch: 'feat/b' },
      { path: '/x/sdk-a', branch: 'feat/a' },
    ],
    mode: 'edit',
    touchedBy: ['main'],
    firstSeen: 1,
    lastSeen: 2,
  },
]

test('init publishes the stored rows with no git call: a hot reload keeps the slot and loses the facts', async () => {
  const t = setup()
  t.w.state.set('repos', STORED_ROWS as unknown as Json)
  const seen = gitAt(t.w, { '/x/sdk': SDK_REMOTE })
  await t.m.ensureStarted(t.w.ports)
  expect(t.m.facts.read(FACT)).toEqual({ repos: [{ ...SDK_REF, branches: ['feat/a', 'feat/b'] }], overflow: 0 })
  expect(t.w.calls.filter(c => c[0] === 'git')).toEqual([])
  expect(seen.lists).toEqual([])
})

test('a fresh start publishes an empty list', async () => {
  const t = setup()
  await t.m.ensureStarted(t.w.ports)
  expect(t.m.facts.read(FACT)).toEqual({ repos: [], overflow: 0 })
})

test('restore publishes the stored rows with no git call, and /track clear publishes an empty list', async () => {
  const s = slotWorld()
  const slot = await s.slot()
  await slot.restore(STORED_ROWS as unknown as Json, 'load')
  expect(s.t.facts.read(FACT)).toEqual({ repos: [{ ...SDK_REF, branches: ['feat/a', 'feat/b'] }], overflow: 0 })
  expect(s.t.w.calls).toEqual([])
  await slot.clear?.()
  expect(s.t.facts.read(FACT)).toEqual({ repos: [], overflow: 0 })
})

test('/clear carries the rows over: the roots of both copies stay, and the fact lists their branches with no git call', async () => {
  const s = slotWorld()
  const slot = await s.slot()
  await s.put([
    row({
      root: '/x/sdk-live',
      branch: 'feat/live',
      roots: [{ path: '/x/sdk-live', branch: 'feat/live' }],
      firstSeen: 1,
      lastSeen: 1,
    }),
  ])
  await slot.restore(STORED_ROWS as unknown as Json, 'carry')
  expect(s.rows()[0]?.roots?.map(r => r.path)).toEqual(['/x/sdk-b', '/x/sdk-a', '/x/sdk-live'])
  expect(s.t.facts.read(FACT)).toEqual({
    repos: [{ ...SDK_REF, branches: ['feat/a', 'feat/b', 'feat/live'] }],
    overflow: 0,
  })
  expect(s.t.w.calls).toEqual([])
})

test('/track refresh polls the foreign repos at once, and with wait it answers after the poll', async () => {
  const t = setup()
  const seen = gitAt(t.w, { '/x/sdk': SDK_REMOTE })
  await t.call('Read', { file_path: '/x/sdk/a.ts' })
  await drain(t.w)
  seen.lists.length = 0
  seen.branch = 'feat'
  await t.m.command(t.w.ports, { sub: 'refresh', args: '', wait: true })
  expect(seen.lists).toEqual([SDK_LIST])
  expect(t.m.facts.read(FACT)).toEqual({ repos: [{ ...SDK_REF, branches: ['feat'] }], overflow: 0 })
  await t.m.command(t.w.ports, { sub: 'other', args: '', wait: true }) // a sub the tracker does not know
  expect(seen.lists).toEqual([SDK_LIST])
})

test('a dismissed repo leaves the fact at once', async () => {
  const t = setup()
  gitAt(t.w, { '/x/sdk': SDK_REMOTE, '/x/lib': LIB_REMOTE })
  await t.call('Read', { file_path: '/x/sdk/a.ts' })
  await t.call('Read', { file_path: '/x/lib/a.ts' })
  await drain(t.w)
  await t.m.dismiss(t.w.ports, [`rp:${SDK_KEY}`])
  await drain(t.w)
  expect(t.m.facts.read(FACT)).toEqual({ repos: [{ ...LIB_REF, branches: ['main'] }], overflow: 0 })
})

test('a poll that ends after /track clear publishes nothing', async () => {
  const t = setup()
  gitAt(t.w, { '/x/sdk': SDK_REMOTE })
  await t.call('Read', { file_path: '/x/sdk/a.ts' })
  await drain(t.w)
  const gate = holdList(t.w)
  await t.m.command(t.w.ports, { sub: 'refresh', args: '', wait: false })
  await gate.entered // the poll waits on git
  await t.m.clear(t.w.ports)
  expect(t.m.facts.read(FACT)).toEqual({ repos: [], overflow: 0 })
  gate.release()
  await drain(t.w)
  expect(t.m.facts.read(FACT)).toEqual({ repos: [], overflow: 0 })
})

test('poll requests while a poll waits on git are one more poll, not one each (AC4)', async () => {
  const t = setup()
  const seen = gitAt(t.w, { '/x/sdk': SDK_REMOTE })
  await t.call('Read', { file_path: '/x/sdk/a.ts' })
  await drain(t.w)
  seen.lists.length = 0
  const gate = holdList(t.w)
  const refresh = () => t.m.command(t.w.ports, { sub: 'refresh', args: '', wait: false })
  await refresh()
  await gate.entered // the first poll is on git
  for (let i = 0; i < 4; i++) await refresh()
  gate.release()
  await drain(t.w)
  expect(seen.lists).toEqual([SDK_LIST, SDK_LIST]) // the running poll, and one that waited for it
})

test('a poll pushed into a full queue is dropped, and the next request polls again', async () => {
  const t = setup({ repos: { maxRepoQueue: 1 } })
  const seen = gitAt(t.w, { '/x/sdk': SDK_REMOTE })
  await t.call('Read', { file_path: '/x/sdk/a.ts' })
  await drain(t.w)
  seen.lists.length = 0
  const gate = holdList(t.w)
  await t.m.command(t.w.ports, { sub: 'refresh', args: '', wait: false })
  await gate.entered // the poll runs: the queue holds nothing that waits
  await t.call('Read', { file_path: '/x/sdk/b.ts' }) // a visit job waits: the queue is full
  await t.m.command(t.w.ports, { sub: 'refresh', args: '', wait: false }) // dropped
  gate.release()
  await drain(t.w)
  expect(seen.lists).toEqual([SDK_LIST])
  await t.m.tick()
  await drain(t.w)
  expect(seen.lists).toEqual([SDK_LIST, SDK_LIST])
})

// ---------------------------------------------------------------- agent.spawn and the touchedBy label

test('a workflow spawn cwd in another repo adds a row labelled with the agent', async () => {
  const t = setup()
  gitAt(t.w, { '/x/sdk': SDK_REMOTE })
  t.agents([{ id: 'w1', label: 'architect', cwd: '/x/sdk' }])
  await t.spawn({ cwd: '/x/sdk' }, 'w1')
  await drain(t.w)
  expect(t.rows().map(r => [r.key, r.touchedBy])).toEqual([[SDK_KEY, ['architect']]])
})

test('a spawn with no label is labelled agent:<first 8 of the id>', async () => {
  const t = setup()
  gitAt(t.w, { '/x/sdk': SDK_REMOTE })
  t.agents([{ id: 'abcdefghij', label: '', cwd: '/x/sdk' }])
  await t.spawn({ cwd: '/x/sdk' }, 'abcdefghij')
  await drain(t.w)
  expect(t.rows().map(r => r.touchedBy)).toEqual([['agent:abcdefgh']])
})

test('a spawn the ledger does not know is labelled agent:<first 8 of the id>', async () => {
  const t = setup()
  gitAt(t.w, { '/x/sdk': SDK_REMOTE })
  await t.spawn({ cwd: '/x/sdk' }, 'zyxwvutsrq')
  await drain(t.w)
  expect(t.rows().map(r => r.touchedBy)).toEqual([['agent:zyxwvuts']])
})

test('the main loop and a spawned agent share one row', async () => {
  const t = setup()
  gitAt(t.w, { '/x/sdk': SDK_REMOTE })
  t.agents([{ id: 'w1', label: 'architect', cwd: '/x/sdk' }])
  await t.bash('cd /x/sdk && ls')
  await drain(t.w)
  await t.spawn({ cwd: '/x/sdk' }, 'w1')
  await drain(t.w)
  expect(t.rows().map(r => [r.key, r.touchedBy])).toEqual([[SDK_KEY, ['main', 'architect']]])
})

test('a nested child with no cwd gets the cwd of its parent from the ledger', async () => {
  const t = setup()
  gitAt(t.w, { '/x/sdk': SDK_REMOTE })
  t.agents([
    { id: 'w1', label: 'architect', cwd: '/x/sdk' },
    { id: 'w2', label: 'child', parentId: 'w1', cwd: '/x/sdk' },
  ])
  await t.spawn({ cwd: '/x/sdk' }, 'w1')
  await t.spawn({ parentAgentId: 'w1', description: 'child' }, 'w2')
  await drain(t.w)
  expect(t.rows().map(r => [r.key, r.touchedBy])).toEqual([[SDK_KEY, ['architect', 'child']]])
})

test('a spawn in the root folder, with no cwd, or without an agent id adds no row', async () => {
  const t = setup()
  const seen = gitAt(t.w, { '/x/sdk': SDK_REMOTE })
  t.agents([{ id: 'w1', label: 'a', cwd: '/work' }])
  await t.spawn({ cwd: '/work' }, 'w1')
  await t.spawn({}, 'w2')
  await t.spawn({ parentAgentId: 'w1' }, 'w3') // the ledger has no row for w3: no cwd to take
  await t.m.agentSpawn(t.w.ports, { input: { cwd: '/x/sdk' }, answer: {} })
  await t.m.agentSpawn(t.w.ports, { input: null, answer: null })
  await drain(t.w)
  expect(seen.revParse).toEqual([])
  expect(t.keys()).toEqual([])
})

// ---------------------------------------------------------------- /track clear while a lookup waits

test('a lookup that ends after /track clear leaves no row', async () => {
  const t = setup()
  const { held, release } = holdOne()
  gitAt(t.w, { '/x/sdk': SDK_REMOTE }, held)
  await t.bash('cd /x/sdk && ls')
  await sleep(30) // the job waits on git
  await t.m.clear(t.w.ports)
  release()
  await drain(t.w)
  expect(t.rows()).toEqual([])
})

test('a visit that waits in the queue during /track clear does not swallow the same visit made after it', async () => {
  const t = setup()
  const { held, release } = holdOne()
  gitAt(t.w, { '/x/sdk': SDK_REMOTE, '/x/lib': LIB_REMOTE }, held)
  // The lib job runs and waits on git. The first sdk visit waits behind it in the queue.
  await t.call('Read', { file_path: '/x/lib/b.ts' })
  await sleep(30)
  await t.call('Read', { file_path: '/x/sdk/a.ts' })
  await t.m.clear(t.w.ports)
  await t.call('Read', { file_path: '/x/sdk/a.ts' })
  release()
  await drain(t.w)
  expect(t.keys()).toEqual([SDK_KEY])
})

test('a job that ends after a session switch writes nothing', async () => {
  const t = setup()
  const { held, release } = holdOne()
  gitAt(t.w, { '/x/sdk': SDK_REMOTE }, held)
  await t.bash('cd /x/sdk && ls')
  await sleep(30)
  await t.m.end(t.w.ports, 'resume', 1500)
  t.w.session.id = 'sess-2'
  await t.m.entry(t.w.ports) // finds the new id: a switch, the generation moves
  release()
  await drain(t.w)
  expect(t.rows()).toEqual([])
})

// ---------------------------------------------------------------- dismiss

test('a dismissed repo stays out of later visits', async () => {
  const t = setup()
  gitAt(t.w, { '/x/sdk': SDK_REMOTE })
  await t.bash('cd /x/sdk && ls')
  await drain(t.w)
  expect(t.keys()).toEqual([SDK_KEY])
  await t.m.dismiss(t.w.ports, [`rp:${SDK_KEY}`])
  expect(t.rows()).toEqual([]) // the dismissed event drops the row at once
  await t.bash('cd /x/sdk && ls')
  await drain(t.w)
  expect(t.rows()).toEqual([])
})

test('another repo touched after the dismiss still appears', async () => {
  const t = setup()
  gitAt(t.w, { '/x/sdk': SDK_REMOTE, '/x/lib': LIB_REMOTE })
  await t.bash('cd /x/sdk && ls')
  await drain(t.w)
  await t.m.dismiss(t.w.ports, [`rp:${SDK_KEY}`])
  await t.bash('cd /x/lib && ls')
  await drain(t.w)
  expect(t.keys()).toEqual([LIB_KEY])
})

test('a dismiss of something that is not a repo row makes no repos write', async () => {
  const t = setup()
  gitAt(t.w, { '/x/sdk': SDK_REMOTE })
  await t.bash('cd /x/sdk && ls')
  await drain(t.w)
  const writes = t.w.stateSets.repos
  await t.m.dismiss(t.w.ports, ['wt:/x/other', 'gh:github.com/acme/web#5'])
  expect(t.w.stateSets.repos).toBe(writes)
  expect(t.keys()).toEqual([SDK_KEY])
})

// ---------------------------------------------------------------- the slot: settle, restore, clear

function slotWorld() {
  const t = hostWorld([reposTracker()])
  const slot = async () => {
    await t.host.init()
    const found = t.host.slots().find(s => s.id === 'repos')
    if (!found) throw new Error('no repos slot')
    return found
  }
  const rows = () => (t.w.state.get('repos') ?? []) as unknown as RepoRecord[]
  const put = (v: RepoRecord[]) => t.w.ports.state.slot.update('repos', () => v as unknown as Json)
  return { t, slot, rows, put }
}

const row = (extra: Partial<RepoRecord> = {}): RepoRecord => ({ ...STORED_SDK, ...extra })

test('restore keeps the firstSeen and every agent of a stored row', async () => {
  const s = slotWorld()
  await (await s.slot()).restore([row()] as unknown as Json, 'load')
  expect(s.rows()).toMatchObject([{ key: SDK_KEY, firstSeen: 10, touchedBy: ['main', 'planner'] }])
  expect(s.t.persisted).toEqual(['repos'])
})

test('a load keeps the newer live branch and unites the agents', async () => {
  const s = slotWorld()
  await s.put([row({ branch: 'new', lastSeen: 100, touchedBy: ['main'] })])
  await (await s.slot()).restore([row()] as unknown as Json, 'load')
  expect(s.rows()).toMatchObject([{ branch: 'new', touchedBy: ['main', 'planner'], firstSeen: 10, lastSeen: 100 }])
})

test('on a tie in lastSeen a carry takes the carried row, a load keeps the live one', async () => {
  const live = row({ branch: 'live', lastSeen: 50 })
  const carried = row({ branch: 'carried', lastSeen: 50 })
  const a = slotWorld()
  await a.put([live])
  await (await a.slot()).restore([carried] as unknown as Json, 'carry')
  expect(a.rows()[0]?.branch).toBe('carried')
  const b = slotWorld()
  await b.put([live])
  await (await b.slot()).restore([carried] as unknown as Json, 'load')
  expect(b.rows()[0]?.branch).toBe('live')
})

test('restoring more than maxRepos rows keeps maxRepos', async () => {
  const s = slotWorld()
  const many = Array.from({ length: LIMITS.maxRepos + 1 }, (_, i) =>
    row({ key: `local:/r${i}`, name: `r${i}`, lastSeen: 100 + i }),
  )
  await (await s.slot()).restore(many as unknown as Json, 'load')
  expect(s.rows()).toHaveLength(LIMITS.maxRepos)
  expect(s.rows().map(r => r.key)).not.toContain('local:/r0')
})

test('restore drops the dismissed repo and ignores an empty or malformed value', async () => {
  const s = slotWorld()
  const slot = await s.slot()
  s.t.dismissed.add(`rp:${SDK_KEY}`)
  await slot.restore([row()] as unknown as Json, 'load')
  expect(s.rows()).toEqual([])
  const writes = s.t.w.stateSets.repos
  await slot.restore([] as unknown as Json, 'load')
  await slot.restore('nope' as unknown as Json, 'carry')
  expect(s.t.w.stateSets.repos).toBe(writes)
})

test('settle puts the stored rows under the live ones', async () => {
  const s = slotWorld()
  const slot = await s.slot()
  const merged = (await slot.settle(
    [row({ key: 'local:/live', name: 'live', lastSeen: 70 })] as unknown as Json,
    [row()] as unknown as Json,
  )) as unknown as RepoRecord[]
  expect(merged.map(r => r.key)).toEqual([SDK_KEY, 'local:/live'])
  expect(await slot.settle(undefined, undefined)).toEqual([])
})

test('settle keeps at most maxRepoRoots roots of a row: the two lists together are not more than the cap', async () => {
  const s = slotWorld()
  const slot = await s.slot()
  const roots = (from: number) =>
    Array.from({ length: 4 }, (_, i) => ({ path: `/x/r${from + i}`, branch: `b${from + i}` }))
  const merged = (await slot.settle(
    [row({ lastSeen: 70, roots: roots(0) })] as unknown as Json,
    [row({ lastSeen: 60, roots: roots(10) })] as unknown as Json,
  )) as unknown as RepoRecord[]
  expect(merged[0]!.roots!.map(r => r.path)).toEqual(['/x/r0', '/x/r1', '/x/r2', '/x/r3'])
})

test('settle keeps maxRepos rows and the first maxRepoAgents agents of a row', async () => {
  const s = slotWorld()
  const slot = await s.slot()
  const many = Array.from({ length: LIMITS.maxRepos }, (_, i) =>
    row({ key: `local:/r${i}`, name: `r${i}`, lastSeen: 100 + i }),
  )
  const agents = Array.from({ length: LIMITS.maxRepoAgents + 1 }, (_, i) => `a${i}`)
  const busy = row({ key: 'local:/busy', name: 'busy', lastSeen: 500, touchedBy: agents })
  const merged = (await slot.settle([busy] as unknown as Json, many as unknown as Json)) as unknown as RepoRecord[]
  expect(merged).toHaveLength(LIMITS.maxRepos)
  expect(merged.map(r => r.key)).not.toContain('local:/r0') // the oldest row goes
  expect(merged.find(r => r.key === 'local:/busy')?.touchedBy).toEqual(agents.slice(0, LIMITS.maxRepoAgents))
})

test('empty is true for no rows and for a value that is not a list; clear empties the slot', async () => {
  const s = slotWorld()
  const slot = await s.slot()
  expect(slot.empty(undefined)).toBe(true)
  expect(slot.empty([] as unknown as Json)).toBe(true)
  expect(slot.empty('x' as unknown as Json)).toBe(true)
  expect(slot.empty([row()] as unknown as Json)).toBe(false)
  await s.put([row()])
  expect(slot.persist).toBe(true)
  await slot.clear?.()
  expect(s.rows()).toEqual([])
})

test('setRepos writes nothing when the change returns its input', async () => {
  const s = slotWorld()
  await s.put([row()])
  const before = s.t.w.stateSets.repos
  const ctx = s.t.host.ctx('repos', s.t.w.ports) as unknown as Parameters<typeof setRepos>[0]
  await setRepos(ctx, rows => rows)
  expect(s.t.w.stateSets.repos).toBe(before)
  await setRepos(ctx, rows => rows, 7) // an older generation is dropped by the host
  expect(s.t.w.stateSets.repos).toBe(before)
})

test('asRepoRows reads a value that is not a list as none', () => {
  expect(asRepoRows(undefined)).toEqual([])
  expect(asRepoRows('x' as unknown as RepoRecord[])).toEqual([])
  expect(asRepoRows([STORED_SDK])).toEqual([STORED_SDK])
})

// ---------------------------------------------------------------- the tracker object

test('the tracker serves LIMITS from memory and builds its services once per load', async () => {
  const t = hostWorld([reposTracker()])
  await t.host.init()
  expect(t.host.failed()).toEqual([])
  expect(t.host.stored().get('repos')).toEqual({
    enabled: true,
    maxRepos: LIMITS.maxRepos,
    maxRepoAgents: LIMITS.maxRepoAgents,
    maxRepoQueue: LIMITS.maxRepoQueue,
    gitTimeoutMs: LIMITS.gitTimeoutMs,
    pollRepos: 3,
    maxRepoRoots: 4,
  })
  const tracker = reposTracker()
  expect(tracker.id).toBe('repos')
  expect(tracker.order).toBe(50)
  expect(tracker.persist).toBeUndefined()
})

test('normalise keeps a valid slice, clamps numbers, falls back per field and names each problem once', () => {
  const warns: string[] = []
  const warn = (p: string) => void warns.push(p)
  expect(reposConfig.normalise({}, reposConfig.defaults, warn)).toEqual(reposConfig.defaults)
  expect(warns).toEqual([])
  const out = reposConfig.normalise(
    { enabled: false, maxRepos: 20, maxRepoAgents: 0, maxRepoQueue: 'many', gitTimeoutMs: 99_999_999, extra: 1 },
    reposConfig.defaults,
    warn,
  )
  expect(out).toMatchObject({
    enabled: false,
    maxRepos: 20,
    maxRepoAgents: 1, // below the min: the min
    maxRepoQueue: LIMITS.maxRepoQueue, // no number: the default
    gitTimeoutMs: 60000, // above the max: the max
    extra: 1,
  })
  expect(warns).toEqual([
    'maxRepoAgents: 0 is below the min 1. Using 1.',
    'maxRepoQueue: "many" is not a number. Using 32.',
    'gitTimeoutMs: 99999999 is above the max 60000. Using 60000.',
    'extra: unknown key. The mod keeps it and ignores it.',
  ])
  const bad = reposConfig.normalise({ enabled: 'yes' }, reposConfig.defaults, warn)
  expect(bad.enabled).toBe(true)
  expect(warns).toHaveLength(5)
})
