// PR discovery: query shape, reply parsing, skip reasons and outcome mapping. Pure, fake gh.
import { expect, test } from 'claude-code/testing'
import { PR_LANE_DEFAULTS } from '../trackers/github/config'
import { buildDiscoveryQuery, discoverPrs, parseDiscovery } from '../trackers/github/pr-discovery'
import type { PrRef } from '../trackers/github/types'
import type { GitHubDiscoveryApi, GraphqlOutcome, GraphqlReply, ToolStatus } from './fixtures/contracts'
import { discoveryData, prNode, REPO } from './fixtures/gh-discovery'
import { LIMITS } from './fixtures/limits'

const NOW = 1_000_000
const reply = (data: Record<string, unknown>, errors: unknown[] = []): GraphqlReply => ({ data, errors })

test('buildDiscoveryQuery: a head and a base alias per branch, with the spec limits', () => {
  const { query, aliases } = buildDiscoveryQuery(REPO, ['feat/a', 'feat/b'], 'main')
  expect([...aliases.keys()]).toEqual(['h0', 'b0', 'h1', 'b1'])
  expect(aliases.get('b1')).toEqual({ branch: 'feat/b', by: 'base' })
  expect(query).toContain('repository(owner: "acme", name: "web")')
  expect(query).toContain('defaultBranchRef { name }')
  expect(query).toContain(
    `h0: pullRequests(headRefName: "feat/a", first: ${LIMITS.headPrsPerBranch}, states: [OPEN, MERGED, CLOSED]`,
  )
  expect(query).toContain(`b0: pullRequests(baseRefName: "feat/a", first: ${LIMITS.basePrsPerBranch}, states: [OPEN]`)
  expect(query).toContain('rateLimit { cost remaining }')
  expect(query).toContain('fragment pr on PullRequest')
  expect(query).toContain(`closingIssuesReferences(first: ${LIMITS.closingRefsPerPr})`)
})

test('buildDiscoveryQuery: the default branch gets no alias once it is known', () => {
  const { query, aliases } = buildDiscoveryQuery(REPO, ['main', 'feat/a'], 'main')
  expect(aliases.size).toBe(2)
  expect(query).not.toContain('headRefName: "main"')
  expect(query).not.toContain('baseRefName: "main"')
  expect(buildDiscoveryQuery(REPO, ['main', 'feat/a']).aliases.size).toBe(4)
})

test('buildDiscoveryQuery quotes a branch name with JSON.stringify', () => {
  const { query } = buildDiscoveryQuery(REPO, ['feat/"x"'])
  expect(query).toContain('headRefName: "feat/\\"x\\""')
})

test('parseDiscovery: maps fields, checks, state and closing refs', () => {
  const { aliases } = buildDiscoveryQuery(REPO, ['feat/a'], 'main')
  const node = prNode({ number: 7, state: 'MERGED', rollup: 'FAILURE', closing: [{ number: 1 }], body: 'hi' })
  const r = parseDiscovery(reply(discoveryData({ h0: [node], b0: [] })), REPO, aliases)
  expect(r.complete).toBe(true)
  expect(r.defaultBranch).toBe('main')
  expect(r.prs).toEqual([
    {
      host: 'github.com',
      owner: 'acme',
      repo: 'web',
      number: 7,
      url: 'https://github.com/acme/web/pull/7',
      title: 'PR 7',
      state: 'merged',
      isDraft: false,
      checks: 'failure',
      headRefName: 'feat/auto-tracking',
      baseRefName: 'main',
      body: 'hi',
      closing: [
        { host: 'github.com', owner: 'acme', repo: 'web', number: 1, url: 'https://github.com/acme/web/issues/1' },
      ],
      by: 'head',
    },
  ])
})

test('parseDiscovery: the same PR from a head and a base alias is one entry with by head', () => {
  const { aliases } = buildDiscoveryQuery(REPO, ['feat/a'], 'main')
  const same = prNode({ number: 7 })
  const stacked = prNode({ number: 9, baseRefName: 'feat/a', headRefName: 'feat/b' })
  const r = parseDiscovery(reply(discoveryData({ b0: [same, stacked], h0: [same] })), REPO, aliases)
  expect(r.prs.map(p => [p.number, p.by])).toEqual([
    [7, 'head'],
    [9, 'base'],
  ])
})

test('parseDiscovery: a cross-repository head match is dropped', () => {
  const { aliases } = buildDiscoveryQuery(REPO, ['feat/a'], 'main')
  const fork = prNode({ number: 8, isCrossRepository: true })
  const r = parseDiscovery(reply(discoveryData({ h0: [fork, prNode({ number: 7 })], b0: [] })), REPO, aliases)
  expect(r.prs.map(p => p.number)).toEqual([7])
})

test('M3: a cross-repository PR found by a base alias is kept and marked crossRepo; a PR of this repo has no mark', () => {
  // A fork PR that targets a tracked branch comes in by its base. Its head name is a branch of the fork.
  const { aliases } = buildDiscoveryQuery(REPO, ['feat/a'], 'main')
  const fork = prNode({ number: 8, headRefName: 'main', baseRefName: 'feat/a', isCrossRepository: true })
  const own = prNode({ number: 9, headRefName: 'feat/b', baseRefName: 'feat/a' })
  const r = parseDiscovery(reply(discoveryData({ h0: [], b0: [fork, own] })), REPO, aliases)
  expect(r.prs.map(p => [p.number, p.by, p.crossRepo])).toEqual([
    [8, 'base', true],
    [9, 'base', undefined],
  ])
  expect('crossRepo' in r.prs[1]!).toBe(false) // no field: the record of a PR of this repo stays as it was
})

test('parseDiscovery: matches on the default branch are dropped, also when the first round did not know it', () => {
  const { aliases } = buildDiscoveryQuery(REPO, ['feat/a', 'main'])
  const data = discoveryData({
    h0: [prNode({ number: 7 })],
    b0: [],
    h1: [prNode({ number: 1 })],
    b1: [prNode({ number: 2 })],
  })
  const r = parseDiscovery(reply(data), REPO, aliases)
  expect(r.prs.map(p => p.number)).toEqual([7])
  expect(r.defaultBranch).toBe('main')
})

test('parseDiscovery: an alias error or a null alias or a null repository makes it incomplete', () => {
  const { aliases } = buildDiscoveryQuery(REPO, ['feat/a'], 'main')
  const withError = reply(discoveryData({ h0: [prNode({ number: 7 })], b0: null }), [
    { path: ['repository', 'b0'], message: 'boom' },
  ])
  const a = parseDiscovery(withError, REPO, aliases)
  expect(a.complete).toBe(false)
  expect(a.prs.map(p => p.number)).toEqual([7])
  expect(parseDiscovery(reply(discoveryData({ h0: [], b0: null })), REPO, aliases).complete).toBe(false)
  const noRepo = parseDiscovery(reply({ rateLimit: {}, repository: null }), REPO, aliases)
  expect(noRepo).toMatchObject({ complete: false, prs: [] })
})

