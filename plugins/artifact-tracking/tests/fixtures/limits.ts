// `LIMITS` for the tests, rebuilt from the defaults of the config specs. The production object is gone since L4
// (plan decision C14): each value lives with the code that owns it. The 30 names are the ones of `d391552`, so a test
// that sizes its input by `LIMITS.maxItems` keeps its meaning. Test-only: no production file imports this.
import { GLOBAL_DEFAULTS } from '../../core/lib/global-config'
import { AUTO_DEFAULTS } from '../../trackers/auto/config'
import { FILE_DEFAULTS } from '../../trackers/file/config'
import { GITHUB_DEFAULTS } from '../../trackers/github/config'
import { JIRA_DEFAULTS } from '../../trackers/jira/config'
import { REPOS_DEFAULTS } from '../../trackers/repos/config'

export const LIMITS = {
  maxItems: GLOBAL_DEFAULTS.store.maxItems,
  keepSessions: GLOBAL_DEFAULTS.store.keepSessions,
  staleMs: GLOBAL_DEFAULTS.refresh.staleMs,
  pendingStaleMs: GITHUB_DEFAULTS.pendingStaleMs,
  tickMs: GLOBAL_DEFAULTS.refresh.tickMs,
  captureDebounceMs: GLOBAL_DEFAULTS.refresh.captureDebounceMs,
  flushMs: GLOBAL_DEFAULTS.refresh.flushMs,
  breakerThreshold: GLOBAL_DEFAULTS.tools.breaker.threshold,
  breakerOpenMs: GLOBAL_DEFAULTS.tools.breaker.openMs,
  toolTimeoutMs: GLOBAL_DEFAULTS.tools.timeoutMs,
  acliConcurrency: JIRA_DEFAULTS.concurrency,
  epicChildLimit: JIRA_DEFAULTS.epicChildLimit,
  autoDebounceMs: AUTO_DEFAULTS.debounceMs,
  gitTimeoutMs: REPOS_DEFAULTS.gitTimeoutMs,
  discoveryTimeoutMs: GITHUB_DEFAULTS.discoveryTimeoutMs,
  workflowIdleMs: AUTO_DEFAULTS.workflowIdleMs,
  maxBranches: AUTO_DEFAULTS.maxBranches,
  headPrsPerBranch: GITHUB_DEFAULTS.headPrsPerBranch,
  basePrsPerBranch: GITHUB_DEFAULTS.basePrsPerBranch,
  closingRefsPerPr: GITHUB_DEFAULTS.closingRefsPerPr,
  maxBodyRefs: GITHUB_DEFAULTS.maxBodyRefs,
  maxAutoItems: AUTO_DEFAULTS.maxAutoItems,
  maxProofs: AUTO_DEFAULTS.maxProofs,
  maxAgents: AUTO_DEFAULTS.maxAgents,
  maxDismissed: GLOBAL_DEFAULTS.store.maxDismissed,
  maxMentionsPerRow: FILE_DEFAULTS.maxMentionsPerRow,
  maxRepos: REPOS_DEFAULTS.maxRepos,
  maxRepoAgents: REPOS_DEFAULTS.maxRepoAgents,
  maxRepoQueue: REPOS_DEFAULTS.maxRepoQueue,
  /** The newest manual-high items the cap never drops: a code constant, `MAX_PINNED` in the registry (decision C2). */
  maxPinned: 100,
} as const
