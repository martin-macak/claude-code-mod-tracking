// The jira tracker: Jira issues. In L3 it declares its identity and config only. The capture funnel, the refresh
// coordinator and the `acli` tool stay in the item runtime until layer L5 gives them to the tracker (plan decision D13).
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.7 and 5.8. Plan: L3 Task 11.

import type { ConfigSpec } from '../../core/interfaces/config'
import type { Json } from '../../core/interfaces/items'
import type { Tracker } from '../../core/interfaces/tracker'
import { LIMITS } from '../../hooks/contracts'

export type JiraConfig = { enabled: boolean; concurrency: number; epicChildLimit: number }

const DEFAULTS: Readonly<JiraConfig> = Object.freeze({
  enabled: true,
  concurrency: LIMITS.acliConcurrency,
  epicChildLimit: LIMITS.epicChildLimit,
})

/** The numbers of the slice, with the range each may take. */
const RANGES = { concurrency: [1, 10], epicChildLimit: [1, 500] } as const

export const jiraConfig: ConfigSpec<JiraConfig> = {
  defaults: DEFAULTS,
  normalise(raw, defaults, warn) {
    let enabled = defaults.enabled
    if (raw.enabled !== undefined) {
      if (typeof raw.enabled === 'boolean') enabled = raw.enabled
      else warn('jira.enabled must be true or false; using the default')
    }
    const out: JiraConfig = { ...defaults, enabled }
    for (const key of Object.keys(RANGES) as (keyof typeof RANGES)[]) {
      const value = raw[key]
      if (value === undefined) continue
      const [min, max] = RANGES[key]
      if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max)
        out[key] = Math.round(value)
      else warn(`jira.${key} must be a number from ${min} to ${max}; using the default`)
    }
    return Object.freeze({ ...raw, ...out })
  },
}

export function jiraTracker(): Tracker<JiraConfig, Json> {
  return {
    id: 'jira',
    order: 20,
    config: jiraConfig,
    init: () => {},
    store: ctx => ctx.config.slice(),
  }
}
