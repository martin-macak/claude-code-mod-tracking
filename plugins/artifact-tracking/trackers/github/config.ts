// The config of the github tracker: its schema, its defaults and its `ConfigSpec`. Bounds: the Defaults table of the
// L4 plan. Each default is the value the code used before the config file.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.7. Plan: L4 Task 2 (decisions C2, C15).

import { bool, type ConfigOf, int, type Schema, specOf, words } from '../../core/lib/normalise'

export const GITHUB_SCHEMA = {
  enabled: bool(true),
  /** Items per `gh api graphql` call (today `CHUNK` in `gh-tool.ts`). */
  chunkSize: int(50, 1, 100),
  pendingStaleMs: int(60000, 10000, 3600000),
  /** The `gh` discovery call. */
  discoveryTimeoutMs: int(10000, 1000, 120000),
  closingRefsPerPr: int(10, 1, 50),
  headPrsPerBranch: int(5, 1, 50),
  basePrsPerBranch: int(10, 1, 50),
  maxBodyRefs: int(50, 1, 200),
  /** The lead words that opt a conversation `#N` in (today the regex in `hooks/scan/refs.ts`). */
  shortRefKeywords: words(['github', 'bug', 'issue', 'issues', 'enhancement', 'chore'], 32),
} as const satisfies Schema

export type GithubConfig = ConfigOf<typeof GITHUB_SCHEMA>
export const githubConfig = specOf(GITHUB_SCHEMA)
export const GITHUB_DEFAULTS: Readonly<GithubConfig> = githubConfig.defaults

/** The values the PR lane of the auto tracker needs. */
export type PrLane = {
  headPrsPerBranch: number
  basePrsPerBranch: number
  closingRefsPerPr: number
  maxBranches: number
  maxAutoItems: number
}

/**
 * The PR lane values for a direct caller of `discoverPrs` or `applyDiscovery` that has no slice at hand. The auto round
 * always passes its own. `maxBranches` and `maxAutoItems` repeat the defaults of the auto tracker, because a tracker
 * folder imports no other (decision C15). Layer L5 gives them one owner.
 */
export const PR_LANE_DEFAULTS: PrLane = Object.freeze({
  headPrsPerBranch: GITHUB_DEFAULTS.headPrsPerBranch,
  basePrsPerBranch: GITHUB_DEFAULTS.basePrsPerBranch,
  closingRefsPerPr: GITHUB_DEFAULTS.closingRefsPerPr,
  maxBranches: 12,
  maxAutoItems: 100,
})
