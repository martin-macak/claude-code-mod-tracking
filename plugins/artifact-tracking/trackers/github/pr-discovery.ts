// PR discovery (spec A8, 8.3, 9.2): one aliased GraphQL query for the PRs whose head or base is a tracked branch.
// Pure around an injected GitHubDiscoveryApi. No `$`.

import type { RepoRef } from '../../core/interfaces/ports'
import { dig, isRecord } from '../../core/lib/json'
import { GITHUB_DEFAULTS, PR_LANE_DEFAULTS, type PrLane } from './config'
import { rollupToChecks } from './gh-tool'
import type { DiscoveredPr, DiscoveryOutcome, DiscoveryTool, GitHubState, GraphqlReply } from './types'

export type Alias = { branch: string; by: 'head' | 'base' }

const ORDER = 'orderBy: {field: UPDATED_AT, direction: DESC}'
/** The PR fields of the query. Built per call, because the closing refs count comes from the config. */
const fragmentOf = (closingRefs: number): string => `fragment pr on PullRequest {
  number title state isDraft url headRefName baseRefName isCrossRepository reviewDecision body
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  closingIssuesReferences(first: ${closingRefs}) { nodes { number url repository { nameWithOwner } } }
}`

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/**
 * A head alias (open, merged, closed) and a base alias (open) per branch. The known default branch gets none.
 * `lane` holds the `first:` counts. The PR lane passes the github slice; a direct caller gets today's numbers.
 */
export function buildDiscoveryQuery(
  repo: RepoRef,
  branches: readonly string[],
  defaultBranch?: string,
  lane: PrLane = PR_LANE_DEFAULTS,
): { query: string; aliases: Map<string, Alias> } {
  const aliases = new Map<string, Alias>()
  const fields: string[] = []
  let i = 0
  for (const branch of branches) {
    if (defaultBranch !== undefined && branch === defaultBranch) continue
    const q = JSON.stringify(branch)
    fields.push(
      `    h${i}: pullRequests(headRefName: ${q}, first: ${lane.headPrsPerBranch}, states: [OPEN, MERGED, CLOSED], ${ORDER}) { nodes { ...pr } }`,
      `    b${i}: pullRequests(baseRefName: ${q}, first: ${lane.basePrsPerBranch}, states: [OPEN], ${ORDER}) { nodes { ...pr } }`,
    )
    aliases.set(`h${i}`, { branch, by: 'head' })
    aliases.set(`b${i}`, { branch, by: 'base' })
    i++
  }
  const query = `query {
  rateLimit { cost remaining }
  repository(owner: ${JSON.stringify(repo.owner)}, name: ${JSON.stringify(repo.repo)}) {
    defaultBranchRef { name }
${fields.join('\n')}
  }
}
${fragmentOf(lane.closingRefsPerPr)}`
  return { query, aliases }
}

function toPr(node: unknown, repo: RepoRef, by: 'head' | 'base', closingRefs: number): DiscoveredPr | null {
  if (!isRecord(node)) return null
  const number = node.number
  const title = str(node.title)
  const url = str(node.url)
  const head = str(node.headRefName)
  const base = str(node.baseRefName)
  if (
    typeof number !== 'number' ||
    title === undefined ||
    url === undefined ||
    head === undefined ||
    base === undefined
  )
    return null
  const state = (str(node.state) ?? 'OPEN').toLowerCase()
  const rollupState = str(dig(node, 'commits', 'nodes', 0, 'commit', 'statusCheckRollup', 'state'))
  const closingNodes = dig(node, 'closingIssuesReferences', 'nodes')
  const closing: DiscoveredPr['closing'] = []
  for (const c of Array.isArray(closingNodes) ? closingNodes : []) {
    if (!isRecord(c) || typeof c.number !== 'number') continue
    const [owner, name] = (str(dig(c, 'repository', 'nameWithOwner')) ?? '').split('/')
    closing.push({
      host: repo.host,
      owner: owner || repo.owner,
      repo: name || repo.repo,
      number: c.number,
      url: str(c.url) ?? '',
    })
  }
  const reviewDecision = str(node.reviewDecision)
  return {
    host: repo.host,
    owner: repo.owner,
    repo: repo.repo,
    number,
    url,
    title,
    state: (state === 'merged' || state === 'closed' ? state : 'open') as GitHubState,
    isDraft: node.isDraft === true,
    ...(reviewDecision !== undefined ? { reviewDecision } : {}),
    checks: rollupToChecks(rollupState),
    headRefName: head,
    baseRefName: base,
    body: str(node.body) ?? '',
    closing: closing.slice(0, closingRefs),
    by,
  }
}

