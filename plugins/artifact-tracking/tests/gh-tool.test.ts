// GhTool: batched GraphQL refresh, outcome classification, host and repo probes. Pure, fake Runner.
import { expect, test } from 'claude-code/testing'
import type { GitHubTarget, RunInit, Runner, RunResult } from '../hooks/contracts'
import { LIMITS } from '../hooks/contracts'
import { buildQuery, classifyReply, GhTool, rollupToChecks } from '../hooks/tools/gh-tool'
import * as fx from './fixtures/gh'

const NOW = 1_000_000
const ok = (stdout = '', exitCode = 0, stderr = ''): RunResult => ({ exitCode, stdout, stderr })

function item(owner: string | undefined, repo: string | undefined, number: number, host = 'github.com'): GitHubTarget {
  const key = owner && repo ? `gh:${host}/${owner}/${repo}#${number}`.toLowerCase() : `gh:?#${number}`
  const t: GitHubTarget = { key, host, number, type: 'unknown' }
  if (owner !== undefined) t.owner = owner
  if (repo !== undefined) t.repo = repo
  return t
}

/**
 * Replays a fixture for the `gh api graphql` call. The fixture uses its own alias names.
 * They are renamed, in order, to the aliases found in the query that was sent.
 */
function remap(fixture: string, query: string): string {
  const sent = [...query.matchAll(/\b(a\d+): repository\(/g)].map(m => m[1] as string)
  const parsed = JSON.parse(fixture) as { data: Record<string, unknown>; errors?: { path: string[] }[] }
  const names = Object.keys(parsed.data).filter(k => k !== 'rateLimit')
  const rename = new Map(names.map((n, i) => [n, sent[i] as string]))
  const data: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(parsed.data)) data[rename.get(k) ?? k] = v
  const out: Record<string, unknown> = { data }
  if (parsed.errors)
    out.errors = parsed.errors.map(e => ({
      ...e,
      path: [rename.get(e.path[0] as string) ?? e.path[0], ...e.path.slice(1)],
    }))
  return JSON.stringify(out)
}

type Graphql = (query: string, argv: readonly string[]) => RunResult | Error

function rig(graphql: Graphql, extra: (argv: readonly string[]) => RunResult | Error | undefined = () => undefined) {
  const calls: string[][] = []
  const run: Runner = async argv => {
    calls.push([...argv])
    let a: RunResult | Error | undefined
    if (argv[1] === '--version') a = ok('gh version 2.102.0 (2026-09-30)')
    else if (argv[1] === 'api' && argv[2] === 'graphql') {
      const q = argv.find(x => x.startsWith('query='))?.slice('query='.length) ?? ''
      a = graphql(q, argv)
    } else a = extra(argv)
    if (a === undefined) throw new Error(`unexpected call: ${argv.join(' ')}`)
    if (a instanceof Error) throw a
    return a
  }
  const graphqlCalls = () => calls.filter(c => c[1] === 'api')
  return { run, calls, graphqlCalls }
}

test('fixtures: every JSON fixture parses', () => {
  for (const json of [
    fx.BATCH_SAMPLE_OUTPUT,
    fx.BATCH_50_PROBE_OUTPUT,
    fx.AUTH_BAD_TOKEN_STDOUT,
    fx.REPO_RESOLUTION_STDOUT,
  ]) {
    expect(() => JSON.parse(json)).not.toThrow()
  }
})

