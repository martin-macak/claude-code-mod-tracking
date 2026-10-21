// Refocus: after `x` or `0`-`3` the pane selects a row and asks the engine for the ring on that row's handle. The last
// drawing may not know the row's new handle yet, so the request keeps the row it is meant for until the ring answers
// (`take`), the engine refuses (`to`), or a drawing holds the key (`seen`). A press on a pane that has no keys asks for
// them first (issues #115 and #129), and a press that began before the pane closed does nothing after it (issue #130).
// PaneSession owns one; nothing here touches the engine but the `ui.focus` and `ui.open` ports.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10 "Selection". Plan: L6 Task 11, G8.

import { reason } from '../core/infra/steps'
import type { Ports } from '../core/interfaces/ports'
import { type Drawn, handleOf } from '../ux/tree-data-table/table'
import { type PaneHost, shownOf } from './pane-text'

/**
 * What a press knows when the person presses: it is taken from the drawing of the pressed Button, before any work starts.
 * `keys` is true when that drawing said the keys are in the prompt: the press asks for them (issue #115, #129). A press
 * with no drawing, such as a scroll, has `keys: false`. `still` is true while the pane has not closed since the press
 * began: a press that began before a closing does nothing after it, because `PaneSession.closed` cleared what the press
 * would write (issue #130). Every call of `Refocus` takes one, so a caller written later cannot leave the check out.
 */
export type Press = { readonly keys: boolean; readonly still: () => boolean }

/**
 * `next`, but the old value once the pane closed since `press` began. For the function of an atom `update`: the engine may
 * apply it after the closing, and again after a retry on the value that the closing wrote.
 */
export const unlessClosed =
  <T>(press: Press, next: (cur: T) => T) =>
  (cur: T): T =>
    press.still() ? next(cur) : cur

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
   * `press` says what the press knew when it began. When its drawing had no keys, the keys go to the prompt box, where
   * `ui.focus` is refused (issue #115): the pane asks for them first (`askKeys`), unless the pane closed since. The engine
   * may refuse the ask too (text in the composer, issue #108 case C): the row stays selected and the pane keeps its hint.
   * A press asks once and never again by itself.
   *
   * A press that began before a closing writes nothing after it (issue #130): no selection, no ask, no ring request. The
   * check comes at the start, in the write (the engine may apply it after the closing) and before the request. A call that
   * ran its ask or its request already cannot be taken back.
   *
   * When the pane gets the keys, the engine puts the ring on the `autoFocus` handle of the frame it holds, and that frame
   * can be older than the press: the `ui.focus` hook of that landing names the old row, at any time after the ask (live,
   * Claude Code 2.1.305). No write here can come after it. `PaneSession.focused` ignores such a landing (origin plugin)
   * while a drawn row is selected, so the pressed row stays selected whatever the order.
   */
  async to(p: Ports, m: PaneHost, id: string | null, press: Press): Promise<void> {
    if (!press.still()) return
    await p.state.selected.update(unlessClosed(press, () => id))
    if (id === null) return
    await this.askKeys(p, press)
    await this.ring(p, m, id, press)
  }

  /**
   * `ui.open` with `focus`, the one call that grants the keyboard to a pane that is open. It asks only for a press whose
   * drawing said that the keys are in the prompt, and only while the pane has not closed since the press began: `ui.open`
   * would open the pane the person just closed. A failure is one log line.
   */
  async askKeys(p: Ports, press: Press): Promise<void> {
    if (!press.keys || !press.still()) return
    try {
      await p.ui.open()
    } catch (e) {
      p.log(`pane: keys request failed: ${reason(e)}`)
    }
  }

  /** Asks for the ring on the handle of `id`, when a drawing holds the row. */
  private async ring(p: Ports, m: PaneHost, id: string, press: Press): Promise<void> {
    const expanded = new Set(await p.state.expanded.get())
    const sections = await m.paneData(p, { selected: id, expanded })
    const shown = await shownOf(p, sections)
    const key = handleOf(sections, { expanded, shown: s => shown.get(s) ?? 0, limits: m.config.global().ui }, id)
    if (key === undefined || !press.still()) return // the reads above took time: the pane may have closed
    this.pending = { key, id }
    try {
      if (!(await p.ui.focus(key))) this.pending = undefined
    } catch {
      this.pending = undefined
    }
  }
}