test('parseDiscovery: an error that names no alias or repository is ignored', () => {
  const { aliases } = buildDiscoveryQuery(REPO, ['feat/a'], 'main')
  const r = parseDiscovery(
    reply(discoveryData({ h0: [], b0: [] }), [{ path: ['rateLimit'], message: 'x' }]),
    REPO,
    aliases,
  )
  expect(r.complete).toBe(true)
})

/** A fake gh with the parts discoverPrs reads. */
function fakeGh(over: {
  available?: boolean
  can?: boolean
  loggedIn?: boolean | null
  authed?: boolean | undefined
  /** `checkHost` says false, but the login of the host is not known: the check could not run. */
  unreachable?: boolean
  outcome?: GraphqlOutcome
  lastError?: string
}) {
  const queries: string[] = []
  const gh = {
    isAvailable: over.available ?? true,
    canCall: () => over.can ?? true,
    status: (): ToolStatus => ({
      name: 'gh',
      available: true,
      loggedIn: over.loggedIn ?? true,
      breaker: 'closed',
      ...(over.lastError ? { lastError: over.lastError } : {}),
    }),
    // A host that no call asked about is not known yet (`isHostAuthed` undefined): `checkHost` asks, and answers.
    checkHost: async () => over.authed === true,
    isHostAuthed: () => (over.unreachable ? undefined : over.authed === true),
    graphql: async (_host: string, q: string) => {
      queries.push(q)
      return over.outcome ?? { ok: true as const, reply: reply(discoveryData({ h0: [prNode({ number: 7 })], b0: [] })) }
    },
  } as unknown as GitHubDiscoveryApi
  return { gh, queries }
}

test('discoverPrs skips in order: no repo, no branches, no gh, not logged in, paused, host not authed', async () => {
  expect(await discoverPrs(fakeGh({}).gh, null, ['a'], NOW)).toEqual({ ok: false, skipped: 'no-repo' })
  expect(await discoverPrs(fakeGh({}).gh, REPO, [], NOW)).toEqual({ ok: false, skipped: 'no-branches' })
  expect(await discoverPrs(fakeGh({ available: false }).gh, REPO, ['a'], NOW)).toEqual({ ok: false, skipped: 'no-gh' })
  expect(await discoverPrs(fakeGh({ can: false, loggedIn: false }).gh, REPO, ['a'], NOW)).toEqual({
    ok: false,
    skipped: 'not-logged-in',
  })
  expect(await discoverPrs(fakeGh({ can: false }).gh, REPO, ['a'], NOW)).toEqual({ ok: false, skipped: 'paused' })
  const ghe = { ...REPO, host: 'ghe.corp' }
  expect(await discoverPrs(fakeGh({ authed: undefined }).gh, ghe, ['a'], NOW)).toEqual({
    ok: false,
    skipped: 'host-not-authed',
    host: 'ghe.corp', // the skip names the host that said no
  })
  expect((await discoverPrs(fakeGh({ authed: true }).gh, ghe, ['a'], NOW)).ok).toBe(true)
})

test('discoverPrs maps each failed outcome to a skip or an error', async () => {
  const out = (outcome: GraphqlOutcome, lastError?: string) =>
    discoverPrs(fakeGh({ outcome, lastError }).gh, REPO, ['a'], NOW)
  expect(await out({ ok: false, kind: 'blocked' })).toEqual({ ok: false, skipped: 'paused' })
  expect(await out({ ok: false, kind: 'auth' })).toEqual({ ok: false, skipped: 'not-logged-in', host: 'github.com' })
  expect(await out({ ok: false, kind: 'no-gh' })).toEqual({ ok: false, skipped: 'no-gh' })
  expect(await out({ ok: false, kind: 'transport' }, 'timeout')).toEqual({ ok: false, error: 'timeout' })
  expect(await out({ ok: false, kind: 'truncated' })).toEqual({ ok: false, error: 'reply over 4 MiB' })
  expect(await out({ ok: false, kind: 'query-error', error: 'Field x' })).toEqual({ ok: false, error: 'Field x' })
})

test('discoverPrs returns the parsed PRs, and polls at most maxBranches', async () => {
  const { gh, queries } = fakeGh({})
  const branches = Array.from({ length: 15 }, (_, i) => `b${i}`)
  const r = await discoverPrs(gh, REPO, branches, NOW, undefined, {
    ...PR_LANE_DEFAULTS,
    maxBranches: LIMITS.maxBranches,
  })
  expect(r).toMatchObject({ ok: true, defaultBranch: 'main' })
  expect(queries[0]).toContain(`h${LIMITS.maxBranches - 1}:`)
  expect(queries[0]).not.toContain(`h${LIMITS.maxBranches}:`)
})

test('discoverPrs makes no call when every branch is the known default branch', async () => {
  const { gh, queries } = fakeGh({})
  const r = await discoverPrs(gh, REPO, ['main'], NOW, 'main')
  expect(r).toEqual({ ok: true, prs: [], complete: true, defaultBranch: 'main' })
  expect(queries).toHaveLength(0)
})

// ---------------------------------------------------------------- merge state (issue #50, P1)

test('the pr fragment asks for mergeable and mergeStateStatus', () => {
  const { query } = buildDiscoveryQuery(REPO, ['feat/a'], 'main')
  expect(query).toContain('mergeable mergeStateStatus')
})

