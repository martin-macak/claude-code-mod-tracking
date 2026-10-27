// The PR lane and the merge state (issue #50): the notes a step keeps for CONFLICTING and UNKNOWN PRs, the one git call
// that finds the worktrees, and the extra steps for a PR that GitHub still calls UNKNOWN. The lane over plain closures.
import { expect, test } from 'claude-code/testing'
import type { StoredItem } from '../core/interfaces/items'
import type { RepoRef } from '../core/interfaces/ports'
import { parsePorcelain } from '../core/lib/porcelain'
import { PR_LANE_DEFAULTS } from '../trackers/github/config'
import { EMPTY_LANE, type LaneDeps, PrLane } from '../trackers/github/lane'
import { mergeChip, RETRY_MS, UNKNOWN_SPENT } from '../trackers/github/merge'
import type {
  BranchesFact,
  GitHubDiscoveryApi,
  GitHubRecord,
  GraphqlOutcome,
  LaneState,
} from '../trackers/github/types'
import { discoveryData, prNode } from './fixtures/gh-discovery'
import { LIMITS } from './fixtures/limits'
import { scanBody } from './fixtures/refs'
import { buildRecord, capTo } from './fixtures/registry'

const REPO: RepoRef = { host: 'github.com', owner: 'acme', repo: 'web' }
const K7 = 'gh:github.com/acme/web#7'
const K8 = 'gh:github.com/acme/web#8'
const NOW = 5_000_000
const FACT: BranchesFact = { seq: 1, reasons: ['start'], branches: ['main', 'feat/a', 'feat/b'], overflow: 0 }

type Timer = { ms: number; fn: () => void; cancelled: boolean }

