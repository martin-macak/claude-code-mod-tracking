// The `global` block of the config file: its schema, its defaults and the rule that normalises a raw block.
// Infra collaborators and trackers read their numbers from here, never from `LIMITS`. It lives in `core/lib` so a tracker
// can name `GLOBAL_DEFAULTS` as a default parameter without importing `core/infra` (plan decision C13).
// Bounds: the Defaults table of the L4 plan. The spec gives none.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.7. Plan: L4 Task 2.

import type { GlobalConfig } from '../interfaces/config'
import { deepFreeze, defaultsOf, int, normaliseWith, obj, type Schema } from './normalise'

export const GLOBAL_SCHEMA = {
  refresh: obj({
    tickMs: int(30000, 5000, 600000),
    staleMs: int(300000, 30000, 86400000),
    captureDebounceMs: int(1000, 100, 60000),
    flushMs: int(1500, 100, 60000),
  }),
  tools: obj({
    timeoutMs: int(30000, 1000, 300000),
    probeTimeoutMs: int(10000, 1000, 120000),
    breaker: obj({ threshold: int(3, 1, 100), openMs: int(300000, 1000, 86400000) }),
  }),
  store: obj({
    keepSessions: int(20, 1, 200),
    maxItems: int(500, 200, 5000),
    maxDismissed: int(500, 50, 5000),
    // Under the 4 MiB limit of one store key (engine constraint E18).
    maxBytes: int(3000000, 100000, 4000000),
  }),
  ui: obj({ maxRows: int(300, 50, 1000), sectionRows: int(50, 5, 300) }),
} as const satisfies Schema

/** The block as it reads with no file. Frozen all the way down: a reader that wrote to it would change every other reader. */
export const GLOBAL_DEFAULTS: GlobalConfig = deepFreeze(defaultsOf(GLOBAL_SCHEMA))

/** A raw `global` block as a valid one. Problem lines name the dotted path, e.g. `global.refresh.tickMs`. */
export function normaliseGlobal(raw: unknown, warn: (problem: string) => void): GlobalConfig {
  return normaliseWith(GLOBAL_SCHEMA, raw, GLOBAL_DEFAULTS, warn, 'global')
}