test('three items in two repos make one graphql call and update every field', async () => {
  const { run, graphqlCalls } = rig(q => ok(remap(fx.BATCH_SAMPLE_OUTPUT, q)))
  const tool = new GhTool(run, () => NOW)
  const [issue, pr, merged] = [item('cli', 'cli', 14622), item('cli', 'cli', 14640), item('other', 'repo', 14633)]
  await tool.refreshItems([issue!, pr!, merged!])

  expect(graphqlCalls().length).toBe(1)
  expect(issue).toMatchObject({ type: 'issue', state: 'closed', stateReason: 'DUPLICATE', refreshedAt: NOW })
  expect(issue!.title).toContain('gh pr edit fails')
  expect(issue!.checks).toBeUndefined()
  expect(pr).toMatchObject({
    type: 'pr',
    state: 'open',
    isDraft: false,
    reviewDecision: 'REVIEW_REQUIRED',
    checks: 'failure',
    refreshedAt: NOW,
  })
  expect(pr!.stateReason).toBeUndefined()
  expect(merged).toMatchObject({ type: 'pr', state: 'merged', checks: 'none' })
  expect(tool.status().breaker).toBe('closed')
  expect(tool.status().loggedIn).toBe(true)
})

test('the call carries the query, rateLimit and always a --hostname, also for github.com', async () => {
  const { run, graphqlCalls } = rig(q => ok(remap(fx.BATCH_SAMPLE_OUTPUT, q)))
  const tool = new GhTool(run, () => NOW)
  await tool.refreshItems([item('cli', 'cli', 1), item('cli', 'cli', 2), item('cli', 'cli', 3)])
  const argv = graphqlCalls()[0]!
  expect(argv.slice(0, 4)).toEqual(['gh', 'api', 'graphql', '--hostname'])
  expect(argv[4]).toBe('github.com')
  const q = argv[argv.length - 1]!
  expect(q.startsWith('query=')).toBe(true)
  expect(q).toContain('rateLimit { cost remaining }')
  expect(q).toContain('a0: repository(owner: "cli", name: "cli")')
  expect(q).toContain('issueOrPullRequest(number: 3)')
})

test('a NOT_FOUND alias returns exit 1 with JSON: that item errors, the others update, breaker stays closed', async () => {
  const { run } = rig(q => ok(remap(fx.BATCH_50_PROBE_OUTPUT, q), 1, fx.BATCH_50_PROBE_STDERR))
  const tool = new GhTool(run, () => NOW)
  const items = [item('cli', 'cli', 14600), item('cli', 'cli', 14601), item('cli', 'cli', 14602)]
  await tool.refreshItems(items)
  expect(items[0]!.error).toMatchObject({ kind: 'not-found', at: NOW })
  expect(items[0]!.error!.message).toContain('Could not resolve to an issue or pull request')
  expect(items[0]!.refreshedAt).toBe(NOW)
  expect(items[1]).toMatchObject({ type: 'issue', state: 'closed', stateReason: 'NOT_PLANNED' })
  expect(items[1]!.error).toBeUndefined()
  expect(items[2]).toMatchObject({ type: 'pr', state: 'closed', checks: 'none' })
  expect(tool.status().breaker).toBe('closed')
})

test('a later good answer clears the not-found error', async () => {
  let n = 0
  const { run } = rig(q => ok(remap(n++ === 0 ? fx.BATCH_50_PROBE_OUTPUT : fx.BATCH_SAMPLE_OUTPUT, q), n === 1 ? 1 : 0))
  const tool = new GhTool(run, () => NOW)
  const [a] = [item('cli', 'cli', 14600)]
  await tool.refreshItems([a!, item('cli', 'cli', 2), item('cli', 'cli', 3)])
  expect(a!.error).toBeDefined()
  await tool.refreshItems([a!, item('cli', 'cli', 2), item('cli', 'cli', 3)])
  expect(a!.error).toBeUndefined()
  expect(a!.state).toBe('closed')
})

test('a FORBIDDEN alias is kept and marked failed, not not-found', async () => {
  const { run } = rig(() =>
    ok(
      JSON.stringify({
        data: { a0: null },
        errors: [{ type: 'FORBIDDEN', path: ['a0'], message: 'Resource not accessible by integration' }],
      }),
      1,
    ),
  )
  const tool = new GhTool(run, () => NOW)
  const it = item('cli', 'cli', 1)
  await tool.refreshItems([it])
  expect(it.error).toEqual({ kind: 'failed', message: 'Resource not accessible by integration', at: NOW })
  expect(tool.status().breaker).toBe('closed')
})

