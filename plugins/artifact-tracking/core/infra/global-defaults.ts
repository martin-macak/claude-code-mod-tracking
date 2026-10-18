// The `global` block of the config file as it reads before any file exists (spec 5.7).
// Infra collaborators read their numbers from here, never from `LIMITS`. No config file is read in L3 (plan constraint).

import type { GlobalConfig } from '../interfaces/config'

/** Frozen all the way down: a collaborator that wrote to it would change every other reader. */
export const GLOBAL_DEFAULTS: GlobalConfig = Object.freeze({
  refresh: Object.freeze({ tickMs: 30000, staleMs: 300000, captureDebounceMs: 1000, flushMs: 1500 }),
  tools: Object.freeze({
    timeoutMs: 30000,
    probeTimeoutMs: 10000,
    breaker: Object.freeze({ threshold: 3, openMs: 300000 }),
  }),
  store: Object.freeze({ keepSessions: 20, maxItems: 500, maxDismissed: 500, maxBytes: 3000000 }),
  ui: Object.freeze({ maxRows: 300, sectionRows: 50 }),
})
