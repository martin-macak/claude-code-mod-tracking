// The jira tracker: Jira issues. It declares its identity, its config, its kind and its tool, `acli`. Core runs the
// capture, the refresh and the probe of `acli` through them.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.7 and 5.8. Plan: L3 Task 11, L5 Tasks 3 and 8.

import type { Json } from '../../core/interfaces/items'
import type { Tracker } from '../../core/interfaces/tracker'
import { ACLI_TOOL } from './client'
import { type JiraConfig, jiraConfig } from './config'
import { jiraKind } from './kind'

export { ACLI_TOOL, type JiraConfig, jiraConfig, jiraKind }

export function jiraTracker(): Tracker<JiraConfig, Json> {
  return {
    id: 'jira',
    order: 20,
    config: jiraConfig,
    kinds: [jiraKind],
    tools: [ACLI_TOOL],
    init: () => {},
    store: ctx => ctx.config.slice(),
  }
}