test('exit 4 with no JSON: not logged in, canCall is false (review focus 4)', async () => {
  const { run, graphqlCalls } = rig(() => ok('', 4, fx.AUTH_UNAUTH_STDERR))
  const tool = new GhTool(run, () => NOW)
  await tool.probe()
  expect(tool.canCall(NOW)).toBe(true)
  const it = item('cli', 'cli', 1)
  await tool.refreshItems([it])
  expect(tool.status().loggedIn).toBe(false)
  expect(tool.status().lastError).toContain('gh auth login')
  expect(tool.canCall(NOW)).toBe(false)
  expect(it.refreshedAt).toBeUndefined()
  expect(it.error).toBeUndefined()
  expect(graphqlCalls().length).toBe(1)
})

test('HTTP 401 without data is a plain failure, not "logged out": the breaker counts it (spec section 8)', async () => {
  const { run } = rig(() => ok(fx.AUTH_BAD_TOKEN_STDOUT, 1, fx.AUTH_BAD_TOKEN_STDERR))
  const tool = new GhTool(run, () => NOW)
  await tool.probe()
  await tool.refreshItems([item('cli', 'cli', 1)])
  expect(tool.status().loggedIn).not.toBe(false)
  expect(tool.canCall(NOW)).toBe(true)
})

test('an unreachable host is a tool failure, not an auth failure', async () => {
  const { run } = rig(() => ok('', 1, fx.GHE_HOST_PROBE_STDERR))
  const tool = new GhTool(run, () => NOW)
  await tool.probe()
  await tool.refreshItems([item('o', 'r', 1, 'ghe.example.invalid')])
  expect(tool.status().loggedIn).toBe(null)
  expect(tool.status().lastError).toBe('error connecting to ghe.example.invalid')
})

test('unparsable output is a tool failure', async () => {
  const { run } = rig(() => ok('<html>oops</html>', 0, ''))
  const tool = new GhTool(run, () => NOW)
  const it = item('cli', 'cli', 1)
  await tool.refreshItems([it])
  expect(tool.status().lastError).toBe('unparsable gh output')
  expect(it.refreshedAt).toBeUndefined()
})

test('three runner rejections open the breaker; the 4th refresh makes no call', async () => {
  const { run, graphqlCalls } = rig(() => new Error('artifact-tracking: $.process.run(gh) failed to start: ENOENT'))
  const tool = new GhTool(run, () => NOW)
  for (let i = 0; i < LIMITS.breakerThreshold; i++) await tool.refreshItems([item('cli', 'cli', 1)])
  expect(tool.status().breaker).toBe('open')
  expect(graphqlCalls().length).toBe(LIMITS.breakerThreshold)
  await tool.refreshItems([item('cli', 'cli', 1)])
  expect(graphqlCalls().length).toBe(LIMITS.breakerThreshold)
})

test('an unresolved item makes no call', async () => {
  const { run, calls } = rig(() => ok(''))
  const tool = new GhTool(run, () => NOW)
  const bare = item(undefined, undefined, 7)
  await tool.refreshItems([bare])
  expect(calls).toEqual([])
  expect(bare.error).toBeUndefined()
})

test('an invalid owner or repo gets an error and no call', async () => {
  const { run, calls } = rig(() => ok(''))
  const tool = new GhTool(run, () => NOW)
  const evil = item('cli"){x}', 'cli', 1)
  const evilRepo = item('cli', 'a b', 2)
  await tool.refreshItems([evil, evilRepo])
  expect(calls).toEqual([])
  expect(evil.error).toEqual({ kind: 'not-found', message: 'invalid repo', at: NOW })
  expect(evilRepo.error).toEqual({ kind: 'not-found', message: 'invalid repo', at: NOW })
})

