// The repos tracker on fakePorts, through the LifecycleManager: the events it hears, the lookups it queues, the rows it
// keeps and how a switch or `/track clear` treats them. Each case mirrors the kit test of the same subject in
// register.test.tsx. The facts `auto.root` and `auto.agents` stand in for the auto tracker. Plan: L3 Task 9.
import { expect, test } from 'claude-code/testing'
import { LifecycleManager } from '../core/infra/lifecycle'
import type { ToolCallEvent } from '../core/interfaces/events'
import type { ItemsHost, Json } from '../core/interfaces/items'
import type { RunResult } from '../core/interfaces/ports'
import type { AgentProof, RepoRecord } from '../hooks/contracts'
import { asRepoRows, reposConfig, reposTracker, setRepos } from '../trackers/repos'
import { fakeConfig } from './fixtures/config-fs'
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
    slot: {
      id: 'items',
      persist: true,
      read: async () => [],
      empty: () => true,
      settle: async live => live,
      restore: async () => {},
    },
    start: async () => {},
    capture: async () => {},
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

function setup(o: { cwd?: string } = {}) {
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
      config: () => fakeConfig({ specs: trackers }),
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
  const seen = { revParse: [] as string[], branchCalls: 0, branch: 'main', inFlight: 0, peak: 0 }
  w.run = async argv => {
    if (argv[0] !== 'git' || argv[1] !== '-C') return undefined
    const dir = String(argv[2])
    const top = Object.keys(tops).find(t => dir === t || dir.startsWith(`${t}/`))
    if (top === undefined) return undefined
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
