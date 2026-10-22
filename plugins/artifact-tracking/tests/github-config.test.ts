// The github slice reaches the gh tool, the PR discovery, the PR body scan, the discovery apply step and the short-ref
// keywords. Each test uses a value that is not the default, so it fails on the old constant. Plan: L4 Task 7 (C2, C15).
import { expect, test } from 'claude-code/testing'
import { GITHUB_DEFAULTS, PR_LANE_DEFAULTS } from '../trackers/github/config'
import { applyDiscovery } from '../trackers/github/discovered'
import { buildQuery, GhTool } from '../trackers/github/gh-tool'
import { prBodyRefs } from '../trackers/github/pr-body'
import { buildDiscoveryQuery, discoverPrs, parseDiscovery } from '../trackers/github/pr-discovery'
import type { GitHubDiscoveryApi, GitHubTarget, GraphqlReply, ItemRecord, RunInit, Runner } from './fixtures/contracts'
import { discovered, discoveryData, prNode, REPO } from './fixtures/gh-discovery'
import { reasonsOfSources } from './fixtures/reasons'
import { extractRefs, scanBody } from './fixtures/refs'
import { buildRecord } from './fixtures/registry'

const NOW = 1_000_000

const target = (n: number): GitHubTarget => ({
  key: `gh:github.com/o/r#${n}`,
  host: 'github.com',
  owner: 'o',
  repo: 'r',
  number: n,
  type: 'unknown',
})

function runner(): { run: Runner; calls: { argv: string[]; init: RunInit | undefined }[] } {
  const calls: { argv: string[]; init: RunInit | undefined }[] = []
  const run: Runner = async (argv, init) => {
    calls.push({ argv: [...argv], init })
    return { exitCode: 0, stdout: argv[1] === 'api' ? '{"data":{}}' : 'gh version 2.102.0 (2026-09-30)', stderr: '' }
  }
  return { run, calls }
}

const limits =
  (over: Partial<typeof GITHUB_DEFAULTS> = {}) =>
  () => ({ ...GITHUB_DEFAULTS, ...over })
const queryOf = (argv: string[]): string => argv.find(x => x.startsWith('query='))?.slice('query='.length) ?? ''

// ---------------------------------------------------------------- the gh tool

