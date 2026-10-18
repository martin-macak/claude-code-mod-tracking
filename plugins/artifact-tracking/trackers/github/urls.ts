// GitHub item keys and URLs. Pure: no state, no I/O. The kind, the lane and the tool build their keys here.
// Plan: L5 Task 4 (keys move with their kind). Task 5 adds `parseGitHubUrl`.

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

/** The item key of the PR, `gh:<host>/<owner>/<repo>#<n>`. */
export function prKey(pr: Pick<DiscoveredPr, 'host' | 'owner' | 'repo' | 'number'>): string {
  return githubKey(pr.host, pr.owner, pr.repo, pr.number)
}
