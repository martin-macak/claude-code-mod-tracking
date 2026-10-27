// PR discovery of the branches of other repos (issue #195): the lane asks each foreign repo that the repos tracker proved
// branches in, in the one query per repo that #186 added. Pure, fake gh.
import { expect, test } from 'claude-code/testing'
import { PR_LANE_DEFAULTS } from '../trackers/github/config'
import { discoverPrs } from '../trackers/github/pr-discovery'
import type { ForeignRepo, PrRef } from '../trackers/github/types'
import type { GitHubDiscoveryApi } from './fixtures/contracts'
import { foreignNode, type PerRepoGhOptions, perRepoGh, prNode, REPO } from './fixtures/gh-discovery'

const NOW = 1_000_000
const SESSION = 'acme/web'
const FOREIGN = 'acme-org/foreign-repo'
const OTHER = 'acme-org/other-repo'
const KFOREIGN = 'github.com/acme-org/foreign-repo'
const F: ForeignRepo = {
  host: 'github.com',
  owner: 'Acme-Org',
  repo: 'Foreign-Repo',
  branches: ['feat/one', 'feat/two'],
}
const O: ForeignRepo = { host: 'github.com', owner: 'Acme-Org', repo: 'Other-Repo', branches: ['feat/other'] }
const GHE: ForeignRepo = { host: 'ghe.corp', owner: 'team', repo: 'svc', branches: ['feat/g'] }
const ref = (r: { host: string; owner: string; repo: string }, number: number): PrRef => ({ ...r, number })

const run = (
  gh: GitHubDiscoveryApi,
  o: {
    branches?: string[]
    created?: PrRef[]
    foreign?: ForeignRepo[]
    foreignDefaults?: Record<string, string>
    repo?: typeof REPO | null
  } = {},
) =>
  discoverPrs(gh, o.repo === undefined ? REPO : o.repo, o.branches ?? ['feat/root'], NOW, 'main', PR_LANE_DEFAULTS, {
    created: o.created ?? [],
    foreign: o.foreign ?? [],
    foreignDefaults: o.foreignDefaults ?? {},
  })

test('discoverPrs: one query per foreign repo, with all its proven branches in it (AC2)', async () => {
  const { gh, calls } = perRepoGh({
    repos: {
      [SESSION]: {},
      [FOREIGN]: {
        heads: { 'head:feat/one': [foreignNode(31, 'feat/one')], 'head:feat/two': [foreignNode(32, 'feat/two')] },
      },
      [OTHER]: {},
    },
  })
  const r = await run(gh, { foreign: [F, O] })
  expect(calls.map(c => c.repo)).toEqual([SESSION, FOREIGN, OTHER])
  expect(calls[1]!.query).toContain('repository(owner: "Acme-Org", name: "Foreign-Repo")')
  expect(calls[1]!.query).toContain('h0: pullRequests(headRefName: "feat/one"')
  expect(calls[1]!.query).toContain('h1: pullRequests(headRefName: "feat/two"')
  expect(calls[1]!.query).not.toContain('pullRequest(number')
  expect(r.ok && r.prs.map(p => [p.owner, p.repo, p.number, p.by, p.otherRepo, p.created])).toEqual([
    ['Acme-Org', 'Foreign-Repo', 31, 'head', true, undefined],
    ['Acme-Org', 'Foreign-Repo', 32, 'head', true, undefined],
  ])
  expect(r).toMatchObject({ ok: true, complete: true })
  expect('held' in r).toBe(false)
  expect('heldRepos' in r).toBe(false)
})

test('discoverPrs: the branches and the created PRs of one foreign repo ride in one query, whatever the case of its name', async () => {
  const { gh, calls } = perRepoGh({
    repos: {
      [SESSION]: {},
      [FOREIGN]: {
        heads: { 'head:feat/one': [foreignNode(31, 'feat/one')] },
        numbers: { 40: foreignNode(40, 'feat/elsewhere') },
      },
    },
  })
  const created = [ref({ host: 'github.com', owner: 'ACME-ORG', repo: 'foreign-repo' }, 40)]
  const r = await run(gh, { foreign: [{ ...F, branches: ['feat/one'] }], created })
  expect(calls.map(c => c.repo)).toEqual([SESSION, FOREIGN])
  expect(calls[1]!.query).toContain('h0: pullRequests(headRefName: "feat/one"')
  expect(calls[1]!.query).toContain('p0: pullRequest(number: 40)')
  expect(r.ok && r.prs.map(p => [p.number, p.created])).toEqual([
    [31, undefined],
    [40, true],
  ])
})

test('discoverPrs: a foreign entry that is the session repo adds no query and no branch', async () => {
  const { gh, calls } = perRepoGh({ repos: { [SESSION]: {} } })
  await run(gh, {
    foreign: [
      { ...REPO, branches: ['feat/x'] },
      { ...REPO, owner: 'ACME', branches: ['feat/y'] },
    ],
  })
  expect(calls.map(c => c.repo)).toEqual([SESSION])
  expect(calls[0]!.query).toContain('"feat/root"')
  expect(calls[0]!.query).not.toContain('feat/x')
  expect(calls[0]!.query).not.toContain('feat/y')
})

