// GhTool: batched GraphQL refresh, outcome classification, host and repo probes. Pure, fake Runner.
import { expect, test } from 'claude-code/testing'
import type { Breaker } from '../core/interfaces/tracker'
import { CliTool } from '../core/lib/tool'
import { buildQuery, classifyReply, GhTool, rollupToChecks } from '../trackers/github/gh-tool'
import type { GitHubTarget, RunInit, Runner, RunResult } from './fixtures/contracts'
import * as fx from './fixtures/gh'
import { LIMITS } from './fixtures/limits'

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
    fx.AUTH_STATUS_JSON_LOGGED_IN,
    fx.AUTH_STATUS_JSON_NO_LOGIN,
    fx.AUTH_STATUS_JSON_BAD_TOKEN,
    fx.AUTH_STATUS_JSON_STORED_BAD_TOKEN,
    fx.AUTH_STATUS_JSON_DNS,
    fx.AUTH_STATUS_JSON_TIMEOUT,
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
  tool.setHome('ghe.example.invalid') // the session host: a failure of it is the tool's
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

test('buildQuery asks a PR for the issues it closes, capped like discovery', () => {
  const { query } = buildQuery([item('o', 'r', 2)])
  const pr = query.slice(query.indexOf('... on PullRequest'))
  expect(pr).toContain(
    `closingIssuesReferences(first: ${LIMITS.closingRefsPerPr}) { nodes { number repository { nameWithOwner } } }`,
  )
  expect(query.slice(0, query.indexOf('... on PullRequest'))).not.toContain('closingIssuesReferences')
})

test('a PR refresh reads the issues it closes as item keys; none is an empty list; an issue gets no field', async () => {
  const pr = (number: number, nodes: unknown[]) => ({
    issueOrPullRequest: {
      __typename: 'PullRequest',
      number,
      title: 'T',
      state: 'OPEN',
      isDraft: false,
      closingIssuesReferences: { nodes },
    },
  })
  const reply = JSON.stringify({
    data: {
      x: pr(7, [
        { number: 9, url: 'https://github.com/Acme/Web/issues/9', repository: { nameWithOwner: 'Acme/Web' } },
        { number: 3, repository: { nameWithOwner: 'other/lib' } },
        { number: 4, repository: {} },
      ]),
      y: pr(8, []),
      z: { issueOrPullRequest: { __typename: 'Issue', number: 9, title: 'I', state: 'OPEN' } },
    },
  })
  const { run } = rig(q => ok(remap(reply, q)))
  const tool = new GhTool(run, () => NOW)
  const [p7, p8, i9] = [item('acme', 'web', 7), item('acme', 'web', 8), item('acme', 'web', 9)]
  await tool.refreshItems([p7!, p8!, i9!])
  // A ref with no repository is in the PR's own repo, as discovery reads it.
  expect(p7!.closes).toEqual(['gh:github.com/acme/web#9', 'gh:github.com/other/lib#3', 'gh:github.com/acme/web#4'])
  expect(p8!.closes).toEqual([])
  expect('closes' in i9!).toBe(false)
})

test('buildQuery asks a PR for mergeable and mergeStateStatus, an issue for neither', () => {
  const { query } = buildQuery([item('o', 'r', 2)])
  const at = query.indexOf('... on PullRequest')
  expect(query.slice(at)).toContain('mergeable mergeStateStatus')
  expect(query.slice(0, at)).not.toContain('mergeable')
})

