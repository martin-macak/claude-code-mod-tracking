// Refocus: after `x` or `0`-`3` the pane selects a row and asks the engine for the ring on that row's handle. The last
// drawing may not know the row's new handle yet, so the request keeps the row it is meant for until the ring answers
// (`take`), the engine refuses (`to`), or a drawing holds the key (`seen`). A press on a pane that has no keys asks for
// them first (issues #115 and #129), and a press that began before the pane closed does nothing after it (issue #130).
// It also knows where the ring is (`noted`): a press that changes the Buttons of the drawing asks for the ring again
// (`keep`, issue #140).
// PaneSession owns one; nothing here touches the engine but the `ui.focus` and `ui.open` ports.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10 "Selection". Plan: L6 Task 11, G8.

import { reason } from '../core/infra/steps'
import type { Ports, Timer } from '../core/interfaces/ports'
import { type Drawn, findRow, handleOf } from '../ux/tree-data-table/table'
import { type PaneHost, paneGroups, shownOf } from './pane-text'

/** How long a press waits for the drawing that follows its write. A drawing takes tens of milliseconds. */
export const NEXT_DRAWING_MS = 1000

/** What a press can tell about a drawing: whether it is the help view, and the ids of the rows it draws. */
export type Frame = { readonly help: boolean; readonly ids: ReadonlySet<string> }

