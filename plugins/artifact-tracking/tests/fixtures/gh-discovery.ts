// Aliased discovery replies (spec 9.2). The KB keeps jq-reduced JSON; the GraphQL shape is rebuilt from
// docs/knowledge-base/claude-code-auto-tracking/sources/gh-2.102.0/gh-graphql-base-filter-and-closing-issues.json
// and gh-pr-4-body-sample.md.

import type { DiscoveredPr } from './contracts'

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
