// The fact `github.branchPr` (issue #254, L3 of #57): the open PR of the session repo whose head is the current branch, as the
// preview of a file reads it to pick the base of a diff. The publisher is the github tracker, the reader is the file tracker, and a
// tracker imports no other, so the name and the shape are two copies. The parity test here fails when they part. Pure.
import { expect, test } from 'claude-code/testing'
import { Facts } from '../core/infra/facts'
import type { Json, StoredItem } from '../core/interfaces/items'
import type { RepoRef } from '../core/interfaces/ports'
import { reasonSet } from '../core/lib/reasons'
import { branchesOfFact, FACT_BRANCH_PR as READ_NAME } from '../trackers/file/facts'
import { branchPrOf, FACT_BRANCH_PR, publishBranchPr } from '../trackers/github/branch-pr'
import { forgetRepo } from '../trackers/github/repo'
import { BRANCH_PR } from '../trackers/github/rules'
import type { GitHubRecord } from '../trackers/github/types'

const REPO: RepoRef = { host: 'github.com', owner: 'acme', repo: 'web' }

const pr = (over: Partial<GitHubRecord> = {}): GitHubRecord => ({
  key: 'gh:github.com/acme/web#9',
  category: 'github',
  url: 'https://github.com/acme/web/pull/9',
  label: 'Nine',
  sources: ['auto'],
  reasons: reasonSet('discovered'),
  firstSeen: 1,
  lastSeen: 1,
  seenCount: 1,
  host: 'github.com',
  owner: 'acme',
  repo: 'web',
  number: 9,
  type: 'pr',
  state: 'open',
  headRefName: 'feat/x',
  baseRefName: 'main',
  ...over,
})

const list = (...items: GitHubRecord[]): readonly StoredItem[] => items

test('the PR of the current branch: host, owner, repo, number, base and head of the open PR whose head is the branch', () => {
  expect(branchPrOf(list(pr()), REPO, 'feat/x')).toEqual({
    host: 'github.com',
    owner: 'acme',
    repo: 'web',
    number: 9,
    base: 'main',
    head: 'feat/x',
  })
})

test('a draft PR is the fact too, as it is the top PR of rule R7', () => {
  expect(branchPrOf(list(pr({ isDraft: true })), REPO, 'feat/x')).toMatchObject({ number: 9, base: 'main' })
})

test('a stacked PR gives its own base, not the default branch', () => {
  expect(branchPrOf(list(pr({ baseRefName: 'feat/file-preview' })), REPO, 'feat/x')?.base).toBe('feat/file-preview')
})

test('no fact without an open PR of the session repo on the current branch', () => {
  const cases: [string, readonly StoredItem[], RepoRef | undefined, string | undefined][] = [
    ['no current branch (a detached HEAD, or auto has not run)', list(pr()), REPO, undefined],
    ['no session repo', list(pr()), undefined, 'feat/x'],
    ['another branch', list(pr()), REPO, 'feat/y'],
    ['a merged PR', list(pr({ state: 'merged' })), REPO, 'feat/x'],
    ['a closed PR', list(pr({ state: 'closed' })), REPO, 'feat/x'],
    ['an issue', list(pr({ type: 'issue' })), REPO, 'feat/x'],
    ['a PR of another repo', list(pr({ repo: 'api' })), REPO, 'feat/x'],
    ['a PR of another owner', list(pr({ owner: 'other' })), REPO, 'feat/x'],
    ['a PR of another host', list(pr({ host: 'ghe.corp' })), REPO, 'feat/x'],
    ['a PR the lane did not give a head branch', list(pr({ headRefName: undefined })), REPO, 'feat/x'],
    ['a PR with no base branch', list(pr({ baseRefName: undefined })), REPO, 'feat/x'],
    ['a PR with a bare number and no owner', list(pr({ owner: undefined })), REPO, 'feat/x'],
    ['an empty list', list(), REPO, 'feat/x'],
  ]
  for (const [name, items, repo, branch] of cases) expect(branchPrOf(items, repo, branch), name).toBeUndefined()
})

test('the repo is compared in any case, as the priority rule R7 compares it, and the fact keeps the spelling of the record', () => {
  const upper: RepoRef = { host: 'GitHub.com', owner: 'ACME', repo: 'Web' }
  expect(branchPrOf(list(pr()), upper, 'feat/x')).toMatchObject({ owner: 'acme', repo: 'web' })
})

