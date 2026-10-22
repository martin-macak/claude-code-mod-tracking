// The facts of the auto tracker. The readers that cannot wait take them from here or by name: the repos tracker and the
// file ignore rule read the root and the agents, the github tracker reads the branches and the PRs the run created, the
// Worktrees note reads the time of the last round.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.5. Plan: L5 Task 14.

export const FACT_ROOT = 'auto.root'
export const FACT_AGENTS = 'auto.agents'
export const FACT_CHECKED_AT = 'auto.checkedAt'
export const FACT_BRANCHES = 'auto.branches'
/** The PRs this run created (issue #158): the PR lane reads them by number, in any repo. */
export const FACT_PRS = 'auto.prs'