test('discoverPrs: a foreign repo with no proven branch is not asked', async () => {
  const { gh, calls } = perRepoGh({ repos: { [SESSION]: {} } })
  await run(gh, { foreign: [{ ...O, branches: [] }] })
  expect(calls.map(c => c.repo)).toEqual([SESSION])
})

test('discoverPrs: foreign branches are asked with no tracked branch', async () => {
  const only = perRepoGh({ repos: { [FOREIGN]: { heads: { 'head:feat/one': [foreignNode(31, 'feat/one')] } } } })
  const r = await run(only.gh, { branches: [], foreign: [{ ...F, branches: ['feat/one'] }] })
  expect(only.calls.map(c => c.repo)).toEqual([FOREIGN])
  expect(r.ok && r.prs.map(p => p.number)).toEqual([31])
  expect(r).toMatchObject({ ok: true, complete: true })
})

test('discoverPrs: foreign branches are asked with no session repo', async () => {
  const noRepo = perRepoGh({ repos: { [FOREIGN]: { heads: { 'head:feat/one': [foreignNode(31, 'feat/one')] } } } })
  const n = await run(noRepo.gh, { repo: null, branches: [], foreign: [{ ...F, branches: ['feat/one'] }] })
  expect(noRepo.calls.map(c => c.repo)).toEqual([FOREIGN])
  expect(n.ok && n.prs.map(p => p.number)).toEqual([31])
})

test('discoverPrs: the skips of before stay when no branch was proven anywhere', async () => {
  const { gh } = perRepoGh({ repos: {} })
  expect(await run(gh, { branches: [], foreign: [{ ...F, branches: [] }] })).toEqual({
    ok: false,
    skipped: 'no-branches',
  })
  expect(await run(gh, { repo: null, branches: [], foreign: [] })).toEqual({ ok: false, skipped: 'no-branches' })
})

test('discoverPrs: the default branch of a foreign repo is learned from its reply', async () => {
  const { gh, calls } = perRepoGh({ repos: { [SESSION]: {}, [FOREIGN]: { defaultBranch: 'trunk' } } })
  const first = await run(gh, { foreign: [{ ...F, branches: ['trunk'] }] })
  expect(calls.map(c => c.repo)).toEqual([SESSION, FOREIGN])
  expect(first).toMatchObject({ ok: true, foreignDefaults: { [KFOREIGN]: 'trunk' } })
})

test('discoverPrs: a foreign repo with only its known default branch is not asked', async () => {
  const { gh, calls } = perRepoGh({ repos: { [SESSION]: {}, [FOREIGN]: { defaultBranch: 'trunk' } } })
  const next = await run(gh, { foreign: [{ ...F, branches: ['trunk'] }], foreignDefaults: { [KFOREIGN]: 'trunk' } })
  expect(calls.map(c => c.repo)).toEqual([SESSION])
  expect('foreignDefaults' in next).toBe(false)
})

test('discoverPrs: a branch beside the known default branch of a foreign repo is asked, the default branch is not', async () => {
  const { gh, calls } = perRepoGh({ repos: { [SESSION]: {}, [FOREIGN]: { defaultBranch: 'trunk' } } })
  await run(gh, { foreign: [{ ...F, branches: ['trunk', 'feat/one'] }], foreignDefaults: { [KFOREIGN]: 'trunk' } })
  expect(calls[1]!.query).toContain('"feat/one"')
  expect(calls[1]!.query).not.toContain('"trunk"')
})

test('discoverPrs: no default branch is learned from the session repo, a created-only group or a failed query', async () => {
  const { gh } = perRepoGh({
    repos: { [SESSION]: {}, [FOREIGN]: { numbers: { 40: foreignNode(40, 'feat/x') } } },
    fail: { [OTHER]: { ok: false, kind: 'transport' } },
  })
  const r = await run(gh, {
    created: [ref(F, 40)],
    foreign: [{ ...O, branches: ['feat/other'] }],
  })
  expect(r).toMatchObject({ ok: true })
  expect('foreignDefaults' in r).toBe(false)
})

const failures: [string, PerRepoGhOptions['fail']?, PerRepoGhOptions['broken']?][] = [
  ['a transport error', { [FOREIGN]: { ok: false, kind: 'transport', error: 'timeout' } }],
  ['an auth error', { [FOREIGN]: { ok: false, kind: 'auth' } }],
  ['a paused tool', { [FOREIGN]: { ok: false, kind: 'blocked' } }],
  ['a reply over 4 MiB', { [FOREIGN]: { ok: false, kind: 'truncated' } }],
  ['a query error', { [FOREIGN]: { ok: false, kind: 'query-error', error: 'Field x' } }],
  ['a repository that is null (gone, or no access)'],
  ['an alias that an error names', undefined, { [FOREIGN]: ['h0'] }],
]

