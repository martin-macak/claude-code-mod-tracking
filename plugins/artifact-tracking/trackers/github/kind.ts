// The item kind of GitHub issues and pull requests: its key, its record, its fold and its refresh through `gh`.
// Plan: L5 Task 4, K4, K5. Task 5 adds `claimUrl` and `scan`; Task 6 the rules; Task 8 the async hooks.

import type { Claim, ItemKind, Json, Refreshable, RefreshContext } from '../../core/interfaces/items'
import { sighted } from '../../core/lib/records'
import { ghClient } from './client'
import type { GithubConfig } from './config'
import { GitHubItem } from './github-item'
import { BRANCH_PR, CLOSED_BY_PR } from './rules'
import { githubClaim, scanGitHub } from './scan'
import type { GitHubRecord, GitHubRef, GitHubTarget } from './types'
import { githubKeyOf, githubUrl, parseGitHubUrl } from './urls'

/** The ref a claim carries: the kind's ref fields under the category. */
const refOf = (claim: Claim): GitHubRef => ({ category: 'github', ...claim.fields }) as unknown as GitHubRef

function githubRecord(ref: GitHubRef, claim: Claim): GitHubRecord {
  const base = { sources: [claim.source], firstSeen: claim.at, lastSeen: claim.at, seenCount: 1 }
  const host = ref.host.toLowerCase()
  if (!ref.owner || !ref.repo) {
    return {
      key: githubKeyOf(ref),
      category: 'github',
      url: ref.url ?? '',
      label: `#${ref.number}`,
      ...base,
      host,
      number: ref.number,
      type: ref.type,
    }
  }
  const owner = ref.owner.toLowerCase()
  const repo = ref.repo.toLowerCase()
  return {
    key: githubKeyOf(ref),
    category: 'github',
    url: ref.url ?? githubUrl(host, owner, repo, ref.type, ref.number),
    label: `${owner}/${repo}#${ref.number}`,
    ...base,
    host,
    owner,
    repo,
    number: ref.number,
    type: ref.type,
  }
}

/** The client of the `gh` handle the owning tracker declared. The runner builds a handle for every live tool. */
const clientOf = (c: RefreshContext) =>
  ghClient(c.tools.handle('gh')!, { now: c.now, limits: () => c.config.slice() as unknown as GithubConfig })

export const githubKind: ItemKind<GitHubRecord> = {
  category: 'github',
  rank: 10,
  claimUrl(url, _label, ctx) {
    const hosts = ctx.facts.read<Json>('github.hosts') as unknown as readonly string[] | undefined
    const ref = parseGitHubUrl(url, hosts)
    return ref && githubClaim(ref, ctx)
  },
  scan: scanGitHub,
  decode: item => (item.category === 'github' && typeof item.number === 'number' ? (item as GitHubRecord) : null),
  merge(cur, seen) {
    if (cur === null) return githubRecord(refOf(seen), seen)
    const next = sighted(cur, seen)
    if (cur.type === 'unknown') next.type = refOf(seen).type
    return next
  },
  fold(_winner, loser, out) {
    if (out.type === 'unknown') out.type = loser.type
    return out
  },
  refresh: {
    tool: 'gh',
    fields: ['title', 'state', 'stateReason', 'isDraft', 'reviewDecision', 'checks', 'closes'],
    hydrate: (rec, c): Refreshable =>
      new GitHubItem(
        rec,
        clientOf(c),
        () => c.config.global().refresh.staleMs,
        () => (c.config.slice() as unknown as GithubConfig).pendingStaleMs,
      ),
    refreshItems: (items: Refreshable[], c) => clientOf(c).refreshItems(items as unknown as GitHubTarget[]),
    apply: (out, fresh) => (out.type === 'unknown' || fresh.type !== 'unknown' ? { ...out, type: fresh.type } : out),
  },
  rules: [BRANCH_PR, CLOSED_BY_PR],
}