/**
 * Head aliases first, then base aliases. One entry per PR number, `by: 'head'` when both found it.
 * Drops cross-repository head matches and every match on the default branch.
 * `complete` is false when an error names an alias or the repository, or an alias or the repository is null.
 */
export function parseDiscovery(
  reply: GraphqlReply,
  repo: RepoRef,
  aliases: ReadonlyMap<string, Alias>,
  closingRefs: number = GITHUB_DEFAULTS.closingRefsPerPr,
): { prs: DiscoveredPr[]; complete: boolean; defaultBranch?: string } {
  const node = reply.data.repository
  const repoNode = isRecord(node) ? node : undefined
  let complete = repoNode !== undefined
  for (const e of reply.errors) {
    if (!isRecord(e)) continue
    const path = Array.isArray(e.path) ? e.path : undefined
    if (!path || path.some(p => p === 'repository' || (typeof p === 'string' && aliases.has(p)))) complete = false
  }
  const defaultName = str(dig(reply.data, 'repository', 'defaultBranchRef', 'name'))
  const prs: DiscoveredPr[] = []
  const seen = new Set<number>()
  for (const by of ['head', 'base'] as const) {
    for (const [alias, a] of aliases) {
      if (a.by !== by) continue
      const entry = repoNode?.[alias]
      if (!isRecord(entry) || !Array.isArray(entry.nodes)) {
        complete = false
        continue
      }
      if (defaultName !== undefined && a.branch === defaultName) continue
      for (const n of entry.nodes) {
        if (by === 'head' && isRecord(n) && n.isCrossRepository === true) continue
        const pr = toPr(n, repo, by, closingRefs)
        if (!pr || seen.has(pr.number)) continue
        seen.add(pr.number)
        prs.push(pr)
      }
    }
  }
  return { prs, complete, ...(defaultName !== undefined ? { defaultBranch: defaultName } : {}) }
}

/** Skip reasons first (spec 8.3 step 1), then one query. A failed outcome becomes a skip or an error. */
export async function discoverPrs(
  gh: DiscoveryTool,
  repo: RepoRef | null,
  branches: readonly string[],
  now: number,
  defaultBranch?: string,
  lane: PrLane = PR_LANE_DEFAULTS,
): Promise<DiscoveryOutcome> {
  if (branches.length === 0) return { ok: false, skipped: 'no-branches' }
  if (!gh.isAvailable) return { ok: false, skipped: 'no-gh' }
  if (!repo) return { ok: false, skipped: 'no-repo' }
  if (!gh.canCall(now)) return { ok: false, skipped: gh.status().loggedIn === false ? 'not-logged-in' : 'paused' }
  if (repo.host.toLowerCase() !== 'github.com' && gh.isHostAuthed(repo.host) !== true)
    return { ok: false, skipped: 'host-not-authed' }

  const polled = [...new Set(branches)].slice(0, lane.maxBranches)
  const { query, aliases } = buildDiscoveryQuery(repo, polled, defaultBranch, lane)
  if (aliases.size === 0) return { ok: true, prs: [], complete: true, ...(defaultBranch ? { defaultBranch } : {}) }

  const out = await gh.graphql(repo.host, query)
  if (!out.ok) {
    switch (out.kind) {
      case 'blocked':
        return { ok: false, skipped: 'paused' }
      case 'auth':
        return { ok: false, skipped: 'not-logged-in' }
      case 'no-gh':
        return { ok: false, skipped: 'no-gh' }
      case 'transport':
        return { ok: false, error: gh.status().lastError ?? out.error ?? 'gh failed' }
      case 'truncated':
        return { ok: false, error: 'reply over 4 MiB' }
      case 'query-error':
        return { ok: false, error: out.error ?? 'query error' }
    }
  }
  return { ok: true, ...parseDiscovery(out.reply, repo, aliases, lane.closingRefsPerPr) }
}
