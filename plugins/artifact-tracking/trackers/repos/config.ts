// The config of the repos tracker: its schema, its defaults and its `ConfigSpec`. Bounds: the Defaults table of the
// L4 plan. Each default is the value the code used before the config file.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.7. Plan: L4 Task 2.

import { bool, type ConfigOf, int, type Schema, specOf } from '../../core/lib/normalise'

export const REPOS_SCHEMA = {
  enabled: bool(true),
  maxRepos: int(50, 1, 500),
  maxRepoAgents: int(8, 1, 50),
  /** The lookup queue. Read once per load: it sizes an object at construction. */
  maxRepoQueue: int(32, 1, 256),
  gitTimeoutMs: int(5000, 500, 60000),
} as const satisfies Schema

export type ReposConfig = ConfigOf<typeof REPOS_SCHEMA>
export const reposConfig = specOf(REPOS_SCHEMA)
export const REPOS_DEFAULTS: Readonly<ReposConfig> = reposConfig.defaults
