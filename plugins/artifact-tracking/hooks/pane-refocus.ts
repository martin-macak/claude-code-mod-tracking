// Refocus: after `x` or `0`-`3` the pane selects a row and asks the engine for the ring on that row's handle. The last
// drawing may not know the row's new handle yet, so the request keeps the row it is meant for until the ring answers
// (`take`), the engine refuses (`to`), or a drawing holds the key (`seen`). A press on a pane that has no keys asks for
// them first (issues #115 and #129), and a press that began before the pane closed does nothing after it (issue #130).
// It also knows where the ring is (`noted`): a press that changes the Buttons of the drawing asks for the ring again
// (`keep`, issue #140). It waits for the drawing (`awaitFrame`), then for a pause (`pause`) that a drawing with other
// controls starts again, then asks, and it chooses the Button from the latest drawing alone (`Frame`, issue #156). Only a
// drawing that never comes (the bound) makes it read the state. Each wait has a second wake-up behind its engine timer, a
// timer of the mod's own runtime that no hook can refuse (`afterOrWake`, issue #193), so a refused timer with no drawing at
// all does not hold the press until the pane closes.
// PaneSession owns one; nothing here touches the engine but the `ui.focus` and `ui.open` ports.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10 "Selection". Plan: L6 Task 11, G8.

import { viewButtonKeys } from '../core/infra/keys'
import { reason } from '../core/infra/steps'
import type { Ports, Timer } from '../core/interfaces/ports'
import { type Drawn, findRow, handleOf } from '../ux/tree-data-table/table'
import { type PaneHost, paneGroups, shownOf } from './pane-text'

/** How long a press waits for the drawing that follows its write. A drawing takes tens of milliseconds. */
export const NEXT_DRAWING_MS = 1000

/**
 * The pause between the frame and the ring request of `keep` (`Refocus.pause`): one timer of the engine clock. The engine
 * takes the frame that the render hook returned in a turn of its own loop, and a request that comes before that turn names
 * a Button of the old frame. Live (Claude Code 2.1.306, `tree-table.md`), a request sent in the same turn as the frame, after
 * one read of an atom, after fifty microtask turns, and after a busy wait of 20 ms that gives no turn to any loop, left
 * the ring one Button off (`h: help` for `r: refresh`, `x: dismiss` for `h: back`). A `setTimeout` of 0 to 3 ms worked in 7
 * of 9 runs. The engine's own timer (the `clock.after` port, 0, 1 and 10 ms) worked in every run, 14 of 14, and a timer of
 * 0 ms fired 4 to 8 ms after the frame. 10 ms keeps room above that and is far below what a person sees.
 */
export const RING_PAUSE_MS = 10

/**
 * The wake of `afterOrWake` comes this long after the engine timer. It is the last resort, so it is long: it wins when the
 * engine timer is refused, and also when that timer is only late, and then the ring request may name a Button of a frame the
 * engine has not taken yet, the failure of #140 and #156. A 10 ms engine timer fired 23 ms after it was armed in an idle
 * headless probe (Claude Code 2.1.311, issue #193), and no run has measured a larger pane or a loaded machine, so the slack
 * leaves room above that. A refused timer costs it in time and no more: the press ends `ms + WAKE_SLACK_MS` after its
 * arming (260 ms for the pause, 1250 ms for the frame bound), with no drawing at all. A shorter slack is a one-constant
 * change, to be chosen from a measure of the engine timer on a 30-row pane under load.
 */
export const WAKE_SLACK_MS = 250

/**
 * What a press can tell about a drawing: whether it is the help view, the handle of each row it draws (by row id) and the
 * keys of its Buttons outside the rows: the footer in drawing order, then the view line (`g`, `a`, `t` and `m`, issues
 * #63 and #138). The help view has no view line, and its footer holds those four keys as dim Buttons (issue #200).
 * `keep` chooses the Button for its ring request from this alone. A press whose drawing never came gets one from the
 * state instead (`frameFromState`).
 *
 * `stops` is the key of every focus stop of the body in drawing order, the row handles and the `m<n>` Buttons (`Drawn.stops`).
 * The pause compares drawings by it, and `keep` chooses from none of it: the ring sits on a position among the Buttons, so an
 * `m<n>` that appears or goes moves the Buttons after it, though no row handle or footer key changes.
 */
