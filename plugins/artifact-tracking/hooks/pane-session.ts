// PaneSession: what the pane keeps for one load outside the engine state: the last drawing (its handle map and rows), the
// place of the window over the rows (issue #109), a refocus that waits for its element (pane-refocus.ts), and the work
// behind each Button. `draw` only reads the engine state (E9). The writes run from the Buttons and from the focus, scroll
// and close hooks. register.tsx calls it; nothing here touches the engine.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10 "Selection". Plan: L6 Task 11, G6, G8, G22.

import type { RenderElement } from 'claude-code'
import { route, viewKeys } from '../core/infra/keys'
import { reason } from '../core/infra/steps'
import type { Ports } from '../core/interfaces/ports'
import type { GroupSpec } from '../core/interfaces/view'
import { flipShowAll, flipTouched, listGroups, nextView, resolveView, viewSummary } from '../core/lib/grouping'
import { resetWidths } from '../ux/tree-data-table/columns'
import type { TableElements } from '../ux/tree-data-table/el'
import { hintRows, withKeysHint } from '../ux/tree-data-table/hint'
import {
  DEFAULT_BODY_COLUMNS,
  type Drawn,
  type DrawnRow,
  findRow,
  neighbourOf,
  shownSelection,
  type TableActions,
  type TableView,
  TreeDataTable,
} from '../ux/tree-data-table/table'
import { WorkQueue } from './pane-queue'
import { frameFromState, type Press, Refocus, unlessClosed } from './pane-refocus'
import { helpOf, type PaneHost, paneGroups, paneModel, shownOf } from './pane-text'
import { openTurn, type TurnPaneHost } from './pane-turn'

export { helpOf, helpTextOf, listText, type PaneHost, TEXT_VIEW, turnLabels } from './pane-text'

/** What the engine gives the pane to draw with (`Pane` props): the body size, and whether the pane has the keys. */
export type PaneDrawProps = {
  /** The cells of a body row. Absent: the table takes its default. */
  readonly bodyColumns?: number
  /** The rows of the body (`scroll.bodyRows`). The help view and the window over the rows read it. */
  readonly bodyRows?: number
  /** `Pane.isFocused`. */
  readonly focused?: boolean
  /** `Pane.placement`: a docked pane has a fixed body, an inline one is as tall as its tree. */
  readonly placement?: 'dock' | 'inline'
}

/** Who moved the ring: the person (Tab, arrows, click) or the plugin itself (`UiFocusOrigin.kind`). */
export type FocusOrigin = 'person' | 'plugin'

/** The key of the "N more" Button of a group. */
const MORE_KEY = /^m\d+$/

export class PaneSession {
  private drawn: Drawn | undefined
  /** How often the pane closed. A press that began before a closing does nothing after it (issues #115 and #130). */
  private closings = 0
  /** The first unit the last drawing showed in full. The window keeps its place until the selection leaves it. */
  private top = 0
  /** The "N more" Button the ring sits on, until the ring lands on a row: its row must show. */
  private onMore: string | undefined
  /** The rows of the last drawing that held any. The help view and an empty pane draw none (issue #49). */
  private rows: readonly DrawnRow[] = []
  private groups: readonly GroupSpec[] = []
  /** The `selected` atom as the last drawing read it, and the row that drawing treated as selected (issue #49). */
  private chosen: { readonly atom: string | null; readonly id: string | null } | undefined
  private readonly refocus = new Refocus()
  private readonly work = new WorkQueue()

