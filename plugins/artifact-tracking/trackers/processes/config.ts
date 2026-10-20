// The config of the processes tracker: its schema, its defaults and its `ConfigSpec`. Bounds: the Defaults table of
// the L4 plan. The default is the timeout the L3 code used for the probe.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.7. Plan: L4 Task 2.

import { bool, type ConfigOf, int, type Schema, specOf } from '../../core/lib/normalise'

export const PROCESSES_SCHEMA = {
  enabled: bool(true),
  probeTimeoutMs: int(10000, 1000, 120000),
  // Issue #49: an ended row leaves the view after the TTL, counted from its `endedAt`. `failedTtlMs` is for `failed`
  // and `killed` rows, `endedTtlMs` for the other end states.
  hideEnded: bool(true),
  endedTtlMs: int(1800000, 0, 86400000),
  failedTtlMs: int(3600000, 0, 86400000),
} as const satisfies Schema

export type ProcessesConfig = ConfigOf<typeof PROCESSES_SCHEMA>
export const processesConfig = specOf(PROCESSES_SCHEMA)
export const PROCESSES_DEFAULTS: Readonly<ProcessesConfig> = processesConfig.defaults
