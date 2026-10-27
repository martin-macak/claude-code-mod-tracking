// The PR lane of the github tracker (plan L5, Task 12): after each round of the auto tracker, one GraphQL query finds the
// PRs of the tracked branches and the lane writes them, and the refs in their bodies, into the item list. Three layers:
// the cases of the old AutoRound lane, over a real round and a real PrLane with fake deps; the lane alone; and the
// shipped `auto` and `github` trackers through a LifecycleManager. The cases that moved from tests/round.test.ts keep their names.
import { expect, test } from 'claude-code/testing'
import type { Json, JsonObject, StoredItem } from '../core/interfaces/items'
import type { RepoRef } from '../core/interfaces/ports'
import type { PendingEnd } from '../core/interfaces/slots'
import { autoIds, dismiss } from '../trackers/auto/dismiss'
import { emptyAuto, pinRoot, recordEnter } from '../trackers/auto/ledger'
import { AutoRound, type RoundDeps } from '../trackers/auto/round'
import { fileRecord } from '../trackers/file/kind'
import { githubTracker } from '../trackers/github'
import { PR_LANE_DEFAULTS } from '../trackers/github/config'
import { dropAuto } from '../trackers/github/discovered'
import { branchesOf, createdOf } from '../trackers/github/facts'
import { EMPTY_LANE, type LaneDeps, PrLane, wantsStep } from '../trackers/github/lane'
import { isLanePr } from '../trackers/github/lane-pr'
import type { BranchesFact, LaneState, PrRef } from '../trackers/github/types'
import { type FakeConfig, fakeConfig } from './fixtures/config-fs'
import type {
  AutoReason,
  AutoState,
  GitHubDiscoveryApi,
  GitHubRecord,
  GraphqlOutcome,
  ItemRecord,
  LiveAgent,
} from './fixtures/contracts'
import { createdPr } from './fixtures/events'
import { discoveryData, prNode } from './fixtures/gh-discovery'
import { porcelain as gitPorcelain } from './fixtures/git'
import { res, until } from './fixtures/items'
import { LIMITS } from './fixtures/limits'
import { managerWorld } from './fixtures/manager'
import { reasonsOfSources } from './fixtures/reasons'
import { scanBody } from './fixtures/refs'
import { buildRecord, capTo } from './fixtures/registry'
import { hostWorld } from './fixtures/tracker-host'

declare function setTimeout(fn: () => void, ms: number): unknown
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const MAIN = '/x/repo'
const K7 = 'gh:github.com/acme/web#7'
const K1 = 'gh:github.com/acme/web#1'
const REPO: RepoRef = { host: 'github.com', owner: 'acme', repo: 'web' }

const porcelain = (...kids: [string, string][]): string => gitPorcelain(MAIN, ...kids)

/** Lets every pending promise step run. The lane uses promises only, no timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

/**
 * The reply for a discovery query: nodes by `head:<branch>` or `base:<branch>`, and for each `pullRequest(number:)` alias
 * (a PR the session created, issue #158) the node of `created[owner/repo][number]`, null when there is none. The repo
 * is read from the query, in lower case.
 */
