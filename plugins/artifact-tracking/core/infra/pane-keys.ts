// PaneKeys: the keys of the pane for one load. It holds the KeyRegistry, which each start rebuilds right after the trackers
// ran `init` (a tracker that is off or failed adds no key). It says which footer Buttons work for the selected row, asks
// the row's owner for its actions at render (reads only) and runs a tracker key. The manager hands the calls to it.
// It names no tracker and holds no `$`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10 "Keys". Plan: L6 Task 10, G6, G7, G15.

import type { Json, JsonObject } from '../interfaces/items'
import type { Ports } from '../interfaces/ports'
import type { Tracker, TrackerContext } from '../interfaces/tracker'
import type { ActionImpl, ActionImpls, FooterKey, RowRef, ViewContext } from '../interfaces/view'
import { footerKeys, KeyRegistry } from './keys'
import { reason } from './steps'
import type { TrackerHost } from './tracker-host'
import type { Views } from './views'

export interface PaneKeysDeps {
  trackers: readonly Tracker[]
  /** Which trackers run, which failed to start, and the context an action runs in. */
  host: Pick<TrackerHost, 'live' | 'failed' | 'ctx'>
  /** The read-only context a tracker builds its actions from. */
  views: Pick<Views, 'viewOf'>
  /** The kinds: one problem line for each kind reason that is off (#62). */
  kinds: { problems(): readonly string[] }
  /** Checks the config file. A key reads the config it runs with, so a press sees an edit made since the last tick. Never rejects. */
  refreshConfig(ports: Ports): Promise<unknown>
  log(line: string): void
}

const own = (impls: ActionImpls, id: string): ActionImpl | undefined =>
  Object.hasOwn(impls, id) ? impls[id] : undefined

export class PaneKeys {
  private reg = new KeyRegistry()
  private readonly ordered: readonly Tracker[]

  constructor(private readonly d: PaneKeysDeps) {
    this.ordered = [...d.trackers].sort((a, b) => a.order - b.order)
  }

  /** The current registry: the core keys, then the keys of the live trackers in `order`. */
  get registry(): KeyRegistry {
    return this.reg
  }

  /** A fresh registry from the trackers that are on. A second start leaves no duplicate problem behind. */
  rebuild(): void {
    const next = new KeyRegistry()
    for (const t of this.ordered) if (t.keys !== undefined && this.d.host.live(t.id)) next.add(t.id, t.keys)
    this.reg = next
  }

  /** True when the tracker has at least one item kind. The priority keys need such an owner. */
  isItemOwner(owner: string): boolean {
    return (this.d.trackers.find(t => t.id === owner)?.kinds?.length ?? 0) > 0
  }

  /** The key problems, then the kind reasons that are off, then one line per tracker that failed to start. */
  problems(): readonly string[] {
    return [
      ...this.reg.problems(),
      ...this.d.kinds.problems(),
      ...this.d.host
        .failed()
        .map(id => `trackers.${id}: init or store failed. Its sections, keys and commands are off.`),
    ]
  }

  /**
   * The footer for the selected row. A tracker key works when the owner's actions have an impl for it, and the impl's
   * `state` does not say `disabled`. Reads only: it runs in a render.
   */
  async footer(ports: Ports, row: RowRef | undefined, help: boolean): Promise<readonly FooterKey[]> {
    let impls: ActionImpls = {}
    if (row !== undefined && !help && this.reg.all().some(k => k.owner === row.owner)) {
      try {
        impls = await this.implsOf(ports, row.owner, row.id)
      } catch (e) {
        this.d.log(`keys: ${row.owner} actions failed: ${reason(e)}`)
      }
    }
    const state = (owner: string, id: string): 'enabled' | 'disabled' => {
      const impl = own(impls, id)
      try {
        return impl === undefined ? 'disabled' : (impl.state?.(row?.id ?? null) ?? 'enabled')
      } catch (e) {
        this.d.log(`keys: ${owner}.${id} state failed: ${reason(e)}`)
        return 'disabled'
      }
    }
    return footerKeys(this.reg, row, o => this.isItemOwner(o), help, state)
  }

  /**
   * Runs the key `id` of a tracker with its context and the row it acts on. A missing impl does nothing. `surface` is the one
   * the press came from: a copy of the action goes to the clipboard of that surface. The config file is checked first, as the
   * commands do: an action may hang on a toggle that was edited since the last tick (the mask of the questions copy).
   */
  async runAction(ports: Ports, owner: string, id: string, rowId: string | null, surface?: string): Promise<void> {
    try {
      await this.d.refreshConfig(ports)
      const impl = own(await this.implsOf(ports, owner, rowId), id)
      const pressed: Ports =
        surface === undefined ? ports : { ...ports, ui: { ...ports.ui, copy: text => ports.ui.copy(text, surface) } }
      await impl?.run(this.d.host.ctx(owner, pressed) as TrackerContext<JsonObject, Json>, rowId)
    } catch (e) {
      this.d.log(`keys: ${owner}.${id} failed: ${reason(e)}`)
    }
  }

  /** The actions a tracker builds for a view with `rowId` selected. A tracker with none gives `{}` and reads nothing. */
  private async implsOf(ports: Ports, owner: string, rowId: string | null): Promise<ActionImpls> {
    const tracker = this.d.trackers.find(t => t.id === owner)
    if (tracker?.actions === undefined) return {}
    const ctx: ViewContext = await this.d.views.viewOf(ports, owner, { selected: rowId, expanded: new Set() })
    return tracker.actions(ctx)
  }
}