for (const [what, fail, broken] of failures) {
  test(`discoverPrs: ${what} holds the foreign repo, silently, and the rest of the reply stays complete (AC3)`, async () => {
    const repos: PerRepoGhOptions['repos'] = {
      [SESSION]: { heads: { 'head:feat/root': [prNode({ number: 7, headRefName: 'feat/root' })] } },
      ...(what.startsWith('a repository that is null') ? {} : { [FOREIGN]: { heads: {} } }),
    }
    const { gh } = perRepoGh({ repos, ...(fail ? { fail } : {}), ...(broken ? { broken } : {}) })
    const r = await run(gh, { foreign: [{ ...F, branches: ['feat/one'] }] })
    expect(r.ok && r.prs.map(p => p.number)).toEqual([7])
    expect(r).toMatchObject({ ok: true, complete: true, heldRepos: [KFOREIGN] })
  })
}

test('discoverPrs: a foreign host that gh is not logged in to is held and asked nothing (AC3)', async () => {
  const { gh, calls } = perRepoGh({ repos: { [SESSION]: {} }, authed: host => host !== 'ghe.corp' })
  const r = await run(gh, { foreign: [GHE] })
  expect(calls.map(c => c.repo)).toEqual([SESSION])
  expect(r).toMatchObject({ ok: true, complete: true, heldRepos: ['ghe.corp/team/svc'] })
})

test('discoverPrs: a foreign repo that answers is not held, and one that fails does not hide the PRs of the others', async () => {
  const { gh } = perRepoGh({
    repos: { [SESSION]: {}, [OTHER]: { heads: { 'head:feat/other': [foreignNode(51, 'feat/other')] } } },
    fail: { [FOREIGN]: { ok: false, kind: 'transport' } },
  })
  const r = await run(gh, { foreign: [F, O] })
  expect(r.ok && r.prs.map(p => p.number)).toEqual([51])
  expect(r).toMatchObject({ ok: true, complete: true, heldRepos: [KFOREIGN] })
})

test('discoverPrs: the proven branches of a foreign repo ride in its first chunk only, and a failing repo is held once', async () => {
  const created = Array.from({ length: 51 }, (_, i) => ref(F, i + 1)) // more than a query holds: two chunks
  const ok = perRepoGh({ repos: { [SESSION]: {}, [FOREIGN]: {} } })
  await run(ok.gh, { created, foreign: [{ ...F, branches: ['feat/one', 'feat/two'] }] })
  const q = ok.calls.filter(c => c.repo === FOREIGN).map(c => c.query)
  expect(q).toHaveLength(2)
  expect(q[0]).toContain('h0: pullRequests(headRefName: "feat/one"')
  expect(q[0]).toContain('h1: pullRequests(headRefName: "feat/two"')
  expect(q[0]).toContain('p49: pullRequest(number: 50)')
  expect(q[0]).not.toContain('number: 51')
  expect(q[1]).toContain('p0: pullRequest(number: 51)')
  expect(q[1]).not.toContain('pullRequests(headRefName')
  const bad = perRepoGh({ repos: { [SESSION]: {} }, fail: { [FOREIGN]: { ok: false, kind: 'transport' } } })
  const r = await run(bad.gh, { created, foreign: [{ ...F, branches: ['feat/one'] }] })
  expect(r).toMatchObject({ ok: true, heldRepos: [KFOREIGN] }) // once, not once per chunk
  expect(r.ok && r.held).toHaveLength(51)
})

const queryError = { [FOREIGN]: { ok: false, kind: 'query-error', error: 'Field x' } } as const

test('discoverPrs: a foreign repo that holds a created PR fails the step when nothing else was asked', async () => {
  const lone = perRepoGh({ repos: {}, fail: queryError })
  const only = await run(lone.gh, { branches: [], foreign: [{ ...F, branches: ['feat/one'] }], created: [ref(F, 40)] })
  expect(only).toEqual({ ok: false, error: 'Field x' })
})

test('discoverPrs: a foreign repo that holds branches only fails silently: the step answers with what it has', async () => {
  const quiet = perRepoGh({ repos: {}, fail: queryError })
  const q = await run(quiet.gh, { branches: [], foreign: [{ ...F, branches: ['feat/one'] }] })
  expect(q).toMatchObject({ ok: true, prs: [], heldRepos: [KFOREIGN] })
})

test('discoverPrs: with the session repo answering, the failure of a foreign repo holds its created PR and the repo', async () => {
  const both = perRepoGh({ repos: { [SESSION]: {} }, fail: queryError })
  const b = await run(both.gh, { foreign: [{ ...F, branches: ['feat/one'] }], created: [ref(F, 40)] })
  expect(b).toMatchObject({
    ok: true,
    complete: true,
    held: ['gh:github.com/acme-org/foreign-repo#40'],
    heldRepos: [KFOREIGN],
  })
})

test('discoverPrs: a failure of the first query of the session repo still fails the step, with foreign repos in the list', async () => {
  const { gh } = perRepoGh({
    repos: { [FOREIGN]: {} },
    fail: { [SESSION]: { ok: false, kind: 'query-error', error: 'Field x' } },
  })
  expect(await run(gh, { foreign: [{ ...F, branches: ['feat/one'] }] })).toEqual({ ok: false, error: 'Field x' })
})