export type Frame = {
  readonly help: boolean
  readonly rows: ReadonlyMap<string, string>
  readonly keys: readonly string[]
  readonly stops: readonly string[]
}

/**
 * A press on `Refocus.waiting`: it waits for a drawing like the one it wants (`awaitFrame`) or for the pause after it
 * (`pause`). `offer` hands it each drawing that returns. `close` ends the wait with no drawing, once: a closing does.
 */
type Waiter = {
  readonly offer: (frame: Frame) => void
  readonly close: () => void
}

/** True when `a` and `b` draw the same controls in the same order: the Button keys, the focus stops and the handle of each row. */
function sameControls(a: Frame, b: Frame): boolean {
  if (a.keys.length !== b.keys.length || a.stops.length !== b.stops.length || a.rows.size !== b.rows.size) return false
  if (a.keys.some((key, i) => key !== b.keys[i]) || a.stops.some((key, i) => key !== b.stops[i])) return false
  const rows = [...b.rows]
  return [...a.rows].every(([id, handle], i) => rows[i]?.[0] === id && rows[i]?.[1] === handle)
}

/**
 * The engine timer, and behind it a wake that no hook can refuse (`Ports.clock.wake`, a timer of the mod's own runtime). The
 * first of them to fire runs `fn`, once, and cancels the other. The engine gives no sign of a refused timer (`Timer` has
 * `cancel` and no more), so the wake is the bound when no drawing comes: `ms + WAKE_SLACK_MS` after the arming at most. When
 * the wake wins it writes one line to the log, named by `label`, and the line says only what is known: the engine timer did
 * not fire in time. The mod cannot tell a late timer from a refused one, so a count of the lines counts both, and the
 * ring request after a late one may name a Button of a frame the engine has not taken yet (issue #140). Cancel stops both.
 */
function afterOrWake(p: Ports, ms: number, fn: () => void, label: string): Timer {
  let done = false
  const fire = (byWake: boolean): void => {
    if (done) return
    done = true
    engine.cancel()
    wake.cancel()
    if (byWake)
      p.log(
        `${label}: the engine timer of ${ms} ms did not fire in ${ms + WAKE_SLACK_MS} ms (late or refused); the wake ended the wait`,
      )
    fn()
  }
  const engine = p.clock.after(ms, () => fire(false))
  const wake = p.clock.wake(ms + WAKE_SLACK_MS, () => fire(true))
  return {
    cancel: () => {
      done = true
      engine.cancel()
      wake.cancel()
    },
  }
}

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

/** The handle that a request for the row `id` names, from a fresh read of the state. Absent: no drawing would hold the row. */
async function handleFromState(p: Ports, m: PaneHost, id: string): Promise<string | undefined> {
  const expanded = new Set(await p.state.expanded.get())
  const groups = await paneGroups(p, m, { selected: id, expanded })
  const shown = await shownOf(p, groups)
  return handleOf(groups, { expanded, shown: g => shown.get(g) ?? 0, limits: m.config.global().ui }, id)
}

/**
 * The drawing that the state of `next` would give, from a fresh read: the `atBound` of `Refocus.keep`. It is the one read
 * of `keep`, and only a drawing that never came calls it (`NEXT_DRAWING_MS`).
 */
export async function frameFromState(
  p: Ports,
  m: PaneHost,
  next: { help: boolean; row: string | null },
): Promise<Frame> {
  const expanded = new Set(await p.state.expanded.get())
  const groups = await paneGroups(p, m, { selected: next.row, expanded })
  const footer = await m.footer(p, next.help ? undefined : findRow(groups, next.row), next.help)
  const row = next.help ? null : next.row // the help view draws no row
  const handle = row === null ? undefined : await handleFromState(p, m, row)
  return {
    help: next.help,
    rows: row === null || handle === undefined ? new Map() : new Map([[row, handle]]),
    // The view line holds `g`, `a`, `t` and `m` outside the footer, and a ring on one of them stays on it. The help view
    // has no view line: its footer holds the four keys (issue #200), so `footer` names them there and a ring on one stays
    // on it too.
    keys: [...footer.map(k => k.buttonKey), ...(next.help ? [] : viewButtonKeys(m.keys))],
    stops: [], // no pause follows the bound, so nothing compares this frame
  }
}