test('parseDiscovery: mergeable and mergeStateStatus ride on the PR', () => {
  const { aliases } = buildDiscoveryQuery(REPO, ['feat/a'], 'main')
  const conflict = prNode({ number: 7, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })
  const behind = prNode({ number: 8, mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' })
  const lazy = prNode({ number: 9, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })
  const r = parseDiscovery(reply(discoveryData({ h0: [conflict, behind, lazy], b0: [] })), REPO, aliases)
  expect(r.prs.map(p => [p.number, p.mergeable, p.mergeStateStatus])).toEqual([
    [7, 'CONFLICTING', 'DIRTY'],
    [8, 'MERGEABLE', 'BEHIND'],
    [9, 'UNKNOWN', 'UNKNOWN'],
  ])
})

test('parseDiscovery: a reply with no merge fields, or a value of no known kind, leaves them off the PR', () => {
  const { aliases } = buildDiscoveryQuery(REPO, ['feat/a'], 'main')
  const none = prNode({ number: 7 })
  const nulled = prNode({ number: 8, mergeable: null, mergeStateStatus: null })
  const odd = prNode({ number: 9, mergeable: 'SOMETHING_NEW', mergeStateStatus: 'DIRTY' })
  const r = parseDiscovery(reply(discoveryData({ h0: [none, nulled, odd], b0: [] })), REPO, aliases)
  const [a, b, c] = r.prs
  expect('mergeable' in a! || 'mergeStateStatus' in a!).toBe(false)
  expect('mergeable' in b! || 'mergeStateStatus' in b!).toBe(false)
  expect('mergeable' in c!).toBe(false) // a mergeable value that no code knows is no value
  expect(c!.mergeStateStatus).toBe('DIRTY')
})

// ---------------------------------------------------------------- the PRs the session created (issue #158)

const OTHER = { host: 'github.com', owner: 'VerticeOne', repo: 'vertice-iam' }
const ref = (repo: { host: string; owner: string; repo: string }, number: number): PrRef => ({ ...repo, number })

test('buildDiscoveryQuery: a created PR is one pullRequest(number:) alias in the repository block, after the branches', () => {
  const { query, aliases } = buildDiscoveryQuery(REPO, ['feat/a'], 'main', PR_LANE_DEFAULTS, [12, 13])
  expect([...aliases.keys()]).toEqual(['h0', 'b0', 'p0', 'p1'])
  expect(aliases.get('p1')).toEqual({ number: 13, by: 'created' })
  expect(query).toContain('p0: pullRequest(number: 12) { ...pr }')
  expect(query).toContain('p1: pullRequest(number: 13) { ...pr }')
  expect(query.indexOf('p0:')).toBeGreaterThan(query.indexOf('b0:'))
  // No branch at all: the PRs are the whole query.
  const only = buildDiscoveryQuery(OTHER, [], undefined, PR_LANE_DEFAULTS, [657])
  expect([...only.aliases.keys()]).toEqual(['p0'])
  expect(only.query).toContain('repository(owner: "VerticeOne", name: "vertice-iam")')
})

test('parseDiscovery: a created alias holds one PR, of any state, and a fork PR stays, marked crossRepo', () => {
  const { aliases } = buildDiscoveryQuery(REPO, [], undefined, PR_LANE_DEFAULTS, [7, 8])
  const closed = prNode({ number: 7, state: 'CLOSED', headRefName: 'feat/untracked-p2' })
  const fork = prNode({ number: 8, isCrossRepository: true })
  const data = { repository: { defaultBranchRef: { name: 'main' }, p0: closed, p1: fork } }
  const r = parseDiscovery(reply(data), REPO, aliases)
  expect(r.complete).toBe(true)
  expect(r.prs.map(p => [p.number, p.state, p.by, p.crossRepo])).toEqual([
    [7, 'closed', 'created', undefined],
    [8, 'open', 'created', true],
  ])
})

test('parseDiscovery: a created alias with no sure verdict is unsure; one that parsed, or is gone, is not', () => {
  const { aliases } = buildDiscoveryQuery(OTHER, [], undefined, PR_LANE_DEFAULTS, [7, 8, 9, 10])
  const block = {
    defaultBranchRef: { name: 'main' },
    p0: prNode({ number: 7 }),
    p1: null, // no verdict
    p2: null, // gone
    p3: prNode({ number: 10 }),
  }
  const gone = { type: 'NOT_FOUND', path: ['repository', 'p2'] }
  const r = parseDiscovery(reply({ repository: block }, [gone]), OTHER, aliases)
  expect(r.prs.map(p => p.number)).toEqual([7, 10])
  expect(r.unsure).toEqual([8])
  // An error under the alias of a PR that did parse (its closing refs, say): that body is not sure either.
  const nested = { path: ['repository', 'p3', 'closingIssuesReferences'], message: 'boom' }
  expect(parseDiscovery(reply({ repository: block }, [gone, nested]), OTHER, aliases).unsure).toEqual([8, 10])
  // An error that names no alias says nothing about the PRs that parsed.
  const other = { path: ['repository', 'defaultBranchRef'], message: 'boom' }
  expect(parseDiscovery(reply({ repository: block }, [gone, other]), OTHER, aliases).unsure).toEqual([8])
  // No repository: no alias is sure, a gone one included (nothing was read).
  const noRepo = reply({ repository: null }, [{ type: 'NOT_FOUND', path: ['repository'] }])
  expect(parseDiscovery(noRepo, OTHER, aliases)).toMatchObject({ complete: false, prs: [], unsure: [7, 8, 9, 10] })
  // A branch alias is no created PR: it never lands in the list.
  const branch = buildDiscoveryQuery(REPO, ['feat/a'], 'main').aliases
  expect(parseDiscovery(reply(discoveryData({ h0: null, b0: [] })), REPO, branch)).toMatchObject({ unsure: [] })
})

test('parseDiscovery: a PR that a branch alias found first keeps by head when a created alias names it too', () => {
  const { aliases } = buildDiscoveryQuery(REPO, ['feat/a'], 'main', PR_LANE_DEFAULTS, [7])
  const node = prNode({ number: 7 })
  const data = {
    repository: { defaultBranchRef: { name: 'main' }, h0: { nodes: [node] }, b0: { nodes: [] }, p0: node },
  }
  const r = parseDiscovery(reply(data), REPO, aliases)
  expect(r.prs.map(p => [p.number, p.by])).toEqual([[7, 'head']])
})

test('parseDiscovery: a created PR that GitHub says is not there is gone, so the reply stays complete', () => {
  const { aliases } = buildDiscoveryQuery(REPO, [], undefined, PR_LANE_DEFAULTS, [7, 99])
  const data = { repository: { defaultBranchRef: { name: 'main' }, p0: prNode({ number: 7 }), p1: null } }
  const gone = { type: 'NOT_FOUND', path: ['repository', 'p1'], message: 'Could not resolve to a PullRequest' }
  const r = parseDiscovery(reply(data, [gone]), REPO, aliases)
  expect(r.prs.map(p => p.number)).toEqual([7])
  expect(r.complete).toBe(true)
  // A null with no such error, another error type, or a missing repository says nothing sure: incomplete.
  expect(parseDiscovery(reply(data), REPO, aliases).complete).toBe(false)
  expect(parseDiscovery(reply(data, [{ ...gone, type: 'RATE_LIMITED' }]), REPO, aliases).complete).toBe(false)
  const noRepo = reply({ repository: null }, [{ type: 'NOT_FOUND', path: ['repository'] }])
  expect(parseDiscovery(noRepo, REPO, aliases).complete).toBe(false)
  // A NOT_FOUND on a branch alias is not a gone PR: it stays incomplete.
  const branch = buildDiscoveryQuery(REPO, ['feat/a'], 'main').aliases
  const lost = { type: 'NOT_FOUND', path: ['repository', 'h0'] }
  expect(parseDiscovery(reply(discoveryData({ h0: null, b0: [] }), [lost]), REPO, branch).complete).toBe(false)
})

/**
 * A gh that answers per repository: `repos` maps `owner/name` (lower case) to the nodes of its `pullRequest` aliases by
 * number, and `heads` the nodes of a branch alias. A repository it does not know answers `repository: null`.
 */
function repoGh(o: {
  repos: Record<string, Record<number, unknown>>
  heads?: Record<string, unknown[]>
  fail?: Record<string, GraphqlOutcome>
  /** What `gh auth status` says: one answer for every host, or one per host. */
  authed?: boolean | ((host: string) => boolean)
  /** The hosts whose check cannot run (a timeout, a network error): `checkHost` says false and the login stays unknown. */
  unreachable?: (host: string) => boolean
}) {
  const calls: { host: string; repo: string; query: string }[] = []
  /** The hosts that were checked: a host is not known to be authed until `checkHost` asked (as the real tool). */
  const checked: string[] = []
  /** What the tool knows of the login of a host after a check: an answer, or nothing when the check could not run. */
  const known = new Map<string, boolean>()
  const gh = {
    isAvailable: true,
    canCall: () => true,
    status: (): ToolStatus => ({ name: 'gh', available: true, loggedIn: true, breaker: 'closed', lastError: 'boom' }),
    checkHost: async (host: string) => {
      checked.push(host)
      if (o.unreachable?.(host)) return false
      const authed = typeof o.authed === 'function' ? o.authed(host) : (o.authed ?? true)
      known.set(host, authed)
      return authed
    },
    isHostAuthed: (host: string) => known.get(host),
    graphql: async (host: string, q: string): Promise<GraphqlOutcome> => {
      const m = /repository\(owner: "([^"]+)", name: "([^"]+)"\)/.exec(q)
      const repo = `${m?.[1]}/${m?.[2]}`.toLowerCase()
      calls.push({ host, repo, query: q })
      const failed = o.fail?.[repo]
      if (failed) return failed
      const known = o.repos[repo]
      if (!known) return { ok: true, reply: reply({ repository: null }, [{ type: 'NOT_FOUND', path: ['repository'] }]) }
      const block: Record<string, unknown> = { defaultBranchRef: { name: 'main' } }
      for (const a of q.matchAll(/(p\d+): pullRequest\(number: (\d+)\)/g)) block[a[1]!] = known[Number(a[2])] ?? null
      for (const a of q.matchAll(/(([hb])\d+): pullRequests\((head|base)RefName: ("(?:[^"\\]|\\.)*")/g))
        block[a[1]!] = { nodes: o.heads?.[`${a[3]}:${JSON.parse(a[4]!) as string}`] ?? [] }
      return { ok: true, reply: reply({ rateLimit: { cost: 1, remaining: 1 }, repository: block }) }
    },
  } as unknown as GitHubDiscoveryApi
  return { gh, calls, checked }
}

const SESSION = 'acme/web'
const FOREIGN = 'verticeone/vertice-iam'
const KFOREIGN657 = 'gh:github.com/verticeone/vertice-iam#657'
const KFOREIGN658 = 'gh:github.com/verticeone/vertice-iam#658'

test('discoverPrs: a created PR of the session repo rides in its query; one more query per other repo', async () => {
  const { gh, calls } = repoGh({
    repos: {
      [SESSION]: { 12: prNode({ number: 12, state: 'CLOSED', headRefName: 'feat/untracked-p2', baseRefName: 'main' }) },
      [FOREIGN]: { 657: prNode({ number: 657, headRefName: 'feat/brown-2901' }) },
    },
  })
  const created = [ref(REPO, 12), ref(OTHER, 657), ref({ ...OTHER, owner: 'verticeone' }, 658)]
  const r = await discoverPrs(gh, REPO, ['feat/root'], NOW, 'main', PR_LANE_DEFAULTS, { created })
  expect(calls.map(c => c.repo)).toEqual([SESSION, FOREIGN]) // two PRs of one repo, in any case, make one query
  expect(calls[0]!.query).toContain('h0: pullRequests(headRefName: "feat/root"')
  expect(calls[0]!.query).toContain('p0: pullRequest(number: 12)')
  expect(calls[1]!.query).not.toContain('pullRequests(') // another repo: no branch is asked
  expect(calls[1]!.query).toContain('p0: pullRequest(number: 657)')
  expect(calls[1]!.query).toContain('p1: pullRequest(number: 658)')
  expect(r.ok && r.prs.map(p => [p.owner, p.repo, p.number, p.state, p.created, p.otherRepo])).toEqual([
    ['acme', 'web', 12, 'closed', true, undefined],
    ['VerticeOne', 'vertice-iam', 657, 'open', true, true],
  ])
  // 658 is not in the reply: nothing sure about that PR. The reply stays complete for the session repo, and only the
  // PR with no sure answer is held, so a prune leaves it alone. 657 answered, so its body is read (m2 of the review of
  // #186, and its Codex finding "hold only PR aliases whose results are uncertain").
  expect(r).toMatchObject({ ok: true, complete: true, defaultBranch: 'main', held: [KFOREIGN658] })
})

test('discoverPrs: a repo with a sure and an unsure created PR holds only the unsure one; two sure ones hold nothing', async () => {
  const { gh } = repoGh({
    repos: { [SESSION]: { 12: prNode({ number: 12 }) }, [FOREIGN]: { 657: prNode({ number: 657 }) } },
  })
  const created = [ref(REPO, 12), ref(OTHER, 657), ref(OTHER, 658)]
  const r = await discoverPrs(gh, REPO, ['feat/root'], NOW, 'main', PR_LANE_DEFAULTS, { created })
  expect(r.ok && r.prs.map(p => p.number)).toEqual([12, 657]) // the sure PR is listed, and its body is read
  expect(r).toMatchObject({ ok: true, complete: true, held: [KFOREIGN658] })
  // The unsure PR answers on the next step: nothing is held any more.
  const both = repoGh({
    repos: {
      [SESSION]: { 12: prNode({ number: 12 }) },
      [FOREIGN]: { 657: prNode({ number: 657 }), 658: prNode({ number: 658 }) },
    },
  })
  const sure = await discoverPrs(both.gh, REPO, ['feat/root'], NOW, 'main', PR_LANE_DEFAULTS, { created })
  expect(sure.ok && sure.prs.map(p => p.number)).toEqual([12, 657, 658])
  expect(sure).toMatchObject({ ok: true, complete: true })
  expect('held' in sure).toBe(false)
})

test('discoverPrs: a PR that a branch found and the session also created is one PR marked created', async () => {
  const { gh } = repoGh({
    repos: { [SESSION]: { 7: prNode({ number: 7, headRefName: 'feat/root' }) } },
    heads: { 'head:feat/root': [prNode({ number: 7, headRefName: 'feat/root' })] },
  })
  const r = await discoverPrs(gh, REPO, ['feat/root'], NOW, 'main', PR_LANE_DEFAULTS, { created: [ref(REPO, 7)] })
  expect(r.ok && r.prs.map(p => [p.number, p.by, p.created])).toEqual([[7, 'head', true]])
})

test('discoverPrs: a PR found by a branch alone is not marked created', async () => {
  const { gh } = repoGh({ repos: { [SESSION]: {} }, heads: { 'head:feat/root': [prNode({ number: 7 })] } })
  const r = await discoverPrs(gh, REPO, ['feat/root'], NOW, 'main', PR_LANE_DEFAULTS, { created: [] })
  expect(r.ok && r.prs.map(p => ['created' in p, 'otherRepo' in p])).toEqual([[false, false]])
})

test('discoverPrs: created PRs are polled with no branch to poll, and with no session repo', async () => {
  const { gh, calls } = repoGh({ repos: { [FOREIGN]: { 657: prNode({ number: 657 }) } } })
  const none = await discoverPrs(gh, REPO, [], NOW, undefined, PR_LANE_DEFAULTS, { created: [ref(OTHER, 657)] })
  expect(none.ok && none.prs.map(p => p.number)).toEqual([657])
  expect(calls.map(c => c.repo)).toEqual([FOREIGN]) // the session repo has nothing to ask: no query for it
  const noRepo = await discoverPrs(gh, null, ['feat/root'], NOW, undefined, PR_LANE_DEFAULTS, {
    created: [ref(OTHER, 657)],
  })
  expect(noRepo.ok && noRepo.prs.map(p => [p.number, p.otherRepo])).toEqual([[657, true]]) // no session repo: all are another repo's
  // The skips of before stay when no PR was created.
  const bare = await discoverPrs(gh, null, ['feat/root'], NOW, undefined, PR_LANE_DEFAULTS, { created: [] })
  expect(bare).toEqual({ ok: false, skipped: 'no-repo' })
  expect(await discoverPrs(gh, REPO, [], NOW, undefined, PR_LANE_DEFAULTS, { created: [] })).toEqual({
    ok: false,
    skipped: 'no-branches',
  })
})

test('discoverPrs: tracked branches and no session repo make the reply incomplete, whatever a created PR of another repo says', async () => {
  // The branches of the session repo were never asked: a prune must not take their PRs for gone (Codex review of #186).
  const { gh, calls } = repoGh({ repos: { [FOREIGN]: { 657: prNode({ number: 657 }) } } })
  const r = await discoverPrs(gh, null, ['feat/root'], NOW, 'main', PR_LANE_DEFAULTS, { created: [ref(OTHER, 657)] })
  expect(calls.map(c => c.repo)).toEqual([FOREIGN])
  expect(r.ok && r.prs.map(p => p.number)).toEqual([657]) // the sure answer of the other repo still lands
  expect(r).toMatchObject({ ok: true, complete: false })
  // No branch to ask, so nothing of the session repo is left unasked: the reply is complete.
  const none = await discoverPrs(gh, null, [], NOW, 'main', PR_LANE_DEFAULTS, { created: [ref(OTHER, 657)] })
  expect(none).toMatchObject({ ok: true, complete: true })
  // A tracked branch that equals the default branch is no exception here. With no session repo the default branch is
  // the one that an in-process /resume carried from another session (the lane state is restored), so it proves nothing
  // about this session: its stored branch PRs and refs are not asked, and a prune must leave them be (Codex review of #186).
  const onlyDefault = await discoverPrs(gh, null, ['main'], NOW, 'main', PR_LANE_DEFAULTS, {
    created: [ref(OTHER, 657)],
  })
  expect(onlyDefault.ok && onlyDefault.prs.map(p => p.number)).toEqual([657])
  expect(onlyDefault).toMatchObject({ ok: true, complete: false })
  const carried = await discoverPrs(gh, null, ['main', 'feat/x'], NOW, 'main', PR_LANE_DEFAULTS, {
    created: [ref(OTHER, 657)],
  })
  expect(carried).toMatchObject({ ok: true, complete: false })
  // With a session repo the known default branch still needs no query: nothing is left unasked.
  const own = repoGh({ repos: { [SESSION]: {}, [FOREIGN]: { 657: prNode({ number: 657 }) } } })
  const withRepo = await discoverPrs(own.gh, REPO, ['main'], NOW, 'main', PR_LANE_DEFAULTS, {
    created: [ref(OTHER, 657)],
  })
  expect(withRepo).toMatchObject({ ok: true, complete: true })
})

test('discoverPrs: a created PR whose repo fails leaves the other repos in a complete reply, and its PRs are held', async () => {
  const { gh } = repoGh({
    repos: { [SESSION]: { 12: prNode({ number: 12 }) } },
    fail: { [FOREIGN]: { ok: false, kind: 'transport' } },
  })
  const created = [ref(REPO, 12), ref(OTHER, 657)]
  const r = await discoverPrs(gh, REPO, ['feat/root'], NOW, 'main', PR_LANE_DEFAULTS, { created })
  expect(r.ok && r.prs.map(p => p.number)).toEqual([12])
  expect(r).toMatchObject({ ok: true, complete: true, held: [KFOREIGN657] })
})

test('discoverPrs: a repo that is gone, or that gh cannot read, holds its PRs and does not stop the prune of the rest', async () => {
  // `repository: null` with `path: ["repository"]`: the repo is deleted, or the token has no access to it.
  const { gh } = repoGh({ repos: { [SESSION]: { 12: prNode({ number: 12 }) } } })
  const created = [ref(REPO, 12), ref(OTHER, 657)]
  for (let step = 0; step < 2; step++) {
    const r = await discoverPrs(gh, REPO, ['feat/root'], NOW, 'main', PR_LANE_DEFAULTS, { created })
    expect(r.ok && r.prs.map(p => p.number)).toEqual([12])
    expect(r).toMatchObject({ ok: true, complete: true, held: [KFOREIGN657] }) // every step: it never comes back
  }
})

test('discoverPrs: an unsure answer of the session repo still makes the reply incomplete, and holds nothing', async () => {
  // PR 99 of the session repo is null with no NOT_FOUND: the lane cannot say it is gone.
  const { gh } = repoGh({ repos: { [SESSION]: { 12: prNode({ number: 12 }) } } })
  const r = await discoverPrs(gh, REPO, ['feat/root'], NOW, 'main', PR_LANE_DEFAULTS, {
    created: [ref(REPO, 12), ref(REPO, 99)],
  })
  expect(r.ok && r.prs.map(p => p.number)).toEqual([12])
  expect(r).toMatchObject({ ok: true, complete: false })
  expect('held' in r).toBe(false)
})

test('discoverPrs: a reply that holds no PR has no held list', async () => {
  const { gh } = repoGh({ repos: { [SESSION]: { 12: prNode({ number: 12 }) } } })
  const r = await discoverPrs(gh, REPO, ['feat/root'], NOW, 'main', PR_LANE_DEFAULTS, { created: [ref(REPO, 12)] })
  expect(r).toMatchObject({ ok: true, complete: true })
  expect('held' in r).toBe(false)
})

test('discoverPrs: a failure of the session repo fails the whole step; one of another repo never does', async () => {
  const created = [ref(REPO, 12), ref(OTHER, 657)]
  const repos = { [SESSION]: { 12: prNode({ number: 12 }) }, [FOREIGN]: { 657: prNode({ number: 657 }) } }
  const run = (fail: Record<string, GraphqlOutcome>) =>
    discoverPrs(repoGh({ repos, fail }).gh, REPO, ['feat/root'], NOW, 'main', PR_LANE_DEFAULTS, { created })
  const fieldX: GraphqlOutcome = { ok: false, kind: 'query-error', error: 'Field x' }
  expect(await run({ [SESSION]: fieldX })).toEqual({ ok: false, error: 'Field x' })
  expect(await run({ [SESSION]: { ok: false, kind: 'blocked' } })).toEqual({ ok: false, skipped: 'paused' })
  expect(await run({ [SESSION]: { ok: false, kind: 'no-gh' } })).toEqual({ ok: false, skipped: 'no-gh' })
  // Nothing in the session repo to ask, and the one other repo fails: the step has nothing, so it says why.
  const lone = repoGh({ repos: {}, fail: { [FOREIGN]: { ok: false, kind: 'truncated' } } })
  const only = await discoverPrs(lone.gh, null, [], NOW, undefined, PR_LANE_DEFAULTS, { created: [ref(OTHER, 657)] })
  expect(only).toEqual({ ok: false, error: 'reply over 4 MiB' })
})

test('discoverPrs: an auth failure of another repo is that host alone: its PRs are held, the other repos stay', async () => {
  // The session repo is on a GHES host that gh is logged in to. A created PR is on github.com, where it is not (Codex
  // review of #186): authentication is per host, so the answer of the session repo is not thrown away.
  const ghes = { ...REPO, host: 'ghe.corp' }
  const created = [ref(ghes, 12), ref(OTHER, 657)]
  const repos = { [SESSION]: { 12: prNode({ number: 12 }) }, [FOREIGN]: { 657: prNode({ number: 657 }) } }
  const fail: Record<string, GraphqlOutcome> = { [FOREIGN]: { ok: false, kind: 'auth' } }
  const r = await discoverPrs(repoGh({ repos, fail }).gh, ghes, ['feat/root'], NOW, 'main', PR_LANE_DEFAULTS, {
    created,
  })
  expect(r.ok && r.prs.map(p => [p.host, p.number])).toEqual([['ghe.corp', 12]])
  expect(r).toMatchObject({ ok: true, complete: true, held: [KFOREIGN657] })
  // Nothing else answered: the step has nothing, so it says why, and names the host that refused.
  const lone = await discoverPrs(repoGh({ repos: {}, fail }).gh, null, [], NOW, undefined, PR_LANE_DEFAULTS, {
    created: [ref(OTHER, 657)],
  })
  expect(lone).toEqual({ ok: false, skipped: 'not-logged-in', host: 'github.com' })
  // The session repo itself refused: the step fails, as before.
  const own = await discoverPrs(
    repoGh({ repos, fail: { [SESSION]: { ok: false, kind: 'auth' } } }).gh,
    ghes,
    ['feat/root'],
    NOW,
    'main',
    PR_LANE_DEFAULTS,
    { created },
  )
  expect(own).toEqual({ ok: false, skipped: 'not-logged-in', host: 'ghe.corp' })
})

test('discoverPrs: another repo that is blocked or has no gh holds its PRs; the answers before it are kept', async () => {
  // Nothing a host does makes `gh` blocked for the session repo, but a step can meet it half way (another call opened the
  // breaker): the answers already read are not thrown away (Codex review of #186).
  const created = [ref(REPO, 12), ref(OTHER, 657)]
  const repos = { [SESSION]: { 12: prNode({ number: 12 }) }, [FOREIGN]: { 657: prNode({ number: 657 }) } }
  for (const kind of ['blocked', 'no-gh'] as const) {
    const gh = repoGh({ repos, fail: { [FOREIGN]: { ok: false, kind } } }).gh
    const r = await discoverPrs(gh, REPO, ['feat/root'], NOW, 'main', PR_LANE_DEFAULTS, { created })
    expect(r.ok && r.prs.map(p => p.number)).toEqual([12])
    expect(r).toMatchObject({ ok: true, complete: true, held: [KFOREIGN657] })
  }
  // Nothing answered: the step says why.
  const lone = (kind: 'blocked' | 'no-gh') =>
    discoverPrs(
      repoGh({ repos, fail: { [FOREIGN]: { ok: false, kind } } }).gh,
      null,
      [],
      NOW,
      undefined,
      PR_LANE_DEFAULTS,
      { created: [ref(OTHER, 657)] },
    )
  expect(await lone('blocked')).toEqual({ ok: false, skipped: 'paused' })
  expect(await lone('no-gh')).toEqual({ ok: false, skipped: 'no-gh' })
})

test('discoverPrs: a step that asks foreign hosts only does not wait for the home host to log in or to rest', async () => {
  // The tool-wide flag and breaker stand for the home host. With the session repo on GHES logged out (canCall false), a
  // created PR on an authed github.com is still asked for: nothing of the home host is asked (Codex review of #186).
  const ghes = { ...REPO, host: 'ghe.corp' }
  const ghe = { host: 'ghe.corp', owner: 'team', repo: 'svc' }
  const { gh, calls } = repoGh({
    repos: { [FOREIGN]: { 657: prNode({ number: 657 }) }, 'team/svc': { 3: prNode({ number: 3 }) } },
  })
  Object.assign(gh, { canCall: () => false })
  const r = await discoverPrs(gh, ghes, [], NOW, undefined, PR_LANE_DEFAULTS, { created: [ref(OTHER, 657)] })
  expect(calls.map(c => c.host)).toEqual(['github.com'])
  expect(r.ok && r.prs.map(p => p.number)).toEqual([657])
  expect(r).toMatchObject({ ok: true, complete: true })
  // No session repo: github.com is the home host, so a GHES PR goes on and a github.com PR waits.
  const bare = await discoverPrs(gh, null, [], NOW, undefined, PR_LANE_DEFAULTS, { created: [ref(ghe, 3)] })
  expect(bare.ok && bare.prs.map(p => [p.host, p.number])).toEqual([['ghe.corp', 3]])
  expect(await discoverPrs(gh, null, [], NOW, undefined, PR_LANE_DEFAULTS, { created: [ref(OTHER, 657)] })).toEqual({
    ok: false,
    skipped: 'paused',
  })
  // A group of the home host waits, as before: a tracked branch of the session repo, or a created PR in it.
  expect(
    await discoverPrs(gh, ghes, ['feat/root'], NOW, 'main', PR_LANE_DEFAULTS, { created: [ref(OTHER, 657)] }),
  ).toEqual({
    ok: false,
    skipped: 'paused',
  })
  expect(await discoverPrs(gh, ghes, [], NOW, undefined, PR_LANE_DEFAULTS, { created: [ref(ghes, 12)] })).toEqual({
    ok: false,
    skipped: 'paused',
  })
})

test('discoverPrs: a later query of the session repo that fails holds its PRs; the first one, with the branches, fails the step', async () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => i + 1)
  const nodes = (numbers: number[]) => Object.fromEntries(numbers.map(n => [n, prNode({ number: n })]))
  const created = many(60).map(n => ref(REPO, n))
  const run = async (failAt: number) => {
    let n = 0
    const { gh } = repoGh({ repos: { [SESSION]: nodes(many(60)) } })
    const real = gh.graphql.bind(gh)
    Object.assign(gh, {
      graphql: async (host: string, q: string): Promise<GraphqlOutcome> =>
        n++ === failAt ? { ok: false, kind: 'transport', error: 'timeout' } : real(host, q),
    })
    return discoverPrs(gh, REPO, ['feat/root'], NOW, 'main', PR_LANE_DEFAULTS, { created })
  }
  // The second query (PRs 51 to 60, no branch) fails: the branch results and the first 50 PRs are kept, the rest held.
  const later = await run(1)
  expect(later.ok && later.prs).toHaveLength(50)
  expect(later).toMatchObject({ ok: true, complete: true, defaultBranch: 'main' })
  expect(later.ok && later.held).toEqual(
    many(60)
      .slice(50)
      .map(i => `gh:github.com/acme/web#${i}`),
  )
  // The first query carries the branches of the session repo: its failure fails the step, as before.
  expect(await run(0)).toEqual({ ok: false, error: 'timeout' })
})

test('discoverPrs: a PR that the first query returned is not held when a later query of the session repo fails', async () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => i + 1)
  const nodes = (numbers: number[]) => Object.fromEntries(numbers.map(n => [n, prNode({ number: n })]))
  // #55 is the head of the tracked branch, so the first query returns it by a head alias, and it is also a created PR in the
  // second chunk (51 to 60). The second query fails: a PR that parsed is read, and never held (Codex review of #186).
  const { gh } = repoGh({
    repos: { [SESSION]: nodes(many(60)) },
    heads: { 'head:feat/root': [prNode({ number: 55, headRefName: 'feat/root' })] },
  })
  let n = 0
  const real = gh.graphql.bind(gh)
  Object.assign(gh, {
    graphql: async (host: string, q: string): Promise<GraphqlOutcome> =>
      n++ === 1 ? { ok: false, kind: 'transport', error: 'timeout' } : real(host, q),
  })
  const created = many(60).map(i => ref(REPO, i))
  const r = await discoverPrs(gh, REPO, ['feat/root'], NOW, 'main', PR_LANE_DEFAULTS, { created })
  expect(r.ok && r.prs.map(p => p.number)).toContain(55)
  expect(r.ok && r.prs.filter(p => p.number === 55)).toHaveLength(1)
  expect(r).toMatchObject({ ok: true, complete: true })
  expect(r.ok && r.held).toEqual(
    many(60)
      .slice(50)
      .filter(i => i !== 55)
      .map(i => `gh:github.com/acme/web#${i}`),
  )
})

