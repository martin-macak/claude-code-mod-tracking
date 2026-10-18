// The web tracker: plain web links. They have no status, so nothing refreshes. It declares its identity, its config and
// its kind; core claims the links through the kind, last of all kinds.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.7 and 5.8. Plan: L3 Task 11, L5 Task 8.

import type { Json } from '../../core/interfaces/items'
import type { Tracker } from '../../core/interfaces/tracker'
import { type WebConfig, webConfig } from './config'
import { webKind } from './kind'

export { type WebConfig, webConfig, webKind }

export function webTracker(): Tracker<WebConfig, Json> {
  return {
    id: 'web',
    order: 60,
    config: webConfig,
    kinds: [webKind],
    init: () => {},
    store: ctx => ctx.config.slice(),
  }
}
