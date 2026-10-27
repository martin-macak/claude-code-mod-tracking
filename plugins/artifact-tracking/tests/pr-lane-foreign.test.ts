// The PR lane over the branches of other repos (issue #195). Three layers: the reader of the fact `repos.branches`; the lane
// alone, over a fake `gh` that answers each repo; and the shipped trackers through a LifecycleManager, from a Read of a file
// in a second repo to the row in Pull requests.
import { expect, test } from 'claude-code/testing'
import type { Json, StoredItem } from '../core/interfaces/items'
import type { RepoRef } from '../core/interfaces/ports'
import { TRACKERS } from '../trackers'
import { PR_LANE_DEFAULTS } from '../trackers/github/config'
import { foreignOf } from '../trackers/github/facts'
import { EMPTY_LANE, type LaneDeps, PrLane } from '../trackers/github/lane'
import { isLanePr } from '../trackers/github/lane-pr'
import type {
  BranchesFact,
  ForeignRepo,
  GitHubRecord,
  GraphqlOutcome,
  LaneState,
  PrRef,
} from '../trackers/github/types'
import { discoveryData, foreignNode, perRepoGh, prNode, type RepoNodes } from './fixtures/gh-discovery'
import { res } from './fixtures/items'
import { LIMITS } from './fixtures/limits'
import { managerWorld } from './fixtures/manager'
import { scanBody } from './fixtures/refs'
import { buildRecord, capTo } from './fixtures/registry'

declare function setTimeout(fn: () => void, ms: number): unknown

const SESSION: RepoRef = { host: 'github.com', owner: 'acme', repo: 'web' }
const FOREIGN: RepoRef = { host: 'github.com', owner: 'Acme-Org', repo: 'Foreign-Repo' }
const GHE: RepoRef = { host: 'ghe.corp', owner: 'team', repo: 'svc' }
const K7 = 'gh:github.com/acme/web#7'
const K31 = 'gh:github.com/acme-org/foreign-repo#31'
const K32 = 'gh:github.com/acme-org/foreign-repo#32'
const K40 = 'gh:github.com/acme-org/foreign-repo#40'
const KGHE = 'gh:ghe.corp/team/svc#5'
const I501 = 'gh:github.com/acme-org/foreign-repo#501'
const I502 = 'gh:github.com/acme-org/foreign-repo#502'

// ---------------------------------------------------------------- the reader of the fact

test('foreignOf reads the fact repos.branches: whole entries only, and the overflow', () => {
  const ok = { host: 'github.com', owner: 'o', repo: 'r', branches: ['feat/a', 'feat/b'] }
  expect(foreignOf({ repos: [ok], overflow: 2 } as unknown as Json)).toEqual({ repos: [ok], overflow: 2 })
  const bad = [
    null,
    7,
    { ...ok, host: '' },
    { ...ok, owner: 3 },
    { ...ok, repo: undefined },
    { ...ok, branches: [] },
    { ...ok, branches: ['a', 4] },
    { ...ok, branches: 'a' },
  ]
  expect(foreignOf({ repos: [...bad, ok], overflow: -1 } as unknown as Json)).toEqual({ repos: [ok], overflow: 0 })
  expect(foreignOf({ repos: [ok], overflow: 'x' } as unknown as Json).overflow).toBe(0)
  for (const v of [undefined, null, 'x', [], { repos: 'x' }, { overflow: 1 }])
    expect(foreignOf(v as unknown as Json).repos).toEqual([])
  expect(foreignOf({ overflow: 3 } as unknown as Json)).toEqual({ repos: [], overflow: 3 })
})

// ---------------------------------------------------------------- the lane alone

/**
 * A lane over plain closures, and a gh that answers per repo (lower-case `owner/repo`). A repo not listed is `repository: null`.
 * The session repo is `SESSION` and its tracked branch `feat/x`, unless `repo` (null: none) and `branches` say otherwise.
 */
