// PR discovery (spec A8, 8.3, 9.2): one aliased GraphQL query for the PRs whose head or base is a tracked branch, and
// the PRs the session created by number (issue #158), in the same query for the session repo and in one more for each
// other repo. A foreign repo that the session proved branches in (issue #195) is asked for those branches in that one
// query too. Pure around an injected GitHubDiscoveryApi. No `$`.

import type { RepoRef } from '../../core/interfaces/ports'
import { dig, isRecord } from '../../core/lib/json'
import { GITHUB_DEFAULTS, PR_LANE_DEFAULTS, type PrLane } from './config'
import { mergeableOf, rollupToChecks } from './gh-tool'
import type {
  DiscoveredPr,
  DiscoveryOutcome,
  DiscoveryTool,
  ForeignRepo,
  GitHubState,
  GraphqlOutcome,
  GraphqlReply,
  PrRef,
} from './types'
import { prKey, repoKey } from './urls'

/** A branch alias (`h`, `b`) or the alias of a PR the session created (`p`), which holds that one PR of any state. */
export type Alias = { branch: string; by: 'head' | 'base' } | { number: number; by: 'created' }

const ORDER = 'orderBy: {field: UPDATED_AT, direction: DESC}'
/** The PR fields of the query. Built per call, because the closing refs count comes from the config. */
const fragmentOf = (closingRefs: number): string => `fragment pr on PullRequest {
  number title state isDraft url headRefName baseRefName isCrossRepository reviewDecision body mergeable mergeStateStatus
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  closingIssuesReferences(first: ${closingRefs}) { nodes { number url repository { nameWithOwner } } }
}`

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/**
 * A head alias (open, merged, closed) and a base alias (open) per branch. The known default branch gets none. A PR the
 * session created has one `pullRequest(number:)` alias, after the branches: it finds the PR whatever its state or branch.
 * `lane` holds the `first:` counts. The PR lane passes the github slice; a direct caller gets today's numbers.
 */
export function buildDiscoveryQuery(
  repo: RepoRef,
  branches: readonly string[],
  defaultBranch?: string,
  lane: PrLane = PR_LANE_DEFAULTS,
  numbers: readonly number[] = [],
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
  numbers.forEach((n, j) => {
    fields.push(`    p${j}: pullRequest(number: ${n}) { ...pr }`)
    aliases.set(`p${j}`, { number: n, by: 'created' })
  })
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

function toPr(node: unknown, repo: RepoRef, by: DiscoveredPr['by'], closingRefs: number): DiscoveredPr | null {
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
  const mergeable = mergeableOf(node.mergeable)
  const mergeStateStatus = str(node.mergeStateStatus)
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
    ...(mergeable !== undefined ? { mergeable } : {}),
    ...(mergeStateStatus !== undefined ? { mergeStateStatus } : {}),
    headRefName: head,
    baseRefName: base,
    ...(node.isCrossRepository === true ? { crossRepo: true as const } : {}),
    body: str(node.body) ?? '',
    closing: closing.slice(0, closingRefs),
    by,
  }
}

/** The created alias that GitHub says does not exist: a `NOT_FOUND` on `repository.<alias>`. The reply is sure about it. */
function goneAlias(e: Record<string, unknown>, aliases: ReadonlyMap<string, Alias>): string | undefined {
  const path = Array.isArray(e.path) ? e.path : []
  const alias = path[1]
  const named = typeof alias === 'string' ? aliases.get(alias) : undefined
  return e.type === 'NOT_FOUND' && path.length === 2 && path[0] === 'repository' && named?.by === 'created'
    ? (alias as string)
    : undefined
}

/**
 * Head aliases first, then base aliases, then the created ones. One entry per PR number, the first alias that found it
 * wins. Drops cross-repository head matches and every match on the default branch. A cross-repository PR found by a base
 * or a created alias stays, marked `crossRepo`: its head name is a branch of the fork, not of this repo.
 * `complete` is false when an error names an alias or the repository, or an alias or the repository is null. A created
 * PR that GitHub says is gone (`NOT_FOUND` on its alias) is the one null that leaves the reply complete.
 * `unsure` lists, per created alias, the PR numbers with no sure verdict: no PR came back (null, or no repository) and
 * GitHub did not say it is gone, or an error names the alias. A created PR that parsed with no error on its alias is sure,
 * whatever else is wrong with the reply: its body is read.
 */