test('discoverPrs: an unsure created PR in a later query of the session repo makes the reply incomplete, as in the first one', async () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => i + 1)
  const nodes = (numbers: number[]) => Object.fromEntries(numbers.map(n => [n, prNode({ number: n })]))
  const created = many(60).map(n => ref(REPO, n))
  // #55 is in the second query and has no verdict (null, no NOT_FOUND): no prune may run on the session repo.
  const { gh } = repoGh({ repos: { [SESSION]: nodes(many(60).filter(n => n !== 55)) } })
  const r = await discoverPrs(gh, REPO, ['feat/root'], NOW, 'main', PR_LANE_DEFAULTS, { created })
  expect(r.ok && r.prs).toHaveLength(59)
  expect(r).toMatchObject({ ok: true, complete: false })
  // The same in the first query.
  const first = repoGh({ repos: { [SESSION]: nodes(many(60).filter(n => n !== 5)) } })
  expect(await discoverPrs(first.gh, REPO, ['feat/root'], NOW, 'main', PR_LANE_DEFAULTS, { created })).toMatchObject({
    ok: true,
    complete: false,
  })
})

test('discoverPrs: a session group of the known default branch alone asks nothing, so it does not gate a foreign PR', async () => {
  const ghes = { ...REPO, host: 'ghe.corp' }
  const { gh, calls } = repoGh({ repos: { [FOREIGN]: { 657: prNode({ number: 657 }) } } })
  Object.assign(gh, { canCall: () => false })
  const r = await discoverPrs(gh, ghes, ['main'], NOW, 'main', PR_LANE_DEFAULTS, { created: [ref(OTHER, 657)] })
  expect(calls.map(c => c.host)).toEqual(['github.com'])
  expect(r.ok && r.prs.map(p => p.number)).toEqual([657])
  expect(r).toMatchObject({ ok: true, defaultBranch: 'main' }) // the group is still counted as answered
  // The default branch is not known yet (a cold start): `main` gets aliases, and the home host is asked, so the gate holds.
  expect(
    await discoverPrs(gh, ghes, ['main'], NOW, undefined, PR_LANE_DEFAULTS, { created: [ref(OTHER, 657)] }),
  ).toEqual({
    ok: false,
    skipped: 'paused',
  })
})

