import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { answer, callsOf, type FakeGhSpec, type FakePr, fakeGhSpec, parseOwnerRepo } from '../support/fake-gh.ts'
import { FAKE_GH_DIR, fakeGhEnv } from '../support/fake-gh-env.ts'

const tempDir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))

const PR: FakePr = {
  number: 7,
  title: 'Fix the fake conflict',
  headRefName: 'feat/fake-conflict',
  baseRefName: 'main',
  mergeable: 'CONFLICTING',
  mergeStateStatus: 'DIRTY',
}
const SPEC: FakeGhSpec = { owner: 'e2e-owner', repo: 'e2e-repo', defaultBranch: 'main', prs: [PR] }

// The discovery query as `buildDiscoveryQuery` in trackers/github/pr-discovery.ts writes it, for one branch.
const discovery = (owner: string, repo: string, branch: string) => `query {
  rateLimit { cost remaining }
  repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {
    defaultBranchRef { name }
    h0: pullRequests(headRefName: ${JSON.stringify(branch)}, first: 5, states: [OPEN, MERGED, CLOSED], orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...pr } }
    b0: pullRequests(baseRefName: ${JSON.stringify(branch)}, first: 20, states: [OPEN], orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...pr } }
  }
}
fragment pr on PullRequest {
  number title state isDraft url headRefName baseRefName isCrossRepository reviewDecision body mergeable mergeStateStatus
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  closingIssuesReferences(first: 5) { nodes { number url repository { nameWithOwner } } }
}`

// The refresh query as `buildQuery` in trackers/github/gh-tool.ts writes it, for one item.
const refresh = (owner: string, repo: string, number: number) => `query {
  rateLimit { cost remaining }
  a0: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {
    issueOrPullRequest(number: ${number}) {
      __typename
      ... on Issue { number title state stateReason url }
      ... on PullRequest { number title state isDraft reviewDecision url mergeable mergeStateStatus
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        closingIssuesReferences(first: 5) { nodes { number repository { nameWithOwner } } } }
    }
  }
}`

const graphql = (query: string) => ['api', 'graphql', '--hostname', 'github.com', '-f', `query=${query}`]
const body = (stdout: string) => JSON.parse(stdout)

test('--version succeeds, so the mod finds a gh', () => {
  const r = answer(['--version'], SPEC)
  assert.equal(r.exitCode, 0)
  assert.match(r.stdout, /^gh version \S+/)
  assert.equal(r.call, '--version')
})

test('auth status succeeds for any host', () => {
  const r = answer(['auth', 'status', '--hostname', 'github.com'], SPEC)
  assert.equal(r.exitCode, 0)
  assert.equal(r.call, 'auth status')
})

test('auth token has no token, so Claude Code itself cannot reach GitHub through the fake', () => {
  // Claude Code runs `gh auth token` at start for its own PR status, with and without a host. A fake token would let it
  // call GitHub for the fake repo.
  for (const argv of [
    ['auth', 'token'],
    ['auth', 'token', '--hostname', 'github.com'],
  ]) {
    const r = answer(argv, SPEC)
    assert.equal(r.exitCode, 1)
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /no oauth token found for github\.com/)
    assert.equal(r.call, 'auth token')
  }
})

test('repo view names the fake repo', () => {
  const r = answer(['repo', 'view', '--json', 'nameWithOwner,url'], SPEC)
  assert.equal(r.exitCode, 0)
  assert.deepEqual(body(r.stdout), {
    nameWithOwner: 'e2e-owner/e2e-repo',
    url: 'https://github.com/e2e-owner/e2e-repo',
  })
})

test('a discovery query gets the PR under the head alias of its branch, and the default branch', () => {
  const r = answer(graphql(discovery('e2e-owner', 'e2e-repo', 'feat/fake-conflict')), SPEC)
  assert.equal(r.exitCode, 0)
  assert.equal(r.call, 'graphql discovery')
  const { repository } = body(r.stdout).data
  assert.equal(repository.defaultBranchRef.name, 'main')
  assert.equal(repository.h0.nodes.length, 1)
  assert.deepEqual(repository.b0.nodes, [])
  const node = repository.h0.nodes[0]
  assert.equal(node.number, 7)
  assert.equal(node.state, 'OPEN')
  assert.equal(node.isDraft, false)
  assert.equal(node.headRefName, 'feat/fake-conflict')
  assert.equal(node.baseRefName, 'main')
  assert.equal(node.isCrossRepository, false)
  assert.equal(node.mergeable, 'CONFLICTING')
  assert.equal(node.mergeStateStatus, 'DIRTY')
  assert.equal(node.url, 'https://github.com/e2e-owner/e2e-repo/pull/7')
  assert.equal(node.body, '')
  assert.deepEqual(node.closingIssuesReferences.nodes, [])
  assert.equal(node.commits.nodes[0].commit.statusCheckRollup.state, 'SUCCESS')
})

