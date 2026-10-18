// The github tracker: GitHub issues and pull requests. In L3 it declares its identity and config only. The capture
// funnel, the refresh coordinator and the `gh` tool stay in the item runtime until layer L5 gives them to the tracker
// (plan decision D13). The PR lane of the auto tracker reaches `gh` through the runtime's facet.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.7 and 5.8. Plan: L3 Task 11.

import type { ConfigSpec } from '../../core/interfaces/config'
import type { Json } from '../../core/interfaces/items'
import type { Tracker } from '../../core/interfaces/tracker'
import { CHUNK } from './gh-tool'

export type GithubConfig = { enabled: boolean; chunkSize: number }

const DEFAULTS: Readonly<GithubConfig> = Object.freeze({ enabled: true, chunkSize: CHUNK })
const MIN_CHUNK = 1
const MAX_CHUNK = 100

export const githubConfig: ConfigSpec<GithubConfig> = {
  defaults: DEFAULTS,
  normalise(raw, defaults, warn) {
    let enabled = defaults.enabled
    if (raw.enabled !== undefined) {
      if (typeof raw.enabled === 'boolean') enabled = raw.enabled
      else warn('github.enabled must be true or false; using the default')
    }
    let chunkSize = defaults.chunkSize
    if (raw.chunkSize !== undefined) {
      const n = raw.chunkSize
      if (typeof n === 'number' && Number.isFinite(n) && n >= MIN_CHUNK && n <= MAX_CHUNK) chunkSize = Math.round(n)
      else warn(`github.chunkSize must be a number from ${MIN_CHUNK} to ${MAX_CHUNK}; using the default`)
    }
    return Object.freeze({ ...raw, enabled, chunkSize })
  },
}

export function githubTracker(): Tracker<GithubConfig, Json> {
  return {
    id: 'github',
    order: 30,
    config: githubConfig,
    init: () => {},
    store: ctx => ctx.config.slice(),
  }
}