test('discoverPrs: the created PRs of one repo ask at most 50 aliases a query, the branches in the first one', async () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => i + 1)
  const nodes = (numbers: number[]) => Object.fromEntries(numbers.map(n => [n, prNode({ number: n })]))
  // Another repo, 120 PRs: 50, 50 and 20.
  const foreign = repoGh({ repos: { [FOREIGN]: nodes(many(120)) } })
  const r = await discoverPrs(foreign.gh, null, [], NOW, undefined, PR_LANE_DEFAULTS, {
    created: many(120).map(n => ref(OTHER, n)),
  })
  expect(foreign.calls).toHaveLength(3)
  expect(foreign.calls.map(c => (c.query.match(/: pullRequest\(number:/g) ?? []).length)).toEqual([50, 50, 20])
  expect(r.ok && r.prs).toHaveLength(120)
  // The session repo: 60 created PRs and one branch. The branch rides in the first query only.
  const own = repoGh({ repos: { [SESSION]: nodes(many(60)) } })
  const s = await discoverPrs(own.gh, REPO, ['feat/root'], NOW, 'main', PR_LANE_DEFAULTS, {
    created: many(60).map(n => ref(REPO, n)),
  })
  expect(own.calls.map(c => (c.query.match(/: pullRequest\(number:/g) ?? []).length)).toEqual([50, 10])
  expect(own.calls.map(c => c.query.includes('pullRequests(headRefName'))).toEqual([true, false])
  expect(s.ok && s.prs).toHaveLength(60)
  expect(s).toMatchObject({ ok: true, complete: true, defaultBranch: 'main' })
  // A chunk that fails holds its own PRs only, and the chunks before it are kept.
  let n = 0
  const flaky = repoGh({ repos: { [FOREIGN]: nodes(many(60)) } })
  const real = flaky.gh.graphql.bind(flaky.gh)
  Object.assign(flaky.gh, {
    graphql: async (host: string, q: string): Promise<GraphqlOutcome> =>
      n++ === 1 ? { ok: false, kind: 'transport', error: 'timeout' } : real(host, q),
  })
  const f = await discoverPrs(flaky.gh, null, [], NOW, undefined, PR_LANE_DEFAULTS, {
    created: many(60).map(i => ref(OTHER, i)),
  })
  expect(f.ok && f.prs).toHaveLength(50)
  expect(f).toMatchObject({ ok: true, complete: true })
  expect(f.ok && f.held).toEqual(
    many(60)
      .slice(50)
      .map(i => `gh:github.com/verticeone/vertice-iam#${i}`),
  )
})