test('a valid item next to an invalid one is still refreshed', async () => {
  const { run, graphqlCalls } = rig(q => ok(remap(fx.BATCH_SAMPLE_OUTPUT, q)))
  const tool = new GhTool(run, () => NOW)
  const good = item('cli', 'cli', 14622)
  await tool.refreshItems([item('b d', 'x', 1), good])
  expect(graphqlCalls().length).toBe(1)
  expect(good.state).toBe('closed')
  expect(graphqlCalls()[0]!.at(-1)).not.toContain('b d')
})

test('a GHE item call carries --hostname ghe.corp; hosts never share a call', async () => {
  const { run, graphqlCalls } = rig(q => ok(remap(fx.BATCH_SAMPLE_OUTPUT, q)))
  const tool = new GhTool(run, () => NOW)
  await tool.refreshItems([item('o', 'r', 1, 'ghe.corp'), item('cli', 'cli', 2)])
  const calls = graphqlCalls()
  expect(calls.length).toBe(2)
  const ghe = calls.find(c => c.includes('ghe.corp'))!
  expect(ghe.slice(3, 5)).toEqual(['--hostname', 'ghe.corp'])
  expect(ghe.at(-1)).toContain('number: 1')
  expect(ghe.at(-1)).not.toContain('number: 2')
})

