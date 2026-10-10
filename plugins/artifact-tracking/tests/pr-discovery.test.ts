// PR discovery: query shape, reply parsing, skip reasons and outcome mapping. Pure, fake gh.
import { expect, test } from 'claude-code/testing'
import type { GitHubDiscoveryApi, GraphqlOutcome, GraphqlReply, ToolStatus } from '../hooks/contracts'
import { LIMITS } from '../hooks/contracts'
import { buildDiscoveryQuery, discoverPrs, parseDiscovery } from '../hooks/tools/pr-discovery'
import { discoveryData, prNode, REPO } from './fixtures/gh-discovery'

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
    isHostAuthed: () => over.authed,
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
  })
  expect((await discoverPrs(fakeGh({ authed: true }).gh, ghe, ['a'], NOW)).ok).toBe(true)
})

test('discoverPrs maps each failed outcome to a skip or an error', async () => {
  const out = (outcome: GraphqlOutcome, lastError?: string) =>
    discoverPrs(fakeGh({ outcome, lastError }).gh, REPO, ['a'], NOW)
  expect(await out({ ok: false, kind: 'blocked' })).toEqual({ ok: false, skipped: 'paused' })
  expect(await out({ ok: false, kind: 'auth' })).toEqual({ ok: false, skipped: 'not-logged-in' })
  expect(await out({ ok: false, kind: 'no-gh' })).toEqual({ ok: false, skipped: 'no-gh' })
  expect(await out({ ok: false, kind: 'transport' }, 'timeout')).toEqual({ ok: false, error: 'timeout' })
  expect(await out({ ok: false, kind: 'truncated' })).toEqual({ ok: false, error: 'reply over 4 MiB' })
  expect(await out({ ok: false, kind: 'query-error', error: 'Field x' })).toEqual({ ok: false, error: 'Field x' })
})

test('discoverPrs returns the parsed PRs, and polls at most maxBranches', async () => {
  const { gh, queries } = fakeGh({})
  const branches = Array.from({ length: 15 }, (_, i) => `b${i}`)
  const r = await discoverPrs(gh, REPO, branches, NOW)
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