/** A press that waits for a drawing like `wants`. `release` ends the wait, once, and takes the press off the list. */
type Waiter = { readonly wants: (frame: Frame) => boolean; readonly release: () => void }

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
  /** The element the last `ui.focus` hook named: where the ring is. Absent: no word yet, or one of the engine's own stops. */
  private at: string | undefined
  /** The footer Button that `keep` put the ring on, because its own Button left the footer, until the ring moves on. */
  private displaced: string | undefined
  /** The presses that wait for a drawing (`awaitFrame`). */
  private waiting: Waiter[] = []

  /**
   * The ring moved to `element` (the `ui.focus` hook, any origin). A move off the Button that `keep` chose ends its claim:
   * the person walked on, so the next `keep` leaves the ring where the person put it.
   */
  noted(element: string | undefined): void {
    this.at = element
    if (element !== this.displaced) this.displaced = undefined
  }

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
    this.at = undefined
    this.displaced = undefined
    for (const { release } of [...this.waiting]) release() // a press that waits for a drawing ends: the pane closed
  }

  /**
   * Resolves when a drawing that returns after this call is a `wants` drawing: one that holds what the press wrote. Arm it
   * before the write. The ring request of `keep` must come after that frame: the engine lands a request on the frame it
   * holds, and then keeps the ring's position through the next one, so an early request ends up one Button off (issue #140).
   * Any drawing that returns after the arming is not enough: live, a draw that the dismissal itself caused still held the
   * row. It resolves at a closing (`clear`) and after `NEXT_DRAWING_MS`, so a frame that never comes cannot hold the chain
   * of keys.
   */
  awaitFrame(p: Ports, wants: (frame: Frame) => boolean): Promise<void> {
    return new Promise<void>(resolve => {
      let timer: Timer | undefined
      const waiter: Waiter = {
        wants,
        release: (): void => {
          timer?.cancel()
          const at = this.waiting.indexOf(waiter)
          if (at >= 0) this.waiting.splice(at, 1) // a frame, the bound and a closing leave the list alike
          resolve()
        },
      }
      this.waiting.push(waiter)
      timer = p.clock.after(NEXT_DRAWING_MS, waiter.release)
    })
  }

  /** A drawing returned: it releases the presses that wait for a frame like it. */
  frame(frame: Frame): void {
    for (const waiter of this.waiting.filter(w => w.wants(frame))) waiter.release()
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

  /**
   * `h` and the last `x` change which Buttons the pane draws, and the ring sits on a position among the Buttons, not on a
   * key (verified live). The engine keeps the position and lands the ring on whatever Button holds it now, with no
   * `ui.focus` word to the mod, or on none when the position is past the last Button (issue #140). So the press asks for the
   * ring again. `next` is what the next drawing reads: the help view (no rows, the core footer), or the rows with `row`
   * selected (no row: nothing selected, so no tracker keys).
   *
   * - The ring's Button is in the next footer: the ring is asked for that Button again, so it stays where the person put it.
   * - It is not (a row, an "N more", a tracker key): the help view puts the ring on `h: back`. The rows put it on `row`, as
   *   after `x`, or with no row on the first footer Button.
   * - Closing the help view sends a ring that this put on `h: back` home, to `row`, whichever Button it left.
   *
   * A ring that is not reported (`at` absent) is left alone: the pane cannot tell where it is. A footer Button selects
   * nothing, so no row follows it. `x` calls it only when no row is left to take the ring (`neighbourOf` is null).
   *
   * `drawn` is `awaitFrame`, armed before the press wrote its state. The request waits for it (live: a request sent at
   * once, or after a drawing that still held the old state, left the ring one Button off).
   *
   * The reads after the wait come before the request, and live that gap matters. A variant that chose from the buttons of
   * the frame and asked at once failed both e2e scenarios of issue #140, and after `x` on the last row the ring sat on
   * `h: help` (Claude Code 2.1.306). One read of an atom before the request did not change that. A pause of one macrotask
   * did. So do not drop these reads before the pause is explicit. Evidence: `tree-table.md`.
   */
  async keep(
    p: Ports,
    m: PaneHost,
    next: { help: boolean; row: string | null },
    press: Press,
    drawn: Promise<void>,
  ): Promise<void> {
    if (this.at === undefined || !press.still()) return
    await drawn
    const at = this.at // the person may have moved the ring while the press waited
    if (at === undefined || !press.still()) return // or the pane closed
    const expanded = new Set(await p.state.expanded.get())
    const groups = await paneGroups(p, m, { selected: next.row, expanded })
    const footer = await m.footer(p, next.help ? undefined : findRow(groups, next.row), next.help)
    if (!press.still()) return // the reads took time: the pane may have closed
    const keys = footer.map(k => k.buttonKey)
    const toRow = !next.help && next.row !== null
    const home = this.displaced !== undefined && toRow
    this.displaced = undefined
    if (keys.includes(at) && !home) {
      await this.request(p, at, undefined, press)
    } else if (toRow) {
      await this.ring(p, m, next.row as string, press)
    } else {
      const key = next.help ? 'help' : keys[0] // the help footer always holds `h`
      if (key === undefined) return
      if (next.help) this.displaced = key
      if (!(await this.request(p, key, undefined, press))) this.displaced = undefined
    }
  }

  /** Asks for the ring on the handle of `id`, when a drawing holds the row. */
  private async ring(p: Ports, m: PaneHost, id: string, press: Press): Promise<void> {
    const expanded = new Set(await p.state.expanded.get())
    const groups = await paneGroups(p, m, { selected: id, expanded })
    const shown = await shownOf(p, groups)
    const key = handleOf(groups, { expanded, shown: g => shown.get(g) ?? 0, limits: m.config.global().ui }, id)
    if (key === undefined || !press.still()) return // the reads above took time: the pane may have closed
    await this.request(p, key, id, press)
  }

  /**
   * Asks the engine for the ring on `key`. With `id` the request waits for its answer (`take`): that row is selected when
   * the ring lands. A footer Button has no row. True when the ring moved: a refusal or a failure drops the request.
   */
  private async request(p: Ports, key: string, id: string | undefined, press: Press): Promise<boolean> {
    if (!press.still()) return false
    this.pending = id === undefined ? undefined : { key, id }
    try {
      if (await p.ui.focus(key)) return true
    } catch {
      // a refused ring is no error: the next Tab starts where the engine left it
    }
    this.pending = undefined
    return false
  }
}
