// The item kind of GitHub issues and pull requests: its key, its record, its fold and its refresh through `gh`, the
// session repo it needs before a scan (`prepare`) and the open check of a short `#N` (`accept`).
// Plan: L5 Task 4, K4, K5. Task 5 adds `claimUrl` and `scan`; Task 6 the rules; Task 8 the async hooks.

import type { Claim, ItemKind, Json, Refreshable, RefreshContext } from '../../core/interfaces/items'
import type { RepoRef } from '../../core/interfaces/ports'
import { sighted } from '../../core/lib/records'
import { ghOf } from './client'
import type { GithubConfig } from './config'
import { GitHubItem } from './github-item'
import { ensureRepo, forgetRepo } from './repo'
import { githubRow } from './rows'
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

/** The client of the `gh` handle the owning tracker declared. The runner builds a handle for every declared tool. */
const clientOf = (c: RefreshContext) => ghOf(c.tools, c.config, c.now)!

// ---------------------------------------------------------------- the open check of a short #N

type Short = { host: string; owner: string; repo: string; number: number; type: 'unknown' }

/** A short `#N` of the session repo: the claim of a keyword-prefixed ref, named in the session repo, type not known. */
function shortOf(repo: RepoRef | null | undefined, claim: Claim): Short | null {
  const f = claim.fields as unknown as Partial<GitHubRef> & { short?: true }
  if (claim.category !== 'github' || f.short !== true || f.type !== 'unknown' || !f.owner || !f.repo || !repo)
    return null
  const same =
    f.host?.toLowerCase() === repo.host.toLowerCase() &&
    f.owner.toLowerCase() === repo.owner.toLowerCase() &&
    f.repo.toLowerCase() === repo.repo.toLowerCase()
  return same ? { host: f.host!, owner: f.owner, repo: f.repo, number: f.number!, type: 'unknown' } : null
}

export const githubKind: ItemKind<GitHubRecord> = {
  category: 'github',
  rank: 10,
  claimUrl(url, _label, ctx) {
    const hosts = ctx.facts.read<Json>('github.hosts') as unknown as readonly string[] | undefined
    const ref = parseGitHubUrl(url, hosts)
    return ref && githubClaim(ref, ctx)
  },
  scan: scanGitHub,
  prepare: ensureRepo,
  sessionChanged: forgetRepo,
  /**
   * A short `#N` of the session repo counts only when the item exists and is open. Without `gh` none of them counts.
   * One pre-check call refreshes the candidates and reads their state.
   */
  async accept(claims, ctx) {
    const repo = ctx.facts.read<Json>('session.repo') as unknown as RepoRef | null | undefined
    const gh = ghOf(ctx.tools, ctx.config, () => ctx.clock.wall())
    const shorts = new Map(claims.map(c => [c, shortOf(repo, c)] as const))
    if (!gh) return claims.filter(c => !shorts.get(c))
    const targets: GitHubTarget[] = claims.flatMap(c => {
      const s = shorts.get(c)
      return s ? [{ key: c.key, ...s }] : []
    })
    if (targets.length === 0) return claims
    await gh.refreshItems(targets)
    // GhTool sets either `error` or a normalized lower-case `state` for each queried item.
    const open = new Set(targets.filter(t => t.error === undefined && t.state === 'open').map(t => t.key))
    return claims.filter(c => !shorts.get(c) || open.has(c.key))
  },
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
    // A manual refresh also forgets the hosts `gh` denied, which the handle does not know.
    reset: c => clientOf(c).reset(),
  },
  rules: [BRANCH_PR, CLOSED_BY_PR],
  row: githubRow,
}