test('a discovery query for another branch finds no PR', () => {
  const { repository } = body(answer(graphql(discovery('e2e-owner', 'e2e-repo', 'feat/other')), SPEC).stdout).data
  assert.deepEqual(repository.h0.nodes, [])
  assert.deepEqual(repository.b0.nodes, [])
})

test('a base alias finds an open PR that targets the branch, a head alias also finds a merged one', () => {
  const stacked: FakePr = { ...PR, number: 8, headRefName: 'feat/top', baseRefName: 'feat/base' }
  const merged: FakePr = { ...PR, number: 9, headRefName: 'feat/base', baseRefName: 'main', state: 'MERGED' }
  const spec = { ...SPEC, prs: [stacked, merged] }
  const { repository } = body(answer(graphql(discovery('e2e-owner', 'e2e-repo', 'feat/base')), spec).stdout).data
  assert.deepEqual(
    repository.h0.nodes.map((n: { number: number }) => n.number),
    [9],
  )
  assert.deepEqual(
    repository.b0.nodes.map((n: { number: number }) => n.number),
    [8],
  )
})

test('a query for a repo the fake does not stand for is a NOT_FOUND, never a PR', () => {
  const r = answer(graphql(discovery('martin-macak', 'claude-code-mod-tracking', 'feat/fake-conflict')), SPEC)
  assert.equal(r.exitCode, 1)
  const reply = body(r.stdout)
  assert.equal(reply.data.repository, null)
  assert.equal(reply.errors[0].type, 'NOT_FOUND')
  assert.deepEqual(reply.errors[0].path, ['repository'])
})

test('a refresh query gets the PR with the same merge state', () => {
  const r = answer(graphql(refresh('e2e-owner', 'e2e-repo', 7)), SPEC)
  assert.equal(r.exitCode, 0)
  assert.equal(r.call, 'graphql refresh')
  const node = body(r.stdout).data.a0.issueOrPullRequest
  assert.equal(node.__typename, 'PullRequest')
  assert.equal(node.number, 7)
  assert.equal(node.title, 'Fix the fake conflict')
  assert.equal(node.state, 'OPEN')
  assert.equal(node.mergeable, 'CONFLICTING')
  assert.equal(node.mergeStateStatus, 'DIRTY')
  assert.equal(node.url, 'https://github.com/e2e-owner/e2e-repo/pull/7')
})

test('a refresh query for a repo the fake does not stand for is a NOT_FOUND on its alias', () => {
  const r = answer(graphql(refresh('martin-macak', 'claude-code-mod-tracking', 7)), SPEC)
  assert.equal(r.exitCode, 1)
  assert.equal(r.call, 'graphql refresh')
  const reply = body(r.stdout)
  assert.equal(reply.data.a0, null)
  assert.equal(reply.errors[0].type, 'NOT_FOUND')
  assert.deepEqual(reply.errors[0].path, ['a0'])
})

test('a refresh query for a number the fake does not know gets null, as GitHub says for a missing item', () => {
  const reply = body(answer(graphql(refresh('e2e-owner', 'e2e-repo', 99)), SPEC).stdout)
  assert.equal(reply.data.a0.issueOrPullRequest, null)
})

test('any other call is unsupported: exit 1, a message, and a name for the log', () => {
  const r = answer(['pr', 'list', '--json', 'number'], SPEC)
  assert.equal(r.exitCode, 1)
  assert.equal(r.call, 'unsupported')
  assert.match(r.stderr, /fake gh: unsupported call: pr list --json number/)
  assert.equal(answer(['api', 'user'], SPEC).call, 'unsupported')
  assert.equal(answer([], SPEC).call, 'unsupported')
})

test('fakeGhSpec builds the spec from owner/repo and the PRs', () => {
  assert.deepEqual(fakeGhSpec('e2e-owner/e2e-repo', 'main', [PR]), SPEC)
  assert.throws(() => fakeGhSpec('no-slash', 'main', []), /owner\/repo/)
})

test('parseOwnerRepo takes two plain names and nothing else, so every part of the fake agrees on one check', () => {
  assert.deepEqual(parseOwnerRepo('e2e-owner/e2e-repo'), { owner: 'e2e-owner', repo: 'e2e-repo' })
  assert.deepEqual(parseOwnerRepo('a.b_c/d-e.f'), { owner: 'a.b_c', repo: 'd-e.f' })
  for (const bad of ['no-slash', 'a/b/c', '/b', 'a/', 'a b/c', 'a/b;c', ''])
    assert.throws(() => parseOwnerRepo(bad), /expected owner\/repo/, bad)
  // The spec used to split on "/" only, so "a b/c" passed there and failed in fakeGithubClone.
  assert.throws(() => fakeGhSpec('a b/c', 'main', []), /owner\/repo/)
})

