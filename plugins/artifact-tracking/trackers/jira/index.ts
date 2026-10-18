// The jira tracker: Jira issues. In L3 it declares its identity and config only. The capture funnel, the refresh
// coordinator and the `acli` tool stay in the item runtime until layer L5 gives them to the tracker (plan decision D13).
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.7 and 5.8. Plan: L3 Task 11.

import type { Json } from '../../core/interfaces/items'
import type { Tracker } from '../../core/interfaces/tracker'
import { type JiraConfig, jiraConfig } from './config'

export { type JiraConfig, jiraConfig }

export function jiraTracker(): Tracker<JiraConfig, Json> {
  return {
    id: 'jira',
    order: 20,
    config: jiraConfig,
    init: () => {},
    store: ctx => ctx.config.slice(),
  }
}
