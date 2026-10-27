// PaneApi: the calls of the pane that the LifecycleManager hands to its collaborators. The manager extends it, so the
// reads of the pane (Views) and the keys of the pane (PaneKeys) do not grow the manager. None of them runs a session
// check: a render must not write (E9). It names no tracker and holds no `$`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10. Plan: L6 Task 10, L5 Task 13.

import type { KeyRegistry } from './keys'
import type { PaneKeys } from './pane-keys'
import type { Views } from './views'

export abstract class PaneApi {
  protected abstract readonly views: Views
  protected abstract readonly paneKeys: PaneKeys

  readonly viewOf: Views['viewOf'] = (...a) => this.views.viewOf(...a)
  readonly viewsOf: Views['viewsOf'] = (...a) => this.views.viewsOf(...a)
  readonly paneData: Views['paneData'] = (...a) => this.views.paneData(...a)
  readonly inventory: Views['inventory'] = (...a) => this.views.inventory(...a)
  readonly bandData: Views['bandData'] = (...a) => this.views.bandData(...a)
  readonly levels: Views['levels'] = (...a) => this.views.levels(...a)

  readonly isItemOwner: PaneKeys['isItemOwner'] = (...a) => this.paneKeys.isItemOwner(...a)
  readonly problems: PaneKeys['problems'] = () => this.paneKeys.problems()
  readonly liveTools: PaneKeys['liveTools'] = () => this.paneKeys.liveTools()
  readonly footer: PaneKeys['footer'] = (...a) => this.paneKeys.footer(...a)
  readonly runAction: PaneKeys['runAction'] = (...a) => this.paneKeys.runAction(...a)

  /** The core keys, then the keys of the live trackers. Each start rebuilds it. */
  get keys(): KeyRegistry {
    return this.paneKeys.registry
  }
}
