// Refocus: after `x` or `0`-`3` the pane selects a row and asks the engine for the ring on that row's handle. The last
// drawing may not know the row's new handle yet, so the request keeps the row it is meant for until the ring answers
// (`take`), the engine refuses (`to`), or a drawing holds the key (`seen`). A press on a pane that has no keys asks for
// them first (issue #115). PaneSession owns one; nothing here touches the engine but the `ui.focus` and `ui.open` ports.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10 "Selection". Plan: L6 Task 11, G8.

import { reason } from '../core/infra/steps'
import type { Ports } from '../core/interfaces/ports'
import { type Drawn, handleOf } from '../ux/tree-data-table/table'
import { type PaneHost, shownOf } from './pane-text'

/** A press that asks for the keys first. `still` is true while the pane has not closed since the press began. */
export type KeyAsk = { readonly still: () => boolean }

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
   *
   * `ask` is set when the pane has no keys: the keys go to the prompt box, where `ui.focus` is refused (issue #115). The
   * pane asks for them first, unless `ask.still()` says that the pane closed since the press began: `ui.open` would open
   * it again. The engine may refuse the ask too (text in the composer, issue #108 case C): the row stays selected and the
   * pane keeps its hint. A press asks once and never again by itself.
   *
   * When the pane gets the keys, the engine puts the ring on the `autoFocus` handle of the frame it holds, and that frame
   * can be older than the press: the `ui.focus` hook of that landing names the old row, at any time after the ask (live,
   * Claude Code 2.1.305). No write here can come after it. `PaneSession.focused` ignores such a landing (origin plugin)
   * while a drawn row is selected, so the pressed row stays selected whatever the order.
   */
  async to(p: Ports, m: PaneHost, id: string | null, ask?: KeyAsk): Promise<void> {
    await p.state.selected.update(() => id)
    if (id === null) return
    if (ask?.still() === true) await this.askKeys(p)
    await this.ring(p, m, id)
  }

  /** `ui.open` with `focus`, the one call that grants the keyboard to a pane that is open. A failure is one log line. */
  private async askKeys(p: Ports): Promise<void> {
    try {
      await p.ui.open()
    } catch (e) {
      p.log(`pane: keys request failed: ${reason(e)}`)
    }
  }

  /** Asks for the ring on the handle of `id`, when a drawing holds the row. */
  private async ring(p: Ports, m: PaneHost, id: string): Promise<void> {
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
