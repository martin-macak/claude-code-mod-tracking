// Contract between the github tracker and the fake `gh` of the e2e harness (issue #106). The real GhTool, with the real
// query builders and parsers, runs against `answer()` of e2e/support/fake-gh.ts. A rename of an alias or of a field in
// the tracker that the fake does not follow fails here, in `make verify`, and not only in a local `make e2e`, where the
// break would show as an unsupported call at the chip step.
// It lives here and not in plugins/artifact-tracking/tests, because the kit refuses an import from outside the plugin
// folder. Node runs it with the coverage loader (extensionless imports), as `make test-scripts` does for this folder.
// Run: node --experimental-transform-types --no-warnings --import scripts/coverage/loader.mjs --test scripts/contracts/fake-gh-contract.test.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { answer } from '../../e2e/support/fake-gh.ts'
import { GhTool } from '../../plugins/artifact-tracking/trackers/github/gh-tool'
import { discoverPrs } from '../../plugins/artifact-tracking/trackers/github/pr-discovery'

const NOW = 1_000_000
const REPO = { host: 'github.com', owner: 'e2e-owner', repo: 'e2e-repo' }
const PR = {
  number: 7,
  title: 'Fix the fake conflict',
  headRefName: 'feat/fake-conflict',
  baseRefName: 'main',
  mergeable: 'CONFLICTING',
  mergeStateStatus: 'DIRTY',
}
const SPEC = { owner: REPO.owner, repo: REPO.repo, defaultBranch: 'main', prs: [PR] }

/** The fields of `object` that `expected` names, so a test states only what it cares about. */
const pick = (object, expected) => Object.fromEntries(Object.keys(expected).map(key => [key, object[key]]))

/** A GhTool whose runner is the fake. `kinds` lists the name of the fake's answer to each call, in order. */
function rig(spec = SPEC) {
  const kinds = []
  const run = async argv => {
    const r = answer(argv.slice(1), spec) // argv[0] is "gh"
    kinds.push(r.call)
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
  }
  return { tool: new GhTool(run, () => NOW), kinds }
}

const target = (owner, repo, number) => ({
  key: `gh:github.com/${owner}/${repo}#${number}`.toLowerCase(),
  host: 'github.com',
  owner,
  repo,
  number,
  type: 'unknown',
})

test('the fake gh answers the discovery query that the lane builds, and the lane reads the conflict from it', async () => {
  const { tool, kinds } = rig()
  await tool.probe()
  const out = await discoverPrs(tool, REPO, ['feat/fake-conflict'], NOW)

  assert.equal(out.ok, true)
  assert.equal(out.complete, true)
  assert.equal(out.defaultBranch, 'main')
  assert.equal(out.prs.length, 1)
  const expected = {
    number: 7,
    title: 'Fix the fake conflict',
    state: 'open',
    headRefName: 'feat/fake-conflict',
    baseRefName: 'main',
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY',
    by: 'head',
  }
  assert.deepEqual(pick(out.prs[0], expected), expected)
  // Both calls were answered as what they are. An alias that the fake no longer knows would read `unsupported`.
  assert.deepEqual(kinds, ['--version', 'graphql discovery'])
})

