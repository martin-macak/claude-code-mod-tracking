// The github tracker: GitHub issues and pull requests. It declares its identity, its config, its kind and its tool, `gh`.
// Core runs the capture, the refresh and the probe of `gh` through them. The PR lane of the auto tracker reaches `gh`
// through `hooks/auto-github.ts` until layer L5b moves the lane here.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.7 and 5.8. Plan: L3 Task 11, L5 Tasks 3 and 8.

import type { Json } from '../../core/interfaces/items'
import type { Tracker } from '../../core/interfaces/tracker'
import { GH_TOOL } from './client'
import { type GithubConfig, githubConfig } from './config'
import { githubKind } from './kind'

export { GH_TOOL, type GithubConfig, githubConfig, githubKind }

export function githubTracker(): Tracker<GithubConfig, Json> {
  return {
    id: 'github',
    order: 30,
    config: githubConfig,
    kinds: [githubKind],
    tools: [GH_TOOL],
    init: () => {},
    store: ctx => ctx.config.slice(),
  }
}