function rig(
  o: {
    foreign?: ForeignRepo[]
    created?: PrRef[]
    authed?: (host: string) => boolean
    repo?: RepoRef | null
    branches?: string[]
  } = {},
) {
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = []
  const repos: Record<string, RepoNodes> = {}
  const fail: Record<string, GraphqlOutcome | undefined> = {}
  const broken: Record<string, string[]> = {}
  const log = { saves: 0, itemWrites: 0 }
  let items: StoredItem[] = []
  let state: LaneState = EMPTY_LANE
  let foreign = o.foreign ?? []
  let session: RepoRef | null = o.repo === undefined ? SESSION : o.repo
  const fact: BranchesFact = { seq: 1, reasons: ['start'], branches: o.branches ?? ['feat/x'], overflow: 0 }
  const { gh, calls } = perRepoGh({ repos, fail, broken, ...(o.authed ? { authed: o.authed } : {}) })
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
    created: () => o.created ?? [],
    foreign: () => foreign,
    gh: gh as unknown as LaneDeps['gh'],
    ghReady: async () => true,
    repo: async () => session,
    scanBody,
    build: buildRecord,
    applyItems: async change => {
      const r = change(items, new Set())
      if (r.list !== items) log.itemWrites++
      items = r.list
      return r
    },
    onAdded: () => {},
    lane: () => PR_LANE_DEFAULTS,
    caps: () => ({ staleMs: LIMITS.staleMs, cap: capTo(LIMITS.maxItems) }),
    after: (ms, fn) => {
      const t = { ms, fn, cancelled: false }
      timers.push(t)
      return {
        cancel() {
          t.cancelled = true
        },
      }
    },
  }
  const lane = new PrLane(deps)
  const step = async () => {
    lane.request()
    await lane.idle()
  }
  return {
    repos,
    fail,
    broken,
    calls,
    log,
    timers,
    step,
    items: () => items as unknown as GitHubRecord[],
    state: () => state,
    setForeign: (f: ForeignRepo[]) => {
      foreign = f
    },
    /** The session repo of the next step: null is a session in a git repository with no GitHub remote. */
    setRepo: (r: RepoRef | null) => {
      session = r
    },
    /** The tracked branches of the session repo, as the next fact says them. */
    setBranches: (b: string[]) => {
      fact.branches = b
    },
  }
}

const session7 = { heads: { 'head:feat/x': [prNode({ number: 7, headRefName: 'feat/x' })] } }
const foreign31 = { heads: { 'head:feat/one': [foreignNode(31, 'feat/one')] } }

test('lane: a PR on a proven branch of a foreign repo lists with the lane marker, the case of its repo and otherRepo (AC1)', async () => {
  const t = rig({ foreign: [{ ...FOREIGN, branches: ['feat/one'] }] })
  t.repos['acme/web'] = session7
  t.repos['acme-org/foreign-repo'] = foreign31
  await t.step()
  const rec = t.items().find(i => i.key === K31)
  expect(rec).toMatchObject({ key: K31, owner: 'Acme-Org', repo: 'Foreign-Repo', lane: true, otherRepo: true })
  expect(rec?.reasons.all).toEqual(['discovered']) // the session did not create it
  expect(isLanePr(rec as GitHubRecord)).toBe(true)
  expect(t.state().prs).toMatchObject({ ok: true })
})

test('lane: one query per repo, with the proven branches and the created PRs of that repo in it (AC2)', async () => {
  const t = rig({
    foreign: [{ ...FOREIGN, branches: ['feat/one', 'feat/two'] }],
    created: [{ ...FOREIGN, number: 40 }],
  })
  t.repos['acme/web'] = {}
  t.repos['acme-org/foreign-repo'] = {
    heads: { 'head:feat/one': [foreignNode(31, 'feat/one')] },
    numbers: { 40: foreignNode(40, 'feat/elsewhere') },
  }
  await t.step()
  expect(t.calls.map(c => c.repo)).toEqual(['acme/web', 'acme-org/foreign-repo'])
  const q = t.calls[1]!.query
  expect(q).toContain('h0: pullRequests(headRefName: "feat/one"')
  expect(q).toContain('h1: pullRequests(headRefName: "feat/two"')
  expect(q).toContain('p0: pullRequest(number: 40)')
  expect(t.items().map(i => [i.key, i.lane, i.reasons.all])).toEqual([
    [K31, true, ['discovered']],
    [K40, true, ['created', 'discovered']],
  ])
})

