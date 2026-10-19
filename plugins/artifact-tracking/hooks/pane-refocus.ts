// Refocus: after `x` or `0`-`3` the pane selects a row and asks the engine for the ring on that row's handle. The last
// drawing may not know the row's new handle yet, so the request keeps the row it is meant for until the ring answers
// (`take`), the engine refuses (`to`), or a drawing holds the key (`seen`). PaneSession owns one; nothing here touches
// the engine but the `ui.focus` port.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10 "Selection". Plan: L6 Task 11, G8.

import type { Ports } from '../core/interfaces/ports'
import { type Drawn, handleOf } from '../ux/tree-data-table/table'
import { type PaneHost, shownOf } from './pane-text'

export class Refocus {
  /** The element the ring was asked for, and the row it is meant for. */
  private pending: { readonly key: string; readonly id: string } | undefined

  /** The ring moved to `element`: the row a request meant for it, once. */
  take(element: string): string | undefined {
    if (this.pending?.key !== element) return undefined
    const { id } = this.pending
    this.pending = undefined
    return id
  }

  /** A drawing that holds the key answers for itself, or draws another row there: the request is old either way. */
  seen(drawn: Drawn): void {
    if (this.pending !== undefined && drawn.handles.has(this.pending.key)) this.pending = undefined
  }

  clear(): void {
    this.pending = undefined
  }

  /**
   * Selects `id` and, when the next drawing holds the row, asks for the ring there. The explicit write and the request
   * keep a stale handle map from selecting another row. A refused focus (E10) drops the request, or the next Tab onto
   * that key would select this row. The selection is written already.
   */
  async to(p: Ports, m: PaneHost, id: string | null): Promise<void> {
    await p.state.selected.update(() => id)
    if (id === null) return
    const expanded = new Set(await p.state.expanded.get())
    const sections = await m.paneData(p, { selected: id, expanded })
    const shown = await shownOf(p, sections)
    const key = handleOf(sections, { expanded, shown: s => shown.get(s) ?? 0, limits: m.config.global().ui }, id)
    if (key === undefined) return
    this.pending = { key, id }
    try {
      if (!(await p.ui.focus(key))) this.pending = undefined
    } catch {
      this.pending = undefined
    }
  }
}