test('chunkSize 2 splits three items of one host into two calls', async () => {
  const { run, calls } = runner()
  const tool = new GhTool(run, () => NOW, undefined, { limits: limits({ chunkSize: 2 }) })
  await tool.refreshItems([target(1), target(2), target(3)])
  const graphql = calls.filter(c => c.argv[1] === 'api')
  expect(graphql.length).toBe(2)
  expect(graphql.map(c => [...queryOf(c.argv).matchAll(/\ba\d+: repository\(/g)].length)).toEqual([2, 1])
})

test('chunkSize is read at each refresh, so a changed file shows at the next one', async () => {
  const { run, calls } = runner()
  let chunkSize = 50
  const tool = new GhTool(run, () => NOW, undefined, { limits: () => ({ ...GITHUB_DEFAULTS, chunkSize }) })
  await tool.refreshItems([target(1), target(2), target(3)])
  chunkSize = 1
  await tool.refreshItems([target(1), target(2), target(3)])
  expect(calls.filter(c => c.argv[1] === 'api').length).toBe(1 + 3)
})

test('with no opts the tool batches 50 items per call, as before', async () => {
  const { run, calls } = runner()
  const tool = new GhTool(run, () => NOW)
  await tool.refreshItems(Array.from({ length: 51 }, (_, i) => target(i + 1)))
  expect(calls.filter(c => c.argv[1] === 'api').length).toBe(2)
})

test('buildQuery writes the closing refs count', () => {
  expect(buildQuery([target(1)], 3).query).toContain('closingIssuesReferences(first: 3)')
  expect(buildQuery([target(1)]).query).toContain('closingIssuesReferences(first: 10)')
})

test('a refresh builds its query with closingRefsPerPr from the limits', async () => {
  const { run, calls } = runner()
  const tool = new GhTool(run, () => NOW, undefined, { limits: limits({ closingRefsPerPr: 4 }) })
  await tool.refreshItems([target(1)])
  expect(queryOf(calls.find(c => c.argv[1] === 'api')!.argv)).toContain('closingIssuesReferences(first: 4)')
})

test('discovery runs with discoveryTimeoutMs', async () => {
  const { run, calls } = runner()
  const tool = new GhTool(run, () => NOW, undefined, { limits: limits({ discoveryTimeoutMs: 2500 }) })
  await tool.probe()
  const out = await tool.graphql('github.com', 'query { x }')
  expect(out.ok).toBe(true)
  expect(calls.find(c => c.argv[1] === 'api')?.init?.timeoutMs).toBe(2500)
})

// ---------------------------------------------------------------- the PR lane

test('the lane sets first: for head, base and closing refs', () => {
  const lane = { ...PR_LANE_DEFAULTS, headPrsPerBranch: 2, basePrsPerBranch: 3, closingRefsPerPr: 4 }
  const { query } = buildDiscoveryQuery(REPO, ['feat/a'], 'main', lane)
  expect(query).toContain('headRefName: "feat/a", first: 2')
  expect(query).toContain('baseRefName: "feat/a", first: 3')
  expect(query).toContain('closingIssuesReferences(first: 4)')
})

test('with no lane the query keeps today numbers: 5, 10 and 10', () => {
  const { query } = buildDiscoveryQuery(REPO, ['feat/a'], 'main')
  expect(query).toContain('headRefName: "feat/a", first: 5')
  expect(query).toContain('baseRefName: "feat/a", first: 10')
  expect(query).toContain('closingIssuesReferences(first: 10)')
})

function fakeGh() {
  const queries: string[] = []
  const gh = {
    isAvailable: true,
    canCall: () => true,
    canCallHost: () => true,
    status: () => ({ name: 'gh', available: true, loggedIn: true, breaker: 'closed' }),
    isHostAuthed: () => true,
    graphql: async (_host: string, q: string) => {
      queries.push(q)
      return { ok: true as const, reply: { data: discoveryData({}), errors: [] } satisfies GraphqlReply }
    },
  } as unknown as GitHubDiscoveryApi
  return { gh, queries }
}

test('discoverPrs polls lane.maxBranches branches', async () => {
  const { gh, queries } = fakeGh()
  await discoverPrs(gh, REPO, ['a', 'b', 'c', 'd', 'e'], NOW, undefined, { ...PR_LANE_DEFAULTS, maxBranches: 2 })
  expect(queries.length).toBe(1)
  expect(queries[0]).toContain('h1:')
  expect(queries[0]).not.toContain('h2:')
  await discoverPrs(gh, REPO, ['a', 'b', 'c', 'd', 'e'], NOW) // no cap of its own: all five
  expect(queries[1]).toContain('h4:')
})

test('discoverPrs cuts the closing refs of a PR to lane.closingRefsPerPr', async () => {
  const node = prNode({ number: 7, closing: [{ number: 1 }, { number: 2 }, { number: 3 }] })
  const gh = {
    ...fakeGh().gh,
    graphql: async () => ({ ok: true as const, reply: { data: discoveryData({ h0: [node], b0: [] }), errors: [] } }),
  } as unknown as GitHubDiscoveryApi
  const out = await discoverPrs(gh, REPO, ['feat/a'], NOW, undefined, { ...PR_LANE_DEFAULTS, closingRefsPerPr: 2 })
  expect(out.ok && out.prs[0]?.closing.length).toBe(2)
  const parsed = parseDiscovery(
    { data: discoveryData({ h0: [node], b0: [] }), errors: [] },
    REPO,
    buildDiscoveryQuery(REPO, ['feat/a']).aliases,
  )
  expect(parsed.prs[0]?.closing.length).toBe(3) // the default of 10
})

// ---------------------------------------------------------------- the PR body and the apply step

test('prBodyRefs keeps max refs', () => {
  const pr = discovered({ body: 'see #3 and #4 and #5' })
  expect(prBodyRefs(pr, scanBody).length).toBe(3)
  expect(prBodyRefs(pr, scanBody, 1).length).toBe(1)
})

const records = (list: readonly { key: string }[]) => list.map(r => r.key)

test('applyDiscovery caps.maxAutoItems 1 adds one auto item', () => {
  const input = {
    prs: [discovered({ number: 7 }), discovered({ number: 8 })],
    refsByPr: new Map(),
    complete: true,
    dismissed: new Set<string>(),
    at: NOW,
    build: buildRecord,
  }
  const caps = { staleMs: 300000, maxAutoItems: 1, maxItems: 500 }
  expect(records(applyDiscovery([], { ...input, caps }).list)).toEqual(['gh:github.com/acme/web#7'])
  expect(applyDiscovery([], input).list.length).toBe(2) // the default is 100
})

test('applyDiscovery caps.staleMs sets how long a discovered record stays current', () => {
  const pr = discovered({ number: 7 })
  const input = { prs: [pr], refsByPr: new Map(), complete: true, dismissed: new Set<string>(), build: buildRecord }
  const first = applyDiscovery([], { ...input, at: 1000 }).list
  // A record is current for half of staleMs. At 1000 + 100000 the default (150000) still says current.
  expect(applyDiscovery(first, { ...input, at: 101_000 }).list).toBe(first)
  const caps = { staleMs: 100_000, maxAutoItems: 100, maxItems: 500 }
  expect(applyDiscovery(first, { ...input, at: 101_000, caps }).list).not.toBe(first)
})

test('applyDiscovery caps.maxItems caps the items that are not auto-only', () => {
  const mention = (n: number): ItemRecord =>
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
    }) as ItemRecord
  const list = [mention(1), mention(2), mention(3)]
  const input = {
    prs: [],
    refsByPr: new Map(),
    complete: true,
    dismissed: new Set<string>(),
    at: NOW,
    build: buildRecord,
  }
  const out = applyDiscovery(list, { ...input, caps: { staleMs: 300000, maxAutoItems: 100, maxItems: 2 } })
  expect(records(out.list)).toEqual(['web:https://h2.example/', 'web:https://h3.example/'])
})

