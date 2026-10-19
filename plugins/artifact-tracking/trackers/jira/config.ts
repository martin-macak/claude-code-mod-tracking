// The config of the jira tracker: its schema, its defaults and its `ConfigSpec`. Bounds: the Defaults table of the
// L4 plan. Each default is the value the code used before the config file.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.7. Plan: L4 Task 2.

import { bool, type ConfigOf, int, type Schema, specOf } from '../../core/lib/normalise'
import { PROMPT_RULE } from '../../core/lib/prompt-config'

export const JIRA_SCHEMA = {
  enabled: bool(true),
  /** Parallel `acli` calls. Read once per load. */
  concurrency: int(3, 1, 10),
  epicChildLimit: int(50, 1, 500),
  /** The opt-in list of tracked items in the model's system prompt. Off by default. */
  prompt: PROMPT_RULE,
} as const satisfies Schema

export type JiraConfig = ConfigOf<typeof JIRA_SCHEMA>
export const jiraConfig = specOf(JIRA_SCHEMA)
export const JIRA_DEFAULTS: Readonly<JiraConfig> = jiraConfig.defaults