const outcomes: [string, GraphqlOutcome][] = [
  ['a transport error', { ok: false, kind: 'transport', error: 'timeout' }],
  [
    'a repository that is null',
    { ok: true, reply: { data: { repository: null }, errors: [{ type: 'NOT_FOUND', path: ['repository'] }] } },
  ],
  ['an auth error', { ok: false, kind: 'auth' }],
  ['a paused tool', { ok: false, kind: 'blocked' }],
]

for (const [what, outcome] of outcomes) {
  test(`lane: ${what} in a foreign repo holds its lane PRs over steps and does not stop the prune of the session repo (AC3)`, async () => {
    const t = rig({ foreign: [{ ...FOREIGN, branches: ['feat/one'] }] })
    t.repos['acme/web'] = { heads: { 'head:feat/x': [prNode({ number: 7, headRefName: 'feat/x' })] } }
    t.repos['acme-org/foreign-repo'] = foreign31
    await t.step()
    expect(t.items().map(i => [i.key, i.lane])).toEqual([
      [K7, true],
      [K31, true],
    ])
    delete t.repos['acme/web']!.heads!['head:feat/x'] // #7 leaves the session repo
    t.fail['acme-org/foreign-repo'] = outcome
    for (let i = 0; i < 3; i++) {
      await t.step()
      expect(t.items().map(r => [r.key, r.lane])).toEqual([[K31, true]]) // #7 pruned, #31 held
      expect(t.items()[0]?.reasons.all).toEqual(['discovered'])
      expect(t.state().prs).toMatchObject({ ok: true })
      expect(t.state().prs.error).toBeUndefined() // silent: the note does not change (#222 names the host)
    }
    // The repo answers again, and #31 is not on its branch any more: now it goes.
    t.fail['acme-org/foreign-repo'] = undefined
    t.repos['acme-org/foreign-repo'] = { heads: {} }
    await t.step()
    expect(t.items()).toEqual([])
  })
}

test('lane: a PR of a foreign host that gh stops being logged in to stays listed, and the host is not asked (AC3)', async () => {
  let authed = true
  const t = rig({ foreign: [{ ...GHE, branches: ['feat/g'] }], authed: () => authed })
  t.repos['acme/web'] = {}
  t.repos['team/svc'] = {
    heads: {
      'head:feat/g': [{ ...prNode({ number: 5, headRefName: 'feat/g' }), url: 'https://ghe.corp/team/svc/pull/5' }],
    },
  }
  await t.step()
  expect(t.items().map(i => i.key)).toEqual([KGHE])
  expect(t.calls.map(c => c.repo)).toEqual(['acme/web', 'team/svc'])
  authed = false
  await t.step()
  expect(t.calls.map(c => c.repo)).toEqual(['acme/web', 'team/svc', 'acme/web']) // the refused host is asked nothing
  expect(t.items().map(i => i.key)).toEqual([KGHE]) // held, not pruned
  expect(t.state().prs).toMatchObject({ ok: true })
  expect(t.state().prs.error).toBeUndefined()
})

test('lane: a held foreign PR keeps its merge note; a dropped branch of an answering repo takes the PR away', async () => {
  const t = rig({ foreign: [{ ...FOREIGN, branches: ['feat/one'] }] })
  t.repos['acme/web'] = {}
  t.repos['acme-org/foreign-repo'] = {
    heads: { 'head:feat/one': [foreignNode(31, 'feat/one', { mergeable: 'CONFLICTING' })] },
  }
  await t.step()
  expect(Object.keys(t.state().merge ?? {})).toEqual([K31])
  t.fail['acme-org/foreign-repo'] = { ok: false, kind: 'transport' }
  await t.step()
  expect(Object.keys(t.state().merge ?? {})).toEqual([K31])
  t.fail['acme-org/foreign-repo'] = undefined
  t.setForeign([{ ...FOREIGN, branches: ['feat/other'] }]) // the session moved to another branch of the repo
  await t.step()
  expect(t.items()).toEqual([])
  expect(t.state().merge).toBeUndefined()
})