test('discoverPrs: a host that is not the home host is checked before it is asked, github.com too, and held when gh is not logged in', async () => {
  const ghes = { ...REPO, host: 'ghe.corp' }
  const repos = { [SESSION]: { 12: prNode({ number: 12 }) }, [FOREIGN]: { 657: prNode({ number: 657 }) } }
  // The session repo is on a GHES host, a created PR is on github.com where gh is logged out: the check says no, so
  // github.com is never queried (a refused query would log the whole tool out), and the GHES answers stay.
  const out = repoGh({ repos, authed: host => host !== 'github.com' })
  const r = await discoverPrs(out.gh, ghes, ['feat/root'], NOW, 'main', PR_LANE_DEFAULTS, {
    created: [ref(ghes, 12), ref(OTHER, 657)],
  })
  expect(out.checked).toEqual(['ghe.corp', 'github.com'])
  expect(out.calls.map(c => c.host)).toEqual(['ghe.corp'])
  expect(r.ok && r.prs.map(p => [p.host, p.number])).toEqual([['ghe.corp', 12]])
  expect(r).toMatchObject({ ok: true, complete: true, held: [KFOREIGN657] })
  // The session repo is on github.com too: that host is the home host, and it is not checked.
  const same = repoGh({ repos, authed: false })
  const s = await discoverPrs(same.gh, REPO, ['feat/root'], NOW, 'main', PR_LANE_DEFAULTS, {
    created: [ref(REPO, 12), ref(OTHER, 657)],
  })
  expect(same.checked).toEqual([])
  expect(s.ok && s.prs.map(p => p.number)).toEqual([12, 657])
  // No session repo: github.com is the home host as well.
  const bare = repoGh({ repos, authed: false })
  const b = await discoverPrs(bare.gh, null, [], NOW, undefined, PR_LANE_DEFAULTS, { created: [ref(OTHER, 657)] })
  expect(bare.checked).toEqual([])
  expect(b.ok && b.prs.map(p => p.number)).toEqual([657])
})

