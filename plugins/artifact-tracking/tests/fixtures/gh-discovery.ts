// Aliased discovery replies (spec 9.2). The KB keeps jq-reduced JSON; the GraphQL shape is rebuilt from
// docs/knowledge-base/claude-code-auto-tracking/sources/gh-2.102.0/gh-graphql-base-filter-and-closing-issues.json
// and gh-pr-4-body-sample.md.

import type { DiscoveredPr, GitHubDiscoveryApi, GraphqlOutcome, ToolStatus } from './contracts'

export const REPO = { host: 'github.com', owner: 'acme', repo: 'web' }

type NodeOver = Partial<{
  number: number
  title: string
  state: string
  isDraft: boolean
  headRefName: string
  baseRefName: string
  isCrossRepository: boolean
  reviewDecision: string | null
  body: string
  rollup: string | null
  closing: { number: number; nameWithOwner?: string }[]
  mergeable: string | null
  mergeStateStatus: string | null
}>

/** One `PullRequest` node as the `pr` fragment returns it. */
export function prNode(over: NodeOver = {}): Record<string, unknown> {
  const number = over.number ?? 7
  return {
    number,
    title: over.title ?? `PR ${number}`,
    state: over.state ?? 'OPEN',
    isDraft: over.isDraft ?? false,
    url: `https://github.com/acme/web/pull/${number}`,
    headRefName: over.headRefName ?? 'feat/auto-tracking',
    baseRefName: over.baseRefName ?? 'main',
    isCrossRepository: over.isCrossRepository ?? false,
    reviewDecision: over.reviewDecision ?? null,
    body: over.body ?? '',
    // Left out unless a test sets it: a reply from before the merge fields has neither.
    ...(over.mergeable !== undefined ? { mergeable: over.mergeable } : {}),
    ...(over.mergeStateStatus !== undefined ? { mergeStateStatus: over.mergeStateStatus } : {}),
    commits: {
      nodes: [{ commit: { statusCheckRollup: over.rollup === null ? null : { state: over.rollup ?? 'SUCCESS' } } }],
    },
    closingIssuesReferences: {
      nodes: (over.closing ?? []).map(c => ({
        number: c.number,
        url: `https://github.com/${c.nameWithOwner ?? 'acme/web'}/issues/${c.number}`,
        repository: { nameWithOwner: c.nameWithOwner ?? 'acme/web' },
      })),
    },
  }
}

/** The `data` object of a reply. A null alias stands for an alias GitHub could not resolve. */
export function discoveryData(
  aliases: Record<string, unknown[] | null>,
  defaultBranch: string | null = 'main',
): Record<string, unknown> {
  const repository: Record<string, unknown> = {
    defaultBranchRef: defaultBranch === null ? null : { name: defaultBranch },
  }
  for (const [alias, nodes] of Object.entries(aliases)) repository[alias] = nodes === null ? null : { nodes }
  return { rateLimit: { cost: 1, remaining: 4999 }, repository }
}

export const discoveryReply = (
  aliases: Record<string, unknown[] | null>,
  defaultBranch: string | null = 'main',
): string => JSON.stringify({ data: discoveryData(aliases, defaultBranch) })

/** A body with a template comment (ignored), a closing line, a Jira URL and a web URL. */
export const BODY_WITH_COMMENT =
  'Adds tracking.\n\n<!-- see #12 -->\n\nCloses #1\nSee https://acme.atlassian.net/browse/ISS-9 and https://example.com/spec\n'

/** A `DiscoveredPr` as parseDiscovery returns it. */
export function discovered(over: Partial<DiscoveredPr> = {}): DiscoveredPr {
  const number = over.number ?? 7
  return {
    host: 'github.com',
    owner: 'acme',
    repo: 'web',
    number,
    url: `https://github.com/acme/web/pull/${number}`,
    title: `PR ${number}`,
    state: 'open',
    isDraft: false,
    checks: 'success',
    headRefName: 'feat/auto-tracking',
    baseRefName: 'main',
    body: '',
    closing: [],
    by: 'head',
    ...over,
  }
}

/** What a fake repo answers with: the PR nodes of a branch alias by `head:<branch>` or `base:<branch>`, and a created PR by number. */
export type RepoNodes = {
  heads?: Record<string, unknown[]>
  numbers?: Record<number, unknown>
  defaultBranch?: string
}

export type PerRepoGhOptions = {
  /** The nodes of each repo, by `owner/repo` in lower case. A repo that is not in the table answers `repository: null`. */
  repos: Record<string, RepoNodes>
  /** A query of a repo that fails with this outcome. Read at each call: a test can change it between steps. */
  fail?: Record<string, GraphqlOutcome | undefined>
  /** The aliases of a repo whose reply names an error: the answer is not sure, and the alias is null, as GitHub sends it. */
  broken?: Record<string, string[]>
  /** What `gh auth status` says of a host. Read at each call. Default: logged in. */
  authed?: (host: string) => boolean
}

/**
 * A `gh` that answers per repo (issue #195): it reads the `repository(owner:, name:)` of the query and gives that repo its
 * nodes, a `repository: null` for a repo it does not know, or the failure that `fail` names. `calls` lists each query.
 */
export function perRepoGh(o: PerRepoGhOptions) {
  const calls: { host: string; repo: string; query: string }[] = []
  const known = new Map<string, boolean>()
  const gh = {
    isAvailable: true,
    canCall: () => true,
    status: (): ToolStatus => ({ name: 'gh', available: true, loggedIn: true, breaker: 'closed', lastError: 'boom' }),
    checkHost: async (host: string) => {
      const authed = o.authed?.(host) ?? true
      known.set(host, authed)
      return authed
    },
    isHostAuthed: (host: string) => known.get(host),
    graphql: async (host: string, q: string): Promise<GraphqlOutcome> => {
      const m = /repository\(owner: "([^"]+)", name: "([^"]+)"\)/.exec(q)
      const repo = `${m?.[1]}/${m?.[2]}`.toLowerCase()
      calls.push({ host, repo, query: q })
      const failed = o.fail?.[repo]
      if (failed) return failed
      const found = o.repos[repo]
      if (!found)
        return {
          ok: true,
          reply: { data: { repository: null }, errors: [{ type: 'NOT_FOUND', path: ['repository'] }] },
        }
      const block: Record<string, unknown> = { defaultBranchRef: { name: found.defaultBranch ?? 'main' } }
      for (const a of q.matchAll(/(p\d+): pullRequest\(number: (\d+)\)/g))
        block[a[1]!] = found.numbers?.[Number(a[2])] ?? null
      for (const a of q.matchAll(/(([hb])\d+): pullRequests\((head|base)RefName: ("(?:[^"\\]|\\.)*")/g))
        block[a[1]!] = { nodes: found.heads?.[`${a[3]}:${JSON.parse(a[4]!) as string}`] ?? [] }
      const errors = (o.broken?.[repo] ?? []).map(alias => ({ type: 'INTERNAL', path: ['repository', alias] }))
      for (const alias of o.broken?.[repo] ?? []) block[alias] = null // GitHub nulls an alias that errors: its PRs are not read
      return { ok: true, reply: { data: { rateLimit: { cost: 1, remaining: 1 }, repository: block }, errors } }
    },
  } as unknown as GitHubDiscoveryApi
  return { gh, calls }
}

/** A PR node of the fake repo `Acme-Org/Foreign-Repo`, with its URL. */
export const foreignNode = (number: number, head: string, over: NodeOver = {}): Record<string, unknown> => ({
  ...prNode({ number, headRefName: head, ...over }),
  url: `https://github.com/Acme-Org/Foreign-Repo/pull/${number}`,
})