test('lane: a foreign PR that was read keeps no stale issue while another branch of its repo fails; that branch keeps its PR and issue', async () => {
  const t = rig({ foreign: [{ ...FOREIGN, branches: ['feat/one', 'feat/two'] }] })
  t.repos['acme/web'] = {}
  const withBody = (n: number, head: string, issue: number) =>
    foreignNode(n, head, { body: `Closes Acme-Org/Foreign-Repo#${issue}` })
  t.repos['acme-org/foreign-repo'] = {
    heads: { 'head:feat/one': [withBody(31, 'feat/one', 501)], 'head:feat/two': [withBody(32, 'feat/two', 502)] },
  }
  await t.step()
  expect(t.items().map(i => i.key)).toEqual([K31, K32, I501, I502])
  // #31 is edited and names no issue now. The query for `feat/two` (alias h1) gets an error: #32 is not read, and its repo is held.
  t.repos['acme-org/foreign-repo']!.heads!['head:feat/one'] = [foreignNode(31, 'feat/one', { body: 'no issue' })]
  t.broken['acme-org/foreign-repo'] = ['h1']
  await t.step()
  // The issue of the body that was read goes. #32 got no sure answer: it keeps its marker, and so does its issue.
  expect(t.items().map(i => [i.key, i.lane])).toEqual([
    [K31, true],
    [K32, true],
    [I502, undefined],
  ])
  expect(t.state().prs).toMatchObject({ ok: true })
})

test('lane: a repo that leaves the fact (dismissed, over the cap) loses its lane PRs at the next complete step', async () => {
  const t = rig({ foreign: [{ ...FOREIGN, branches: ['feat/one'] }] })
  t.repos['acme/web'] = {}
  t.repos['acme-org/foreign-repo'] = foreign31
  await t.step()
  expect(t.items().map(i => i.key)).toEqual([K31])
  t.setForeign([])
  await t.step()
  expect(t.items()).toEqual([])
})

/** A foreign PR that closes the issue #501 of its repo and conflicts, so it has a body ref and a merge note. */
const foreign31Conflicting = {
  heads: {
    'head:feat/one': [
      foreignNode(31, 'feat/one', { body: 'Closes Acme-Org/Foreign-Repo#501', mergeable: 'CONFLICTING' }),
    ],
  },
}

test('lane: the last proof of a foreign repo going away prunes its PR, its body refs and its note, with no branch and no repo (issue #195, Codex P2)', async () => {
  // A session started outside a git repository: the proven branch of the foreign repo is the lane's only input.
  const t = rig({ repo: null, branches: [], foreign: [{ ...FOREIGN, branches: ['feat/one'] }] })
  t.repos['acme-org/foreign-repo'] = foreign31Conflicting
  await t.step()
  expect(t.items().map(i => [i.key, i.lane])).toEqual([
    [K31, true],
    [I501, undefined],
  ])
  expect(Object.keys(t.state().merge ?? {})).toEqual([K31])
  // The last Repos row is dismissed, `pollRepos` is 0, or the only visited worktree is detached: the fact is empty.
  t.setForeign([])
  await t.step()
  expect(t.items()).toEqual([])
  expect(t.state().merge).toBeUndefined()
  expect(t.state().prs).toMatchObject({ ok: false, skipped: 'no-branches' }) // nothing was asked: the note of before
  expect(t.calls.map(c => c.repo)).toEqual(['acme-org/foreign-repo']) // and nothing was asked of GitHub
  // The next step has nothing left to reconcile: it writes nothing.
  const writes = t.log.itemWrites
  const saves = t.log.saves
  await t.step()
  expect([t.log.itemWrites, t.log.saves]).toEqual([writes, saves])
})

