// The web tracker: plain web links. They have no status, so nothing refreshes. In L3 it declares its identity and
// config only; the capture funnel in the item runtime claims the links until layer L5 gives the kind to the tracker.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.7 and 5.8. Plan: L3 Task 11.

import type { ConfigSpec } from '../../core/interfaces/config'
import type { Json } from '../../core/interfaces/items'
import type { Tracker } from '../../core/interfaces/tracker'

export type WebConfig = { enabled: boolean }

const DEFAULTS: Readonly<WebConfig> = Object.freeze({ enabled: true })

export const webConfig: ConfigSpec<WebConfig> = {
  defaults: DEFAULTS,
  normalise(raw, defaults, warn) {
    let enabled = defaults.enabled
    if (raw.enabled !== undefined) {
      if (typeof raw.enabled === 'boolean') enabled = raw.enabled
      else warn('web.enabled must be true or false; using the default')
    }
    return Object.freeze({ ...raw, enabled })
  },
}

export function webTracker(): Tracker<WebConfig, Json> {
  return {
    id: 'web',
    order: 60,
    config: webConfig,
    init: () => {},
    store: ctx => ctx.config.slice(),
  }
}
