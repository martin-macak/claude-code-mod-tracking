// The github tracker: GitHub issues and pull requests. In L3 it declares its identity and config. L5 adds its tool, `gh`.
// The capture funnel and the refresh coordinator stay in the item runtime until Task 8 gives them to the kinds (plan
// decision D13). The PR lane of the auto tracker reaches `gh` through the runtime's facet.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.7 and 5.8. Plan: L3 Task 11, L5 Task 3.

import type { Json } from '../../core/interfaces/items'
import type { Tracker } from '../../core/interfaces/tracker'
import { GH_TOOL } from './client'
import { type GithubConfig, githubConfig } from './config'

export { GH_TOOL, type GithubConfig, githubConfig }

export function githubTracker(): Tracker<GithubConfig, Json> {
  return {
    id: 'github',
    order: 30,
    config: githubConfig,
    tools: [GH_TOOL],
    init: () => {},
    store: ctx => ctx.config.slice(),
  }
}