test('lane: the last proof going away leaves the lane PRs of the session repo and their notes alone, with no tracked branch', async () => {
  const t = rig({ foreign: [{ ...FOREIGN, branches: ['feat/one'] }] })
  t.repos['acme/web'] = {
    heads: {
      'head:feat/x': [prNode({ number: 7, headRefName: 'feat/x', body: 'Closes #8', mergeable: 'CONFLICTING' })],
    },
  }
  t.repos['acme-org/foreign-repo'] = foreign31Conflicting
  await t.step()
  const I8 = 'gh:github.com/acme/web#8'
  expect(t.items().map(i => i.key)).toEqual([K7, K31, I8, I501])
  expect(Object.keys(t.state().merge ?? {})).toEqual([K7, K31])
  // The session stands on its default branch now (no tracked branch), and the last foreign proof is gone.
  t.setBranches([])
  t.setForeign([])
  await t.step()
  // The step asks nothing, so it says nothing of #7: its marker, its issue and its note stay. The foreign PR and its issue go.
  expect(t.items().map(i => [i.key, i.lane])).toEqual([
    [K7, true],
    [I8, undefined],
  ])
  expect(Object.keys(t.state().merge ?? {})).toEqual([K7])
  expect(t.calls.map(c => c.repo)).toEqual(['acme/web', 'acme-org/foreign-repo'])
})

test('lane: the last proof going away prunes the foreign PR when the session has branches but no GitHub repo', async () => {
  const t = rig({ repo: null, branches: ['feat/x'], foreign: [{ ...FOREIGN, branches: ['feat/one'] }] })
  t.repos['acme-org/foreign-repo'] = foreign31Conflicting
  await t.step()
  expect(t.items().map(i => i.key)).toEqual([K31, I501])
  t.setForeign([])
  await t.step()
  expect(t.items()).toEqual([])
  expect(t.state().merge).toBeUndefined()
  expect(t.state().prs).toMatchObject({ ok: false, skipped: 'no-repo' })
})

// One rule: a reply that is not complete for the session repo holds its lane PRs and still reconciles each repo that answered.

test('lane: a foreign repo that answered is reconciled when the session has branches but no GitHub repo: its PR, its body refs and its note go (issue #195, Codex P2)', async () => {
  const t = rig({ repo: null, branches: ['feat/x'], foreign: [{ ...FOREIGN, branches: ['feat/one'] }] })
  t.repos['acme-org/foreign-repo'] = foreign31Conflicting
  await t.step()
  expect(t.items().map(i => [i.key, i.lane])).toEqual([
    [K31, true],
    [I501, undefined],
  ])
  expect(Object.keys(t.state().merge ?? {})).toEqual([K31])
  // The worktree of the foreign repo moves from `feat/one` to `feat/two`: the repo answers, with no PR on that branch.
  t.setForeign([{ ...FOREIGN, branches: ['feat/two'] }])
  t.repos['acme-org/foreign-repo'] = { heads: {} }
  await t.step()
  expect(t.items()).toEqual([])
  expect(t.state().merge).toBeUndefined()
  expect(t.state().prs).toMatchObject({ ok: true }) // a step that asked, and a good one: no skip note
  expect(t.calls.map(c => c.repo)).toEqual(['acme-org/foreign-repo', 'acme-org/foreign-repo']) // the session repo is never asked
})