export function parseDiscovery(
  reply: GraphqlReply,
  repo: RepoRef,
  aliases: ReadonlyMap<string, Alias>,
  closingRefs: number = GITHUB_DEFAULTS.closingRefsPerPr,
): { prs: DiscoveredPr[]; complete: boolean; unsure: number[]; defaultBranch?: string } {
  const node = reply.data.repository
  const repoNode = isRecord(node) ? node : undefined
  let complete = repoNode !== undefined
  const gone = new Set<string>()
  /** The aliases that an error names, a gone one aside: whatever came back under them is not sure. */
  const named = new Set<string>()
  for (const e of reply.errors) {
    if (!isRecord(e)) continue
    const alias = goneAlias(e, aliases)
    if (alias !== undefined) {
      gone.add(alias)
      continue
    }
    const path = Array.isArray(e.path) ? e.path : undefined
    if (!path || path.some(p => p === 'repository' || (typeof p === 'string' && aliases.has(p)))) complete = false
    for (const p of path ?? []) if (typeof p === 'string' && aliases.has(p)) named.add(p)
  }
  const defaultName = str(dig(reply.data, 'repository', 'defaultBranchRef', 'name'))
  const prs: DiscoveredPr[] = []
  const unsure: number[] = []
  const seen = new Set<number>()
  for (const by of ['head', 'base', 'created'] as const) {
    for (const [alias, a] of aliases) {
      if (a.by !== by) continue
      const entry = repoNode?.[alias]
      if (a.by === 'created') {
        // The alias holds the PR itself. A PR that is gone leaves nothing to list and nothing unsure.
        const pr = toPr(entry, repo, 'created', closingRefs)
        const isGone = entry === null && gone.has(alias)
        if (!pr) complete &&= isGone
        if ((!pr && !isGone) || named.has(alias)) unsure.push(a.number)
        if (!pr) continue
        if (!seen.has(pr.number)) {
          seen.add(pr.number)
          prs.push(pr)
        }
        continue
      }
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
  return { prs, complete, unsure, ...(defaultName !== undefined ? { defaultBranch: defaultName } : {}) }
}

const lower = (s: string): string => s.toLowerCase()
const sameRepo = (a: RepoRef, b: RepoRef): boolean =>
  lower(a.host) === lower(b.host) && lower(a.owner) === lower(b.owner) && lower(a.repo) === lower(b.repo)

/**
 * One query: a repo, and what to ask in it. `asks` holds the branches of the query, in the first chunk of the group only
 * (`first`): the tracked branches of the session repo, or the branches that the session proved in a foreign repo (issue
 * #195). `defaultBranch` is the one that the repo is known to have: it gets no alias. Any repo takes created PRs by number,
 * at most `CREATED_PER_QUERY` of them in a query.
 */
type Group = {
  repo: RepoRef
  session: boolean
  asks: readonly string[]
  defaultBranch?: string
  first: boolean
  numbers: number[]
}

/**
 * The created PRs of one repo in one query: 50, the default `chunkSize` of the item refresh. The configured `chunkSize`
 * can be higher, but a created PR comes back with its body, so discovery keeps its own cap.
 */
const CREATED_PER_QUERY = 50

/** A group with more created PRs than a query holds, as several groups. The branches stay in the first. */
function chunked(g: Group): Group[] {
  const out: Group[] = []
  for (let i = 0; i === 0 || i < g.numbers.length; i += CREATED_PER_QUERY)
    out.push({ ...g, first: i === 0, asks: i === 0 ? g.asks : [], numbers: g.numbers.slice(i, i + CREATED_PER_QUERY) })
  return out
}

/**
 * The repos to ask. The session repo comes first, with the numbers of the PRs created in it, and only when it has a
 * branch to poll or such a PR. Every other repo of a created PR follows, in the order of the first PR, with the
 * case it came with. Then each foreign repo of the fact `repos.branches` that no created PR named: a foreign repo that a
 * created PR names too is one group, so it is one query (issue #195). A PR is in the session repo when host, owner and
 * repo match in lower case. `foreign` holds no entry of the session repo and none without a branch.
 */
function groupsOf(
  repo: RepoRef | null,
  polled: readonly string[],
  defaultBranch: string | undefined,
  asks: Required<Pick<Asks, 'created' | 'foreign'>> & Pick<Asks, 'foreignDefaults'>,
): Group[] {
  const session: Group | null = repo
    ? {
        repo,
        session: true,
        asks: polled,
        ...(defaultBranch !== undefined ? { defaultBranch } : {}),
        first: true,
        numbers: [],
      }
    : null
  const others: Group[] = []
  const find = (r: RepoRef): Group | undefined =>
    session && sameRepo(r, session.repo) ? session : others.find(o => sameRepo(o.repo, r))
  const open = (r: RepoRef): Group => {
    const known = asks.foreignDefaults?.[repoKey(r)]
    const g: Group = {
      repo: { host: r.host, owner: r.owner, repo: r.repo },
      session: false,
      asks: [],
      ...(known !== undefined ? { defaultBranch: known } : {}),
      first: true,
      numbers: [],
    }
    others.push(g)
    return g
  }
  for (const pr of asks.created) {
    const g = find(pr) ?? open(pr)
    if (!g.numbers.includes(pr.number)) g.numbers.push(pr.number)
  }
  for (const f of asks.foreign) {
    const g = find(f) ?? open(f)
    g.asks = [...new Set([...g.asks, ...f.branches])]
  }
  return [
    ...(session && (polled.length > 0 || session.numbers.length > 0) ? chunked(session) : []),
    ...others.flatMap(chunked),
  ]
}

type Failed = Extract<DiscoveryOutcome, { ok: false }>

/** A failed `graphql` outcome of `host` as a skip or an error. An `auth` skip names the host that refused. */
function failedOutcome(gh: DiscoveryTool, out: Extract<GraphqlOutcome, { ok: false }>, host: string): Failed {
  switch (out.kind) {
    case 'blocked':
      return { ok: false, skipped: 'paused' }
    case 'auth':
      return { ok: false, skipped: 'not-logged-in', host }
    case 'no-gh':
      return { ok: false, skipped: 'no-gh' }
    case 'transport':
      return { ok: false, error: out.error ?? gh.status().lastError ?? 'gh failed' }
    case 'truncated':
      return { ok: false, error: 'reply over 4 MiB' }
    case 'query-error':
      return { ok: false, error: out.error ?? 'query error' }
  }
}

/** What the lane asks beyond the tracked branches of the session repo. */
export type Asks = {
  /** The PRs the session created, by repo and number (issue #158). */
  created?: readonly PrRef[]
  /** The other repos and the branches the session proved in them (issue #195), from the fact `repos.branches`. */
  foreign?: readonly ForeignRepo[]
  /** The default branch that each foreign repo named, by `repoKey`. */
  foreignDefaults?: Readonly<Record<string, string>>
}

/**
 * Skip reasons first (spec 8.3 step 1), then one query for the session repo and one for each other repo of a PR the
 * session created (issue #158). A failed outcome becomes a skip or an error.
 *
 * `created` makes branches optional: with PRs to ask for, the lane needs neither a branch nor a session repo. A failure
 * of the first query of the session repo (the one that carries its branches) fails the step: it is asked first, and its
 * host is the home host. Every other query, a later one of the session repo (more than 50 created PRs) included, that
 * fails in any way (`auth`, a transport error, `blocked`, no `gh`), or that is on a host `gh` is not logged in to, leaves
 * the rest of the reply `complete` and lists its created PRs in `held`: a prune keeps them. So does a repo that never
 * answers (`repository: null`: deleted, no access). A host that is not the home host (the session repo's host, else
 * github.com) is checked with `checkHost` before it is asked, and `GhTool` keeps its logins and failures out of the
 * tool-wide flag and breaker. A repo that answers for some PRs and not for others holds only those with no verdict (an
 * alias that is null with no `NOT_FOUND`, or that an error names): a PR that parsed takes its new refs. None of this
 * stops every prune for the run. It fails the step only when nothing else was asked or answered. The tool-wide check
 * `canCall` gates the step only when a group of the home host will be asked. An unsure answer of the session repo makes
 * the reply not `complete`. So do tracked branches with no session repo: they are not asked. `complete` says only that the
 * reply is sure of the lane PRs of the session repo: `applyDiscovery` holds them when it is false, and still reconciles
 * each other repo by its own answer, so a foreign repo that answered is pruned also then (issue #195).
 *
 * A skip of `no-branches` or `no-repo` asks nothing, and this function has no list to prune. The lane (`PrLane`) reconciles
 * the lane PRs of other repos that earlier steps found, as the last proof of them may be gone (issue #195).
 *
 * `asks.foreign` (issue #195) holds the other repos that the session proved branches in, from the fact `repos.branches`: each
 * one is asked for those branches in its one query, which also holds the created PRs of that repo. They need neither a
 * tracked branch nor a session repo. A foreign repo with no sure answer for its branches (a failed query, a host `gh` is not
 * logged in to, `repository: null`, an alias with an error) is listed in `heldRepos`: the prune leaves its lane PRs alone,
 * except a PR that the reply returned (it was read, so its body still reconciles its refs and its marker follows the reply),
 * and the rest of the reply stays `complete`. It is silent: only a failed query that also holds a created PR can be the
 * failure of the step. `asks.foreignDefaults` holds the default branch that each foreign repo named (by `repoKey`): it gets no alias,
 * and a repo with only that branch is not asked. The default branch that a reply names goes back in the outcome
 * (`foreignDefaults`).
 */
export async function discoverPrs(
  gh: DiscoveryTool,
  repo: RepoRef | null,
  branches: readonly string[],
  now: number,
  defaultBranch?: string,
  lane: PrLane = PR_LANE_DEFAULTS,
  asks: Asks = {},
): Promise<DiscoveryOutcome> {
  const created = asks.created ?? []
  // The session repo polls its own tracked branches: a foreign entry that is that repo proves nothing more.
  const foreign = (asks.foreign ?? []).filter(f => f.branches.length > 0 && !(repo && sameRepo(f, repo)))
  if (branches.length === 0 && created.length === 0 && foreign.length === 0)
    return { ok: false, skipped: 'no-branches' }
  if (!gh.isAvailable) return { ok: false, skipped: 'no-gh' }
  if (!repo && created.length === 0 && foreign.length === 0) return { ok: false, skipped: 'no-repo' }

  const polled = [...new Set(branches)].slice(0, lane.maxBranches)
  const homeHost = lower(repo?.host ?? 'github.com')
  // What a group asks is what its query holds: `buildDiscoveryQuery` decides (a branch that is the known default branch has no
  // alias), for the gate below and for the loop alike.
  const queries = groupsOf(repo, polled, defaultBranch, {
    created,
    foreign,
    foreignDefaults: asks.foreignDefaults,
  }).map(g => ({ g, ...buildDiscoveryQuery(g.repo, g.asks, g.defaultBranch, lane, g.numbers) }))
  // `canCall` is the tool-wide check (login flag, breaker), and those stand for the home host. A step that asks foreign
  // hosts only does not wait for it: each foreign host has its own login and breaker (see `GhTool.setHome`). A session
  // group of the known default branch alone asks nothing, so it gates nothing either.
  const homeAsked = queries.length === 0 || queries.some(q => lower(q.g.repo.host) === homeHost && q.aliases.size > 0)
  if (homeAsked && !gh.canCall(now))
    return { ok: false, skipped: gh.status().loggedIn === false ? 'not-logged-in' : 'paused' }

  const createdKeys = new Set(created.map(prKey))
  const prs: DiscoveredPr[] = []
  // With no session repo the branches are never asked: a reply that holds only the PRs of other repos says nothing of the PRs
  // of the branches, so the reply is not `complete` and the prune leaves those be. The PRs of other repos are reconciled all
  // the same (`applyDiscovery`). The default branch is no exception here: with no repo it is the one that an in-process
  // /resume carried from another session, and it proves nothing about this one.
  let complete = repo !== null || polled.length === 0
  let answered = 0
  let failure: Failed | undefined
  let defaultName: string | undefined
  const held: string[] = []
  const heldRepos: string[] = []
  const learned: Record<string, string> = {}
  /**
   * The created PRs with no sure answer (all of a query that failed): the prune leaves them alone, the rest stays complete.
   * A PR that an earlier query returned (a head or base alias of the session repo) is read, and never held.
   */
  const hold = (g: Group, numbers: readonly number[] = g.numbers): void => {
    const parsed = new Set(prs.map(prKey))
    for (const number of numbers) {
      const key = prKey({ ...g.repo, number })
      if (!parsed.has(key)) held.push(key)
    }
  }
  /**
   * A group of another repo with no sure answer: its created PRs are held, and a repo that was asked for branches is held as a
   * whole (`applyDiscovery` skips a PR of it that the reply returned). A failure is the step's only when a created PR hangs
   * on it: a foreign repo with branches alone fails silently.
   */
  const holdGroup = (g: Group, why: Failed): void => {
    if (g.numbers.length > 0) failure ??= why
    hold(g)
    if (!g.session && g.asks.length > 0) heldRepos.push(repoKey(g.repo))
  }
  for (const { g, query, aliases } of queries) {
    if (aliases.size === 0) {
      answered++
      if (g.session) defaultName = defaultBranch // every branch is the known default branch: nothing to ask
      continue
    }
    // A host that only a created PR names has not passed the repo lookup: ask once (cached), do not take "not asked" for "no".
    // Only the home host goes unchecked: github.com when the session repo is there, or none is known. A refused query of
    // any other host would be the end of its own PRs, never of the others (see `GhTool.setHome`).
    if ((lower(g.repo.host) !== 'github.com' || homeHost !== 'github.com') && !(await gh.checkHost(g.repo.host))) {
      // Only a denial is "not logged in". A check that could not run (a timeout, a network error, a host at rest) leaves
      // the login unknown: the step reports that, and the pane does not tell the person to log in.
      const skip: Failed =
        gh.isHostAuthed(g.repo.host) === false
          ? { ok: false, skipped: 'host-not-authed', host: g.repo.host }
          : { ok: false, error: `gh could not check the login to ${g.repo.host}` }
      if (g.session && g.first) return skip // the first query of the session repo: nothing was read before it
      holdGroup(g, skip)
      continue
    }
    const out = await gh.graphql(g.repo.host, query)
    if (!out.ok) {
      const failed = failedOutcome(gh, out, g.repo.host)
      if (g.session && g.first) return failed // the first query of the session repo fails the step
      holdGroup(g, failed)
      continue
    }
    answered++
    const parsed = parseDiscovery(out.reply, g.repo, aliases, lane.closingRefsPerPr)
    if (g.session) complete &&= parsed.complete
    else {
      hold(g, parsed.unsure) // only the PRs with no sure verdict: the body of a PR that answered is read
      if (g.asks.length > 0) {
        if (!parsed.complete) heldRepos.push(repoKey(g.repo))
        if (parsed.defaultBranch !== undefined) learned[repoKey(g.repo)] = parsed.defaultBranch
      }
    }
    if (g.session) defaultName = parsed.defaultBranch
    for (const pr of parsed.prs)
      prs.push({
        ...pr,
        ...(createdKeys.has(prKey(pr)) ? { created: true as const } : {}),
        ...(g.session ? {} : { otherRepo: true as const }),
      })
  }
  if (answered === 0 && failure) return failure
  return {
    ok: true,
    prs,
    complete,
    ...(held.length > 0 ? { held } : {}),
    ...(heldRepos.length > 0 ? { heldRepos } : {}),
    ...(Object.keys(learned).length > 0 ? { foreignDefaults: learned } : {}),
    ...(defaultName !== undefined ? { defaultBranch: defaultName } : {}),
  }
}