  /**
   * Reads the state and the groups, and draws. It writes nothing and calls no entry (E9). `focused` is
   * `Pane.isFocused`: with `false` the keys go to the prompt box, so the selected row is not drawn live and a hint says why.
   */
  async draw(p: Ports, m: PaneHost, el: TableElements, props: PaneDrawProps = {}): Promise<RenderElement> {
    const { bodyColumns, bodyRows, focused, placement } = props
    const [expanded, selected, help] = await Promise.all([
      p.state.expanded.get(),
      p.state.selected.get(),
      p.state.help.get(),
    ])
    const model = await paneModel(p, m, { selected, expanded: new Set(expanded) })
    const { groups } = model
    const shown = await shownOf(p, groups)
    const limits = m.config.global().ui
    // A row can hide with no key from the person. The drawing, the ring and the keys then follow the row the selection
    // falls to. The atom is not written here (E9): `pressed` reads the same row from `chosen` (issue #49). The window
    // follows that row too (`view.selected`), so a row that hid moves it onto the row the selection fell to (issue #109).
    const chosen = shownSelection(
      groups,
      { expanded: new Set(expanded), shown: id => shown.get(id) ?? 0, limits },
      selected,
      this.rows,
      this.chosen?.atom === selected ? this.chosen.id : null,
    )
    this.chosen = { atom: selected, id: chosen }
    // A pane with no keys draws a hint line above the tree (issue #108). The table gets the rows below it, else the tree is
    // taller than the body and the footer drops out of view (issue #109).
    const hinted = focused === false && !help
    const room =
      hinted && bodyRows !== undefined
        ? Math.max(0, bodyRows - hintRows(bodyColumns ?? DEFAULT_BODY_COLUMNS))
        : bodyRows
    const view: TableView = {
      bodyColumns,
      bodyRows: room,
      placement,
      selected: chosen,
      focused,
      // With nothing selected the place is stale: a pane that just opened starts on its first rows, even when a late
      // draw after the last close left a place behind.
      top: selected === null ? 0 : this.top,
      ...(this.onMore === undefined ? {} : { onMore: this.onMore }),
      expanded: new Set(expanded),
      shown: id => shown.get(id) ?? 0,
      limits,
      // The help view works only `r` and `h`, so its footer is drawn as with no row selected: a tracker's dim, inert keys
      // would wrap the footer to a second row and push `Pane keys` out of the body again (issue #105).
      footer: await m.footer(p, help ? undefined : findRow(groups, chosen), help),
      // The view line above the footer: the view, the filters and the keys `g`, `a` and `t` (issue #63, L3). The help view has none.
      ...(help ? {} : { viewLine: { text: viewSummary(model), keys: viewKeys(m.keys) } }),
      // The help titles a tracker's keys by the sections that hold its rows, whatever the view draws (issue #63, L3).
      help: help ? helpOf(m, listGroups(model.sections)) : null,
    }
    const drawn = TreeDataTable.render(groups, view, el, this.actionsOf(p, m, focused === false))
    this.refocus.seen(drawn)
    this.drawn = drawn
    if (!help) this.top = drawn.top // the help view draws no window: its place of 0 would reset the one the rows left
    if (drawn.rows.length > 0) this.rows = drawn.rows
    this.groups = groups
    // The help view fills the body of a short pane to the row (issue #92): no line is added to it.
    // A press that waits for a frame like this one goes on. The frame names the Buttons the engine got: the press asks for
    // one of them (`Refocus.keep`).
    this.refocus.frame({
      help,
      rows: new Map(drawn.rows.map(r => [r.id, r.handle])),
      // The footer, then the view line: the view line is drawn outside the help view only, and its keys stay Buttons.
      keys: [...view.footer, ...(view.viewLine?.keys ?? [])].map(k => k.buttonKey),
      stops: drawn.stops,
    })
    return hinted ? withKeysHint(el, drawn.tree) : drawn.tree
  }

  /**
   * The engine moved the ring to `element`. A row handle selects its row: the pending refocus answers its own key once,
   * else the last drawing does. The write draws the pane again, and the window follows the selection. An "N more" Button
   * keeps the selection and asks for a draw by itself, so a window that hid it shows it. A footer key, the close mark and
   * no element leave the selection alone.
   *
   * `origin` is who moved the ring (`UiFocusOrigin`). The person's Tab, arrows and click always select the row under the
   * ring. A move of the plugin that no refocus asked for is the engine's own take of the ring (`autoFocus`, as the pane
   * gets the keys). It lands on the handle of a frame that can be older than the selection: after a press it names the
   * old row, in any turn (issue #115). So it only starts a selection: it selects when no row is selected, or the selected
   * row is not drawn, and it never replaces a drawn selected row. The selected row is the row the pane treats as
   * selected (`selectedRow`): after a row hid, that is the row the drawing fell to, and the atom stays (issue #49).
   */
  async focused(p: Ports, element: string | undefined, origin: FocusOrigin = 'person'): Promise<void> {
    try {
      this.refocus.noted(element)
      if (element === undefined) return
      if (MORE_KEY.test(element)) {
        this.onMore = element
        if (this.drawn?.page !== undefined) p.ui.invalidate()
        return
      }
      const id = this.refocus.take(element) ?? (await this.landedOn(p, element, origin))
      // The ring left the "N more" Button for a row, also when the landing keeps the selection (an autoFocus landing).
      if (id !== undefined || this.drawn?.handles.has(element) === true) this.onMore = undefined
      if (id !== undefined) await p.state.selected.update(() => id)
    } catch (e) {
      p.log(`pane: focus failed: ${reason(e)}`)
    }
  }