/** Aliased replies from `nodes`, by `head:<branch>`, as the lane asks for them. */
function reply(q: string, nodes: Record<string, unknown[]>): GraphqlOutcome {
  const data: Record<string, unknown[]> = {}
  for (const m of q.matchAll(/(([hb])\d+): pullRequests\((head|base)RefName: ("(?:[^"\\]|\\.)*")/g))
    data[m[1]!] = nodes[`${m[3]}:${JSON.parse(m[4]!) as string}`] ?? []
  return { ok: true, reply: { data: discoveryData(data, 'main'), errors: [] } }
}

function rig(o: { dismissed?: string[]; porcelain?: string | null | 'throw' } = {}) {
  const log = { gh: 0, git: 0, saves: 0 }
  const nodes: Record<string, unknown[]> = {}
  const timers: Timer[] = []
  let state: LaneState = EMPTY_LANE
  let items: StoredItem[] = []
  let outcome: GraphqlOutcome | undefined
  let porcelain: string | null | 'throw' = o.porcelain ?? null
  const gh = {
    isAvailable: true,
    canCall: () => true,
    status: () => ({ name: 'gh', available: true, loggedIn: true, breaker: 'closed' }),
    checkHost: async () => true,
    graphql: async (_host: string, q: string): Promise<GraphqlOutcome> => {
      log.gh++
      return outcome ?? reply(q, nodes)
    },
  } as unknown as GitHubDiscoveryApi
  const deps: LaneDeps = {
    now: () => NOW,
    load: async () => state,
    save: async change => {
      const next = change(state)
      if (next !== state) {
        state = next
        log.saves++
      }
      return state
    },
    branches: () => FACT,
    gh,
    ghReady: async () => true,
    repo: async () => REPO,
    scanBody,
    build: buildRecord,
    applyItems: async change => {
      const r = change(items, new Set(o.dismissed ?? []))
      items = r.list
      return r
    },
    onAdded: () => {},
    lane: () => PR_LANE_DEFAULTS,
    caps: () => ({ staleMs: LIMITS.staleMs, cap: capTo(LIMITS.maxItems) }),
    worktrees: async () => {
      log.git++
      if (porcelain === 'throw') throw new Error('git broke')
      return porcelain === null ? null : parsePorcelain(porcelain)
    },
    after: (ms, fn) => {
      const t: Timer = { ms, fn, cancelled: false }
      timers.push(t)
      return {
        cancel() {
          t.cancelled = true
        },
      }
    },
  }
  const lane = new PrLane(deps)
  /** Fires the timer that is due, as the host does, and waits for the step it asks for. */
  const fire = async (): Promise<number> => {
    const due = timers.filter(t => !t.cancelled)
    const t = due[due.length - 1]
    if (!t) throw new Error('no timer is pending')
    t.cancelled = true
    t.fn()
    await lane.idle()
    return t.ms
  }
  const pending = () => timers.filter(t => !t.cancelled).map(t => t.ms)
  const step = async () => {
    lane.request()
    await lane.idle()
  }
  return {
    deps,
    lane,
    log,
    nodes,
    fire,
    pending,
    step,
    state: () => state,
    items: () => items,
    setPorcelain: (p: string | null | 'throw') => {
      porcelain = p
    },
    setOutcome: (v: GraphqlOutcome | undefined) => {
      outcome = v
    },
    timers,
  }
}

const tree = (branch: string, path: string) => `worktree ${path}\nHEAD abc\nbranch refs/heads/${branch}\n\n`
const MAIN_TREE = tree('main', '/x/repo')

const open = (number: number, head: string, mergeable?: string) =>
  prNode({ number, headRefName: head, ...(mergeable ? { mergeable, mergeStateStatus: 'DIRTY' } : {}) })

/** A reply that GitHub cut short: the alias of feat/a failed, so the reply holds no PR of that branch. */
const PARTIAL_REPLY: GraphqlOutcome = {
  ok: true,
  reply: {
    data: { rateLimit: { cost: 1, remaining: 1 }, repository: { defaultBranchRef: { name: 'main' }, h0: null } },
    errors: [{ path: ['repository', 'h0'], message: 'timeout' }],
  },
}

// ---------------------------------------------------------------- AC4: the UNKNOWN retries

test('AC4: a PR that GitHub calls UNKNOWN is asked again after 3 s, 6 s and 12 s, and then left to the tick', async () => {
  const t = rig()
  t.nodes['head:feat/a'] = [open(7, 'feat/a', 'UNKNOWN')]
  await t.step()
  expect(t.log.gh).toBe(1)
  expect(t.state().merge).toEqual({ [K7]: { unknown: 1 } })
  expect(t.pending()).toEqual([3000])

  expect(await t.fire()).toBe(3000)
  expect(t.log.gh).toBe(2)
  expect(t.pending()).toEqual([6000])

  expect(await t.fire()).toBe(6000)
  expect(t.log.gh).toBe(3)
  expect(t.pending()).toEqual([12000])

  expect(await t.fire()).toBe(12000)
  expect(t.log.gh).toBe(4)
  expect(t.state().merge).toEqual({ [K7]: { unknown: UNKNOWN_SPENT } }) // the row now reads ? merge
  expect(t.pending()).toEqual([]) // no fifth look

  await t.step() // the normal tick still polls, and asks for nothing more
  expect(t.log.gh).toBe(5)
  expect(t.pending()).toEqual([])
  expect(t.state().merge).toEqual({ [K7]: { unknown: UNKNOWN_SPENT } })
})

test('AC4: a PR that GitHub calls UNKNOWN and that partial replies leave out gets 3 retries at most, then reads ? merge', async () => {
  const t = rig()
  const chip = () =>
    mergeChip(t.items()[0] as unknown as GitHubRecord, { fresh: true, notes: t.state().merge ?? {}, now: NOW })
  t.nodes['head:feat/a'] = [open(7, 'feat/a', 'UNKNOWN')]
  await t.step()
  expect(t.state().merge).toEqual({ [K7]: { unknown: 1 } })
  expect(t.pending()).toEqual([3000])
  expect(chip()).toBeNull() // the retries are not spent: no chip yet

  t.setOutcome(PARTIAL_REPLY) // from now on the alias of feat/a fails, and no reply holds #7
  expect(await t.fire()).toBe(3000)
  expect(t.pending()).toEqual([6000]) // not 3000 again: the kept note counts the look
  expect(await t.fire()).toBe(6000)
  expect(t.pending()).toEqual([12000])
  expect(await t.fire()).toBe(12000)
  expect(t.log.gh).toBe(4) // the first look and three retries
  expect(t.state().merge).toEqual({ [K7]: { unknown: UNKNOWN_SPENT } })
  expect(t.pending()).toEqual([]) // no fourth retry
  expect(chip()).toEqual({ text: '? merge', tone: 'dim' })

  await t.step() // the normal tick still asks, gets no #7 again, and sets no timer
  await t.step()
  expect(t.log.gh).toBe(6)
  expect(t.state().merge).toEqual({ [K7]: { unknown: UNKNOWN_SPENT } })
  expect(t.pending()).toEqual([])
  expect(t.timers.filter(x => !x.cancelled)).toHaveLength(0)
})

test('AC4: the delays are the ones the module names', () => {
  expect(RETRY_MS).toEqual([3000, 6000, 12000])
})

test('AC4: a PR that turns CONFLICTING on a retry ends the retries and keeps its note', async () => {
  const t = rig({ porcelain: MAIN_TREE + tree('feat/a', '/x/wt-a') })
  t.nodes['head:feat/a'] = [open(7, 'feat/a', 'UNKNOWN')]
  await t.step()
  t.nodes['head:feat/a'] = [open(7, 'feat/a', 'CONFLICTING')]
  await t.fire()
  expect(t.state().merge).toEqual({ [K7]: { worktree: '/x/wt-a' } })
  expect(t.pending()).toEqual([])
})

test('AC4: a PR that turns MERGEABLE on a retry has no note left, and the cap starts again for a later push', async () => {
  const t = rig()
  t.nodes['head:feat/a'] = [open(7, 'feat/a', 'UNKNOWN')]
  await t.step()
  t.nodes['head:feat/a'] = [open(7, 'feat/a', 'MERGEABLE')]
  await t.fire()
  expect(t.state().merge).toBeUndefined()
  expect(t.pending()).toEqual([])
  t.nodes['head:feat/a'] = [open(7, 'feat/a', 'UNKNOWN')] // a new push
  await t.step()
  expect(t.state().merge).toEqual({ [K7]: { unknown: 1 } })
  expect(t.pending()).toEqual([3000])
})

test('a step with no UNKNOWN PR sets no timer; one that clears the last UNKNOWN PR cancels the timer', async () => {
  const t = rig()
  t.nodes['head:feat/a'] = [open(7, 'feat/a', 'MERGEABLE')]
  await t.step()
  expect(t.timers).toHaveLength(0)
  t.nodes['head:feat/a'] = [open(7, 'feat/a', 'UNKNOWN')]
  await t.step()
  expect(t.pending()).toEqual([3000])
  t.nodes['head:feat/a'] = [open(7, 'feat/a', 'MERGEABLE')] // the tick got there first
  await t.step()
  expect(t.pending()).toEqual([])
})

test('one timer at a time: a step that runs while a retry waits does not arm a second one', async () => {
  const t = rig()
  t.nodes['head:feat/a'] = [open(7, 'feat/a', 'UNKNOWN')]
  await t.step()
  await t.step()
  expect(t.timers.filter(x => !x.cancelled)).toHaveLength(1)
})

test('the PR that was asked least decides the delay; a PR with no UNKNOWN counts for nothing', async () => {
  const t = rig()
  t.nodes['head:feat/a'] = [open(7, 'feat/a', 'UNKNOWN')]
  await t.step()
  await t.fire() // #7 is on its second look
  t.nodes['head:feat/b'] = [open(8, 'feat/b', 'UNKNOWN'), open(9, 'feat/b', 'MERGEABLE')]
  await t.step() // a tick: #7 third look, #8 first
  expect(t.state().merge).toEqual({ [K7]: { unknown: 3 }, [K8]: { unknown: 1 } })
  expect(t.pending()).toEqual([3000]) // #8 has had the fewest looks
})

test('a lane built with no timer still keeps the notes and asks for no retry', async () => {
  const t = rig()
  const bare = new PrLane({ ...t.deps, after: undefined })
  t.nodes['head:feat/a'] = [open(7, 'feat/a', 'UNKNOWN')]
  bare.request()
  await bare.idle()
  expect(t.state().merge).toEqual({ [K7]: { unknown: 1 } })
  expect(t.timers).toHaveLength(0)
})

test('a failed discovery keeps the notes and arms no timer', async () => {
  const t = rig()
  t.nodes['head:feat/a'] = [open(7, 'feat/a', 'UNKNOWN')]
  await t.step()
  await t.fire()
  expect(t.state().merge).toEqual({ [K7]: { unknown: 2 } })
  t.setOutcome({ ok: false, kind: 'transport', error: 'timeout' })
  await t.step()
  expect(t.state().prs).toMatchObject({ ok: false })
  expect(t.state().merge).toEqual({ [K7]: { unknown: 2 } })
  expect(t.pending()).toEqual([6000]) // the one that was already armed still stands
})

test('a dismissed PR gets no note and no retry', async () => {
  const t = rig({ dismissed: [K7] })
  t.nodes['head:feat/a'] = [open(7, 'feat/a', 'UNKNOWN')]
  await t.step()
  expect(t.state().merge).toBeUndefined()
  expect(t.timers).toHaveLength(0)
})

test('an incomplete reply keeps the notes of the PRs it left out', async () => {
  const t = rig({ porcelain: MAIN_TREE + tree('feat/a', '/x/wt-a') })
  t.nodes['head:feat/a'] = [open(7, 'feat/a', 'CONFLICTING')]
  await t.step()
  await t.deps.save(cur => ({ ...cur, merge: { [K7]: { ...cur.merge![K7], queuedAt: NOW } } }))
  // The alias of feat/a fails: the reply is incomplete and does not hold #7.
  t.setOutcome(PARTIAL_REPLY)
  await t.step()
  expect(t.state().merge).toEqual({ [K7]: { worktree: '/x/wt-a', queuedAt: NOW } })
  t.setOutcome(undefined) // a complete reply that has no PR #7 any more
  t.nodes['head:feat/a'] = []
  await t.step()
  expect(t.state().merge).toBeUndefined()
})

test('a merged PR that GitHub calls UNKNOWN gets no note: only an open PR is asked again', async () => {
  const t = rig()
  t.nodes['head:feat/a'] = [prNode({ number: 7, headRefName: 'feat/a', state: 'MERGED', mergeable: 'UNKNOWN' })]
  await t.step()
  expect(t.state().merge).toBeUndefined()
  expect(t.timers).toHaveLength(0)
})

// ---------------------------------------------------------------- AC10: the worktree of the head branch

test('a CONFLICTING PR notes the worktree that has its head branch; git runs once for any number of conflicts', async () => {
  const t = rig({ porcelain: MAIN_TREE + tree('feat/a', '/x/wt-a') + tree('feat/b', '/x/wt-b') })
  t.nodes['head:feat/a'] = [open(7, 'feat/a', 'CONFLICTING')]
  t.nodes['head:feat/b'] = [open(8, 'feat/b', 'CONFLICTING'), open(9, 'feat/b', 'MERGEABLE')]
  await t.step()
  expect(t.log.git).toBe(1)
  expect(t.state().merge).toEqual({ [K7]: { worktree: '/x/wt-a' }, [K8]: { worktree: '/x/wt-b' } })
})

test('AC10: a CONFLICTING PR whose head branch no worktree has checked out has a note with no worktree', async () => {
  const t = rig({ porcelain: MAIN_TREE })
  t.nodes['head:feat/a'] = [open(7, 'feat/a', 'CONFLICTING')]
  await t.step()
  expect(t.state().merge).toEqual({ [K7]: {} })
})

test('M3: a fork PR gets no worktree, even when a local branch has the name of its head; git is not run for it alone', async () => {
  // The head of a fork PR is a branch of the fork. A fork PR reaches the lane through the base alias of a tracked branch.
  const fork = prNode({
    number: 7,
    headRefName: 'feat/b',
    baseRefName: 'feat/a',
    isCrossRepository: true,
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY',
  })
  const alone = rig({ porcelain: MAIN_TREE + tree('feat/b', '/x/wt-b') })
  alone.nodes['base:feat/a'] = [fork]
  await alone.step()
  expect(alone.log.git).toBe(0)
  expect(alone.state().merge).toEqual({ [K7]: {} })
  // Beside a PR of this repo with the same head name, git runs once, and only that PR gets the worktree.
  const both = rig({ porcelain: MAIN_TREE + tree('feat/b', '/x/wt-b') })
  both.nodes['base:feat/a'] = [fork]
  both.nodes['head:feat/b'] = [open(8, 'feat/b', 'CONFLICTING')]
  await both.step()
  expect(both.log.git).toBe(1)
  expect(both.state().merge).toEqual({ [K7]: {}, [K8]: { worktree: '/x/wt-b' } })
})

test('git that fails or cannot say gives a note with no worktree, and never fails the step', async () => {
  for (const porcelain of [null, 'throw'] as const) {
    const t = rig({ porcelain })
    t.nodes['head:feat/a'] = [open(7, 'feat/a', 'CONFLICTING')]
    await t.step()
    expect(t.state().prs).toMatchObject({ ok: true })
    expect(t.state().merge).toEqual({ [K7]: {} })
  }
})

test('git is not run when no open PR is CONFLICTING, and a lane with no worktree lookup notes none', async () => {
  const t = rig({ porcelain: MAIN_TREE })
  t.nodes['head:feat/a'] = [open(7, 'feat/a', 'MERGEABLE'), open(8, 'feat/a', 'UNKNOWN')]
  await t.step()
  expect(t.log.git).toBe(0)
  const none = rig()
  const bare = new PrLane({ ...none.deps, worktrees: undefined })
  none.nodes['head:feat/a'] = [open(7, 'feat/a', 'CONFLICTING')]
  bare.request()
  await bare.idle()
  expect(none.state().merge).toEqual({ [K7]: {} })
})

// ---------------------------------------------------------------- A22 and what the person did

test('a quiet step writes nothing (A22): the same reply leaves the lane state as it is', async () => {
  const t = rig({ porcelain: MAIN_TREE + tree('feat/a', '/x/wt-a') })
  t.nodes['head:feat/a'] = [open(7, 'feat/a', 'CONFLICTING')]
  await t.step()
  const saves = t.log.saves
  const before = t.state()
  await t.step()
  expect(t.log.saves).toBe(saves)
  expect(t.state()).toBe(before)
})

test('what the person did stays through a step while the PR stays CONFLICTING, and goes when it changes', async () => {
  const t = rig({ porcelain: MAIN_TREE + tree('feat/a', '/x/wt-a') })
  t.nodes['head:feat/a'] = [open(7, 'feat/a', 'CONFLICTING')]
  await t.step()
  // The press lands in the lane state between two steps.
  await t.deps.save(cur => ({
    ...cur,
    merge: { [K7]: { ...cur.merge![K7], queuedAt: NOW, files: { at: NOW, files: ['a.ts'] } } },
  }))
  await t.step()
  expect(t.state().merge).toEqual({ [K7]: { worktree: '/x/wt-a', queuedAt: NOW, files: { at: NOW, files: ['a.ts'] } } })
  t.nodes['head:feat/a'] = [open(7, 'feat/a', 'UNKNOWN')] // the PR changed
  await t.step()
  expect(t.state().merge).toEqual({ [K7]: { unknown: 1 } })
})
