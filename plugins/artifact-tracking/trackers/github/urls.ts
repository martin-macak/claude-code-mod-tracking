// GitHub item keys and URLs. Pure: no state, no I/O. The kind, the lane and the tool build their keys here.
// Plan: L5 Task 4 (keys move with their kind) and Task 5 (`parseGitHubUrl` moves from `hooks/scan/refs.ts`).

import type { RepoRef } from '../../core/interfaces/ports'
import type { DiscoveredPr, GitHubRef } from './types'

/** The item key of a resolved GitHub issue or PR (spec 6.2). */
export const githubKey = (host: string, owner: string, repo: string, number: number): string =>
  `gh:${host.toLowerCase()}/${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`

/** The key of a ref: resolved, or `gh:?#<n>` while a bare `#N` has no known repo. */
export function githubKeyOf(ref: Pick<GitHubRef, 'host' | 'owner' | 'repo' | 'number'>): string {
  return ref.owner && ref.repo ? githubKey(ref.host, ref.owner, ref.repo, ref.number) : `gh:?#${ref.number}`
}

/** The URL of an issue or PR by its parts. An `unknown` type is read as an issue: GitHub redirects it. */
export const githubUrl = (host: string, owner: string, repo: string, type: string, n: number): string =>
  `https://${host}/${owner}/${repo}/${type === 'pr' ? 'pull' : 'issues'}/${n}`

/** The key of a repo in the lane state and in the held list: `host/owner/repo` in lower case (issue #195). */
export const repoKey = (r: RepoRef): string => `${r.host}/${r.owner}/${r.repo}`.toLowerCase()

/** The item key of the PR, `gh:<host>/<owner>/<repo>#<n>`. */
export function prKey(pr: Pick<DiscoveredPr, 'host' | 'owner' | 'repo' | 'number'>): string {
  return githubKey(pr.host, pr.owner, pr.repo, pr.number)
}

const GH_PATH = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(issues|pull)\/(\d+)(?:[/?#].*)?$/

/**
 * The issue or PR an URL names. The URL's host must be `github.com` (also as `www.`) or one of `githubHosts`.
 * The ref keeps the URL in its canonical form: no tail, no query, no fragment.
 */
export function parseGitHubUrl(url: string, githubHosts: readonly string[] = []): GitHubRef | null {
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const seen = u.hostname.toLowerCase()
  const host = seen === 'www.github.com' ? 'github.com' : seen
  const known = host === 'github.com' || githubHosts.some(h => h.toLowerCase() === host)
  if (!known) return null
  const m = GH_PATH.exec(u.pathname + u.search + u.hash)
  if (!m) return null
  const [, owner, repo, kind, n] = m
  const number = Number(n)
  if (!Number.isSafeInteger(number)) return null
  return {
    category: 'github',
    host,
    owner: owner!,
    repo: repo!,
    number,
    type: kind === 'pull' ? 'pr' : 'issue',
    url: `https://${host}/${owner}/${repo}/${kind}/${n}`,
  }
}
