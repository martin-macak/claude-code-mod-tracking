// The auto tracker reads the URL of the PR that a `gitOperation.pr` made (`createdPr` in trackers/auto/events.ts). The
// github tracker reads the URL of a ref (`parseGitHubUrl` in trackers/github/urls.ts). A tracker imports no other tracker,
// and core may not name one, so the two patterns are two copies. This test fails when they read different URLs (issue #158,
// review of #186, n4). Pure.
import { expect, test } from 'claude-code/testing'
import { fromBash } from '../trackers/auto/events'
import { parseGitHubUrl } from '../trackers/github/urls'
import { createdPr } from './fixtures/events'

/** The PR that the proof reads from `url`, or undefined. The number of the operation is the one the ref reads, or 1. */
const proofOf = (url: string, number: number) => fromBash('gh pr create', createdPr(url, number)).pr

const URLS = [
  'https://github.com/VerticeOne/vertice-iam/pull/657',
  'https://github.com/octo/demo/pull/7/',
  'https://github.com/octo/demo/pull/7/files',
  'https://github.com/octo/demo/pull/7/files#diff-1',
  'https://github.com/octo/demo/pull/7?notification_referrer_id=1',
  'https://github.com/octo/demo/pull/7#issuecomment-9',
  '  https://GitHub.com/octo/demo/pull/7  ',
  'http://github.com/octo/demo/pull/7',
  'https://www.github.com/a/b/pull/3',
  'https://github.com/octo/demo/issues/7', // an issue: the ref reads it, the proof refuses it (it is no PR)
  'https://github.com/octo/demo/pulls/7',
  'https://github.com/octo/demo/pull/7x',
  'https://github.com/octo/demo/pull/seven',
  'https://github.com/octo/demo/pull/99999999999999999999',
  'https://github.com/octo/demo',
  'https://github.com/octo/pull/7',
  'ftp://github.com/octo/demo/pull/7',
  'not a url',
  '',
]

test('the proof of a created PR and the ref of a URL read the same pull URLs, and refuse the same others', () => {
  for (const url of URLS) {
    const ref = parseGitHubUrl(url)
    // Whatever the ref reads as a PR, the proof reads as the same PR, in the same case. The rest is no proof.
    const expected =
      ref?.type === 'pr' ? { host: ref.host, owner: ref.owner, repo: ref.repo, number: ref.number } : undefined
    expect(proofOf(url, ref?.number ?? 1), url).toEqual(expected)
  }
})

test('the proof keeps a host that the ref refuses: any host is a proof, and the lane decides whether gh can ask', () => {
  const url = 'https://ghe.corp/team/svc/pull/12'
  expect(parseGitHubUrl(url)).toBeNull() // a ref needs a known host
  expect(proofOf(url, 12)).toEqual({ host: 'ghe.corp', owner: 'team', repo: 'svc', number: 12 })
  expect(parseGitHubUrl(url, ['ghe.corp'])).toMatchObject({ host: 'ghe.corp', owner: 'team', repo: 'svc', number: 12 })
})
