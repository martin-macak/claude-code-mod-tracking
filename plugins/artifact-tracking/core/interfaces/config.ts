// Config contracts: what a tracker declares, what the user's file holds, what a tracker sees. Types only.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.7 and 5.8.

import type { JsonObject } from './items'

/** A tracker's config: its defaults and the rule that turns a raw file slice into a valid one. */
export interface ConfigSpec<C extends JsonObject> {
  readonly defaults: Readonly<C>
  /**
   * Per-field fallback to `defaults`, a min and a max on every number, unknown keys kept.
   * Pure. Calls `warn` once per problem. The caller freezes the result.
   */
  normalise(raw: Readonly<JsonObject>, defaults: Readonly<C>, warn: (problem: string) => void): Readonly<C>
}

/** The `global` block of the config file. Core owns it. Trackers read it only. */
export interface GlobalConfig {
  readonly refresh: {
    readonly tickMs: number
    readonly staleMs: number
    readonly captureDebounceMs: number
    readonly flushMs: number
  }
  readonly tools: {
    readonly timeoutMs: number
    readonly probeTimeoutMs: number
    readonly breaker: { readonly threshold: number; readonly openMs: number }
  }
  readonly store: {
    readonly keepSessions: number
    readonly maxItems: number
    readonly maxDismissed: number
    readonly maxBytes: number
  }
  readonly ui: { readonly maxRows: number; readonly sectionRows: number }
}

/** The live view of the config a tracker gets. A changed file shows on the next call. */
export interface ConfigView<C> {
  slice(): Readonly<C>
  global(): Readonly<GlobalConfig>
}