export class Refocus {
  /** The element the ring was asked for, and the row it is meant for. */
  private pending: { readonly key: string; readonly id: string } | undefined
  /** The element the last `ui.focus` hook named: where the ring is. Absent: no word yet, or one of the engine's own stops. */
  private at: string | undefined
  /** The footer Button that `keep` put the ring on, because its own Button left the footer, until the ring moves on. */
  private displaced: string | undefined
  /** The presses that wait for a drawing (`awaitFrame`) or for the pause after it (`pause`). */
  private waiting: Waiter[] = []
  /** The last drawing that returned. A press that runs on after its frame wait starts its pause from it (`pause`). */
  private latest: Frame | undefined

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
    this.latest = undefined
    for (const { close } of [...this.waiting]) close() // a press that waits for a drawing or a pause ends: the pane closed
  }

  /**
   * Resolves with the first drawing that returns after this call and is a `wants` drawing: one that holds what the press
   * wrote. Arm it before the write. The ring request of `keep` must come after that frame: the engine lands a request on the
   * frame it holds, and then keeps the ring's position through the next one, so an early request ends up one Button off
   * (issue #140). Any drawing that returns after the arming is not enough: live, a draw that the dismissal itself caused
   * still held the row. It resolves with no frame at a closing (`clear`) and after `NEXT_DRAWING_MS`, so a frame that never
   * comes cannot hold the chain of keys. A timer that the engine refuses never fires and says nothing, so the first drawing
   * after the bound ends the wait too, with no frame, whether or not it is a `wants` drawing. With no drawing at all the wake
   * of `afterOrWake` ends it `WAKE_SLACK_MS` later, also with no frame (issue #193). A late frame is not used: it
   * would start a pause whose timer the engine may refuse as well, and the bound says to fall back at once. The deadline is
   * read from the wall clock, which is the one clock a refused timer does not stop (`Ports.clock.wall`).
   */
  awaitFrame(p: Ports, wants: (frame: Frame) => boolean): Promise<Frame | undefined> {
    return new Promise<Frame | undefined>(resolve => {
      let timer: Timer | undefined
      const deadline = p.clock.wall() + NEXT_DRAWING_MS
      const end = (frame?: Frame): void => {
        timer?.cancel()
        this.leave(waiter)
        resolve(frame)
      }
      const waiter: Waiter = {
        offer: frame => {
          // The deadline comes before `wants`: a late frame is not used, even one the press wants.
          if (p.clock.wall() >= deadline) end()
          else if (wants(frame)) end(frame)
        },
        close: () => end(),
      }
      this.waiting.push(waiter)
      timer = afterOrWake(p, NEXT_DRAWING_MS, () => end(), 'pane frame bound')
    })
  }

  /** A drawing returned: it goes to every press that waits, for a frame (`awaitFrame`) or in a pause (`pause`). */
  frame(frame: Frame): void {
    this.latest = frame
    for (const waiter of [...this.waiting]) waiter.offer(frame)
  }

  /** A frame, the timer and a closing take a press off the list alike. */
  private leave(waiter: Waiter): void {
    const at = this.waiting.indexOf(waiter)
    if (at >= 0) this.waiting.splice(at, 1)
  }

  /**
   * The pause between the frame and the ring request: one timer of `RING_PAUSE_MS` on the engine clock (`afterOrWake`). It resolves with the
   * latest frame it saw, the one the request chooses from. The render hook has returned a frame by then, and the engine has
   * not taken it yet (`RING_PAUSE_MS` has the evidence). Reads do not make this pause: an atom read answers in the same turn.
   *
   * The engine takes a second frame in a turn of its own loop too, so a drawing with other controls than the latest (the
   * footer or view line Button keys, the handle of a row, or an "N more" Button, in drawing order, `sameControls`) becomes the latest frame and starts the
   * pause again, `RING_PAUSE_MS` from it: a request that comes sooner could name a Button of the frame before it. A drawing
   * with the same controls changes nothing: it neither ends the pause nor moves it. The restarts end `NEXT_DRAWING_MS` after
   * the first frame, as the frame wait does after its arming: the last timer is cut to that bound, so a stream of changing
   * drawings cannot hold the press for ever, and the request then names a Button of the latest frame.
   *
   * A press runs on in a microtask after its frame wait ends, so a second drawing can return before the pause exists. The
   * pause then begins on that drawing (`latest`), and not on the frame that ended the wait.
   *
   * A closing ends the pause (`clear`), as it ends `awaitFrame`, and `keep` checks the press after it. A timer that the
   * engine refuses never fires: the first drawing after the deadline of the running timer ends the pause then, and the
   * request follows at once. That drawing counts when its controls differ, as the latest frame. With no drawing at all the
   * wake of `afterOrWake` ends the pause `WAKE_SLACK_MS` after the engine timer was due (issue #193), and each restart arms a wake
   * of its own.
   */
  private pause(p: Ports, first: Frame): Promise<Frame> {
    return new Promise<Frame>(resolve => {
      let latest = this.latest ?? first
      let timer: Timer | undefined
      let deadline = 0
      const limit = p.clock.wall() + NEXT_DRAWING_MS
      const end = (): void => {
        timer?.cancel()
        this.leave(waiter)
        resolve(latest)
      }
      const start = (): void => {
        timer?.cancel()
        const ms = Math.min(RING_PAUSE_MS, limit - p.clock.wall()) // positive: `offer` starts it only before its deadline
        deadline = p.clock.wall() + ms
        timer = afterOrWake(p, ms, end, 'pane ring pause')
      }
      const waiter: Waiter = {
        offer: frame => {
          const changed = !sameControls(frame, latest)
          if (changed) latest = frame
          if (p.clock.wall() >= deadline) end()
          else if (changed) start()
        },
        close: end,
      }
      this.waiting.push(waiter)
      start()
    })
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
   * once, or after a drawing that still held the old state, left the ring one Button off), and then for `pause`: the engine
   * has to take the frame before a request can name a Button of it (`RING_PAUSE_MS`, issue #156). A drawing with other
   * controls during the pause starts it again from that drawing. The Buttons come from the latest frame of the pause
   * (`Frame.keys`, `Frame.rows`): after a frame `keep` reads no state and asks the host for nothing.
   *
   * A wait that ended with no frame, because the bound passed, leaves nothing to choose from. Then, and only then, `atBound`
   * reads the state as before issue #156 and the request follows at once: no frame waits for the engine, so no pause. A
   * closing ends the press with no request.
   */
  async keep(
    p: Ports,
    next: { help: boolean; row: string | null },
    press: Press,
    drawn: Promise<Frame | undefined>,
    atBound: () => Promise<Frame>,
  ): Promise<void> {
    if (this.at === undefined || !press.still()) return
    const first = await drawn
    const drawing = first === undefined ? undefined : await this.pause(p, first) // the latest frame of the pause
    const at = this.at // the person may have moved the ring while the press waited
    if (at === undefined || !press.still()) return // or the pane closed
    const frame = drawing ?? (await atBound())
    if (!press.still()) return // the read took time: the pane may have closed
    const toRow = !next.help && next.row !== null
    const home = this.displaced !== undefined && toRow
    this.displaced = undefined
    if (frame.keys.includes(at) && !home) {
      await this.request(p, at, undefined, press)
    } else if (toRow) {
      const key = frame.rows.get(next.row as string)
      if (key !== undefined) await this.request(p, key, next.row as string, press)
    } else {
      const key = next.help ? 'help' : frame.keys[0] // the help footer always holds `h`
      if (key === undefined) return
      if (next.help) this.displaced = key
      if (!(await this.request(p, key, undefined, press))) this.displaced = undefined
    }
  }

  /** Asks for the ring on the handle of `id`, when a drawing holds the row. */
  private async ring(p: Ports, m: PaneHost, id: string, press: Press): Promise<void> {
    const key = await handleFromState(p, m, id)
    if (key === undefined || !press.still()) return // the read above took time: the pane may have closed
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
