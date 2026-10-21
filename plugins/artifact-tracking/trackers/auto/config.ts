// The config of the auto tracker: its schema, its defaults and its `ConfigSpec`. Bounds: the Defaults table of the
// L4 plan. Each default is the value the code used before the config file.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.7. Plan: L4 Task 2.

import { bool, type ConfigOf, int, movedKeys, type Schema, specOf } from '../../core/lib/normalise'

export const AUTO_SCHEMA = {
  enabled: bool(true),
  debounceMs: int(750, 50, 60000),
  gitTimeoutMs: int(5000, 500, 60000),
  workflowIdleMs: int(3600000, 60000, 86400000),
  maxBranches: int(12, 1, 50),
  maxProofs: int(100, 10, 1000),
  maxAgents: int(200, 10, 2000),
  // Issue #49: an ended agent row leaves the view after the TTL, counted from its `endedAt`. A failed one stays longer.
  hideEnded: bool(true),
  endedTtlMs: int(600000, 0, 86400000),
  failedTtlMs: int(3600000, 0, 86400000),
  // A removed worktree row leaves the view after the TTL, counted from the proof's `removedAt`.
  removedTtlMs: int(600000, 0, 86400000),
  // A workflow run of 2 agents or more, whose agents have all ended, is one row (`ag:wf:<runId>`) that opens to its agents.
  // The minimum of 2 is fixed: issue #146.
  foldWorkflows: bool(true),
} as const satisfies Schema

export type AutoConfig = ConfigOf<typeof AUTO_SCHEMA>
/** `maxAutoItems` left this slice in plan L5, Task 12: the github tracker adds the items that only the PR lane found. */
export const autoConfig = movedKeys(specOf(AUTO_SCHEMA), { maxAutoItems: 'trackers.github.maxAutoItems' })
export const AUTO_DEFAULTS: Readonly<AutoConfig> = autoConfig.defaults