test('the fake gh answers the refresh query of the tool, and the tool reads the PR from it', async () => {
  const { tool, kinds } = rig()
  await tool.probe()
  const pr = target(REPO.owner, REPO.repo, 7)
  await tool.refreshItems([pr])

  const expected = { type: 'pr', state: 'open', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', refreshedAt: NOW }
  assert.deepEqual(pick(pr, expected), expected)
  assert.equal(pr.error, undefined)
  assert.deepEqual(kinds, ['--version', 'graphql refresh'])
  assert.equal(tool.status().breaker, 'closed')
})

test('the tool reads a PR number and a repo that the fake does not know as not found, and keeps the others', async () => {
  const { tool } = rig()
  await tool.probe()
  const known = target(REPO.owner, REPO.repo, 7)
  const missing = target(REPO.owner, REPO.repo, 99)
  const foreign = target('martin-macak', 'claude-code-mod-tracking', 7)
  await tool.refreshItems([known, missing, foreign])

  assert.equal(known.type, 'pr')
  assert.equal(known.mergeable, 'CONFLICTING')
  for (const item of [missing, foreign]) {
    assert.equal(item.error?.kind, 'not-found')
    assert.equal(item.error?.at, NOW)
  }
  assert.equal(tool.status().breaker, 'closed')
})

test('the fake gh answers the pullRequest(number:) alias of a created PR, and a missing number as gone (issue #158)', async () => {
  const { tool, kinds } = rig()
  await tool.probe()
  const out = await discoverPrs(tool, REPO, [], NOW, undefined, undefined, {
    created: [
      { ...REPO, number: 7 },
      { ...REPO, number: 99 },
    ],
  })
  assert.equal(out.ok, true)
  assert.deepEqual(
    out.prs.map(p => [p.number, p.by, p.created, p.mergeable]),
    [[7, 'created', true, 'CONFLICTING']],
  )
  // The number that is not there is gone, not unsure: the reply stays complete, and nothing is held.
  assert.equal(out.complete, true)
  assert.equal('held' in out, false)
  assert.deepEqual(kinds, ['--version', 'graphql discovery'])
})

test('the fake gh answers a created PR of another repo as not found, so the lane holds it and the rest stays complete', async () => {
  const { tool } = rig()
  await tool.probe()
  const other = { ...REPO, owner: 'martin-macak', repo: 'claude-code-mod-tracking' }
  const out = await discoverPrs(tool, REPO, [], NOW, undefined, undefined, {
    created: [
      { ...REPO, number: 7 },
      { ...other, number: 7 },
    ],
  })
  assert.equal(out.ok, true)
  assert.deepEqual(
    out.prs.map(p => p.number),
    [7],
  )
  assert.equal(out.complete, true)
  assert.deepEqual(out.held, ['gh:github.com/martin-macak/claude-code-mod-tracking#7'])
})

test('the fake gh answers a discovery query for another repo as not found, so the lane never sees a PR of it', async () => {
  const { tool } = rig()
  await tool.probe()
  const other = { ...REPO, owner: 'martin-macak', repo: 'claude-code-mod-tracking' }
  const out = await discoverPrs(tool, other, ['feat/fake-conflict'], NOW)
  assert.equal(out.ok, true)
  assert.deepEqual(out.prs, [])
  assert.equal(out.complete, false)
})

// Issue #195: a second repo that the session proved a branch in. The fake answers it from `others`, in the one query per repo
// that the lane sends, and the item refresh of its PR finds it.
const SECOND = { host: 'github.com', owner: 'e2e-owner', repo: 'second' }
const SECOND_PR = {
  number: 9,
  title: 'A teammate PR',
  headRefName: 'feat/second',
  baseRefName: 'main',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
}
const TWO = { ...SPEC, others: [{ owner: SECOND.owner, repo: SECOND.repo, defaultBranch: 'trunk', prs: [SECOND_PR] }] }
const foreignOf = branches => [{ ...SECOND, branches }]

test('the fake gh answers the branch query of a second repo, and the lane lists its PR as a PR of another repo (issue #195)', async () => {
  const { tool, kinds } = rig(TWO)
  await tool.probe()
  const out = await discoverPrs(tool, REPO, ['feat/fake-conflict'], NOW, undefined, undefined, {
    foreign: foreignOf(['feat/second']),
  })

  assert.equal(out.ok, true)
  assert.equal(out.complete, true)
  assert.equal('heldRepos' in out, false)
  assert.deepEqual(
    out.prs.map(p => [p.owner, p.repo, p.number, p.by, p.otherRepo, p.mergeable]),
    [
      ['e2e-owner', 'e2e-repo', 7, 'head', undefined, 'CONFLICTING'],
      ['e2e-owner', 'second', 9, 'head', true, 'MERGEABLE'],
    ],
  )
  assert.equal(out.prs[1].url, 'https://github.com/e2e-owner/second/pull/9')
  // The default branch that the second repo names is learned, so its branch alias is never asked for it.
  assert.deepEqual(out.foreignDefaults, { 'github.com/e2e-owner/second': 'trunk' })
  assert.deepEqual(kinds, ['--version', 'graphql discovery', 'graphql discovery'])
})

test('a second repo that the fake does not stand for is held, silently, and the session repo stays complete', async () => {
  const { tool } = rig(SPEC)
  await tool.probe()
  const out = await discoverPrs(tool, REPO, ['feat/fake-conflict'], NOW, undefined, undefined, {
    foreign: foreignOf(['feat/second']),
  })
  assert.equal(out.ok, true)
  assert.equal(out.complete, true)
  assert.deepEqual(out.heldRepos, ['github.com/e2e-owner/second'])
  assert.deepEqual(
    out.prs.map(p => p.number),
    [7],
  )
})

test('the fake gh answers the refresh query of a PR in a second repo', async () => {
  const { tool, kinds } = rig(TWO)
  await tool.probe()
  const pr = target(SECOND.owner, SECOND.repo, 9)
  await tool.refreshItems([pr])
  assert.equal(pr.error, undefined)
  const expected = { type: 'pr', state: 'open', mergeable: 'MERGEABLE' }
  assert.deepEqual(pick(pr, expected), expected)
  assert.deepEqual(kinds, ['--version', 'graphql refresh'])
})