test('lane: with no GitHub repo for the session, a foreign repo that failed keeps its lane PR, and the lane PRs of the session repo stay as they are', async () => {
  const t = rig({
    foreign: [
      { ...FOREIGN, branches: ['feat/one'] },
      { ...GHE, branches: ['feat/g'] },
    ],
  })
  t.repos['acme/web'] = {
    heads: {
      'head:feat/x': [prNode({ number: 7, headRefName: 'feat/x', body: 'Closes #8', mergeable: 'CONFLICTING' })],
    },
  }
  t.repos['acme-org/foreign-repo'] = foreign31Conflicting
  t.repos['team/svc'] = {
    heads: {
      'head:feat/g': [{ ...prNode({ number: 5, headRefName: 'feat/g' }), url: 'https://ghe.corp/team/svc/pull/5' }],
    },
  }
  await t.step()
  const I8 = 'gh:github.com/acme/web#8'
  expect(t.items().map(i => i.key)).toEqual([K7, K31, KGHE, I8, I501])
  // The session repo has no GitHub remote now (null): its branch is not asked. #31 left its branch, and the GHE repo fails.
  t.setRepo(null)
  t.repos['acme-org/foreign-repo'] = { heads: {} }
  t.fail['team/svc'] = { ok: false, kind: 'transport', error: 'timeout' }
  await t.step()
  expect(t.items().map(i => [i.key, i.lane])).toEqual([
    [K7, true], // the session repo was not asked: held, with its issue
    [KGHE, true], // the repo that failed: held
    [I8, undefined],
  ])
  expect(Object.keys(t.state().merge ?? {})).toEqual([K7]) // the note of #7 stays, the note of #31 goes
  expect(t.state().prs).toMatchObject({ ok: true })
})

test('lane: a session repo with no sure answer holds its lane PRs and does not stop the clean-up of a foreign repo that answered', async () => {
  const t = rig({ foreign: [{ ...FOREIGN, branches: ['feat/one'] }] })
  t.repos['acme/web'] = session7
  t.repos['acme-org/foreign-repo'] = foreign31Conflicting
  await t.step()
  expect(t.items().map(i => i.key)).toEqual([K7, K31, I501])
  // The branch alias of the session repo gets an error, so its answer is not sure. The foreign repo answers, with no PR.
  t.broken['acme/web'] = ['h0']
  t.repos['acme-org/foreign-repo'] = { heads: {} }
  await t.step()
  expect(t.items().map(i => [i.key, i.lane])).toEqual([[K7, true]]) // #7 held, #31 and its issue gone
  expect(t.state().merge).toBeUndefined()
})

test('lane: the retry timer of the only UNKNOWN foreign PR is cancelled when its last proof goes away, and none is set again', async () => {
  const t = rig({ repo: null, branches: [], foreign: [{ ...FOREIGN, branches: ['feat/one'] }] })
  t.repos['acme-org/foreign-repo'] = {
    heads: { 'head:feat/one': [foreignNode(31, 'feat/one', { mergeable: 'UNKNOWN' })] },
  }
  await t.step()
  expect(t.state().merge).toEqual({ [K31]: { unknown: 1 } })
  expect(t.timers.map(x => x.cancelled)).toEqual([false]) // one retry waits for #31
  // The last proof goes: the step asks nothing, drops #31 and its note, and no PR is UNKNOWN any more.
  t.setForeign([])
  await t.step()
  expect(t.items()).toEqual([])
  expect(t.state().merge).toBeUndefined()
  expect(t.timers.map(x => x.cancelled)).toEqual([true]) // the retry was cancelled, and no new one was set
})

test('lane: a first step with no branch and no foreign proof still skips, and writes no item', async () => {
  const t = rig({ repo: null, branches: [], foreign: [] })
  await t.step()
  expect(t.items()).toEqual([])
  expect(t.state().prs).toMatchObject({ ok: false, skipped: 'no-branches' })
  expect(t.calls).toEqual([])
  expect(t.log.itemWrites).toBe(0)
})

/** A foreign repo whose only proven branch is its default branch: the first step learns it. */
function defaultOnly() {
  const t = rig({ foreign: [{ ...FOREIGN, branches: ['main'] }] })
  t.repos['acme/web'] = {}
  t.repos['acme-org/foreign-repo'] = { heads: {}, defaultBranch: 'main' }
  return t
}

test('lane: the default branch of a foreign repo is saved once, from the reply of its first query', async () => {
  const t = defaultOnly()
  await t.step()
  expect(t.state().foreignDefaults).toEqual({ 'github.com/acme-org/foreign-repo': 'main' })
  expect(t.calls.map(c => c.repo)).toEqual(['acme/web', 'acme-org/foreign-repo'])
})

