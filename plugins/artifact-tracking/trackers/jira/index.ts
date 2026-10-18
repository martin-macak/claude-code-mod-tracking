// The jira tracker: Jira issues. In L3 it declares its identity and config. L5 adds its tool, `acli`. The capture
// funnel and the refresh coordinator stay in the item runtime until Task 8 gives them to the kinds (plan decision D13).
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.7 and 5.8. Plan: L3 Task 11, L5 Task 3.

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