test('a PR refresh reads mergeable and mergeStateStatus; an issue and a reply with none get no field', async () => {
  const node = (typename: string, number: number, extra: Record<string, unknown> = {}) => ({
    issueOrPullRequest: { __typename: typename, number, title: 'T', state: 'OPEN', ...extra },
  })
  const reply = JSON.stringify({
    data: {
      x: node('PullRequest', 7, { isDraft: false, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
      y: node('PullRequest', 8, { isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' }),
      z: node('PullRequest', 9, { isDraft: false, mergeable: 'WHATEVER' }),
      w: node('Issue', 10),
    },
  })
  const { run } = rig(q => ok(remap(reply, q)))
  const tool = new GhTool(run, () => NOW)
  const stale = { mergeable: 'CONFLICTING' as const, mergeStateStatus: 'DIRTY' }
  const [p7, p8, p9, i10] = [
    item('acme', 'web', 7),
    item('acme', 'web', 8),
    item('acme', 'web', 9),
    item('acme', 'web', 10),
  ]
  Object.assign(p9!, stale) // GitHub stopped answering with a value that is known
  await tool.refreshItems([p7!, p8!, p9!, i10!])
  expect(p7).toMatchObject({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })
  expect(p8).toMatchObject({ mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' })
  expect('mergeable' in p9! || 'mergeStateStatus' in p9!).toBe(false)
  expect('mergeable' in i10! || 'mergeStateStatus' in i10!).toBe(false)
})

test('a PR reply with no closing field leaves closes out, so the stored list stays', async () => {
  const { run } = rig(q => ok(remap(fx.BATCH_SAMPLE_OUTPUT, q)))
  const tool = new GhTool(run, () => NOW)
  const pr = { ...item('cli', 'cli', 14640)!, closes: ['gh:github.com/cli/cli#1'] }
  await tool.refreshItems([item('cli', 'cli', 14622)!, pr])
  expect(pr.type).toBe('pr')
  expect('closes' in pr).toBe(false)
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
          ? ok(fx.authStatusJson('ghe.corp'))
          : ok(fx.AUTH_STATUS_JSON_NO_LOGIN, 0, fx.AUTH_STATUS_NO_LOGIN_NOTICE)
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
    ['gh', 'auth', 'status', '--hostname', 'ghe.corp', '--json', 'hosts'],
    ['gh', 'auth', 'status', '--hostname', 'other.corp', '--json', 'hosts'],
  ])
})

test('checkHost: a runner rejection answers false and is not cached', async () => {
  let fail = true
  const { run } = rig(
    () => ok(),
    argv => (argv[1] === 'auth' ? (fail ? new Error('timeout') : ok(fx.authStatusJson('ghe.corp'))) : undefined),
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
    argv =>
      argv[1] === 'auth'
        ? loggedIn
          ? ok(fx.authStatusJson('ghe.corp'))
          : ok(fx.AUTH_STATUS_JSON_NO_LOGIN, 0, fx.AUTH_STATUS_NO_LOGIN_NOTICE)
        : undefined,
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
  tool.setHome('ghe.corp') // the session host: its calls move the tool-wide flag
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

// ---------------------------------------------------------------- one host never poisons the others (issue #158)
// The tool-wide login flag and breaker stand for the home host: the session repo's host, else github.com. A call to any
// other host (a PR the session created there, an item of it) keeps its login and its failures to that host.

const GHE = (argv: readonly string[]): boolean => argv.includes('ghe.corp')
const REFUSED = (): RunResult => ok('', 4, fx.AUTH_UNAUTH_STDERR)

test('graphql: another host that refuses login is denied alone; the tool stays logged in and the home host goes on', async () => {
  const { run } = rig((_q, argv) => (GHE(argv) ? REFUSED() : ok(DATA)))
  const tool = new GhTool(run, () => NOW)
  await tool.probe()
  expect(await tool.graphql('ghe.corp', DQ)).toMatchObject({ ok: false, kind: 'auth' })
  expect(tool.status().loggedIn).not.toBe(false)
  expect(tool.status().breaker).toBe('closed')
  expect(tool.canCall(NOW)).toBe(true)
  expect(tool.isHostAuthed('ghe.corp')).toBe(false) // the host is denied: items of it do not refresh, and checkHost says no
  expect(await tool.graphql('github.com', DQ)).toMatchObject({ ok: true })
  // The manual refresh forgets the denial, as for a host that gh auth status denied.
  tool.reset()
  expect(tool.isHostAuthed('ghe.corp')).toBeUndefined()
})

test('graphql: three failures of another host open the breaker of that host alone, until a manual refresh', async () => {
  const { run, graphqlCalls } = rig((_q, argv) => (GHE(argv) ? new Error('timeout') : ok(DATA)))
  const tool = new GhTool(run, () => NOW)
  await tool.probe()
  for (let i = 0; i < 3; i++)
    expect(await tool.graphql('ghe.corp', DQ)).toMatchObject({ ok: false, kind: 'transport', error: 'timeout' })
  expect(tool.status().breaker).toBe('closed') // the tool-wide breaker did not count them
  expect(tool.canCall(NOW)).toBe(true)
  expect(await tool.graphql('ghe.corp', DQ)).toEqual({ ok: false, kind: 'blocked' }) // that host rests, with no call
  expect(graphqlCalls().filter(GHE)).toHaveLength(3)
  expect(await tool.graphql('github.com', DQ)).toMatchObject({ ok: true }) // the home host is not held up
  tool.reset() // /track refresh: that host gets one more try
  expect(await tool.graphql('ghe.corp', DQ)).toMatchObject({ ok: false, kind: 'transport' })
  expect(graphqlCalls().filter(GHE)).toHaveLength(4)
})

test('graphql: a cut reply or a query error of another host touches no state, and a good reply proves nothing of the home host', async () => {
  let body: RunResult = { ...ok('{"data":', 0), isStdoutTruncated: true }
  const { run } = rig(() => body)
  const tool = new GhTool(run, () => NOW)
  await tool.probe()
  for (let i = 0; i < 4; i++) expect(await tool.graphql('ghe.corp', DQ)).toMatchObject({ ok: false, kind: 'truncated' })
  body = ok(JSON.stringify({ errors: [{ message: 'Field x' }] }), 1)
  expect(await tool.graphql('ghe.corp', DQ)).toEqual({ ok: false, kind: 'query-error', error: 'Field x' })
  expect(tool.status()).toMatchObject({ breaker: 'closed', loggedIn: null }) // no flag moved
  body = ok(DATA)
  expect(await tool.graphql('ghe.corp', DQ)).toMatchObject({ ok: true })
  expect(tool.status().loggedIn).toBe(null)
})

test('setHome: the session host is the one the tool-wide flag stands for, and then github.com is another host', async () => {
  const { run } = rig(() => REFUSED())
  const tool = new GhTool(run, () => NOW)
  await tool.probe()
  tool.setHome('GHE.corp') // case does not matter
  expect(await tool.graphql('github.com', DQ)).toMatchObject({ ok: false, kind: 'auth' })
  expect(tool.status().loggedIn).not.toBe(false)
  expect(await tool.graphql('ghe.corp', DQ)).toMatchObject({ ok: false, kind: 'auth' })
  expect(tool.status().loggedIn).toBe(false) // the home host refused: the whole tool is logged out, as before
  const bare = new GhTool(run, () => NOW)
  await bare.probe()
  bare.setHome(undefined) // no session repo: github.com
  expect(await bare.graphql('github.com', DQ)).toMatchObject({ ok: false, kind: 'auth' })
  expect(bare.status().loggedIn).toBe(false)
})

test('setHome: a new home host starts with a clean tool: the login flag and the breaker of the old one are forgotten', async () => {
  const { run } = rig(() => new Error('timeout'))
  const tool = new GhTool(run, () => NOW)
  await tool.probe()
  for (let i = 0; i < 3; i++) await tool.graphql('github.com', DQ)
  expect(tool.status().breaker).toBe('open') // the old home host
  tool.setHome('github.com') // the same host: nothing changes
  expect(tool.status().breaker).toBe('open')
  tool.setHome('ghe.corp') // a session on another host (an in-process /resume)
  expect(tool.status().breaker).toBe('half-open') // as a manual refresh leaves it
  const refused = rig(() => REFUSED())
  const other = new GhTool(refused.run, () => NOW)
  await other.probe()
  await other.graphql('github.com', DQ)
  expect(other.status().loggedIn).toBe(false)
  other.setHome('github.com') // no change
  expect(other.status().loggedIn).toBe(false)
  other.setHome('ghe.corp')
  expect(other.status().loggedIn).toBe(null)
  expect(other.canCall(NOW)).toBe(true)
})

test('refreshItems: another host that refuses login is denied alone: the items of the home host refresh, the tool stays logged in', async () => {
  const { run } = rig((q, argv) => (GHE(argv) ? REFUSED() : ok(remap(fx.BATCH_SAMPLE_OUTPUT, q))))
  const tool = new GhTool(run, () => NOW)
  await tool.probe()
  const foreign = item('team', 'svc', 5, 'ghe.corp')
  const [issue, pr, merged] = [item('cli', 'cli', 14622), item('cli', 'cli', 14640), item('other', 'repo', 14633)]
  await tool.refreshItems([foreign, issue!, pr!, merged!]) // the other host comes first
  expect(issue).toMatchObject({ type: 'issue', state: 'closed', refreshedAt: NOW })
  expect(pr).toMatchObject({ type: 'pr', state: 'open' })
  expect(tool.status().loggedIn).toBe(true)
  expect(tool.isHostAuthed('ghe.corp')).toBe(false)
  expect(tool.canCall(NOW)).toBe(true)
})

test('refreshItems: a failed chunk of the home host ends that host only: the hosts after it are still refreshed', async () => {
  const { run, graphqlCalls } = rig((q, argv) =>
    argv.includes('github.com') ? REFUSED() : ok(remap(fx.BATCH_SAMPLE_OUTPUT, q)),
  )
  const tool = new GhTool(run, () => NOW)
  await tool.probe()
  const home = item('cli', 'cli', 1) // first in the batch, and refused: the home host logs the tool out
  const [issue, pr, merged] = [
    item('cli', 'cli', 14622, 'ghe.corp'),
    item('cli', 'cli', 14640, 'ghe.corp'),
    item('other', 'repo', 14633, 'ghe.corp'),
  ]
  await tool.refreshItems([home, issue!, pr!, merged!])
  expect(tool.status().loggedIn).toBe(false) // the home host refused, as before
  expect(home.refreshedAt).toBeUndefined()
  expect(issue).toMatchObject({ type: 'issue', state: 'closed', refreshedAt: NOW }) // the other host went on
  expect(pr).toMatchObject({ type: 'pr', state: 'open' })
  expect(graphqlCalls().map(c => c[4])).toEqual(['github.com', 'ghe.corp'])
})

test('refreshItems: failures of another host never open the tool breaker, and the home host is still refreshed', async () => {
  const { run, graphqlCalls } = rig((q, argv) =>
    GHE(argv) ? new Error('timeout') : ok(remap(fx.BATCH_SAMPLE_OUTPUT, q)),
  )
  const tool = new GhTool(run, () => NOW)
  await tool.probe()
  for (let i = 0; i < 4; i++) await tool.refreshItems([item('team', 'svc', 5, 'ghe.corp')])
  expect(graphqlCalls().filter(GHE)).toHaveLength(3) // the fourth finds that host at rest
  expect(tool.status().breaker).toBe('closed')
  const [issue, pr, merged] = [item('cli', 'cli', 14622), item('cli', 'cli', 14640), item('other', 'repo', 14633)]
  await tool.refreshItems([issue!, pr!, merged!])
  expect(issue!.refreshedAt).toBe(NOW)
})

// ---------------------------------------------------------------- the reviewer's findings on the per-host state (issue #158)

test('canCallHost: the home host asks the tool; another host asks its own denial and breaker', async () => {
  const { run } = rig((_q, argv) => (GHE(argv) ? new Error('timeout') : REFUSED()))
  const tool = new GhTool(run, () => NOW)
  expect(tool.canCallHost('github.com', NOW)).toBe(false) // not probed: not available
  expect(tool.canCallHost('ghe.corp', NOW)).toBe(false)
  await tool.probe()
  expect(tool.canCallHost('github.com', NOW)).toBe(true)
  expect(tool.canCallHost('ghe.corp', NOW)).toBe(true)
  await tool.graphql('github.com', DQ) // the home host refuses: the tool is logged out
  expect(tool.canCall(NOW)).toBe(false)
  expect(tool.canCallHost('github.com', NOW)).toBe(false)
  expect(tool.canCallHost('ghe.corp', NOW)).toBe(true) // another host does not wait for it
  for (let i = 0; i < 3; i++) await tool.graphql('ghe.corp', DQ)
  expect(tool.canCallHost('GHE.corp', NOW)).toBe(false) // its own breaker rests, whatever the case
  expect(tool.canCallHost('other.corp', NOW)).toBe(true)
  tool.reset()
  expect(tool.canCallHost('github.com', NOW)).toBe(true)
  expect(tool.canCallHost('ghe.corp', NOW)).toBe(true) // half open
  // A host that refused its login is denied until the manual refresh.
  const denied = rig(() => REFUSED())
  const other = new GhTool(denied.run, () => NOW)
  await other.probe()
  await other.graphql('ghe.corp', DQ)
  expect(other.canCallHost('ghe.corp', NOW)).toBe(false)
  other.reset()
  expect(other.canCallHost('ghe.corp', NOW)).toBe(true)
})

/** A runner that answers `gh auth status` from `answer(argv)`, and counts the calls. */
function authRig(answer: (argv: readonly string[]) => RunResult | Error) {
  const r = rig(
    () => ok(),
    argv => (argv[1] === 'auth' ? answer(argv) : undefined),
  )
  const asked = () => r.calls.filter(c => c[1] === 'auth')
  return { ...r, asked }
}
const JSON_NO_LOGIN = (): RunResult => ok(fx.AUTH_STATUS_JSON_NO_LOGIN, 0, fx.AUTH_STATUS_NO_LOGIN_NOTICE)

test('checkHost reads gh auth status --json hosts: a login is a yes, no login and a bad token are a denial, cached', async () => {
  const answers: Record<string, RunResult> = {
    'github.com': ok(fx.AUTH_STATUS_JSON_LOGGED_IN),
    'ghe.example.invalid': JSON_NO_LOGIN(),
  }
  const { run, asked } = authRig(argv => answers[argv[4]!]!)
  const tool = new GhTool(run, () => NOW)
  expect(await tool.checkHost('github.com')).toBe(true)
  expect(await tool.checkHost('ghe.example.invalid')).toBe(false) // `hosts` is empty: no account on that host
  expect(tool.isHostAuthed('ghe.example.invalid')).toBe(false)
  expect(asked().every(c => c.join(' ').endsWith('--json hosts'))).toBe(true)
  // The active account decides: its bad token (HTTP 401) is a denial, whatever the other account says.
  answers['github.com'] = ok(fx.AUTH_STATUS_JSON_BAD_TOKEN)
  const other = new GhTool(run, () => NOW)
  expect(await other.checkHost('github.com')).toBe(false)
  expect(other.isHostAuthed('github.com')).toBe(false)
  expect(asked()).toHaveLength(3)
  // A stored token (keyring, hosts.yml: what `gh auth login` leaves) that the host refuses says `HTTP 401: ...`, not the
  // `non-200 OK status code: 401` of an env token. It is a denial as well, and cached.
  answers['github.com'] = ok(fx.AUTH_STATUS_JSON_STORED_BAD_TOKEN)
  const stored = new GhTool(run, () => NOW)
  expect(await stored.checkHost('github.com')).toBe(false)
  expect(stored.isHostAuthed('github.com')).toBe(false)
  expect(await stored.checkHost('github.com')).toBe(false)
  expect(asked()).toHaveLength(4) // the second answer came from the cache
})

test('checkHost: a host that cannot be reached is a failure of that host, not a denial: not cached, and it rests after three', async () => {
  for (const [host, json] of [
    ['ghe.example.invalid', fx.AUTH_STATUS_JSON_DNS],
    ['192.0.2.1', fx.AUTH_STATUS_JSON_TIMEOUT],
    // A gateway error: `HTTP <code>: <message> (<url>)`, the format of the stored-token capture with another code.
    [
      'ghe.corp',
      fx.authStatusJson('ghe.corp', { state: 'error', error: 'HTTP 502: Bad Gateway (https://ghe.corp/api/v3/)' }),
    ],
  ] as const) {
    let reachable = false
    const { run, asked } = authRig(() => (reachable ? ok(fx.authStatusJson(host)) : ok(json)))
    const tool = new GhTool(run, () => NOW)
    await tool.probe()
    expect(tool.canCallHost(host, NOW)).toBe(true)
    for (let i = 0; i < 3; i++) expect(await tool.checkHost(host)).toBe(false)
    expect(tool.isHostAuthed(host)).toBeUndefined() // the login is not known
    expect(tool.status().breaker).toBe('closed') // the breaker of the tool did not count them
    expect(asked()).toHaveLength(3)
    expect(await tool.checkHost(host)).toBe(false) // the host rests: no call
    expect(asked()).toHaveLength(3)
    expect(tool.canCallHost(host, NOW)).toBe(false)
    tool.reset() // /track refresh: one more try
    reachable = true
    expect(await tool.checkHost(host)).toBe(true)
    expect(asked()).toHaveLength(4)
    expect(tool.canCallHost(host, NOW)).toBe(true) // a good check frees the slot of the half-open breaker
  }
})

test('checkHost: a failed check of the home host feeds no breaker and is not cached', async () => {
  const { run, asked } = authRig(() => ok(fx.AUTH_STATUS_JSON_DNS))
  const tool = new GhTool(run, () => NOW)
  const host = 'ghe.example.invalid'
  tool.setHome(host) // the session host
  await tool.probe()
  for (let i = 0; i < 4; i++) expect(await tool.checkHost(host)).toBe(false)
  expect(tool.isHostAuthed(host)).toBeUndefined()
  expect(asked()).toHaveLength(4) // the home host never rests on a check: each call asks
  expect(tool.status().breaker).toBe('closed') // and the breaker of the tool did not count them
  expect(tool.canCall(NOW)).toBe(true)
})

test('checkHost: a denial frees the slot of the half-open breaker of the host as well', async () => {
  let answer: RunResult = ok(fx.AUTH_STATUS_JSON_DNS)
  const { run } = authRig(() => answer)
  const tool = new GhTool(run, () => NOW)
  await tool.probe()
  const host = 'ghe.example.invalid'
  for (let i = 0; i < 3; i++) await tool.checkHost(host) // the host rests
  tool.reset() // half open
  answer = JSON_NO_LOGIN()
  expect(await tool.checkHost(host)).toBe(false)
  expect(tool.isHostAuthed(host)).toBe(false)
  tool.reset() // forgets the denial; the slot must be free by now
  expect(tool.canCallHost(host, NOW)).toBe(true)
})

test('checkHost: an older gh with no --json for auth status is asked for the text, and the text tells the same', async () => {
  let text: RunResult = ok('', 1, fx.AUTH_STATUS_NO_LOGIN_NOTICE)
  const { run, asked } = authRig(argv => (argv.includes('--json') ? ok('', 1, fx.AUTH_STATUS_UNKNOWN_JSON_FLAG) : text))
  const verdict = async (answer: RunResult) => {
    text = answer
    const tool = new GhTool(run, () => NOW)
    tool.setHome('ghe.corp') // the host under test is not the home host
    return { ok: await tool.checkHost('ghe.example.invalid'), authed: tool.isHostAuthed('ghe.example.invalid'), tool }
  }
  // No login on that host, no login at all: a denial, cached.
  expect(await verdict(ok('', 1, fx.AUTH_STATUS_NO_LOGIN_NOTICE))).toMatchObject({ ok: false, authed: false })
  expect(await verdict(ok('', 1, fx.GHE_AUTH_STATUS_STDERR))).toMatchObject({ ok: false, authed: false })
  // gh before 2.40 (`status.go` at v2.39.0): no account on the host. A denial, as on main.
  expect(
    await verdict(ok('', 1, 'Hostname "ghe.example.invalid" not found among authenticated GitHub hosts\n')),
  ).toMatchObject({ ok: false, authed: false })
  // The text of an unreachable host reads as an invalid token, and carries the login hint: a denial, as on main.
  expect(await verdict(ok('', 1, fx.AUTH_STATUS_TEXT_DNS))).toMatchObject({ ok: false, authed: false })
  // A timeout has no login hint: a failure, not cached.
  expect(await verdict(ok('', 1, fx.AUTH_STATUS_TEXT_TIMEOUT))).toMatchObject({ ok: false, authed: undefined })
  // Exit 0 is a login.
  expect(await verdict(ok('github.com\n  Logged in\n'))).toMatchObject({ ok: true, authed: true })
  // Each check asked twice: `--json hosts`, then the text.
  expect(
    asked()
      .slice(0, 2)
      .map(c => c.includes('--json')),
  ).toEqual([true, false])
})

test('host names are one key whatever the case: the check, the denial and the breaker', async () => {
  const { run, calls } = rig(
    (_q, argv) => (argv.some(a => a.toLowerCase() === 'ghe.corp') ? new Error('timeout') : ok(DATA)),
    argv => (argv[1] === 'auth' ? ok(fx.authStatusJson('ghe.corp')) : undefined),
  )
  const tool = new GhTool(run, () => NOW)
  expect(await tool.checkHost('GHE.corp')).toBe(true)
  expect(await tool.checkHost('ghe.CORP')).toBe(true)
  expect(calls.filter(c => c[1] === 'auth')).toHaveLength(1) // one check for one host
  expect(tool.isHostAuthed('ghe.corp')).toBe(true)
  expect(tool.isHostAuthed('Ghe.Corp')).toBe(true)
  await tool.probe()
  await tool.graphql('GHE.corp', DQ)
  await tool.graphql('ghe.corp', DQ)
  await tool.graphql('Ghe.Corp', DQ)
  expect(await tool.graphql('ghe.corp', DQ)).toEqual({ ok: false, kind: 'blocked' }) // three failures of one host
  // Two checks of one host in flight, in two cases, are one call.
  const slow = authRig(() => ok(fx.authStatusJson('ghe.example.invalid')))
  const two = new GhTool(slow.run, () => NOW)
  expect(await Promise.all([two.checkHost('GHE.example.invalid'), two.checkHost('ghe.example.invalid')])).toEqual([
    true,
    true,
  ])
  expect(slow.asked()).toHaveLength(1)
  // A refusal of a query, in any case, denies the host under its one key.
  const refused = rig(() => REFUSED())
  const denied = new GhTool(refused.run, () => NOW)
  await denied.probe()
  await denied.graphql('GHE.corp', DQ)
  expect(denied.isHostAuthed('ghe.corp')).toBe(false)
  expect(denied.canCallHost('Ghe.Corp', NOW)).toBe(false)
})

test('graphql: the last error of another host goes with a good reply and with a manual refresh', async () => {
  // A breaker that lets the call through when the test says so: `allows` false is a half-open slot that another call took.
  const allow = { value: true }
  const breaker: Breaker = {
    state: 'closed',
    openUntil: undefined,
    peek: () => true,
    allows: () => allow.value,
    success: () => {},
    failure: () => {},
    reset: () => {},
  }
  let reject = true
  const { run } = rig(() => (reject ? new Error('timeout') : ok(DATA)))
  const cli = new CliTool(
    { id: 'gh', probe: ['gh', '--version'], timeoutMs: () => 1000, probeTimeoutMs: () => 1000 },
    run,
    () => NOW,
    undefined,
    () => breaker,
  )
  const tool = new GhTool(cli, () => NOW)
  await tool.probe()
  expect(await tool.graphql('ghe.corp', DQ)).toMatchObject({ ok: false, kind: 'transport', error: 'timeout' })
  allow.value = false // the slot is taken: no call, so no new error, and the one of the last failure is told
  expect(await tool.graphql('ghe.corp', DQ)).toMatchObject({ ok: false, kind: 'transport', error: 'timeout' })
  allow.value = true
  reject = false
  expect(await tool.graphql('ghe.corp', DQ)).toMatchObject({ ok: true }) // a good reply forgets the error
  allow.value = false
  expect(await tool.graphql('ghe.corp', DQ)).toEqual({ ok: false, kind: 'transport' })
  // A manual refresh forgets it too.
  allow.value = true
  reject = true
  await tool.graphql('ghe.corp', DQ)
  allow.value = false
  tool.reset()
  expect(await tool.graphql('ghe.corp', DQ)).toEqual({ ok: false, kind: 'transport' })
})