test('lane: a quiet step asks no foreign query for a known default branch, and writes nothing', async () => {
  const t = defaultOnly()
  await t.step()
  const saves = t.log.saves
  await t.step()
  expect(t.calls.map(c => c.repo)).toEqual(['acme/web', 'acme-org/foreign-repo', 'acme/web']) // no foreign query
  expect(t.log.saves).toBe(saves)
})

test('lane: a new branch beside the known default branch of a foreign repo is asked, and the default branch gets no alias', async () => {
  const t = defaultOnly()
  await t.step()
  t.setForeign([{ ...FOREIGN, branches: ['main', 'feat/one'] }])
  t.repos['acme-org/foreign-repo'] = { ...foreign31, defaultBranch: 'main' }
  await t.step()
  expect(t.calls.at(-1)!.query).toContain('"feat/one"')
  expect(t.calls.at(-1)!.query).not.toContain('"main"')
  expect(t.state().foreignDefaults).toEqual({ 'github.com/acme-org/foreign-repo': 'main' }) // a step of notes keeps it
  expect(t.items().map(i => i.key)).toEqual([K31])
})

test('lane: a failed step keeps the learned defaults of the foreign repos', async () => {
  const t = rig({ foreign: [{ ...FOREIGN, branches: ['main'] }] })
  t.repos['acme/web'] = {}
  t.repos['acme-org/foreign-repo'] = { heads: {}, defaultBranch: 'main' }
  await t.step()
  t.fail['acme/web'] = { ok: false, kind: 'query-error', error: 'Field x' }
  await t.step()
  expect(t.state().prs).toMatchObject({ ok: false, error: 'Field x' })
  expect(t.state().foreignDefaults).toEqual({ 'github.com/acme-org/foreign-repo': 'main' })
})

// ---------------------------------------------------------------- the shipped trackers

const ROOT = '/x/repo'
const SDK_TOP = '/x/foreign'

