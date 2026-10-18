// The github tracker: GitHub issues and pull requests. In L3 it declares its identity and config only. The capture
// funnel, the refresh coordinator and the `gh` tool stay in the item runtime until layer L5 gives them to the tracker
// (plan decision D13). The PR lane of the auto tracker reaches `gh` through the runtime's facet.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.7 and 5.8. Plan: L3 Task 11.

import type { Json } from '../../core/interfaces/items'
import type { Tracker } from '../../core/interfaces/tracker'
import { type GithubConfig, githubConfig } from './config'

export { type GithubConfig, githubConfig }

export function githubTracker(): Tracker<GithubConfig, Json> {
  return {
    id: 'github',
    order: 30,
    config: githubConfig,
    init: () => {},
    store: ctx => ctx.config.slice(),
  }
}
