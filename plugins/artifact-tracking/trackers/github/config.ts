// The config of the github tracker: its schema, its defaults and its `ConfigSpec`. Bounds: the Defaults table of the
// L4 plan. Each default is the value the code used before the config file.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.7. Plan: L4 Task 2 (decisions C2, C15).

import { bool, type ConfigOf, int, type Schema, specOf, words } from '../../core/lib/normalise'
import { PROMPT_RULE } from '../../core/lib/prompt-config'

export const GITHUB_SCHEMA = {
  enabled: bool(true),
  /** Items per `gh api graphql` call (today `CHUNK` in `gh-tool.ts`). */
  chunkSize: int(50, 1, 100),
  pendingStaleMs: int(60000, 10000, 3600000),
  /** The `gh` discovery call. */
  discoveryTimeoutMs: int(10000, 1000, 120000),
  /** One `git` call of the PR lane: the worktree list, and the fetch and the merge check of the conflicting files. */
  gitTimeoutMs: int(5000, 500, 60000),
  closingRefsPerPr: int(10, 1, 50),
  headPrsPerBranch: int(5, 1, 50),
  basePrsPerBranch: int(10, 1, 50),
  maxBodyRefs: int(50, 1, 200),
  /** The cap on the items that only the PR lane added (the reason `discovered` only). Auto tracked it before L5b. */
  maxAutoItems: int(100, 1, 200),
  /** The lead words that opt a conversation `#N` in (today the regex in `hooks/scan/refs.ts`). */
  shortRefKeywords: words(['github', 'bug', 'issue', 'issues', 'enhancement', 'chore'], 32),
  /** The opt-in list of tracked items in the model's system prompt. Off by default. */
  prompt: PROMPT_RULE,
} as const satisfies Schema

export type GithubConfig = ConfigOf<typeof GITHUB_SCHEMA>
export const githubConfig = specOf(GITHUB_SCHEMA)
export const GITHUB_DEFAULTS: Readonly<GithubConfig> = githubConfig.defaults

/**
 * The values of the PR lane. `maxBranches` is the cap of the auto tracker on the branches it publishes, so the lane
 * needs none of its own: absent, `discoverPrs` polls every branch it is given. A direct caller may still pass one.
 */
export type PrLane = Pick<
  GithubConfig,
  'headPrsPerBranch' | 'basePrsPerBranch' | 'closingRefsPerPr' | 'maxBodyRefs' | 'maxAutoItems'
> & { maxBranches?: number }

/** The lane part of the github defaults, for a direct caller of `discoverPrs` or `applyDiscovery` with no slice at hand. */
export const PR_LANE_DEFAULTS: PrLane = Object.freeze({
  headPrsPerBranch: GITHUB_DEFAULTS.headPrsPerBranch,
  basePrsPerBranch: GITHUB_DEFAULTS.basePrsPerBranch,
  closingRefsPerPr: GITHUB_DEFAULTS.closingRefsPerPr,
  maxBodyRefs: GITHUB_DEFAULTS.maxBodyRefs,
  maxAutoItems: GITHUB_DEFAULTS.maxAutoItems,
})