// ---------------------------------------------------------------- the short-ref keywords

const refs = (text: string, shortRefWords?: readonly string[]) =>
  extractRefs(text, {
    mode: 'full',
    defaultRepo: { host: 'github.com', owner: 'acme', repo: 'web' },
    strictShortRefs: true,
    ...(shortRefWords ? { shortRefWords } : {}),
  })

test("shortRefWords ['ticket'] makes 'ticket #5' a short ref and 'issue #5' not", () => {
  expect(refs('see ticket #5', ['ticket']).map(r => r.category === 'github' && r.number)).toEqual([5])
  expect(refs('see issue #5', ['ticket'])).toEqual([])
})

test('the default words still make issue #5 a short ref and ticket #5 not', () => {
  expect(refs('see issue #5').length).toBe(1)
  expect(refs('see ticket #5')).toEqual([])
})

test('an empty word list makes no keyword short ref', () => {
  expect(refs('see issue #5', [])).toEqual([])
  expect(refs('bug #5', [])).toEqual([])
})

test('a word list changes the next call, and the match is not case sensitive', () => {
  expect(refs('Ticket #5', ['ticket']).length).toBe(1)
  expect(refs('Ticket #5', ['task']).length).toBe(0)
  expect(refs('Task #5', ['task']).length).toBe(1)
})

test('a keyword with a regex character is matched as text', () => {
  expect(refs('see c++ #5', ['c++']).length).toBe(1)
  expect(refs('see cc #5', ['c++']).length).toBe(0)
})