  /** The row that a ring move which no refocus asked for selects, or undefined when it leaves the selection alone. */
  private async landedOn(p: Ports, element: string, origin: FocusOrigin): Promise<string | undefined> {
    const id = this.drawn?.handles.get(element)
    if (id === undefined || origin === 'person') return id
    // The row the pane treats as selected, not the atom: the atom names a row that hid, and the drawing fell to another one.
    const selected = await this.selectedRow(p)
    return this.drawn?.rows.some(r => r.id === selected) === true ? undefined : id
  }

  /**
   * The wheel or a page key asks the window to move (the `ui.scroll` hook). While a window cuts the rows, the mod moves
   * the selection and the ring by about a page, and the next drawing follows them: the engine's own scroll has nothing to
   * move, because the tree fits the body. True when the mod answered. False leaves the move to the engine: no window cuts
   * the rows, so nothing is hidden.
   */
  async scrolled(p: Ports, m: PaneHost, by: number): Promise<boolean> {
    const rows = this.drawn?.rows ?? []
    const page = this.drawn?.page
    if (page === undefined || rows.length === 0) return false
    if (!Number.isFinite(by) || by === 0) return true // a window cuts the rows and nothing asks for a move: nothing to scroll
    const press = this.pressOf(false) // the move reads `selected` first: a closing in between ends it (issue #130)
    try {
      const step = Math.sign(by) * Math.min(Math.abs(by), Math.max(1, page - 1))
      const selected = await this.selectedRow(p) // the row the pane treats as selected: the atom names a row that hid
      const at = rows.findIndex(r => r.id === selected) // -1: nothing selected, the move starts at the first row
      const to = Math.min(rows.length - 1, Math.max(0, Math.max(0, at) + step))
      const id = rows[to]?.id
      if (id !== undefined && (at < 0 || to !== at)) await this.refocus.to(p, m, id, press)
    } catch (e) {
      p.log(`pane: scroll failed: ${reason(e)}`)
    }
    return true
  }

  /** The pane closed: no selection, no help view, no refocus and no window place left over. Each write stands alone: one may fail. */
  async closed(p: Ports): Promise<void> {
    this.closings++
    this.refocus.clear()
    this.top = 0
    this.onMore = undefined
    for (const write of [() => p.state.selected.update(() => null), () => p.state.help.update(() => false)]) {
      try {
        await write()
      } catch (e) {
        p.log(`pane: close failed: ${reason(e)}`)
      }
    }
  }

  /**
   * The row a key acts on. A person's write after the last drawing (a click, a refocus) wins: the atom is newer than the
   * drawing. Else it is the row that drawing treated as selected, which differs from the atom when the row hid.
   */
  private async selectedRow(p: Ports): Promise<string | null> {
    const atom = await p.state.selected.get()
    return this.chosen !== undefined && this.chosen.atom === atom ? this.chosen.id : atom
  }

  /**
   * The band Button `9: open` (issue #69): opens the pane with the keys and selects the first entry of the newest turn that
   * tracked anything. The open Button of a strip names its turn (`ord`, P2). It stands outside the work chain: the press does
   * not read `selected` after a write of another press. Its token is made now, before any wait, and says `keys: false`: the
   * band and the strip are drawn while the pane is closed or beside it, and `ui.open` grants the keys itself.
   */
  openTurn(p: Ports, m: TurnPaneHost, ord?: number): Promise<void> {
    return openTurn(p, m, this.refocus, this.pressOf(false), ord)
  }