test('duplicate keys in one call share one alias and both objects update', async () => {
  const { run, graphqlCalls } = rig(q => ok(remap(fx.BATCH_SAMPLE_OUTPUT, q)))
  const tool = new GhTool(run, () => NOW)
  const x = item('cli', 'cli', 14622)
  const y = item('CLI', 'cli', 14622) // same key after lower-casing is what the model builds
  const y2 = { ...y, key: x.key }
  const other = item('cli', 'cli', 5)
  await tool.refreshItems([x, y2, other])
  const q = graphqlCalls()[0]!.at(-1)!
  expect([...q.matchAll(/\ba\d+: repository\(/g)].length).toBe(2)
  expect(x.state).toBe('closed')
  expect(y2.state).toBe('closed')
})

test('buildQuery groups by key and escapes with JSON.stringify', () => {
  const a = item('cli', 'cli', 1)
  const b = item('cli', 'cli', 1)
  const c = item('o', 'r', 2)
  const { query, aliases } = buildQuery([a, b, c])
  expect([...aliases.keys()]).toEqual(['a0', 'a1'])
  expect(aliases.get('a0')).toEqual([a, b])
  expect(aliases.get('a1')).toEqual([c])
  expect(query).toContain('a1: repository(owner: "o", name: "r")')
  expect(query).toContain('... on PullRequest')
  expect(query).toContain('statusCheckRollup { state }')
})

test('more than 50 distinct items split into chunks of 50 aliases', async () => {
  const { run, graphqlCalls } = rig(q => {
    const data: Record<string, unknown> = {}
    for (const m of q.matchAll(/\b(a\d+): repository\(/g))
      data[m[1] as string] = {
        issueOrPullRequest: { __typename: 'Issue', title: 't', state: 'OPEN', stateReason: null },
      }
    return ok(JSON.stringify({ data }))
  })
  const tool = new GhTool(run, () => NOW)
  const items = Array.from({ length: 120 }, (_, i) => item('cli', 'cli', i + 1))
  await tool.refreshItems(items)
  const sizes = graphqlCalls().map(c => [...c.at(-1)!.matchAll(/\ba\d+: repository\(/g)].length)
  expect(sizes).toEqual([50, 50, 20])
  expect(items.every(i => i.state === 'open' && i.type === 'issue')).toBe(true)
})

test('a failed chunk leaves its items unchanged; later chunks still run', async () => {
  let n = 0
  const { run, graphqlCalls } = rig(q => {
    if (n++ === 0) return ok('', 1, 'boom')
    const data: Record<string, unknown> = {}
    for (const m of q.matchAll(/\b(a\d+): repository\(/g))
      data[m[1] as string] = { issueOrPullRequest: { __typename: 'Issue', title: 't', state: 'OPEN' } }
    return ok(JSON.stringify({ data }))
  })
  const tool = new GhTool(run, () => NOW)
  const items = Array.from({ length: 60 }, (_, i) => item('cli', 'cli', i + 1))
  await tool.refreshItems(items)
  expect(graphqlCalls().length).toBe(2)
  expect(items[0]!.state).toBeUndefined()
  expect(items[59]!.state).toBe('open')
})

test('rollupToChecks maps every listed value', () => {
  expect(rollupToChecks('SUCCESS')).toBe('success')
  expect(rollupToChecks('FAILURE')).toBe('failure')
  expect(rollupToChecks('ERROR')).toBe('failure')
  expect(rollupToChecks('PENDING')).toBe('pending')
  expect(rollupToChecks('EXPECTED')).toBe('pending')
  expect(rollupToChecks(null)).toBe('none')
  expect(rollupToChecks(undefined)).toBe('none')
  expect(rollupToChecks('SOMETHING_NEW')).toBe('none')
})

test('defaultRepo parses nameWithOwner and url once, even when called twice', async () => {
  const { run, calls } = rig(
    () => ok(),
    argv =>
      argv[1] === 'repo' ? ok('{ "nameWithOwner": "acme/web", "url": "https://github.com/acme/web" }') : undefined,
  )
  const tool = new GhTool(run, () => NOW)
  const [a, b] = await Promise.all([tool.defaultRepo(), tool.defaultRepo()])
  expect(a).toEqual({ host: 'github.com', owner: 'acme', repo: 'web' })
  expect(b).toEqual(a)
  await tool.defaultRepo()
  expect(calls.filter(c => c[1] === 'repo')).toEqual([['gh', 'repo', 'view', '--json', 'nameWithOwner,url']])
})

test('defaultRepo takes the host from the url (GHE)', async () => {
  const { run } = rig(
    () => ok(),
    () => ok('{"nameWithOwner":"o/r","url":"https://ghe.corp/o/r"}'),
  )
  expect(await new GhTool(run, () => NOW).defaultRepo()).toEqual({ host: 'ghe.corp', owner: 'o', repo: 'r' })
})

test('defaultRepo falls back to github.com when the url is missing (recorded sample)', async () => {
  const { run } = rig(
    () => ok(),
    () => ok(fx.REPO_RESOLUTION_STDOUT),
  )
  expect(await new GhTool(run, () => NOW).defaultRepo()).toEqual({
    host: 'github.com',
    owner: '<owner>',
    repo: 'claude-code-mod-tracking',
  })
})

test('defaultRepo returns null on failure or rejection, and asks once', async () => {
  const bad = rig(
    () => ok(),
    () => ok('', 1, 'no git remotes found'),
  )
  const t1 = new GhTool(bad.run, () => NOW)
  expect(await t1.defaultRepo()).toBe(null)
  expect(await t1.defaultRepo()).toBe(null)
  expect(bad.calls.length).toBe(1)

  const rejecting = rig(
    () => ok(),
    () => new Error('ENOENT'),
  )
  expect(await new GhTool(rejecting.run, () => NOW).defaultRepo()).toBe(null)

  const junk = rig(
    () => ok(),
    () => ok('not json'),
  )
  expect(await new GhTool(junk.run, () => NOW).defaultRepo()).toBe(null)
  const noSlash = rig(
    () => ok(),
    () => ok('{"nameWithOwner":"nope"}'),
  )
  expect(await new GhTool(noSlash.run, () => NOW).defaultRepo()).toBe(null)
})

test('defaultRepo and checkHost do not feed the breaker', async () => {
  const { run } = rig(
    () => ok(),
    () => new Error('timeout'),
  )
  const tool = new GhTool(run, () => NOW)
  for (let i = 0; i < 5; i++) {
    await tool.checkHost(`h${i}.corp`)
    await new GhTool(run, () => NOW).defaultRepo()
  }
  expect(tool.status().breaker).toBe('closed')
  expect(tool.status().loggedIn).toBe(null)
})

test('checkHost: exit 0 is true, cached per host', async () => {
  const { run, calls } = rig(
    () => ok(),
    argv =>
      argv[1] === 'auth'
        ? argv.includes('ghe.corp')
          ? ok('Logged in')
          : ok('', 1, fx.GHE_AUTH_STATUS_STDERR)
        : undefined,
  )
  const tool = new GhTool(run, () => NOW)
  expect(tool.isHostAuthed('ghe.corp')).toBeUndefined()
  expect(await tool.checkHost('ghe.corp')).toBe(true)
  expect(await tool.checkHost('ghe.corp')).toBe(true)
  expect(await tool.checkHost('other.corp')).toBe(false)
  expect(await tool.checkHost('other.corp')).toBe(false)
  expect(tool.isHostAuthed('ghe.corp')).toBe(true)
  expect(tool.isHostAuthed('other.corp')).toBe(false)
  expect(calls.filter(c => c[1] === 'auth')).toEqual([
    ['gh', 'auth', 'status', '--hostname', 'ghe.corp'],
    ['gh', 'auth', 'status', '--hostname', 'other.corp'],
  ])
})

test('checkHost: a runner rejection answers false and is not cached', async () => {
  let fail = true
  const { run } = rig(
    () => ok(),
    argv => (argv[1] === 'auth' ? (fail ? new Error('timeout') : ok('ok')) : undefined),
  )
  const tool = new GhTool(run, () => NOW)
  expect(await tool.checkHost('ghe.corp')).toBe(false)
  expect(tool.isHostAuthed('ghe.corp')).toBeUndefined()
  fail = false
  expect(await tool.checkHost('ghe.corp')).toBe(true)
})

test('reset forgets a cached host denial, so a manual refresh can see a new login', async () => {
  let loggedIn = false
  const { run } = rig(
    () => ok(),
    argv => (argv[1] === 'auth' ? (loggedIn ? ok('ok') : ok('', 1, 'no')) : undefined),
  )
  const tool = new GhTool(run, () => NOW)
  expect(await tool.checkHost('ghe.corp')).toBe(false)
  loggedIn = true
  expect(await tool.checkHost('ghe.corp')).toBe(false) // cached
  tool.reset()
  expect(await tool.checkHost('ghe.corp')).toBe(true)
})

// ---------------------------------------------------------------- classifyReply and graphql (spec A21)

const DQ = 'query { repository(owner: "o", name: "r") { h0: pullRequests(headRefName: "x") { nodes { number } } } }'
const DATA = JSON.stringify({ data: { repository: {} } })

test('classifyReply: data wins, also with alias errors in the same reply', () => {
  const stdout = JSON.stringify({ data: { a: 1 }, errors: [{ path: ['a'] }] })
  expect(classifyReply(ok(stdout, 1))).toEqual({ kind: 'data', data: { a: 1 }, errors: [{ path: ['a'] }] })
})

test('classifyReply: auth by exit 4 and by the login hint', () => {
  expect(classifyReply(ok('', 4, fx.AUTH_UNAUTH_STDERR)).kind).toBe('auth')
  expect(classifyReply(ok('', 1, 'please run: gh auth login')).kind).toBe('auth')
})

test('classifyReply: truncated, query-error with its first message, unparsable', () => {
  expect(classifyReply({ ...ok('{"data":'), isStdoutTruncated: true }).kind).toBe('truncated')
  expect(classifyReply(ok(JSON.stringify({ errors: [{ message: 'Field x does not exist' }] }), 1))).toEqual({
    kind: 'query-error',
    detail: 'Field x does not exist',
  })
  expect(classifyReply(ok('not json', 1, 'boom')).kind).toBe('unparsable')
  expect(classifyReply(ok(fx.AUTH_BAD_TOKEN_STDOUT, 1, fx.AUTH_BAD_TOKEN_STDERR)).kind).toBe('unparsable')
})

test('graphql: gh not probed as available is no-gh and makes no call', async () => {
  const { run, calls } = rig(() => ok(DATA))
  const tool = new GhTool(run, () => NOW)
  expect(await tool.graphql('github.com', DQ)).toEqual({ ok: false, kind: 'no-gh' })
  expect(calls).toHaveLength(0)
})

test('graphql: ok returns the reply; the argv is fixed and the run gets the discovery timeout', async () => {
  const seen: (RunInit | undefined)[] = []
  const argvs: string[][] = []
  const run: Runner = async (argv, init) => {
    if (argv[1] === '--version') return ok('gh version 2.102.0 (2026-09-30)')
    argvs.push([...argv])
    seen.push(init)
    return ok(DATA)
  }
  const tool = new GhTool(run, () => NOW)
  await tool.probe()
  expect(await tool.graphql('ghe.corp', DQ)).toEqual({ ok: true, reply: { data: { repository: {} }, errors: [] } })
  expect(argvs[0]).toEqual(['gh', 'api', 'graphql', '--hostname', 'ghe.corp', '-f', 'query=' + DQ])
  expect(seen[0]?.timeoutMs).toBe(LIMITS.discoveryTimeoutMs)
  expect(tool.status()).toMatchObject({ loggedIn: true, breaker: 'closed' })
})

test('graphql: exit 4 is auth and marks the tool logged out', async () => {
  const { run } = rig(() => ok('', 4, fx.AUTH_UNAUTH_STDERR))
  const tool = new GhTool(run, () => NOW)
  await tool.probe()
  expect(await tool.graphql('github.com', DQ)).toMatchObject({ ok: false, kind: 'auth' })
  expect(tool.status().loggedIn).toBe(false)
})

test('graphql: a rejected run is transport and counts; three open the breaker, which then blocks', async () => {
  const { run, calls, graphqlCalls } = rig(() => new Error('spawn gh ENOENT'))
  const tool = new GhTool(run, () => NOW)
  await tool.probe()
  for (let i = 0; i < 3; i++)
    expect(await tool.graphql('github.com', DQ)).toMatchObject({ ok: false, kind: 'transport' })
  expect(tool.status().breaker).toBe('open')
  const before = calls.length
  expect(await tool.graphql('github.com', DQ)).toEqual({ ok: false, kind: 'blocked' })
  expect(calls).toHaveLength(before)
  expect(graphqlCalls()).toHaveLength(3)
})

test('graphql: unparsable output is transport and counts; three of them also block refreshItems', async () => {
  const { run, graphqlCalls } = rig(() => ok('<html>', 1, 'gateway'))
  const tool = new GhTool(run, () => NOW)
  await tool.probe()
  for (let i = 0; i < 3; i++)
    expect(await tool.graphql('github.com', DQ)).toMatchObject({ ok: false, kind: 'transport' })
  expect(tool.status().breaker).toBe('open')
  await tool.refreshItems([item('cli', 'cli', 1)])
  expect(graphqlCalls()).toHaveLength(3)
})

test('graphql: a query-level error and a cut reply leave the breaker closed after three in a row', async () => {
  const queryError = rig(() => ok(JSON.stringify({ errors: [{ message: 'Field x' }] }), 1))
  const a = new GhTool(queryError.run, () => NOW)
  await a.probe()
  for (let i = 0; i < 3; i++)
    expect(await a.graphql('github.com', DQ)).toEqual({ ok: false, kind: 'query-error', error: 'Field x' })
  expect(a.status()).toMatchObject({ breaker: 'closed', loggedIn: true })

  const cut = rig(() => ({ ...ok('{"data":', 0), isStdoutTruncated: true }))
  const b = new GhTool(cut.run, () => NOW)
  await b.probe()
  for (let i = 0; i < 3; i++) expect(await b.graphql('github.com', DQ)).toMatchObject({ ok: false, kind: 'truncated' })
  expect(b.status().breaker).toBe('closed')
})