test('fakeGhEnv puts the shim dir first on PATH, keeps the rest, and names the spec and the log', () => {
  const env = fakeGhEnv({ specFile: '/s/fake-gh.json', logFile: '/s/fake-gh.log' }, `/usr/bin${delimiter}/bin`)
  assert.equal(env.PATH, [`${FAKE_GH_DIR}/bin`, '/usr/bin', '/bin'].join(delimiter))
  assert.equal(env.FAKE_GH_SPEC, '/s/fake-gh.json')
  assert.equal(env.FAKE_GH_LOG, '/s/fake-gh.log')
  assert.equal(env.FAKE_GH_NODE, process.execPath)
  assert.ok(existsSync(join(FAKE_GH_DIR, 'bin', 'gh')))
})

test('fakeGhEnv blanks the GitHub tokens, so a token of the caller gives claude no credential for the fake repo', () => {
  // `env(1)` adds variables and never removes one: a GH_TOKEN in the environment of the harness would pass through.
  const env = fakeGhEnv({ specFile: '/s/fake-gh.json', logFile: '/s/fake-gh.log' }, '/usr/bin')
  assert.equal(env.GH_TOKEN, '')
  assert.equal(env.GITHUB_TOKEN, '')
})

test('callsOf reads one call per log line and skips a broken line', () => {
  const text = [
    JSON.stringify({ call: '--version', exit: 0, argv: ['--version'] }),
    'not json',
    JSON.stringify({ call: 'unsupported', exit: 1, argv: ['pr', 'list'] }),
    '',
  ].join('\n')
  assert.deepEqual(
    callsOf(text).map(c => c.call),
    ['--version', 'unsupported'],
  )
  assert.deepEqual(callsOf(''), [])
})

// The shim as claude runs it: a program named gh, first on PATH, that reads FAKE_GH_SPEC.
function shim(args: string[], env: Record<string, string | undefined>) {
  const result = spawnSync(join(FAKE_GH_DIR, 'bin', 'gh'), args, {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, FAKE_GH_NODE: process.execPath, ...env },
  })
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr }
}

test('the gh shim answers from the spec file and logs one line per call', () => {
  const dir = tempDir('fake-gh-')
  const specFile = join(dir, 'fake-gh.json')
  const logFile = join(dir, 'fake-gh.log')
  writeFileSync(specFile, JSON.stringify(SPEC))
  const env = { FAKE_GH_SPEC: specFile, FAKE_GH_LOG: logFile }

  const version = shim(['--version'], env)
  assert.equal(version.exitCode, 0)
  assert.match(version.stdout, /^gh version/)

  const found = shim(graphql(discovery('e2e-owner', 'e2e-repo', 'feat/fake-conflict')), env)
  assert.equal(found.exitCode, 0)
  assert.equal(body(found.stdout).data.repository.h0.nodes[0].number, 7)

  const other = shim(['pr', 'list'], env)
  assert.equal(other.exitCode, 1)
  assert.match(other.stderr, /unsupported call: pr list/)

  const calls = callsOf(readFileSync(logFile, 'utf8'))
  assert.deepEqual(
    calls.map(c => [c.call, c.exit]),
    [
      ['--version', 0],
      ['graphql discovery', 0],
      ['unsupported', 1],
    ],
  )
  // The log keeps a long query short: the call name says what it was.
  for (const c of calls) for (const a of c.argv) assert.ok(a.length <= 200, `argv element too long: ${a.length}`)
})

test('the gh shim logs nothing and still answers when FAKE_GH_LOG is not set', () => {
  const dir = tempDir('fake-gh-')
  const specFile = join(dir, 'fake-gh.json')
  writeFileSync(specFile, JSON.stringify(SPEC))
  const r = shim(['--version'], { FAKE_GH_SPEC: specFile })
  assert.equal(r.exitCode, 0)
})

test('the gh shim refuses to answer without a spec, so a stray PATH never fakes GitHub silently', () => {
  const r = shim(['--version'], {})
  assert.equal(r.exitCode, 2)
  assert.match(r.stderr, /fake gh: FAKE_GH_SPEC is not set/)
})

test('the gh shim is the file the env names, found by PATH like claude finds gh', () => {
  const env = fakeGhEnv({ specFile: '/nowhere', logFile: '/nowhere.log' }, process.env.PATH ?? '')
  const found = execFileSync('/bin/sh', ['-c', 'command -v gh'], { encoding: 'utf8', env }).trim()
  assert.equal(found, join(FAKE_GH_DIR, 'bin', 'gh'))
})