  /** Resolves when every Button press so far has finished. For tests and for a caller that must not race the work. */
  idle(): Promise<void> {
    return this.work.idle()
  }

  /** A press of the drawing whose actions these are: it knows the closing count of now (issue #130). */
  private pressOf(keysInPrompt: boolean): Press {
    const closings = this.closings
    return { keys: keysInPrompt, still: () => closings === this.closings }
  }

  /**
   * Only a press that reads `selected` waits in the chain: `x`, `0`-`3` and a tracker key. Those writes must see each
   * other's selection. An Enter, an "N more", `h` and `r` run at once, so a press that waits for the entry (after a
   * /resume the entry loads the stored copy) never holds them.
   *
   * An Enter or a click (`toggle`) is a fourth writer of `selected` (issue #108), and it stays outside the chain: the
   * test "Enter, N more, h and r run at once" pins that a hung `x` never holds an Enter. The cost is a race of tens of
   * milliseconds: a click on row B while an `x` on row A is in flight can end with the selection on the neighbour of A,
   * because the `x` asks for the ring last. The next click or Tab sets it right.
   *
   * `keysInPrompt` is `Pane.isFocused === false` of the drawing these actions belong to. One session can be drawn on
   * several surfaces and each has its own value, so a press uses the value of its own tree, not that of the last drawing.
   * A click on any Button then gives the pane the keys, so the next Up or Down moves the selection and not the prompt
   * history (issues #115 and #129). Each press takes its closing count when the person presses, before it waits in the
   * chain: a press that began before a closing does nothing after it (issue #130).
   */
  private actionsOf(p: Ports, m: PaneHost, keysInPrompt: boolean): TableActions {
    return {
      // A press is a click or Enter. It opens or closes the row and selects it (issue #108): the row stays selected
      // whether it opens or closes, and the ring goes to the handle the drawing gives the row. The keys come before the
      // ring, as the ring is refused for a pane that has none.
      toggle: id => {
        const press = this.pressOf(keysInPrompt)
        this.work.detach(p, 'toggle', async () => {
          const flip = (cur: string[]) => (cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id])
          await p.state.expanded.update(unlessClosed(press, flip))
          await this.refocus.to(p, m, id, press)
        })
      },
      // The new rows come in before the N more Button, so the position the ring sits on now holds the stop of the first new
      // row, a row the window may hide. The ring goes back onto the selected row, as after `x`, and the window follows it.
      // The press asks for the keys too, once: `Refocus.to` asks before it asks for the ring, and with no row selected there
      // is no ring request, so the press asks alone.
      more: groupId => {
        const press = this.pressOf(keysInPrompt)
        this.work.detach(p, 'more', async () => {
          await p.state.shown.update(groupId, n => n + m.config.global().ui.sectionRows)
          this.onMore = undefined
          const selected = await this.selectedRow(p) // the atom names a row that hid: it has no handle for the ring
          if (selected !== null) await this.refocus.to(p, m, selected, press)
          else await this.refocus.askKeys(p, press)
        })
      },
      // A dim footer key does no work, but a click on a Button moves no focus: the press asks for the keys alone.
      keys: () => {
        const press = this.pressOf(keysInPrompt)
        this.work.detach(p, 'keys', () => this.refocus.askKeys(p, press))
      },
      // A press that waited in the chain through a closing does nothing: it reads `selected`, and that may be a row of the
      // next pane.
      press: (key, surface) => {
        const press = this.pressOf(keysInPrompt)
        const run = async () => {
          if (press.still()) await this.pressed(p, m, key, press, surface)
        }
        if (m.keys.get(key)?.scope === 'pane') this.work.detach(p, key, run)
        else this.work.queue(p, key, run)
      },
    }
  }

  /**
   * After `g`, `a` or `t` the pane draws other groups: the rows keep their ids and get new handles. The same row stays selected
   * and the ring goes to its new handle. A row that the new drawing lacks (the filter hid it) hands the selection to a row that
   * is shown: the next one of the last drawing, else the one before (`shownSelection`). The press that wrote the atom
   * redraws the pane once. A press that began before a closing asks for nothing after it (`Refocus.to`).
   */
  private async redrawn(p: Ports, m: PaneHost, selected: string | null, press: Press): Promise<void> {
    if (!press.still()) return
    // The key of an "N more" Button is its group index, and the groups of the next view are other groups.
    this.onMore = undefined
    p.ui.invalidate()
    const expanded = new Set(await p.state.expanded.get())
    const groups = await paneGroups(p, m, { selected, expanded })
    const shown = await shownOf(p, groups)
    const view = { expanded, shown: (id: string) => shown.get(id) ?? 0, limits: m.config.global().ui }
    await this.refocus.to(p, m, shownSelection(groups, view, selected, this.rows), press)
  }

  /**
   * The keys come before the work, after the read of `selected`: `x` and the digits end in a ring request, which the
   * engine refuses while the prompt has the keys, and `r` may run long. `Refocus.to` asks no more: one press asks once.
   * A closing that comes while `selected` is read ends the press: the read may return a row of the next pane.
   */
  private async pressed(p: Ports, m: PaneHost, buttonKey: string, begun: Press, surface?: string): Promise<void> {
    const key = m.keys.get(buttonKey)
    if (key === undefined) return
    const selected = await this.selectedRow(p)
    if (!begun.still()) return // the read took time: after a closing and a reopening it returns a row of the new pane
    await this.refocus.askKeys(p, begun)
    const afterAsk: Press = { ...begun, keys: false } // one press asks once: the refocus below must not ask again
    const row = findRow(this.groups, selected)
    const to = route(key, row, owner => m.isItemOwner(owner))
    switch (to.to) {
      case 'refresh':
        resetWidths()
        await m.refreshManual(p)
        return
      case 'help': {
        // The rows leave with the help view and come back with the next `h`: the engine keeps the ring's position, not its
        // Button, so the press asks for the ring again (issue #140).
        const was = await p.state.help.get()
        const drawn = this.refocus.awaitFrame(p, frame => frame.help !== was) // armed before the write
        const open = await p.state.help.update(unlessClosed(afterAsk, v => !v))
        if (!afterAsk.still()) return
        const next = { help: open, row: open ? null : await this.selectedRow(p) }
        await this.refocus.keep(p, next, afterAsk, drawn, () => frameFromState(p, m, next))
        return
      }
      case 'dismiss': {
        const next = neighbourOf(this.drawn?.rows ?? [], to.rowId)
        // Armed before the write that takes the row. A drawing that still holds the row is not the frame the ring waits for.
        // Rows that were hidden behind an "N more" can take its place, so the frame need not be empty.
        const drawn =
          next === null ? this.refocus.awaitFrame(p, frame => !frame.help && !frame.rows.has(to.rowId)) : undefined
        await m.dismiss(p, [to.rowId])
        await this.refocus.to(p, m, next, afterAsk)
        // The last row went: no row is left to take the ring, and the tracker keys left the footer with it (issue #140).
        if (drawn !== undefined) {
          const none = { help: false, row: null }
          await this.refocus.keep(p, none, afterAsk, drawn, () => frameFromState(p, m, none))
        }
        return
      }
      case 'priority':
        await m.setPriority(p, to.rowId, to.level)
        await this.refocus.to(p, m, to.rowId, afterAsk)
        return
      // `g`, `a` and `t` (issue #63, L3) write a session atom and nothing else: no file, no store key. The rows get new
      // handles, and the ring keeps its place among the Buttons, so each key asks for the ring on the selected row again.
      case 'view': {
        const { view, views } = m.config.global().ui
        await p.state.view.update(unlessClosed(afterAsk, cur => nextView(resolveView(cur, view), views)))
        return this.redrawn(p, m, selected, afterAsk)
      }
      case 'showAll':
        await p.state.hidden.update(unlessClosed(afterAsk, flipShowAll))
        return this.redrawn(p, m, selected, afterAsk)
      case 'touched':
        await p.state.filters.update(unlessClosed(afterAsk, flipTouched))
        return this.redrawn(p, m, selected, afterAsk)
      case 'owner':
        // A tracker's own work may take long. It must not hold the keys that come after it.
        this.work.detach(p, buttonKey, async () => {
          await m.entry(p)
          await m.runAction(p, to.owner, to.id, to.rowId, surface)
        })
        return
      case 'none':
        return
    }
  }
}
