// The config of the auto tracker: its schema, its defaults and its `ConfigSpec`. Bounds: the Defaults table of the
// L4 plan. Each default is the value the code used before the config file.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.7. Plan: L4 Task 2.

import { bool, type ConfigOf, int, type Schema, specOf } from '../../core/lib/normalise'

export const AUTO_SCHEMA = {
  enabled: bool(true),
  debounceMs: int(750, 50, 60000),
  gitTimeoutMs: int(5000, 500, 60000),
  workflowIdleMs: int(3600000, 60000, 86400000),
  maxBranches: int(12, 1, 50),
  maxAutoItems: int(100, 1, 200),
  maxProofs: int(100, 10, 1000),
  maxAgents: int(200, 10, 2000),
} as const satisfies Schema

export type AutoConfig = ConfigOf<typeof AUTO_SCHEMA>
export const autoConfig = specOf(AUTO_SCHEMA)
export const AUTO_DEFAULTS: Readonly<AutoConfig> = autoConfig.defaults