test('discoverPrs: a check that could not run is an error of the step, and only a denial is "not logged in"', async () => {
  const ghe = { host: 'ghe.corp', owner: 'team', repo: 'svc' }
  // A timeout, a network error or a host at rest: the login is not known, so the pane must not say "log in" (Codex review of #186).
  const lost = repoGh({ repos: {}, unreachable: () => true })
  expect(await discoverPrs(lost.gh, null, [], NOW, undefined, PR_LANE_DEFAULTS, { created: [ref(ghe, 3)] })).toEqual({
    ok: false,
    error: 'gh could not check the login to ghe.corp',
  })
  // The same for the session repo on that host.
  const own = await discoverPrs(lost.gh, { ...REPO, host: 'ghe.corp' }, ['feat/root'], NOW, 'main', PR_LANE_DEFAULTS, {
    created: [],
  })
  expect(own).toEqual({ ok: false, error: 'gh could not check the login to ghe.corp' })
  // An explicit denial is still "not logged in", and with something answered the PRs of the host are held either way.
  const denied = repoGh({ repos: {}, authed: false })
  expect(await discoverPrs(denied.gh, null, [], NOW, undefined, PR_LANE_DEFAULTS, { created: [ref(ghe, 3)] })).toEqual({
    ok: false,
    skipped: 'host-not-authed',
    host: 'ghe.corp',
  })
  const mixed = repoGh({ repos: { [SESSION]: { 12: prNode({ number: 12 }) } }, unreachable: h => h === 'ghe.corp' })
  const r = await discoverPrs(mixed.gh, REPO, ['feat/root'], NOW, 'main', PR_LANE_DEFAULTS, {
    created: [ref(REPO, 12), ref(ghe, 3)],
  })
  expect(r.ok && r.prs.map(p => p.number)).toEqual([12])
  expect(r).toMatchObject({ ok: true, complete: true, held: ['gh:ghe.corp/team/svc#3'] })
})