test('shipped: a Read of a file in a second repo lists its PR in Pull requests, found by the proven branch (AC1)', async () => {
  const queries: { repo: string; query: string }[] = []
  const listed: string[] = []
  const seenBranch = 'feat/one'
  const t = managerWorld({
    fake: { now: 1_000_000, session: { cwd: ROOT } },
    run: async argv => {
      if (argv[0] === 'git' && argv[1] === '-C') {
        const dir = String(argv[2])
        if (argv[3] === 'rev-parse') {
          if (dir.startsWith(SDK_TOP)) return res(`${SDK_TOP}\n${SDK_TOP}/.git\n`)
          return res(`${ROOT}\n${ROOT}/.git\n`)
        }
        if (argv[3] === 'remote')
          return res(
            dir.startsWith(SDK_TOP) ? 'git@github.com:Acme-Org/Foreign-Repo.git\n' : 'git@github.com:acme/web.git\n',
          )
        if (argv[3] === 'branch') return res(dir.startsWith(SDK_TOP) ? `${seenBranch}\n` : 'feat/x\n')
        if (argv[3] === 'worktree') {
          listed.push(argv.slice(2).join(' '))
          return res(`worktree ${SDK_TOP}\nHEAD abc\nbranch refs/heads/${seenBranch}\n\n`)
        }
      }
      if (argv[0] === 'git') {
        if (argv[1] === 'rev-parse') return res(`${ROOT}\n`)
        if (argv[1] === 'worktree') return res(`worktree ${ROOT}\nHEAD abc\nbranch refs/heads/feat/x\n\n`)
        return undefined
      }
      if (argv[0] === 'sh') return res('/home/me\n\n\n')
      if (argv[0] === 'gh' && argv[1] === 'auth') return res('')
      if (argv[0] === 'gh' && argv[1] === 'api' && argv[2] === 'graphql') {
        const q = argv.find(x => x.startsWith('query='))?.slice('query='.length) ?? ''
        if (!q.includes('pullRequests(') && !q.includes('pullRequest(number:')) return res(JSON.stringify({ data: {} }))
        const m = /repository\(owner: "([^"]+)", name: "([^"]+)"\)/.exec(q)
        const repo = `${m?.[1]}/${m?.[2]}`.toLowerCase()
        queries.push({ repo, query: q })
        const aliases: Record<string, unknown[]> = {}
        for (const a of q.matchAll(/(([hb])\d+): pullRequests\((head|base)RefName: ("(?:[^"\\]|\\.)*")/g))
          aliases[a[1]!] =
            repo === 'acme-org/foreign-repo' && a[3] === 'head' && JSON.parse(a[4]!) === 'feat/one'
              ? [foreignNode(31, 'feat/one', { title: 'A teammate PR' })]
              : []
        return res(JSON.stringify({ data: discoveryData(aliases, 'main') }))
      }
      return undefined
    },
  })
  await t.m.start(t.w.ports, { cwd: ROOT, fromSessionStart: true })
  await t.call('Read', { file_path: `${SDK_TOP}/README.md` }, { result: { content: 'x' } })
  for (let i = 0; i < 100 && !t.keys().includes(K31); i++) {
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
  expect(listed).toEqual([`${SDK_TOP}/.git worktree list --porcelain`])
  expect(queries.filter(q => q.repo === 'acme-org/foreign-repo')).toHaveLength(1)
  expect(queries.find(q => q.repo === 'acme-org/foreign-repo')?.query).toContain('headRefName: "feat/one"')
  const rec = t.items().find(r => r.key === K31) as unknown as GitHubRecord
  expect(rec).toMatchObject({ lane: true, otherRepo: true, title: 'A teammate PR' })
  const text = (await t.m.track(t.w.ports, '')).text
  expect(text).toContain('Pull requests')
  expect(text).toContain('Acme-Org/Foreign-Repo#31')
})

test('shipped: the first value of repos.branches starts no step, a change does, and the same text again does not', async () => {
  const queries: string[] = []
  const t = managerWorld({
    fake: { now: 1_000_000, session: { cwd: ROOT } },
    trackers: () => TRACKERS.filter(x => x.id === 'github'),
    run: async argv => {
      if (argv[0] === 'gh' && argv[1] === 'auth') return res('')
      if (argv[0] === 'gh' && argv[1] === 'api' && argv[2] === 'graphql') {
        const q = argv.find(x => x.startsWith('query='))?.slice('query='.length) ?? ''
        if (q.includes('pullRequests(')) {
          queries.push(q)
          return res(JSON.stringify({ data: discoveryData({ h0: [], b0: [], h1: [], b1: [] }, 'main') }))
        }
        return res(JSON.stringify({ data: {} }))
      }
      return undefined
    },
  })
  await t.m.start(t.w.ports, { cwd: ROOT, fromSessionStart: true })
  // A publish starts its handlers before it returns, and a lane step is marked running by then. `/track refresh` waits for
  // that step to end (`idle`), so "no query yet" is proven after a step would have run, with no wait on the clock.
  const settle = async () => {
    await t.m.command(t.w.ports, { sub: 'refresh', args: '', wait: true })
  }
  const fact = (branches: string[]) =>
    ({
      repos: [{ host: 'github.com', owner: 'Acme-Org', repo: 'Foreign-Repo', branches }],
      overflow: 0,
    }) as unknown as Json
  t.m.facts.publish('repos.branches', fact(['feat/one']))
  await settle()
  expect(queries).toEqual([]) // the first value: nothing to compare with
  t.m.facts.publish('repos.branches', fact(['feat/one', 'feat/two']))
  await settle()
  expect(queries).toHaveLength(1)
  expect(queries[0]).toContain('repository(owner: "Acme-Org", name: "Foreign-Repo")')
  t.m.facts.publish('repos.branches', fact(['feat/one', 'feat/two']))
  await settle()
  expect(queries).toHaveLength(1)
})