function replyFor(
  q: string,
  nodes: Record<string, unknown[]>,
  defaultBranch: string | null = 'main',
  created: Record<string, Record<number, unknown>> = {},
): GraphqlOutcome {
  const data: Record<string, unknown[]> = {}
  for (const m of q.matchAll(/(([hb])\d+): pullRequests\((head|base)RefName: ("(?:[^"\\]|\\.)*")/g))
    data[m[1]!] = nodes[`${m[3]}:${JSON.parse(m[4]!) as string}`] ?? []
  const reply = discoveryData(data, defaultBranch)
  const target = /repository\(owner: "([^"]+)", name: "([^"]+)"\)/.exec(q)
  const known = created[`${target?.[1]}/${target?.[2]}`.toLowerCase()]
  for (const m of q.matchAll(/(p\d+): pullRequest\(number: (\d+)\)/g))
    (reply.repository as Record<string, unknown>)[m[1]!] = known?.[Number(m[2])] ?? null
  return { ok: true, reply: { data: reply, errors: [] } }
}

/** A gh that can be called, logged in, and answers every discovery query from `nodes`. */
function fakeGh(o: {
  nodes: Record<string, unknown[]>
  queries: string[]
  outcome?: () => GraphqlOutcome | undefined
  gate?: () => Promise<void> | undefined
  defaultBranch?: string | null
  /** The PRs the session created, by lower-case `owner/repo` and number. */
  created?: Record<string, Record<number, unknown>>
}): GitHubDiscoveryApi {
  return {
    isAvailable: true,
    canCall: () => true,
    status: () => ({ name: 'gh', available: true, loggedIn: true, breaker: 'closed', lastError: 'timeout' }),
    checkHost: async () => true,
    isHostAuthed: () => true,
    graphql: async (_host: string, q: string): Promise<GraphqlOutcome> => {
      o.queries.push(q)
      await o.gate?.()
      return o.outcome?.() ?? replyFor(q, o.nodes, o.defaultBranch, o.created)
    },
  } as unknown as GitHubDiscoveryApi
}

// ================================================================ the cases of the old round, over a real round and lane

type Setup = { seed?: AutoState; withChild?: boolean }

function rig(setup: Setup = {}) {
  let auto: AutoState =
    setup.seed ??
    (setup.withChild === false
      ? pinRoot(emptyAuto(), MAIN, 1)
      : recordEnter(
          pinRoot(emptyAuto(), MAIN, 1),
          { path: `${MAIN}/.claude/worktrees/probe-wt`, branch: 'worktree-probe-wt' },
          2,
        ))
  let items: ItemRecord[] = []
  let lane: LaneState = EMPTY_LANE
  let fact: BranchesFact = { seq: 0, reasons: [], branches: [], overflow: 0 }
  const log = {
    git: [] as string[][],
    gh: [] as string[],
    added: [] as string[][],
    saves: 0,
    laneSaves: 0,
    itemWrites: 0,
  }
  const state = {
    now: 1_000_000,
    isRepo: true,
    gitFail: false,
    porcelain: porcelain(['probe-wt', 'worktree-probe-wt']),
    repo: REPO as RepoRef | null,
    nodes: {} as Record<string, unknown[]>,
    outcome: undefined as GraphqlOutcome | undefined,
  }
  const gate: { gh?: Promise<void> } = {}

  const roundDeps: RoundDeps = {
    now: () => state.now,
    load: async () => auto,
    save: async change => {
      const next = change(auto)
      if (next !== auto) {
        auto = next
        log.saves++
      }
      return auto
    },
    git: async argv => {
      log.git.push([...argv])
      if (state.gitFail) throw new Error('git broke')
      if (argv[0] === 'rev-parse')
        return state.isRepo
          ? { exitCode: 0, stdout: MAIN + '\n', stderr: '' }
          : { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository\n' }
      return { exitCode: 0, stdout: state.porcelain, stderr: '' }
    },
    listAgents: async () => [] as LiveAgent[],
    sessionCwd: async () => MAIN,
  }
  const round = new AutoRound(roundDeps)
  const deps: LaneDeps = {
    now: () => state.now,
    load: async () => lane,
    save: async change => {
      const next = change(lane)
      if (next !== lane) {
        lane = next
        log.laneSaves++
      }
      return lane
    },
    branches: () => fact,
    gh: fakeGh({
      nodes: state.nodes,
      queries: log.gh,
      outcome: () => state.outcome,
      gate: () => gate.gh,
    }),
    ghReady: async () => true,
    repo: async () => state.repo,
    scanBody,
    build: buildRecord,
    applyItems: async change => {
      const r = change(items as StoredItem[], new Set(auto.dismissed))
      if (r.list !== items) {
        items = r.list as ItemRecord[]
        log.itemWrites++
      }
      return r
    },
    onAdded: keys => void log.added.push([...keys]),
    lane: () => PR_LANE_DEFAULTS,
    caps: () => ({ staleMs: LIMITS.staleMs, cap: capTo(LIMITS.maxItems) }),
  }
  const prLane = new PrLane(deps)
  const hold = () => {
    let release = () => {}
    gate.gh = new Promise<void>(resolve => {
      release = resolve
    })
    return release
  }
  /** What the scheduler and core do after a round: publish the branches, and tell the lane when the fact asks for a step. */
  const run = async (...reasons: AutoReason[]) => {
    await round.run()
    const snap = auto.snapshot
    const next: BranchesFact = {
      seq: fact.seq + 1,
      reasons,
      branches: snap?.branches ?? [],
      overflow: snap?.overflow ?? 0,
    }
    const prev = fact
    fact = next
    if (wantsStep(next, prev)) prLane.request()
  }
  return {
    deps,
    roundDeps,
    run,
    state,
    log,
    hold,
    lane: () => lane,
    idle: () => prLane.idle(),
    auto: () => auto,
    items: () => items,
    setAuto: (change: (s: AutoState) => AutoState) => {
      auto = change(auto)
    },
    setItems: (change: (l: ItemRecord[]) => ItemRecord[]) => {
      items = change(items)
    },
  }
}

test('a first round resolves the root once, tracks the proven child and finds the PR of a tracked branch', async () => {
  const t = rig()
  t.state.nodes['head:worktree-probe-wt'] = [
    prNode({ number: 7, headRefName: 'worktree-probe-wt', body: 'Part of #1', rollup: 'FAILURE' }),
  ]
  await t.run('start')
  await t.idle()
  expect(t.lane().prs).toMatchObject({ ok: true })
  expect(t.lane().defaultBranch).toBe('main')
  expect(t.items().map(i => i.key)).toEqual([K7, K1])
  expect(t.log.added).toEqual([[K1]])
})

test('not a git repository: no more git calls, agents still listed, PR step skips with no-branches', async () => {
  const t = rig({ withChild: false })
  t.state.isRepo = false
  await t.run('start')
  await t.idle()
  await t.run('tick')
  await t.idle()
  expect(t.lane().prs).toMatchObject({ ok: false, skipped: 'no-branches' })
  expect(t.log.gh).toHaveLength(0)
})

test('a failed git call sets the note, keeps the last rows, still computes agents and polls the last branches', async () => {
  const t = rig()
  await t.run('start')
  await t.idle()
  t.state.gitFail = true
  await t.run('tick')
  await t.idle()
  expect(t.log.gh).toHaveLength(2)
})

test('an open breaker (blocked) still saves worktrees and agents', async () => {
  const t = rig()
  t.state.outcome = { ok: false, kind: 'blocked' }
  await t.run('start')
  await t.idle()
  expect(t.lane().prs).toMatchObject({ ok: false, skipped: 'paused' })
  expect(t.auto().snapshot!.worktrees).toHaveLength(2)
})

test('each failed GraphQL outcome maps to the Pull requests note of spec 8.3', async () => {
  const cases: [GraphqlOutcome, object][] = [
    [
      { ok: false, kind: 'blocked' },
      { ok: false, skipped: 'paused' },
    ],
    [
      { ok: false, kind: 'auth' },
      { ok: false, skipped: 'not-logged-in' },
    ],
    [
      { ok: false, kind: 'no-gh' },
      { ok: false, skipped: 'no-gh' },
    ],
    [
      { ok: false, kind: 'transport' },
      { ok: false, error: 'timeout' },
    ],
    [
      { ok: false, kind: 'truncated' },
      { ok: false, error: 'reply over 4 MiB' },
    ],
    [
      { ok: false, kind: 'query-error', error: 'Field x' },
      { ok: false, error: 'Field x' },
    ],
  ]
  for (const [outcome, want] of cases) {
    const t = rig()
    t.state.outcome = outcome
    await t.run('start')
    await t.idle()
    expect(t.lane().prs).toMatchObject(want)
    expect(t.items()).toEqual([])
  }
})

test('no session repo: the PR step skips with no-repo', async () => {
  const t = rig()
  t.state.repo = null
  await t.run('start')
  await t.idle()
  expect(t.lane().prs).toMatchObject({ ok: false, skipped: 'no-repo' })
})

test('PR step gating: an agent kick without a branch change makes no gh call; a tick does', async () => {
  const t = rig()
  await t.run('start')
  await t.idle()
  expect(t.log.gh).toHaveLength(1)
  await t.run('agent')
  await t.idle()
  expect(t.log.gh).toHaveLength(1)
  await t.run('tick')
  await t.idle()
  expect(t.log.gh).toHaveLength(2)
})

test('PR step gating: a new tracked branch starts a PR step even on an agent kick', async () => {
  const t = rig()
  await t.run('start')
  await t.idle()
  t.setAuto(s => recordEnter(s, { path: `${MAIN}/.claude/worktrees/second`, branch: 'second-b' }, 9))
  t.state.porcelain = porcelain(['probe-wt', 'worktree-probe-wt'], ['second', 'second-b'])
  await t.run('agent')
  await t.idle()
  expect(t.log.gh).toHaveLength(2)
  expect(t.log.gh[1]).toContain('"second-b"')
})

test('the default branch learned in the first reply gets no alias in the next query', async () => {
  const t = rig()
  await t.run('start')
  await t.idle()
  await t.run('tick')
  await t.idle()
  expect(t.log.gh[0]).toContain('headRefName: "main"')
  expect(t.log.gh[1]).not.toContain('headRefName: "main"')
})

async function withTrackedPr() {
  const t = rig()
  t.state.nodes['head:worktree-probe-wt'] = [
    prNode({ number: 7, headRefName: 'worktree-probe-wt', body: 'Part of #1' }),
  ]
  await t.run('start')
  await t.idle()
  expect(t.items().map(i => i.key)).toEqual([K7, K1])
  return t
}

test('writes in flight (b): an x dismiss of a PR while gh waits leaves the PR and its auto-only refs absent', async () => {
  const t = await withTrackedPr()
  const release = t.hold()
  await t.run('tick')
  t.setAuto(s => dismiss(s, [K7]))
  t.setItems(l => dropAuto(l, new Set([K7])))
  release()
  await t.idle()
  expect(t.items()).toEqual([])
})

test('writes in flight (c): /track clear while gh waits leaves no auto item back', async () => {
  const t = await withTrackedPr()
  const release = t.hold()
  await t.run('tick')
  const ids = autoIds(t.auto(), t.items())
  t.setAuto(s => dismiss(s, ids))
  t.setItems(l => dropAuto(l, new Set(ids)))
  release()
  await t.idle()
  expect(t.items()).toEqual([])
})

test('PR lane: a second run settles while gh waits; two more requests queue as one gh call; idle waits for it', async () => {
  const t = rig()
  const release = t.hold()
  await t.run('start')
  await flush()
  expect(t.log.gh).toHaveLength(1)
  t.setAuto(s => recordEnter(s, { path: `${MAIN}/.claude/worktrees/second`, branch: 'second-b' }, 9))
  t.state.porcelain = porcelain(['probe-wt', 'worktree-probe-wt'], ['second', 'second-b'])
  await t.run('worktree')
  expect(t.auto().snapshot!.worktrees.map(r => r.name)).toContain('second')
  await t.run('tick')
  await t.run('tick')
  let settled = false
  void t.idle().then(() => {
    settled = true
  })
  await flush()
  expect(settled).toBe(false)
  expect(t.log.gh).toHaveLength(1)
  release()
  await t.idle()
  expect(settled).toBe(true)
  expect(t.log.gh).toHaveLength(2)
})

test('two rounds in a row with the same replies make no auto write and no item write (A22)', async () => {
  const t = await withTrackedPr()
  const saves = t.log.saves
  const laneSaves = t.log.laneSaves
  const writes = t.log.itemWrites
  t.state.now += 30_000
  await t.run('tick')
  await t.idle()
  expect(t.log.gh).toHaveLength(2)
  expect(t.log.saves).toBe(saves)
  expect(t.log.laneSaves).toBe(laneSaves)
  expect(t.log.itemWrites).toBe(writes)
})

test('a throw in the PR step after discovery lands in the Pull requests note and clears on the next good step', async () => {
  const t = await withTrackedPr()
  expect(t.lane().prs).toMatchObject({ ok: true })
  let breakItems = true
  const broken = new PrLane({
    ...t.deps,
    applyItems: async change => {
      if (breakItems) throw new Error('item write refused')
      return t.deps.applyItems(change)
    },
  })
  t.state.now += 30_000
  broken.request()
  await broken.idle()
  expect(t.lane().prs).toMatchObject({ ok: false, error: 'item write refused' })
  // A dependency that throws before discovery is recorded the same way.
  const noRepo = new PrLane({
    ...t.deps,
    repo: async () => {
      throw new Error('repo lookup failed')
    },
  })
  t.state.now += 30_000
  noRepo.request()
  await noRepo.idle()
  expect(t.lane().prs).toMatchObject({ ok: false, error: 'repo lookup failed' })
  // The next good step clears it.
  breakItems = false
  t.state.now += 30_000
  broken.request()
  await broken.idle()
  expect(t.lane().prs).toMatchObject({ ok: true })
  expect(t.lane().prs.error).toBeUndefined()
})

// ================================================================ the lane alone

/** A lane over plain closures: the fact is set by the test. */
function laneRig(
  o: { defaultBranch?: string | null; items?: StoredItem[]; created?: PrRef[]; dismissed?: string[] } = {},
) {
  const log = { gh: [] as string[], saves: 0, worktrees: 0 }
  let items: StoredItem[] = o.items ?? []
  let state: LaneState = EMPTY_LANE
  let fact: BranchesFact | undefined = { seq: 1, reasons: ['start'], branches: ['main', 'feat/x'], overflow: 0 }
  let created: readonly PrRef[] = o.created ?? []
  const nodes: Record<string, unknown[]> = {}
  const createdNodes: Record<string, Record<number, unknown>> = {}
  const gate: { gh?: Promise<void> } = {}
  const deps: LaneDeps = {
    now: () => 5_000_000,
    load: async () => state,
    save: async change => {
      const next = change(state)
      if (next !== state) {
        state = next
        log.saves++
      }
      return state
    },
    branches: () => fact,
    gh: fakeGh({
      nodes,
      queries: log.gh,
      gate: () => gate.gh,
      defaultBranch: o.defaultBranch === undefined ? 'main' : o.defaultBranch,
      created: createdNodes,
    }),
    ghReady: async () => true,
    repo: async () => REPO,
    created: () => created,
    worktrees: async () => {
      log.worktrees++
      return [{ path: '/x/repo/wt', branch: 'feat/x', head: 'abc', detached: false, bare: false }]
    },
    scanBody,
    build: buildRecord,
    applyItems: async change => {
      const r = change(items, new Set(o.dismissed))
      items = r.list
      return r
    },
    onAdded: () => {},
    lane: () => PR_LANE_DEFAULTS,
    caps: () => ({ staleMs: LIMITS.staleMs, cap: capTo(LIMITS.maxItems) }),
  }
  const lane = new PrLane(deps)
  const hold = () => {
    let release = () => {}
    gate.gh = new Promise<void>(resolve => {
      release = resolve
    })
    return release
  }
  return {
    deps,
    lane,
    log,
    nodes,
    createdNodes,
    hold,
    items: () => items,
    state: () => state,
    setFact: (f: BranchesFact | undefined) => {
      fact = f
    },
    setCreated: (list: readonly PrRef[]) => {
      created = list
    },
  }
}

test('lane: a PR found for a branch auto drops while gh waits is pruned by the next step', async () => {
  const t = laneRig({ defaultBranch: null }) // no default branch is learned: the second step still queries `main`
  t.nodes['head:feat/x'] = [prNode({ number: 7, headRefName: 'feat/x' })]
  const landed: string[][] = []
  const write = t.deps.applyItems
  Object.assign(t.deps, {
    applyItems: async (change: Parameters<LaneDeps['applyItems']>[0]) => {
      const r = await write(change)
      landed.push(r.list.map(i => `${i.key} ${i.lane === true ? 'lane' : ''}`))
      return r
    },
  })
  const release = t.hold()
  t.lane.request() // the fact lists ['main', 'feat/x']
  await flush()
  expect(t.log.gh).toHaveLength(1)
  // The worktree goes while gh waits: the next fact lists the main tree only, and the step it asks for queues behind the first.
  const next: BranchesFact = { seq: 2, reasons: ['worktree'], branches: ['main'], overflow: 0 }
  expect(wantsStep(next, { seq: 1, reasons: ['start'], branches: ['main', 'feat/x'], overflow: 0 })).toBe(true)
  t.setFact(next)
  t.lane.request()
  release()
  await t.lane.idle()
  expect(landed).toEqual([[`${K7} lane`], []]) // tracked with the lane marker by the first step, pruned by the queued one
  expect(t.items()).toEqual([])
  expect(t.log.gh).toHaveLength(2) // the queued step asked about `main` only, and its reply was complete
  expect(t.log.gh[1]).not.toContain('feat/x')
})

test('lane: an init publish with no reasons starts no step', () => {
  const fact = (seq: number, reasons: string[], branches: string[] = ['main']): BranchesFact => ({
    seq,
    reasons,
    branches,
    overflow: 0,
  })
  expect(wantsStep(fact(1, []), undefined)).toBe(false)
  expect(wantsStep(fact(1, ['start']), undefined)).toBe(true)
  expect(wantsStep(fact(2, [], ['main', 'b']), fact(1, []))).toBe(true) // another seq, other branches
  expect(wantsStep(fact(2, [], ['main']), fact(1, []))).toBe(false) // another seq, same branches, no reason
  expect(wantsStep(fact(1, ['start'], ['main', 'b']), fact(1, []))).toBe(false) // the same seq
  for (const why of ['tick', 'manual', 'pr-event']) expect(wantsStep(fact(2, [why]), fact(1, []))).toBe(true)
  for (const why of ['worktree', 'agent', 'git']) expect(wantsStep(fact(2, [why]), fact(1, []))).toBe(false)
})

test('lane: branchesOf reads only a well-formed auto.branches', () => {
  const ok = { seq: 3, reasons: ['tick'], branches: ['main'], overflow: 1, current: 'main' }
  expect(branchesOf(ok as unknown as Json)).toEqual({ seq: 3, reasons: ['tick'], branches: ['main'], overflow: 1 })
  expect(branchesOf(undefined)).toBeUndefined()
  expect(branchesOf('feat/x')).toBeUndefined()
  expect(branchesOf({ ...ok, seq: '3' } as unknown as Json)).toBeUndefined()
  expect(branchesOf({ ...ok, overflow: null } as unknown as Json)).toBeUndefined()
  expect(branchesOf({ ...ok, reasons: [1] } as unknown as Json)).toBeUndefined()
  expect(branchesOf({ ...ok, branches: 'main' } as unknown as Json)).toBeUndefined()
})

test('lane: discovery gets the published branches and the github slice', async () => {
  const t = laneRig()
  t.setFact({ seq: 1, reasons: ['start'], branches: ['main', 'b-w4'], overflow: 3 })
  Object.assign(t.deps, {
    lane: () => ({
      ...PR_LANE_DEFAULTS,
      headPrsPerBranch: 2,
      basePrsPerBranch: 3,
      closingRefsPerPr: 4,
      maxBodyRefs: 1,
    }),
  })
  t.lane.request()
  await t.lane.idle()
  const query = t.log.gh[0] ?? ''
  expect(query).toContain('h1:') // the second published branch is polled
  expect(query).not.toContain('h2:') // and there is no third
  expect(query).toMatch(/headRefName: "main", first: 2/)
  expect(query).toMatch(/baseRefName: "main", first: 3/)
  expect(query).toContain('closingIssuesReferences(first: 4)')
})

test('lane: the github maxAutoItems reaches the apply step', async () => {
  const t = laneRig()
  t.setFact({ seq: 1, reasons: ['start'], branches: ['main', 'b-w3', 'b-w4'], overflow: 0 })
  t.nodes['head:b-w4'] = [prNode({ number: 7, headRefName: 'b-w4' })]
  t.nodes['head:b-w3'] = [prNode({ number: 8, headRefName: 'b-w3' })]
  Object.assign(t.deps, { lane: () => ({ ...PR_LANE_DEFAULTS, maxAutoItems: 1 }) })
  t.lane.request()
  await t.lane.idle()
  expect(t.items()).toHaveLength(1) // two PRs found, one auto item allowed
  expect(t.state().prs).toMatchObject({ ok: true, untracked: 1 })
  const free = laneRig()
  free.setFact({ seq: 1, reasons: ['start'], branches: ['main', 'b-w3', 'b-w4'], overflow: 0 })
  free.nodes['head:b-w4'] = [prNode({ number: 7, headRefName: 'b-w4' })]
  free.nodes['head:b-w3'] = [prNode({ number: 8, headRefName: 'b-w3' })]
  free.lane.request()
  await free.lane.idle()
  expect(free.items()).toHaveLength(2) // the default is 100
})

test('lane: global.refresh.staleMs reaches the apply step', async () => {
  const t = laneRig()
  t.nodes['head:feat/x'] = [prNode({ number: 7, headRefName: 'feat/x' })]
  Object.assign(t.deps, { caps: () => ({ staleMs: 1000, cap: capTo(LIMITS.maxItems) }) })
  const step = async () => {
    t.lane.request()
    await t.lane.idle()
  }
  await step()
  const first = t.items()
  expect(first).toHaveLength(1)
  Object.assign(t.deps, { now: () => 5_000_600 }) // over half of staleMs 1000: the record is no longer current
  await step()
  expect(t.items()).not.toBe(first)
  const free = laneRig()
  free.nodes['head:feat/x'] = [prNode({ number: 7, headRefName: 'feat/x' })]
  free.lane.request()
  await free.lane.idle()
  const settled = free.items()
  Object.assign(free.deps, { now: () => 5_000_600 }) // the default staleMs is 300000: still current, a quiet step
  free.lane.request()
  await free.lane.idle()
  expect(free.items()).toBe(settled)
})

test('lane: global.store.maxItems reaches the apply step', async () => {
  const mention = (n: number): StoredItem =>
    ({
      key: `web:https://h${n}.example/`,
      category: 'web',
      url: `https://h${n}.example/`,
      label: `h${n}`,
      sources: ['prompt'],
      reasons: reasonsOfSources(['prompt']),
      firstSeen: 1,
      lastSeen: n,
      seenCount: 1,
    }) as unknown as StoredItem
  const seed = [mention(1), mention(2), mention(3)]
  const capped = laneRig({ items: seed })
  capped.nodes['head:feat/x'] = [prNode({ number: 7, headRefName: 'feat/x' })]
  Object.assign(capped.deps, { caps: () => ({ staleMs: LIMITS.staleMs, cap: capTo(2) }) })
  capped.lane.request()
  await capped.lane.idle()
  expect(capped.items().filter(r => r.category === 'web')).toHaveLength(2) // the oldest mention goes
  const free = laneRig({ items: seed })
  free.nodes['head:feat/x'] = [prNode({ number: 7, headRefName: 'feat/x' })]
  free.lane.request()
  await free.lane.idle()
  expect(free.items().filter(r => r.category === 'web')).toHaveLength(3)
})

test('lane: a lane with no gh tool records gh: not ready in the note, and the next good step clears it', async () => {
  const t = laneRig()
  let ready = false
  Object.assign(t.deps, {
    ghReady: async () => {
      if (!ready) throw new Error('gh: not ready')
      return true
    },
  })
  t.lane.request()
  await t.lane.idle()
  expect(t.state().prs).toMatchObject({ ok: false, error: 'gh: not ready' })
  ready = true
  t.lane.request()
  await t.lane.idle()
  expect(t.state().prs).toMatchObject({ ok: true })
})

// ================================================================ the shipped trackers through a manager

const START_AT = 1_000_000
const ROOT = '/work'
/** #7 as the item refresh sees it. */
const PR7 = {
  __typename: 'PullRequest',
  number: 7,
  title: 'Opened here',
  state: 'OPEN',
  isDraft: false,
  reviewDecision: null,
  url: 'https://github.com/acme/web/pull/7',
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
}
/** Any other issue as the item refresh sees it: open, with a title. */
const issueNode = (n: number) => ({
  __typename: 'Issue',
  number: n,
  title: `Issue ${n}`,
  state: 'OPEN',
  url: `https://github.com/acme/web/issues/${n}`,
})
const BRANCH = 'worktree-probe-wt'
const WINDOW = LIMITS.autoDebounceMs + 10

/** A manager over the shipped trackers. git answers one child worktree; gh answers the discovery queries from `nodes`. */
function shipped(
  o: { off?: boolean; file?: JsonObject; defaultBranch?: string | null; refuse?: readonly string[] } = {},
) {
  const queries: string[] = []
  /** The issue and PR numbers that the item refresh asked about, in order. */
  const refreshed: string[] = []
  const nodes: Record<string, unknown[]> = {}
  /** The PRs the session created, by lower-case `owner/repo` and number (issue #158). */
  const created: Record<string, Record<number, unknown>> = {}
  const gate: { gh?: Promise<void> } = {}
  const t = managerWorld({
    fake: { now: START_AT, session: { cwd: ROOT } },
    run: async argv => {
      if (argv[0] === 'git') {
        if (argv[1] === 'rev-parse') return res(`${ROOT}\n`)
        if (argv[1] === 'worktree') return res(gitPorcelain(ROOT, ['probe-wt', BRANCH]))
        return undefined
      }
      // `gh auth status --hostname <host>`: gh is logged in to every host a test names.
      if (argv[0] === 'gh' && argv[1] === 'auth') return res('')
      if (argv[0] === 'gh' && argv[1] === 'api' && argv[2] === 'graphql') {
        const q = argv.find(x => x.startsWith('query='))?.slice('query='.length) ?? ''
        // A host whose login gh refuses: exit 4 and the login hint, as `gh api` answers when it has no token for it.
        if (o.refuse?.includes(argv[argv.indexOf('--hostname') + 1] ?? ''))
          return res('', 4, 'please run: gh auth login')
        if (!q.includes('pullRequests(') && !q.includes('pullRequest(number:')) {
          // The refresh of the tracked items: #7 is the open PR the lane found, any other number is an open issue.
          const data: Record<string, unknown> = {}
          for (const m of q.matchAll(
            /(a\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\) \{\s*issueOrPullRequest\(number: (\d+)\)/g,
          )) {
            refreshed.push(m[4]!)
            // A PR the session created answers as that PR (issue #158); #7 as the PR the lane found.
            const made = created[`${m[2]}/${m[3]}`.toLowerCase()]?.[Number(m[4])]
            const node = made
              ? { ...(made as object), __typename: 'PullRequest' }
              : m[4] === '7'
                ? PR7
                : issueNode(Number(m[4]))
            data[m[1]!] = { issueOrPullRequest: node }
          }
          return res(JSON.stringify({ data }))
        }
        queries.push(q)
        await gate.gh
        const outcome = replyFor(q, nodes, o.defaultBranch === undefined ? 'main' : o.defaultBranch, created)
        return res(JSON.stringify({ data: outcome.ok ? outcome.reply.data : {} }))
      }
      return undefined
    },
    config: specs => fakeConfig({ specs, file: o.file ?? (o.off ? { trackers: { github: { enabled: false } } } : {}) }),
  })
  const hold = () => {
    let release = () => {}
    gate.gh = new Promise<void>(resolve => {
      release = resolve
    })
    return release
  }
  const enter = () =>
    t.call(
      'EnterWorktree',
      { name: 'probe-wt' },
      { result: { worktreePath: `${ROOT}/.claude/worktrees/probe-wt`, worktreeBranch: BRANCH } },
    )
  const start = () => t.m.start(t.w.ports, { cwd: ROOT, fromSessionStart: true })
  const refresh = () => t.m.command(t.w.ports, { sub: 'refresh', args: '', wait: true })
  const branches = () => t.m.facts.read<BranchesFact>('auto.branches')
  return { ...t, queries, refreshed, nodes, created, hold, enter, start, refresh, branches }
}

test('lane: with github off auto still publishes branches and no gh call runs', async () => {
  const t = shipped({ off: true })
  await t.start()
  await t.enter()
  await t.w.clock.advance(WINDOW)
  await sleep(15)
  expect(t.branches()?.branches).toEqual(['main', BRANCH]) // auto went on without github
  expect(t.w.calls.filter(c => c[0] === 'gh')).toEqual([])
  expect(t.w.state.get('github')).toBeUndefined() // the lane never ran, so it left no note
  expect((await t.m.track(t.w.ports, '')).text).not.toContain('Pull requests')
})

test('lane: /track refresh with wait returns after the discovery', async () => {
  const t = shipped()
  t.nodes[`head:${BRANCH}`] = [prNode({ number: 7, headRefName: BRANCH, title: 'Opened here' })]
  await t.start()
  await t.enter()
  await t.w.clock.advance(WINDOW)
  await sleep(15)
  const release = t.hold()
  let settled = false
  const reply = t.m.track(t.w.ports, 'refresh').then(r => {
    settled = true
    return r
  })
  await t.w.clock.advance(2000) // past the 750 ms debounce of auto
  await sleep(15)
  expect(t.queries.length).toBeGreaterThan(1) // the manual round started the lane, and gh waits
  expect(settled).toBe(false)
  release()
  const out = await reply
  expect(out.text).toContain('Opened here')
})

test('lane: a step that starts during a switch writes after it', async () => {
  const t = shipped({ defaultBranch: null })
  t.nodes[`head:${BRANCH}`] = [prNode({ number: 7, headRefName: BRANCH })]
  await t.start()
  await t.enter()
  await t.w.clock.advance(WINDOW)
  await t.refresh()
  expect(t.keys()).toEqual([K7])
  // `/clear`, the way a reload leaves it (the switch carries from `v2:run`): the carried auto state lists other branches
  // than the last fact, so the restore of auto republishes `auto.branches` with a new seq and asks the lane for a step in
  // the middle of the switch. That step finds no #7 any more.
  await t.m.end(t.w.ports, 'clear', 1500)
  const run = t.w.store.get('v2:run') as unknown as { pendingEnd: PendingEnd; run: { auto: AutoState } }
  run.run.auto.snapshot!.branches = ['main']
  t.w.store.set('v2:run', run as unknown as Json)
  t.m.watch.resumeFrom(run.pendingEnd)
  t.w.session.id = 'sess-2'
  t.w.state.delete('auto')
  t.w.state.delete('github')
  delete t.nodes[`head:${BRANCH}`]
  const before = t.queries.length
  await t.m.entry(t.w.ports) // the switch resolves first: the step it started waits for it, and cannot block it
  await until(() => t.queries.length > before, 'the step that the restore started')
  await t.refresh() // waits for the lane
  // The carried list held #7 with source `auto`. The complete reply lacked it: it is pruned after the carry. A write
  // before the carry would have been undone by it, and #7 would still be here.
  expect(t.keys()).not.toContain(K7)
  expect(t.queries[before]).not.toContain(BRANCH) // the step ran on the carried branches: `main` only
})

test('lane: quiet steps write neither the github slot nor items (A22)', async () => {
  const t = shipped()
  t.nodes[`head:${BRANCH}`] = [prNode({ number: 7, headRefName: BRANCH })]
  await t.start()
  await t.enter()
  await t.w.clock.advance(WINDOW)
  await t.refresh()
  expect(t.keys()).toEqual([K7])
  const slot = t.w.stateSets.github
  const items = t.w.stateSets.items
  expect(slot).toBe(1) // the default branch the first reply named
  await t.refresh()
  await t.refresh()
  expect(t.queries.length).toBeGreaterThan(2)
  expect(t.w.stateSets.github).toBe(slot)
  expect(t.w.stateSets.items).toBe(items)
})

/** Refuses the writes of the `auto` member for which `refuse` answers true. `n` counts them, from 1. */
function refuseAutoWrites(t: ReturnType<typeof shipped>, refuse: (n: number) => boolean): void {
  const slot = t.w.ports.state.slot
  const update = slot.update.bind(slot)
  let n = 0
  slot.update = async (id, fn) => {
    if (id === 'auto' && refuse(++n)) throw new Error('write refused')
    return update(id, fn)
  }
}

// Over the real scheduler and the real `auto` slot: the round catches the refusal and the scheduler still publishes its
// branches, so the lane still runs.
test('a refused snapshot write does not skip the PR step; a refused root write does not stop the round', async () => {
  const t = shipped()
  t.nodes[`head:${BRANCH}`] = [prNode({ number: 7, headRefName: BRANCH })]
  await t.start()
  await t.enter()
  await t.w.clock.advance(WINDOW)
  await until(() => t.queries.some(q => q.includes(BRANCH)), 'the first PR step')
  const before = t.queries.length
  refuseAutoWrites(t, () => true)
  await t.m.tick() // resolves: nothing rejects
  await sleep(15)
  expect(t.queries.length).toBe(before + 1) // the PR step still ran
  // The write of the root top is the second `auto` write of a run (the pin is the first). It is refused: the snapshot is
  // still written, the lane still runs (with no main tree to poll yet), and the next round retries the top.
  const fresh = shipped()
  refuseAutoWrites(fresh, n => n === 2)
  await fresh.start()
  await fresh.w.clock.advance(WINDOW)
  await until(() => fresh.w.state.get('github') !== undefined, 'the PR step')
  const run = () => fresh.w.state.get('auto') as unknown as AutoState
  expect(run().snapshot?.agents.map(r => r.id)).toEqual(['ag:master'])
  expect(run().root?.top).toBeUndefined()
  expect(fresh.w.state.get('github')).toMatchObject({ prs: { ok: false, skipped: 'no-branches' } })
  await fresh.m.tick()
  await until(() => fresh.queries.length > 0, 'the PR step of the retry')
  expect(run().root?.top).toBe(ROOT)
})

test('lane: the discovery writes its items through the item store and asks for the refresh of the new keys', async () => {
  const t = shipped()
  t.nodes[`head:${BRANCH}`] = [prNode({ number: 7, headRefName: BRANCH, body: 'Part of #1' })]
  await t.start()
  // The kick that the start makes for every item runs first. Left pending, it would also refresh the key the lane adds
  // later, and nothing would show whether the lane asked.
  await t.w.clock.advance(LIMITS.captureDebounceMs + 10)
  await t.enter()
  await t.w.clock.advance(WINDOW)
  // The lane asks for the refresh of the keys it added, with no command in between: `/track refresh` refreshes every item
  // itself, so a later check could not tell. #7 came with its data in the discovery; only the key of the PR body is new.
  await until(() => t.keys().includes(K1), 'the discovery')
  expect(t.refreshed).toEqual([]) // the kick waits out its debounce
  await t.w.clock.advance(LIMITS.captureDebounceMs + 10)
  await until(() => t.refreshed.length > 0, 'the refresh of the keys the discovery added')
  expect(t.refreshed).toEqual(['1'])
  await t.refresh()
  expect(t.keys()).toEqual([K7, K1])
  // Sources keep channels only: the lane's records have none, and `discovered` is their one reason (issue #62).
  expect(t.items().every(i => i.sources.length === 0 && i.reasons.all.join() === 'discovered')).toBe(true)
  expect(t.m.facts.read('session.repo')).toEqual(REPO)
  expect((t.w.state.get('github') as unknown as LaneState).defaultBranch).toBe('main')
})

test('lane: a lazy start with no pinned root runs no PR step and leaves the github slot unwritten', async () => {
  const t = shipped()
  await t.m.ensureStarted(t.w.ports) // no cwd: auto pins no root, so its round returns before the snapshot
  for (let i = 0; i < 3; i++) {
    await t.m.tick()
    await sleep(15)
  }
  await t.refresh()
  expect(t.w.stateSets.github).toBeUndefined()
  expect(t.w.state.get('github')).toBeUndefined()
  expect(t.queries).toEqual([])
  // A start with a cwd pins the root, and the lane then runs as usual.
  t.nodes[`head:${BRANCH}`] = [prNode({ number: 7, headRefName: BRANCH })]
  await t.start()
  await t.enter()
  await t.w.clock.advance(WINDOW)
  await t.refresh()
  expect(t.keys()).toEqual([K7])
  expect(t.w.stateSets.github).toBeGreaterThan(0)
})

test('lane: the github slice reaches the discovery and the apply step, and a changed file shows at the next step', async () => {
  const slice = { headPrsPerBranch: 2, basePrsPerBranch: 3, closingRefsPerPr: 4, maxAutoItems: 1 }
  const t = shipped({ file: { trackers: { github: slice } } })
  t.nodes[`head:${BRANCH}`] = [prNode({ number: 7, headRefName: BRANCH }), prNode({ number: 8, headRefName: BRANCH })]
  await t.start()
  await t.enter()
  await t.w.clock.advance(WINDOW)
  await t.refresh()
  const query = t.queries.find(q => q.includes(BRANCH)) ?? ''
  expect(query).toContain(`headRefName: "${BRANCH}", first: 2`)
  expect(query).toContain(`baseRefName: "${BRANCH}", first: 3`)
  expect(query).toContain('closingIssuesReferences(first: 4)')
  expect(t.keys()).toHaveLength(1) // two PRs found, one auto item allowed
  expect(t.w.state.get('github')).toMatchObject({ prs: { ok: true, untracked: 1 } })
  // The file changes: the next step reads the new slice, not the one of the first step.
  const before = t.queries.length
  ;(t.cfg as FakeConfig).set({ trackers: { github: { ...slice, headPrsPerBranch: 9, maxAutoItems: 2 } } })
  await t.refresh()
  expect(t.queries.length).toBeGreaterThan(before)
  expect(t.queries.at(-1)).toContain(`headRefName: "${BRANCH}", first: 9`)
  expect(t.keys()).toHaveLength(2)
  expect(t.w.state.get('github')).toMatchObject({ prs: { ok: true } })
  expect((t.w.state.get('github') as unknown as LaneState).prs.untracked).toBeUndefined()
})

test('lane: github.maxBodyRefs reaches the scan of a PR body', async () => {
  const body = 'Part of #1 and #2'
  const capped = shipped({ file: { trackers: { github: { maxBodyRefs: 1 } } } })
  capped.nodes[`head:${BRANCH}`] = [prNode({ number: 7, headRefName: BRANCH, body })]
  await capped.start()
  await capped.enter()
  await capped.w.clock.advance(WINDOW)
  await capped.refresh()
  expect(capped.keys()).toEqual([K7, K1]) // the first ref of the body only
  const free = shipped()
  free.nodes[`head:${BRANCH}`] = [prNode({ number: 7, headRefName: BRANCH, body })]
  await free.start()
  await free.enter()
  await free.w.clock.advance(WINDOW)
  await free.refresh()
  expect(free.keys()).toEqual([K7, K1, 'gh:github.com/acme/web#2'])
})

test('lane: global.refresh.staleMs reaches the shipped lane: a record is rewritten once half of it has passed', async () => {
  const step = async (t: ReturnType<typeof shipped>, ms: number) => {
    await t.w.clock.advance(ms)
    await t.refresh()
  }
  const run = async (file: JsonObject) => {
    const t = shipped({ file })
    t.nodes[`head:${BRANCH}`] = [prNode({ number: 7, headRefName: BRANCH })]
    await t.start()
    await t.enter()
    await step(t, WINDOW)
    expect(t.keys()).toEqual([K7])
    const settled = t.w.stateSets.items
    await step(t, 16_000) // over half of 30000, under half of the default 300000
    return { t, grew: (t.w.stateSets.items ?? 0) > (settled ?? 0) }
  }
  expect((await run({ global: { refresh: { staleMs: 30_000 } } })).grew).toBe(true)
  expect((await run({})).grew).toBe(false)
})

test('lane: global.store.maxItems reaches the shipped lane: the oldest mention goes over the cap', async () => {
  const mention = (n: number): StoredItem =>
    ({
      key: `web:https://h${n}.example/`,
      category: 'web',
      url: `https://h${n}.example/`,
      label: `h${n}`,
      sources: ['prompt'],
      reasons: reasonsOfSources(['prompt']),
      firstSeen: 1,
      lastSeen: n,
      seenCount: 1,
    }) as unknown as StoredItem
  const webCount = (t: ReturnType<typeof shipped>) => t.items().filter(r => r.category === 'web').length
  const run = async (file: JsonObject) => {
    const t = shipped({ file })
    t.w.state.set('items', Array.from({ length: 201 }, (_, i) => mention(i + 1)) as unknown as Json)
    t.nodes[`head:${BRANCH}`] = [prNode({ number: 7, headRefName: BRANCH })]
    await t.start()
    await t.enter()
    await t.w.clock.advance(WINDOW)
    await t.refresh()
    expect(t.keys()).toContain(K7)
    return webCount(t)
  }
  expect(await run({ global: { store: { maxItems: 200 } } })).toBe(200) // the cap is 200: one mention goes
  expect(await run({})).toBe(201) // the default cap is 500
})

test('lane: the file cap and the rank reach the shipped lane: the written file stays, the oldest reads go (issue #57)', async () => {
  const file = (path: string, kind: 'viewed' | 'created', at: number): StoredItem =>
    fileRecord({ path, label: path, kind, bySubagent: false }, { source: 'tool', at }) as unknown as StoredItem
  const run = async (slice: JsonObject) => {
    const t = shipped({ file: { trackers: { file: slice } } })
    // One written file, the oldest, then 70 read files: over maxFiles 50, far under the shared cap of 500.
    const held = [
      file('/work/keep.ts', 'created', 1),
      ...Array.from({ length: 70 }, (_, i) => file(`/work/r${i}.txt`, 'viewed', 10 + i)),
    ]
    t.w.state.set('items', held as unknown as Json)
    t.nodes[`head:${BRANCH}`] = [prNode({ number: 7, headRefName: BRANCH })]
    await t.start()
    await t.enter()
    await t.w.clock.advance(WINDOW)
    await t.refresh()
    expect(t.keys()).toContain(K7)
    const files = t.items().filter(r => r.category === 'file')
    return [files.length, files.some(r => r.key === 'file:/work/keep.ts')]
  }
  expect(await run({ maxFiles: 50 })).toEqual([50, true])
  expect(await run({})).toEqual([71, true]) // the default file cap is 300
})

test('lane: a PR body ref of a kind that is off makes no item', async () => {
  const body = 'See https://acme.atlassian.net/browse/ISS-9 and https://example.com/spec'
  const on = shipped()
  on.nodes[`head:${BRANCH}`] = [prNode({ number: 7, headRefName: BRANCH, body })]
  await on.start()
  await on.enter()
  await on.w.clock.advance(WINDOW)
  await on.refresh()
  expect(on.keys()).toEqual([K7, 'jira:acme.atlassian.net/ISS-9', 'web:https://example.com/spec'])
  const off = shipped({ file: { trackers: { jira: { enabled: false } } } })
  off.nodes[`head:${BRANCH}`] = [prNode({ number: 7, headRefName: BRANCH, body })]
  await off.start()
  await off.enter()
  await off.w.clock.advance(WINDOW)
  await off.refresh()
  expect(off.keys()).toEqual([K7, 'web:https://example.com/spec']) // the Jira URL is Jira's even when Jira is off
})

test('lane: the github slot is run-scoped; a restore fills an empty slot and never replaces a note written since', async () => {
  const world = hostWorld([githubTracker()])
  await world.host.init()
  const slot = world.host.slots().find(x => x.id === 'github')
  if (!slot) throw new Error('no github slot')
  expect(slot.persist).toBe(false)
  expect(slot.empty(undefined)).toBe(true)
  const kept = { prs: { ok: true }, defaultBranch: 'main' } as unknown as Json
  await slot.restore(kept, 'carry')
  expect(world.w.state.get('github')).toEqual(kept)
  const fresh = { prs: { ok: false, skipped: 'no-repo' }, defaultBranch: 'dev' } as unknown as Json
  world.w.state.set('github', fresh)
  await slot.restore(kept, 'carry')
  expect(world.w.state.get('github')).toEqual(fresh)
})

test('lane: with no gh tool the step lands gh: not ready in the slot, and a bad fact starts nothing', async () => {
  const world = hostWorld([githubTracker()])
  await world.host.init()
  world.host.fill(world.bus)
  const via = world.w.ports
  const started: BranchesFact = { seq: 1, reasons: ['start'], branches: ['main'], overflow: 0 }
  const fact = (value: Json | undefined, previous?: Json) =>
    world.bus.emit('fact', { name: 'auto.branches', value, previous }, via)
  await fact('not a fact')
  await world.bus.emit('command', { sub: 'refresh', args: '', wait: true }, via)
  expect(world.w.state.get('github')).toBeUndefined()
  await fact(started as unknown as Json)
  await world.bus.emit('command', { sub: 'other', args: '', wait: true }, via) // another sub waits for nothing
  await world.bus.emit('command', { sub: 'refresh', args: '', wait: true }, via)
  expect(world.w.state.get('github')).toMatchObject({ prs: { ok: false, error: 'gh: not ready' } })
})

// ================================================================ the merge state, through the shipped trackers (issue #50)

test('lane: a CONFLICTING PR notes the worktree of its head branch, from one git call with the github timeout', async () => {
  const t = shipped()
  t.nodes[`head:${BRANCH}`] = [
    prNode({ number: 7, headRefName: BRANCH, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
  ]
  const timeouts: (number | undefined)[] = []
  const run = t.w.ports.run
  Object.assign(t.w.ports, {
    run: (argv: readonly string[], opts: { timeoutMs?: number }) => {
      if (argv[1] === 'worktree' && argv[3] === '--porcelain') timeouts.push(opts.timeoutMs)
      return run(argv, opts)
    },
  })
  await t.start()
  await t.enter()
  await t.w.clock.advance(WINDOW)
  await t.refresh()
  const lane = t.w.state.get('github') as unknown as LaneState
  expect(lane.merge).toEqual({ [K7]: { worktree: `${ROOT}/.claude/worktrees/probe-wt` } })
  expect(timeouts.length).toBeGreaterThan(0)
  expect(timeouts.every(ms => ms !== undefined)).toBe(true)
})

test('lane: a PR that GitHub calls UNKNOWN is asked again by the host clock after 3 s', async () => {
  const t = shipped()
  t.nodes[`head:${BRANCH}`] = [prNode({ number: 7, headRefName: BRANCH, mergeable: 'UNKNOWN' })]
  await t.start()
  await t.enter()
  await t.w.clock.advance(WINDOW)
  await until(
    () => (t.w.state.get('github') as unknown as LaneState | undefined)?.merge !== undefined,
    'the first step',
  )
  const before = t.queries.length
  t.nodes[`head:${BRANCH}`] = [prNode({ number: 7, headRefName: BRANCH, mergeable: 'MERGEABLE' })]
  await t.w.clock.advance(3000)
  await until(() => t.queries.length > before, 'the retry')
  await until(() => (t.w.state.get('github') as unknown as LaneState).merge === undefined, 'the note to go')
})

// ================================================================ the PRs the session created (issue #158)

const IAM = { host: 'github.com', owner: 'VerticeOne', repo: 'vertice-iam' }
const KIAM = 'gh:github.com/verticeone/vertice-iam#657'
const K12 = 'gh:github.com/acme/web#12'
/** #657 of another repo, as the pr fragment returns it: its URL is that repo's. */
const iamNode = (over: Parameters<typeof prNode>[0] = {}) => ({
  ...prNode({ number: 657, headRefName: 'feat/brown-2901', title: 'Emit the principal scope verdict', ...over }),
  url: 'https://github.com/VerticeOne/vertice-iam/pull/657',
})

test('createdOf reads the fact auto.prs: whole entries only, whatever else the proof holds', () => {
  const ok = { host: 'github.com', owner: 'o', repo: 'r', number: 4, provenAt: 9 } // a stored proof may hold more
  expect(createdOf([ok, { ...ok, number: 5 }] as unknown as Json)).toEqual([
    { host: 'github.com', owner: 'o', repo: 'r', number: 4 },
    { host: 'github.com', owner: 'o', repo: 'r', number: 5 },
  ])
  expect(createdOf(undefined)).toEqual([])
  expect(createdOf('x' as unknown as Json)).toEqual([])
  expect(
    createdOf([{ ...ok, number: '4' }, { ...ok, owner: '' }, { ...ok, number: 0 }, null, 7] as unknown as Json),
  ).toEqual([])
})

test('lane: a PR the session created in a second repo lists with the lane marker, the case of its repo and the reason created', async () => {
  const t = laneRig({ created: [{ ...IAM, number: 657 }] })
  t.createdNodes['verticeone/vertice-iam'] = { 657: iamNode() }
  t.lane.request()
  await t.lane.idle()
  expect(t.log.gh).toHaveLength(2) // the session repo, then the second one
  expect(t.log.gh[1]).toContain('repository(owner: "VerticeOne", name: "vertice-iam")')
  const [rec] = t.items() as unknown as GitHubRecord[]
  expect(rec).toMatchObject({
    key: KIAM,
    owner: 'VerticeOne',
    repo: 'vertice-iam',
    label: 'VerticeOne/vertice-iam#657',
    url: 'https://github.com/VerticeOne/vertice-iam/pull/657',
    otherRepo: true,
    lane: true,
    headRefName: 'feat/brown-2901',
  })
  expect(rec?.reasons).toEqual({ first: 'created', all: ['created', 'discovered'], strongest: 'created' })
  expect(isLanePr(rec as GitHubRecord)).toBe(true)
  expect(t.state().prs).toMatchObject({ ok: true })
})

test('lane: a PR the session created in the session repo on a branch no proof names lists, also once closed, and stays', async () => {
  const t = laneRig({ created: [{ host: 'github.com', owner: 'acme', repo: 'web', number: 12 }] })
  const closed = prNode({ number: 12, state: 'CLOSED', headRefName: 'feat/untracked-p2', baseRefName: 'main' })
  t.createdNodes['acme/web'] = { 12: closed }
  t.lane.request()
  await t.lane.idle()
  expect(t.log.gh).toHaveLength(1) // the same query as the branches
  const [rec] = t.items() as unknown as GitHubRecord[]
  expect(rec).toMatchObject({ key: K12, state: 'closed', lane: true, headRefName: 'feat/untracked-p2' })
  expect('otherRepo' in rec!).toBe(false)
  expect(isLanePr(rec as GitHubRecord)).toBe(true)
  // Later steps keep it, with the same list while nothing changes (A22).
  const list = t.items()
  t.lane.request()
  await t.lane.idle()
  expect(t.items()).toBe(list)
})

test('lane: a closed or merged created PR stays in Pull requests as a lane PR, and a created PR GitHub says is gone leaves it', async () => {
  const t = laneRig({ created: [{ ...IAM, number: 657 }] })
  t.createdNodes['verticeone/vertice-iam'] = { 657: iamNode({ state: 'OPEN' }) }
  t.lane.request()
  await t.lane.idle()
  t.createdNodes['verticeone/vertice-iam'] = { 657: iamNode({ state: 'MERGED' }) }
  t.lane.request()
  await t.lane.idle()
  expect(t.items()[0]).toMatchObject({ key: KIAM, state: 'merged', lane: true })
  // The reply stays complete on a NOT_FOUND of the alias, so the prune runs: the PR keeps `created` and leaves the lane.
  Object.assign(t.deps, {
    gh: {
      ...t.deps.gh,
      graphql: async (_host: string, q: string): Promise<GraphqlOutcome> => {
        const gone = { type: 'NOT_FOUND', path: ['repository', 'p0'], message: 'Could not resolve to a PullRequest' }
        const sessionRepo = q.includes('owner: "acme"')
        return {
          ok: true,
          reply: {
            data: sessionRepo
              ? discoveryData({ h0: [], b0: [], h1: [], b1: [] })
              : { repository: { defaultBranchRef: { name: 'main' }, p0: null } },
            errors: sessionRepo ? [] : [gone],
          },
        }
      },
    },
  })
  t.lane.request()
  await t.lane.idle()
  const rec = t.items()[0] as unknown as GitHubRecord
  expect(rec.reasons.all).toEqual(['created'])
  expect(isLanePr(rec)).toBe(false)
})

test('lane: a repo of a created PR that never answers keeps that PR, and the prune of the session repo still runs', async () => {
  const t = laneRig({ created: [{ ...IAM, number: 657 }] })
  t.nodes['head:feat/x'] = [prNode({ number: 7, headRefName: 'feat/x' })]
  t.createdNodes['verticeone/vertice-iam'] = { 657: iamNode({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }) }
  t.lane.request()
  await t.lane.idle()
  expect(t.items().map(i => [i.key, i.lane])).toEqual([
    [K7, true],
    [KIAM, true],
  ])
  expect(t.state().merge).toEqual({ [KIAM]: {} })
  // The repo is deleted, or the token loses access to it: `repository: null`, step after step. #7 is gone from the
  // session repo, and its prune is not held back by the repo that never answers.
  delete t.nodes['head:feat/x']
  const real = t.deps.gh.graphql.bind(t.deps.gh)
  Object.assign(t.deps.gh, {
    graphql: async (host: string, q: string): Promise<GraphqlOutcome> =>
      q.includes('owner: "VerticeOne"')
        ? { ok: true, reply: { data: { repository: null }, errors: [{ type: 'NOT_FOUND', path: ['repository'] }] } }
        : real(host, q),
  })
  for (let step = 0; step < 2; step++) {
    t.lane.request()
    await t.lane.idle()
    expect(t.items().map(i => [i.key, i.lane, (i as unknown as GitHubRecord).reasons.all])).toEqual([
      [KIAM, true, ['created', 'discovered']], // held: still in Pull requests
    ])
    expect(t.state().prs).toMatchObject({ ok: true })
    expect(t.state().merge).toEqual({ [KIAM]: {} }) // its merge note stays too, so the conflict chip does not vanish
  }
})

test('lane: one unsure created PR of a repo does not keep the stale refs of its sure sibling', async () => {
  const K658 = 'gh:github.com/verticeone/vertice-iam#658'
  const REF1 = 'gh:github.com/verticeone/vertice-iam#901'
  const REF2 = 'gh:github.com/verticeone/vertice-iam#902'
  const iam658 = (body: string) => ({
    ...iamNode({ number: 658, headRefName: 'feat/brown-2902', body }),
    url: 'https://github.com/VerticeOne/vertice-iam/pull/658',
  })
  const t = laneRig({
    created: [
      { ...IAM, number: 657 },
      { ...IAM, number: 658 },
    ],
  })
  t.createdNodes['verticeone/vertice-iam'] = {
    657: iamNode({ body: 'Part of #901' }),
    658: iam658('Part of #902'),
  }
  t.lane.request()
  await t.lane.idle()
  const via = () => Object.fromEntries(t.items().map(i => [i.key, (i as unknown as { via?: string[] }).via]))
  expect(via()).toEqual({ [KIAM]: undefined, [K658]: undefined, [REF1]: [KIAM], [REF2]: [K658] })
  // The body of 657 no longer names #901. 658 gives no verdict (null, no NOT_FOUND): its body was not read, so #902
  // keeps its entry. 657 answered, so #901 loses it, and the lane drops the ref.
  t.createdNodes['verticeone/vertice-iam'] = { 657: iamNode({ body: 'Done' }) }
  t.lane.request()
  await t.lane.idle()
  expect(via()).toEqual({ [KIAM]: undefined, [K658]: undefined, [REF2]: [K658] })
  expect(t.state().prs).toMatchObject({ ok: true })
})

test('lane: the note of a host that gh is not logged in to keeps that host, and a quiet step does not rewrite it', async () => {
  const ghe = { host: 'ghe.corp', owner: 'team', repo: 'svc' }
  const t = laneRig({ created: [{ ...ghe, number: 3 }] })
  Object.assign(t.deps.gh, { checkHost: async () => false, isHostAuthed: () => false })
  t.setFact({ seq: 1, reasons: ['start'], branches: [], overflow: 0 })
  t.lane.request()
  await t.lane.idle()
  expect(t.state().prs).toMatchObject({ ok: false, skipped: 'host-not-authed', host: 'ghe.corp' })
  const saves = t.log.saves
  t.lane.request()
  await t.lane.idle()
  expect(t.log.saves).toBe(saves) // the same note: no write
  // Another host says no: that is a new note, and it is written.
  t.setCreated([{ host: 'ghe.other', owner: 'team', repo: 'svc', number: 3 }])
  t.lane.request()
  await t.lane.idle()
  expect(t.state().prs).toMatchObject({ skipped: 'host-not-authed', host: 'ghe.other' })
})

test('lane: a created PR that is held and then dismissed leaves no merge note and no stale refs', async () => {
  const opts = { created: [{ ...IAM, number: 657 }], dismissed: [] as string[] }
  const t = laneRig(opts)
  t.createdNodes['verticeone/vertice-iam'] = {
    657: iamNode({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', body: 'Part of #901' }),
  }
  t.lane.request()
  await t.lane.idle()
  expect(t.state().merge).toEqual({ [KIAM]: {} })
  expect(t.items().map(i => i.key)).toEqual([KIAM, 'gh:github.com/verticeone/vertice-iam#901'])
  // The repo gives no verdict on the PR (it is held), and the person dismisses it: a held PR that is dismissed keeps
  // neither its merge note (a retry timer would run on it) nor the refs of its body (Codex review of #186).
  delete t.createdNodes['verticeone/vertice-iam']
  opts.dismissed.push(KIAM)
  t.lane.request()
  await t.lane.idle()
  expect(t.state().merge).toBeUndefined()
  expect(t.items().map(i => i.key)).toEqual([KIAM])
})

test('lane: a created PR on a host that refuses its login does not stop the session repo, now or on the next step', async () => {
  const GHE_PR = 'https://ghe.corp/team/svc/pull/3'
  const t = shipped({ refuse: ['ghe.corp'] })
  t.nodes[`head:${BRANCH}`] = [prNode({ number: 7, headRefName: BRANCH })]
  t.created['team/svc'] = { 3: { ...prNode({ number: 3, headRefName: 'feat/ghe' }), url: GHE_PR } }
  await t.start()
  await t.enter()
  await t.w.clock.advance(WINDOW)
  await t.call('Bash', { command: 'gh pr create' }, createdPr(GHE_PR, 3))
  await t.w.clock.advance(WINDOW)
  await t.refresh()
  // Not logged in to ghe.corp (a token that expired after the host check): its PR is held, and #7 of the session repo shows.
  expect(t.keys()).toEqual([K7])
  const after = t.queries.length
  await t.w.clock.advance(WINDOW)
  await t.refresh()
  // The refusal logged out that host alone: gh is not logged out for github.com, so the next step asks again.
  expect(t.queries.length).toBeGreaterThan(after)
  expect(t.keys()).toEqual([K7])
  expect(t.w.state.get('github')).toMatchObject({ prs: { ok: true } })
})

test('lane: an in-process /resume into a session with no repo keeps its lane PRs: the carried default branch speaks for nothing', async () => {
  const REF1 = 'gh:github.com/acme/web#1'
  const t = laneRig({ created: [{ ...IAM, number: 657 }] })
  t.nodes['head:feat/x'] = [prNode({ number: 7, headRefName: 'feat/x', body: 'Part of #1' })]
  t.createdNodes['verticeone/vertice-iam'] = { 657: iamNode() }
  t.lane.request()
  await t.lane.idle()
  expect(t.items().map(i => i.key)).toEqual([K7, KIAM, REF1])
  expect(t.state().defaultBranch).toBe('main') // the lane state carries it over the resume
  // The resumed session has no repo, and tracks `main` only. Its stored lane PR and the refs of its body are not asked:
  // the reply cannot say they are gone (Codex review of #186).
  Object.assign(t.deps, { repo: async () => null })
  t.setFact({ seq: 2, reasons: ['resume'], branches: ['main'], overflow: 0 })
  t.lane.request()
  await t.lane.idle()
  expect(t.items().map(i => [i.key, i.lane])).toEqual([
    [K7, true],
    [KIAM, true],
    [REF1, undefined],
  ])
})

test('lane: created PRs are polled with no tracked branch, and without the note no-branches', async () => {
  const t = laneRig({ created: [{ ...IAM, number: 657 }] })
  t.createdNodes['verticeone/vertice-iam'] = { 657: iamNode() }
  t.setFact({ seq: 1, reasons: ['start'], branches: [], overflow: 0 })
  t.lane.request()
  await t.lane.idle()
  expect(t.log.gh).toHaveLength(1)
  expect(t.state().prs).toMatchObject({ ok: true })
  expect(t.items().map(i => i.key)).toEqual([KIAM])
  // No created PR, no branch: the note of before.
  const bare = laneRig()
  bare.setFact({ seq: 1, reasons: ['start'], branches: [], overflow: 0 })
  bare.lane.request()
  await bare.lane.idle()
  expect(bare.state().prs).toMatchObject({ ok: false, skipped: 'no-branches' })
})

test('lane: a conflicted created PR of another repo gets no worktree lookup; one of the session repo does', async () => {
  const t = laneRig({ created: [{ ...IAM, number: 657 }] })
  t.createdNodes['verticeone/vertice-iam'] = { 657: iamNode({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }) }
  t.lane.request()
  await t.lane.idle()
  expect(t.log.worktrees).toBe(0) // its head name is a branch of that repo, not of the session repo
  expect(t.state().merge).toEqual({ [KIAM]: {} })
  const own = laneRig({ created: [{ host: 'github.com', owner: 'acme', repo: 'web', number: 12 }] })
  own.createdNodes['acme/web'] = { 12: prNode({ number: 12, headRefName: 'feat/x', mergeable: 'CONFLICTING' }) }
  own.lane.request()
  await own.lane.idle()
  expect(own.log.worktrees).toBe(1)
  expect(own.state().merge).toEqual({ [K12]: { worktree: '/x/repo/wt' } })
})

test('lane: a dismissed created PR is not added again; another case of the session repo is the session repo', async () => {
  const t = laneRig({ created: [{ ...IAM, number: 657 }], dismissed: [KIAM] })
  t.createdNodes['verticeone/vertice-iam'] = { 657: iamNode() }
  t.lane.request()
  await t.lane.idle()
  expect(t.items()).toEqual([])
  const sessionOnly = laneRig({ created: [{ host: 'github.com', owner: 'ACME', repo: 'Web', number: 12 }] })
  sessionOnly.createdNodes['acme/web'] = { 12: prNode({ number: 12 }) }
  sessionOnly.lane.request()
  await sessionOnly.lane.idle()
  expect(sessionOnly.log.gh).toHaveLength(1)
  expect(sessionOnly.items().map(i => i.key)).toEqual([K12])
})

// Through the shipped trackers: the Bash result that created the PR is the proof, the lane asks for it, the pane lists it.

/** The lines of a section of the `/track` text, from its title to the next blank line. */
const sectionOf = (text: string, title: string): string[] =>
  text
    .split('\n\n')
    .find(block => block.startsWith(title))
    ?.split('\n') ?? []

test('lane: a gh pr create in another repo, and one in the session repo on an untracked branch, list in Pull requests', async () => {
  const t = shipped()
  t.created['verticeone/vertice-iam'] = { 657: iamNode() }
  t.created['acme/web'] = { 12: prNode({ number: 12, state: 'CLOSED', headRefName: 'feat/untracked-p2' }) }
  await t.start()
  await t.w.clock.advance(WINDOW)
  const make = (url: string, number: number) => createdPr(url, number)
  await t.call('Bash', { command: 'gh pr create --repo VerticeOne/vertice-iam' }, make(iamNode().url, 657))
  await t.call('Bash', { command: 'gh pr create --base main' }, make('https://github.com/acme/web/pull/12', 12))
  await t.w.clock.advance(WINDOW)
  await t.refresh()
  expect(t.keys().sort()).toEqual([K12, KIAM].sort())
  const text = (await t.m.track(t.w.ports, '')).text
  const prs = sectionOf(text, 'Pull requests')
  expect(prs.some(l => l.includes('VerticeOne/vertice-iam#657') && l.includes('feat/brown-2901'))).toBe(true)
  expect(prs.some(l => /^\s+#12\s/.test(l) && l.includes('feat/untracked-p2') && l.includes('closed'))).toBe(true)
  expect(sectionOf(text, 'GitHub')).toEqual([]) // neither is only a conversation item
  // The facts a later reader (a prompt, a priority rule) sees: the strongest reason is that the session created them.
  expect(t.items().map(i => i.reasons.strongest)).toEqual(['created', 'created'])
})

test('lane: a created PR on another GitHub Enterprise host reads the full URLs of its body that name that host', async () => {
  // The session is on github.com, so `github.hosts` does not list ghe.corp. The lane asked ghe.corp for the PR (gh is
  // logged in there), so a URL of that host in the body is an issue of it, not a web link (Codex review of #186).
  const GHE_PR = 'https://ghe.corp/team/svc/pull/3'
  const t = shipped()
  t.created['team/svc'] = {
    3: {
      ...prNode({ number: 3, headRefName: 'feat/ghe', body: 'Closes https://ghe.corp/team/svc/issues/5' }),
      url: GHE_PR,
    },
  }
  await t.start()
  await t.w.clock.advance(WINDOW)
  await t.call('Bash', { command: 'gh pr create' }, createdPr(GHE_PR, 3))
  await t.w.clock.advance(WINDOW)
  await t.refresh()
  expect(t.keys().sort()).toEqual(['gh:ghe.corp/team/svc#3', 'gh:ghe.corp/team/svc#5'])
})

test('lane: a created PR survives /clear: the proof is carried, so the next step still asks for it', async () => {
  const t = shipped()
  t.created['verticeone/vertice-iam'] = { 657: iamNode() }
  await t.start()
  await t.w.clock.advance(WINDOW)
  await t.call('Bash', { command: 'gh pr create' }, createdPr(iamNode().url, 657))
  await t.w.clock.advance(WINDOW)
  await t.refresh()
  expect(t.keys()).toEqual([KIAM])
  await t.m.end(t.w.ports, 'clear', 1500)
  const run = t.w.store.get('v2:run') as unknown as { pendingEnd: PendingEnd; run: { auto: AutoState } }
  expect(run.run.auto.prs?.map(p => p.number)).toEqual([657])
  t.m.watch.resumeFrom(run.pendingEnd)
  t.w.session.id = 'sess-2'
  t.w.state.delete('auto')
  t.w.state.delete('github')
  t.w.state.delete('items')
  const before = t.queries.length
  await t.m.entry(t.w.ports)
  await t.refresh()
  expect(t.queries.slice(before).some(q => q.includes('pullRequest(number: 657)'))).toBe(true)
  expect(t.keys()).toEqual([KIAM])
})

test('lane: a created PR survives an in-process /resume into a stored session: the proof is carried, so the PR stays in Pull requests', async () => {
  const t = shipped()
  t.created['verticeone/vertice-iam'] = { 657: iamNode() }
  await t.start()
  await t.w.clock.advance(WINDOW)
  await t.call('Bash', { command: 'gh pr create' }, createdPr(iamNode().url, 657))
  await t.w.clock.advance(WINDOW)
  await t.refresh()
  expect(t.keys()).toEqual([KIAM])
  await t.m.end(t.w.ports, 'resume', 1500)
  // The resumed session has a stored copy: the one this session left, so the PR comes back as a record that has `created`
  // and no `discovered`, and no step has found it yet.
  const stored = t.w.store.get('v2:s:sess-1')
  expect(stored).toBeDefined()
  t.w.store.set('v2:s:sess-2', stored as never)
  t.w.session.id = 'sess-2'
  t.w.state.delete('auto') // the engine resets the state of a resumed session
  t.w.state.delete('github')
  t.w.state.delete('items')
  const before = t.queries.length
  await t.m.entry(t.w.ports)
  expect((t.items() as unknown as GitHubRecord[]).map(r => isLanePr(r))).toEqual([false])
  await t.refresh()
  // The `auto` slot was carried with its proof: the next step asks for the PR by number and the lane marker is back.
  expect(t.queries.slice(before).some(q => q.includes('pullRequest(number: 657)'))).toBe(true)
  expect((t.items() as unknown as GitHubRecord[]).map(r => [r.key, isLanePr(r)])).toEqual([[KIAM, true]])
  const text = (await t.m.track(t.w.ports, '')).text
  expect(sectionOf(text, 'Pull requests').some(l => l.includes('VerticeOne/vertice-iam#657'))).toBe(true)
  expect(sectionOf(text, 'GitHub')).toEqual([])
})