test('discoverPrs: the skip of a host that gh is not logged in to names that host', async () => {
  // A created-only session: the host is the one of the PR, which the session repo cannot tell (Codex review of #186).
  const ghe = { host: 'ghe.corp', owner: 'team', repo: 'svc' }
  const { gh } = repoGh({ repos: {}, authed: false })
  const created = [ref(ghe, 3)]
  expect(await discoverPrs(gh, null, [], NOW, undefined, PR_LANE_DEFAULTS, { created })).toEqual({
    ok: false,
    skipped: 'host-not-authed',
    host: 'ghe.corp',
  })
  // The host that answered `auth` to a query is named too, in any case it was made with.
  const refused = repoGh({ repos: {}, fail: { [FOREIGN]: { ok: false, kind: 'auth' } } })
  expect(
    await discoverPrs(refused.gh, null, [], NOW, undefined, PR_LANE_DEFAULTS, { created: [ref(OTHER, 657)] }),
  ).toEqual({
    ok: false,
    skipped: 'not-logged-in',
    host: 'github.com',
  })
  // gh is not logged in at all, or paused: no host says no.
  const none = await discoverPrs(fakeGh({ can: false, loggedIn: false }).gh, REPO, ['a'], NOW)
  expect('host' in none).toBe(false)
})

test('discoverPrs: a created PR on a host that no call asked about yet is asked for, once the host is checked', async () => {
  // The session is on github.com, the PR was made on a GitHub Enterprise host that the repo lookup never saw: gh may well be
  // logged in to it, and only `checkHost` knows. github.com itself is never checked.
  const ghe = { host: 'ghe.corp', owner: 'team', repo: 'svc' }
  const { gh, calls, checked } = repoGh({
    repos: { [SESSION]: { 12: prNode({ number: 12 }) }, 'team/svc': { 3: prNode({ number: 3 }) } },
  })
  const r = await discoverPrs(gh, REPO, ['feat/root'], NOW, 'main', PR_LANE_DEFAULTS, {
    created: [ref(REPO, 12), ref(ghe, 3)],
  })
  expect(checked).toEqual(['ghe.corp'])
  expect(calls.map(c => [c.host, c.repo])).toEqual([
    ['github.com', SESSION],
    ['ghe.corp', 'team/svc'],
  ])
  expect(r.ok && r.prs.map(p => [p.host, p.number])).toEqual([
    ['github.com', 12],
    ['ghe.corp', 3],
  ])
  expect(r).toMatchObject({ ok: true, complete: true })
  expect('held' in r).toBe(false)
})

test('discoverPrs: a repo on a host that gh is not logged in to is skipped, and its PRs are held', async () => {
  const ghe = { host: 'ghe.corp', owner: 'team', repo: 'svc' }
  const { gh, calls } = repoGh({ repos: { [SESSION]: { 12: prNode({ number: 12 }) } }, authed: false })
  const r = await discoverPrs(gh, REPO, ['feat/root'], NOW, 'main', PR_LANE_DEFAULTS, {
    created: [ref(REPO, 12), ref(ghe, 3)],
  })
  expect(calls.map(c => c.repo)).toEqual([SESSION])
  expect(r).toMatchObject({ ok: true, complete: true, held: ['gh:ghe.corp/team/svc#3'] })
  const alone = await discoverPrs(gh, null, [], NOW, undefined, PR_LANE_DEFAULTS, { created: [ref(ghe, 3)] })
  expect(alone).toEqual({ ok: false, skipped: 'host-not-authed', host: 'ghe.corp' })
})