test('two open PRs on one branch: the newest number is the base', () => {
  const older = pr({ number: 4, key: 'gh:github.com/acme/web#4', baseRefName: 'main' })
  const newer = pr({ number: 12, key: 'gh:github.com/acme/web#12', baseRefName: 'release' })
  expect(branchPrOf(list(older, newer), REPO, 'feat/x')?.number).toBe(12)
  expect(branchPrOf(list(newer, older), REPO, 'feat/x')?.number).toBe(12)
})

test('the fact is the PR that rule R7 lifts to top: the same predicate, so the two cannot disagree', () => {
  const env = (branch: string | undefined) => ({
    facts: {
      read: <T extends Json>(name: string): T | undefined =>
        (name === 'session.repo'
          ? REPO
          : name === 'auto.branches'
            ? { seq: 1, reasons: [], branches: [], overflow: 0, ...(branch === undefined ? {} : { current: branch }) }
            : undefined) as unknown as T | undefined,
    },
    items: [],
    levelOf: () => ({}),
  })
  const variants = [
    pr(),
    pr({ isDraft: true }),
    pr({ state: 'closed' }),
    pr({ repo: 'api' }),
    pr({ type: 'issue' }),
    pr({ headRefName: undefined }),
    pr({ headRefName: 'feat/y' }),
  ]
  for (const rec of variants)
    for (const branch of ['feat/x', undefined]) {
      const top = BRANCH_PR.level(rec, env(branch) as never) === 'top'
      // R7 does not need a base branch; the fact does. Every variant here has one, so the two answers must agree.
      expect(
        branchPrOf(list(rec), REPO, branch) !== undefined,
        `${rec.state} ${rec.repo} ${rec.headRefName} ${branch}`,
      ).toBe(top)
    }
})

test('parity: the file tracker reads the name and the shape that the github tracker publishes', () => {
  expect(READ_NAME).toBe(FACT_BRANCH_PR)
  expect(READ_NAME).toBe('github.branchPr')
  const fact = branchPrOf(list(pr({ baseRefName: 'feat/file-preview' })), REPO, 'feat/x')
  expect(branchesOfFact(fact as unknown as Json)).toEqual({ base: 'feat/file-preview', head: 'feat/x' })
})

test('the reader takes a whole fact only: a base and a head that are non-empty words, and refuses an odd shape', () => {
  const whole = { host: 'github.com', owner: 'acme', repo: 'web', number: 9, base: 'main', head: 'feat/x' }
  expect(branchesOfFact(whole)).toEqual({ base: 'main', head: 'feat/x' })
  const odd: Json[] = [
    undefined as unknown as Json,
    null,
    'main',
    [],
    { ...whole, base: '' },
    { ...whole, head: '' },
    { ...whole, base: 7 },
    { ...whole, head: null },
    { host: 'github.com' },
  ]
  for (const v of odd) expect(branchesOfFact(v), JSON.stringify(v)).toBeUndefined()
})

test('publishBranchPr: the fact follows the list, the session repo and the branch of auto, and a list with no such PR withdraws it', () => {
  const facts = new Facts()
  facts.publish('session.repo', REPO as unknown as Json)
  facts.publish('auto.branches', { seq: 1, reasons: [], branches: [], overflow: 0, current: 'feat/x' })
  publishBranchPr(facts, list(pr()))
  expect(facts.read(FACT_BRANCH_PR)).toMatchObject({ number: 9, base: 'main', head: 'feat/x' })
  publishBranchPr(facts, list(pr({ state: 'merged' })))
  expect(facts.read(FACT_BRANCH_PR)).toBeUndefined()
})

test('a session switch withdraws the fact: the new session has its own repo and its own branch (forgetRepo)', () => {
  const facts = new Facts()
  facts.publish(FACT_BRANCH_PR, {
    host: 'github.com',
    owner: 'acme',
    repo: 'web',
    number: 9,
    base: 'main',
    head: 'feat/x',
  })
  forgetRepo({ facts } as never)
  expect(facts.read(FACT_BRANCH_PR)).toBeUndefined()
})
