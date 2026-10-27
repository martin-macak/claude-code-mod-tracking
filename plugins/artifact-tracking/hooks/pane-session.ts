// PaneSession: what the pane keeps for one load outside the engine state: the last drawing (its handle map and rows), the
// place of the window over the rows (issue #109), a refocus that waits for its element (pane-refocus.ts), and the work
// behind each Button. `draw` only reads the engine state (E9). The writes run from the Buttons and from the focus, scroll
// and close hooks. register.tsx calls it; nothing here touches the engine.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10 "Selection". Plan: L6 Task 11, G6, G8, G22.

import type { RenderElement } from 'claude-code'
import { NOT_READY } from '../core/infra/command-text'
import { type Bulk, bulkTargets, dismissTargets, planFooter, route, viewKeys } from '../core/infra/keys'
import { reason } from '../core/infra/steps'
import { bandSections } from '../core/infra/views'
import type { Ports } from '../core/interfaces/ports'
import type { GroupSpec, RowRef } from '../core/interfaces/view'
import type { PlanLine } from '../core/lib/clean-text'
import { flipShowAll, flipTouched, listGroups, nextView, resolveView, viewSummary } from '../core/lib/grouping'
import { healthLine } from '../core/lib/health'
import { dismissQuestion, markedSummary, pruned, relabelDismiss, rowIdsOf, toggled } from '../core/lib/marks'
import { bandText } from '../ux/band'
import { resetWidths } from '../ux/tree-data-table/columns'
import type { TableElements } from '../ux/tree-data-table/el'
import { hintRows, withKeysHint } from '../ux/tree-data-table/hint'
import { SUMMARY_ROWS, selectedLine, statusForm, withSummary } from '../ux/tree-data-table/status'
import {
  DEFAULT_BODY_COLUMNS,
  type Drawn,
  type DrawnRow,
  findRow,
  findTreeRow,
  laidRefs,
  neighbourOf,
  shownSelection,
  survivorOf,
  type TableActions,
  type TableView,
  TreeDataTable,
} from '../ux/tree-data-table/table'
import { clearMarks, writeMarks } from './pane-marks'
import { BulkQuestion } from './pane-question'
import { WorkQueue } from './pane-queue'
import { type Frame, frameFromState, type Press, Refocus, unlessClosed, type ViewKind } from './pane-refocus'
import { helpOf, type PaneHost, paneGroups, paneModel, problemCount, shownOf } from './pane-text'
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
  /**
   * The rows that the last drawing of the pane laid (`laidRefs`), as the key routing sees a row (issue #138). The label of `x`, the
   * question and the press read the marked rows from it, so the press acts on the rows that the label counted. The help view draws none and
   * leaves it as it was.
   */
  private laid: readonly RowRef[] = []
  private groups: readonly GroupSpec[] = []
  /** The `selected` atom as the last drawing read it, and the row that drawing treated as selected (issue #49). */
  private chosen: { readonly atom: string | null; readonly id: string | null } | undefined
  private readonly refocus = new Refocus()
  private readonly work = new WorkQueue()
  /** The drawings so far. A drawing takes the next number when it reads the question, and its presses carry it (issue #138). */
  private drawing = 0
  /** The question of a bulk dismiss (issue #138). A press of `x` answers it only from a drawing that showed it. */
  private readonly question = new BulkQuestion()
  /**
   * The plan of `/track clean` while the plan view is open (issue #199): the lines that the press of `p` read, once. A drawing
   * must not run the trackers, so it reads this field and never the plan. `closed` drops it. The help view wins when both are set.
   */
  private plan: readonly PlanLine[] | undefined
  /**
   * The generation of the plan view and its reads. It moves when the view opens, when it drops its lines (a `p` that closes it, an
   * `h`, a closing of the pane) and when an `r` starts a read. An `r` read writes its lines only when the generation is still the
   * one it began with: a read that outlived a close and a new `p`, or that a newer `r` read overtook, is obsolete and its lines go.
   * The first read of `p` takes the generation too: an `h` and an `h` again while it runs leave the help atom as it was, but the
   * generation moved, so the read opens no view.
   */
  private planGen = 0
  /**
   * The press of `p` that reads the plan now. A second press while it is current does nothing, so a double tap does not close the
   * view it opens. The press holds the guard, not the pane: after a closing the press is no longer current (`Press.still`), so it
   * does not block the next pane, and its end does not free the guard of a press of the next pane.
   */
  private planRead: Press | undefined

  /**
   * Reads the state and the groups, and draws. It writes nothing and calls no entry (E9). `focused` is
   * `Pane.isFocused`: with `false` the keys go to the prompt box, so the selected row is not drawn live and a hint says why.
   */
  async draw(p: Ports, m: PaneHost, el: TableElements, props: PaneDrawProps = {}): Promise<RenderElement> {
    const { bodyColumns, bodyRows, focused, placement } = props
    const [expanded, selected, help, marks] = await Promise.all([
      p.state.expanded.get(),
      p.state.selected.get(),
      p.state.help.get(),
      p.state.marks.get(),
    ])
    // The form of the bottom follows the engine's body, before the keys hint line takes its row: a move of the keys to the prompt and
    // back must not flip it (issue #138, owner decision Q3 of the delta study: the full form from 18 body rows, docked or inline;
    // comment 6412630538 on the issue, linked from tree-table.md, "The adaptive status area"). The help view has no status area.
    // The health line reads the state of the tools here, before the question is read below: nothing may await between that read
    // and the drawing. Its time is the wall clock, as `readView` takes for the section notes: a breaker stamps `openUntil` with it.
    const plan = help ? undefined : this.plan
    const viewKind: ViewKind = help ? 'help' : plan === undefined ? 'rows' : 'plan'
    const textOnly = viewKind !== 'rows' // the help view and the plan view: no rows, no view line, no status area, no hint
    const full = !textOnly && statusForm(bodyRows) === 'full'
    const tools = full ? await p.state.tools.get() : undefined
    const now = p.clock.wall()
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
    const hinted = focused === false && !textOnly
    const columns = bodyColumns ?? DEFAULT_BODY_COLUMNS
    // The summary row of the full form wraps the table from above, so its row comes off the room the table gets too.
    const room =
      bodyRows === undefined
        ? undefined
        : Math.max(0, bodyRows - (hinted ? hintRows(columns) : 0) - (full ? SUMMARY_ROWS : 0))
    // The marked rows that this drawing lays: a row that a cap, a filter or a closed parent leaves out counts nowhere (G7). The
    // keys read them, so the footer is asked for them before the drawing is made.
    const laid = textOnly
      ? []
      : laidRefs(groups, { expanded: new Set(expanded), shown: id => shown.get(id) ?? 0, limits })
    const marked = new Set(marks)
    const markedDrawn = laid.filter(r => marked.has(r.id))
    const row = textOnly ? undefined : findRow(groups, chosen)
    // The plan view works `p` and `r` only; its footer holds every core key, so no letter goes to the prompt (issue #199).
    const footer = plan === undefined ? await m.footer(p, row, help, markedDrawn) : planFooter(m.keys)
    // No await from here to the drawing: the question is read once, with the number of this drawing (issue #138, G4).
    const drawing = ++this.drawing
    const targets = dismissTargets(markedDrawn)
    // The question stands while the same rows are its targets and the pane has the keys: a drawing without them, the help
    // view and a change of the marked rows withdraw it. The first drawing that reads it notes its number.
    const asking = this.question.read(drawing, targets, focused !== false && !textOnly)
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
      marked: new Set(markedDrawn.map(r => r.id)),
      shown: id => shown.get(id) ?? 0,
      limits,
      // The help view works only `r` and `h`, so its footer is drawn as with no row selected: a tracker's dim, inert keys
      // would wrap the footer further and push `Pane keys` out of the body again (issue #105). The footer holds the four
      // keys of the view line as dim Buttons, because the help view has no view line (issue #200). While marked rows are
      // the targets of `x`, its label says how many (`dismiss 3`, and `confirm 3` while the question stands).
      footer: relabelDismiss(footer, targets.length, asking),
      // The view line above the footer: the view, the filters and the keys `g`, `a`, `t`, `p` and `m` (issues #63, #138 and #199). The
      // words say how many rows are marked, and the question of a bulk dismiss takes their place. The help view has none.
      ...(textOnly
        ? {}
        : {
            viewLine: {
              text: asking
                ? dismissQuestion(this.question.ids?.length ?? 0)
                : markedSummary(viewSummary(model), markedDrawn.length),
              keys: viewKeys(
                m.keys,
                row,
                owner => m.isItemOwner(owner),
                markedDrawn.some(r => r.id === chosen),
              ),
            },
          }),
      // The full status area (issue #138): the selected row and the health, in the footer Box. The selected row is the row the
      // drawing treats as selected, as the keys and the window do.
      ...(full
        ? {
            status: {
              selected: selectedLine(findTreeRow(groups, chosen)),
              health: healthLine(
                m.liveTools().map(id => ({ id, status: tools?.[id] })),
                now,
                problemCount(m),
              ),
            },
          }
        : {}),
      // The help titles a tracker's keys by the sections that hold its rows, whatever the view draws (issue #63, L3).
      help: help ? helpOf(m, listGroups(model.sections)) : null,
      ...(plan === undefined ? {} : { plan }),
    }
    const drawn = TreeDataTable.render(groups, view, el, this.actionsOf(p, m, focused === false, drawing))
    this.refocus.seen(drawn)
    this.drawn = drawn
    if (!textOnly) this.top = drawn.top // a text view draws no window: its place of 0 would reset the one the rows left
    if (drawn.rows.length > 0) this.rows = drawn.rows
    if (!textOnly) this.laid = laid // a text view lays no row: the rows of the last pane drawing stay
    this.groups = groups
    // The help view fills the body of a short pane to the row (issue #92): no line is added to it.
    // A press that waits for a frame like this one goes on. The frame names the Buttons the engine got: the press asks for
    // one of them (`Refocus.keep`).
    this.refocus.frame({
      view: viewKind,
      rows: new Map(drawn.rows.map(r => [r.id, r.handle])),
      // The footer, then the view line: the view line is drawn outside a text view only, and its keys stay Buttons. The footer of
      // the help view and of the plan view holds those keys (issue #200, `planFooter`).
      keys: [...view.footer, ...(view.viewLine?.keys ?? [])].map(k => k.buttonKey),
      stops: drawn.stops,
    })
    // The summary row is the words of the band, from the sections this drawing holds: no second pass over the trackers.
    const tree = full ? withSummary(el, bandText(bandSections(model.sections)), columns, drawn.tree) : drawn.tree
    return hinted ? withKeysHint(el, tree) : tree
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
      // The person's ring on a row or an "N more" row ends the question. A footer Button does not: Tab to `x` and Enter answers it.
      if (origin === 'person' && (MORE_KEY.test(element) || this.drawn?.handles.has(element) === true)) this.disarm(p)
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
   *
   * A page key, Home, End or the wheel is something the person did other than answer the question of a bulk dismiss, so it ends
   * the question (issue #138). It ends it before the return that leaves the move to the engine too: with every row in view no
   * window cuts the list, and the engine still scrolls. A distance of 0 or no number is no move, so it leaves the question.
   */
  async scrolled(p: Ports, m: PaneHost, by: number): Promise<boolean> {
    const moves = Number.isFinite(by) && by !== 0
    if (moves) this.disarm(p)
    const rows = this.drawn?.rows ?? []
    const page = this.drawn?.page
    if (page === undefined || rows.length === 0) return false
    if (!moves) return true // a window cuts the rows and nothing asks for a move: nothing to scroll
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

  /** The pane closed: no selection, no help view, no plan view, no marks, no question, no refocus and no window place left over. Each write stands alone: one may fail. */
  async closed(p: Ports): Promise<void> {
    this.closings++
    this.refocus.clear()
    this.top = 0
    this.onMore = undefined
    this.setPlan(undefined)
    this.question.clear()
    for (const write of [
      () => p.state.selected.update(() => null),
      () => p.state.help.update(() => false),
      () => clearMarks(p),
    ]) {
      try {
        await write()
      } catch (e) {
        p.log(`pane: close failed: ${reason(e)}`)
      }
    }
  }

  /** The person did something other than answer: the question ends, and the pane draws without it. */
  private disarm(p: Ports): void {
    if (this.question.clear()) p.ui.invalidate()
  }

  /** The marked rows that the last drawing laid, by the marks as they are now. A mark of a row that drawing lacks counts nowhere (G7). */
  private async markedRows(p: Ports): Promise<readonly RowRef[]> {
    const marks = new Set(await p.state.marks.get())
    return marks.size === 0 ? [] : this.laid.filter(r => marks.has(r.id))
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
   * `drawing` is the number of the drawing these actions belong to: a press of `x` answers the question of a bulk dismiss only
   * from a drawing that showed it (issue #138).
   *
   * `keysInPrompt` is `Pane.isFocused === false` of the drawing these actions belong to. One session can be drawn on
   * several surfaces and each has its own value, so a press uses the value of its own tree, not that of the last drawing.
   * A click on any Button then gives the pane the keys, so the next Up or Down moves the selection and not the prompt
   * history (issues #115 and #129). Each press takes its closing count when the person presses, before it waits in the
   * chain: a press that began before a closing does nothing after it (issue #130).
   */
  private actionsOf(p: Ports, m: PaneHost, keysInPrompt: boolean, drawing: number): TableActions {
    return {
      // A press is a click or Enter. It opens or closes the row and selects it (issue #108): the row stays selected
      // whether it opens or closes, and the ring goes to the handle the drawing gives the row. The keys come before the
      // ring, as the ring is refused for a pane that has none.
      toggle: id => {
        this.disarm(p)
        const press = this.pressOf(keysInPrompt)
        this.work.detach(p, 'toggle', async () => {
          await p.state.expanded.update(unlessClosed(press, cur => toggled(cur, id)))
          await this.refocus.to(p, m, id, press)
        })
      },
      // The new rows come in before the N more Button, so the position the ring sits on now holds the stop of the first new
      // row, a row the window may hide. The ring goes back onto the selected row, as after `x`, and the window follows it.
      // The press asks for the keys too, once: `Refocus.to` asks before it asks for the ring, and with no row selected there
      // is no ring request, so the press asks alone.
      more: groupId => {
        this.disarm(p)
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
        this.disarm(p)
        const press = this.pressOf(keysInPrompt)
        this.work.detach(p, 'keys', () => this.refocus.askKeys(p, press))
      },
      // A press that waited in the chain through a closing does nothing: it reads `selected`, and that may be a row of the
      // next pane.
      press: (key, surface) => {
        // Any key but the one that asks ends the question; that key (`confirm`, `x`) is answered in the chain (issue #138).
        if (m.keys.get(key)?.confirm !== true) this.disarm(p)
        const press = this.pressOf(keysInPrompt)
        const run = async () => {
          if (press.still()) await this.pressed(p, m, key, press, surface, drawing)
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
  private async pressed(
    p: Ports,
    m: PaneHost,
    buttonKey: string,
    begun: Press,
    surface: string | undefined,
    drawing: number,
  ): Promise<void> {
    const key = m.keys.get(buttonKey)
    if (key === undefined) return
    const selected = await this.selectedRow(p)
    if (!begun.still()) return // the read took time: after a closing and a reopening it returns a row of the new pane
    await this.refocus.askKeys(p, begun)
    const afterAsk: Press = { ...begun, keys: false } // one press asks once: the refocus below must not ask again
    // While a marked row is drawn, `x` and the digits act on the marked rows only, whatever row is selected (issue #138, G2).
    // Only a core row key reads the marks: `r`, `h`, `g`, `a`, `t`, `p` and the keys of a tracker do not wait for the read.
    const marked = key.owner === 'core' && key.scope === 'row' ? await this.markedRows(p) : []
    if (!afterAsk.still()) return
    const isItemOwner = (owner: string) => m.isItemOwner(owner)
    const bulk = bulkTargets(key, marked, isItemOwner)
    if (bulk !== undefined) return this.bulk(p, m, bulk, selected, afterAsk, drawing)
    const row = findRow(this.groups, selected)
    const to = route(
      key,
      row,
      isItemOwner,
      marked.some(r => r.id === selected),
    )
    switch (to.to) {
      case 'refresh':
        resetWidths()
        await m.refreshManual(p)
        if (this.plan !== undefined) await this.readPlan(p, m, afterAsk) // `r` in the plan view reads the plan again (issue #199)
        return
      case 'help': {
        // The rows leave with the help view and come back with the next `h`: the engine keeps the ring's position, not its
        // Button, so the press asks for the ring again (issue #140).
        const was = await p.state.help.get()
        const drawn = this.refocus.awaitFrame(p, frame => (frame.view === 'help') !== was) // armed before the write
        const open = await p.state.help.update(unlessClosed(afterAsk, v => !v))
        if (!afterAsk.still()) return
        // The plan view and the help view exclude each other, so every write of the help atom drops the plan lines. An `h` that
        // reaches the pane while the plan is open (a press from an older drawing) shows the help view and drops the plan. An `h`
        // that comes while the plan is read, and loses the race with the write of the lines (`togglePlan` reads the atom again),
        // shows the rows when it goes back.
        this.setPlan(undefined)
        const next = {
          view: open ? ('help' as const) : ('rows' as const),
          row: open ? null : await this.selectedRow(p),
        }
        await this.refocus.keep(p, next, afterAsk, drawn, () => frameFromState(p, m, next))
        return
      }
      case 'clean':
        return this.planPressed(p, m, afterAsk)
      case 'dismiss':
        return this.dismissRows(p, m, [to.rowId], neighbourOf(this.drawn?.rows ?? [], to.rowId), afterAsk, false)
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
      // `m` (issue #138) writes a session atom and nothing else, as `g`, `a` and `t` do. The write also drops the marks of rows
      // that no tracker holds any more. It reads the inventory, not `paneData`: a rule that only hides a row (the TTL, the row
      // cap, `--hide`) must not end its mark, since `a` shows the row again. A count on the `x` label can add a footer row at 40
      // cells, so the ring is asked for again.
      case 'mark': {
        const known = rowIdsOf(await m.inventory(p))
        await writeMarks(p, afterAsk, cur => pruned(toggled(cur, to.rowId), known))
        return this.redrawn(p, m, selected, afterAsk)
      }
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

  /**
   * `p` (issue #199). In the rows it reads the plan of `/track clean` once and opens the plan view. In the plan view it closes the view
   * and drops the lines, so the next `p` reads the plan again. It changes nothing: the plan is read and never applied (`PaneHost`
   * has no way to apply). The help view has keys of its own, so `p` does nothing there. Like `h`, it swaps the rows for another
   * tree, so the press asks for the ring again (issue #140): on `p: back` when the view opens, on the selected row when it closes.
   *
   * The host starts itself when it reads the plan, as for a tracker key. A host that did not start gives no plan: the press answers
   * with a toast and opens no view. A press that began before a closing drops its read, and a press while the read is open does
   * nothing, so a double tap does not turn the view it opens into a second read.
   */
  private async planPressed(p: Ports, m: PaneHost, press: Press): Promise<void> {
    if (this.planRead?.still() === true) return
    this.planRead = press
    let change:
      | { readonly drawn: Promise<Frame | undefined>; readonly next: { view: ViewKind; row: string | null } }
      | undefined
    try {
      change = await this.togglePlan(p, m, press)
    } finally {
      if (this.planRead === press) this.planRead = undefined
    }
    if (change === undefined) return
    const { drawn, next } = change
    await this.refocus.keep(p, next, press, drawn, () => frameFromState(p, m, next))
  }

  /** The write of `p`: the view that opened or closed, and the frame the ring request waits for. Absent: nothing changed. */
  private async togglePlan(p: Ports, m: PaneHost, press: Press) {
    if (await p.state.help.get()) return undefined
    if (this.plan !== undefined) {
      const drawn = this.refocus.awaitFrame(p, frame => frame.view !== 'plan') // armed before the write
      this.setPlan(undefined)
      p.ui.invalidate()
      return { drawn, next: { view: 'rows' as const, row: await this.selectedRow(p) } }
    }
    const gen = this.planGen // an `h` or a closing while the plan is read moves it: this opening is then obsolete
    const lines = await m.cleanPlan(p)
    if (!press.still()) return undefined // the pane closed while the plan was read: the lines are not for the next pane
    if (lines === undefined) {
      p.ui.toast(NOT_READY) // the host did not start (study G5)
      return undefined
    }
    if (await p.state.help.get()) return undefined // an `h` opened the help view while the plan was read: the lines are not for it
    // Two `h` presses leave the help atom false, as it was at the press, but each moved the generation: the person went to the help
    // view and back to the rows, so the view that `p` meant to open is gone. The check comes last: the atom read above took time.
    if (!press.still() || gen !== this.planGen) return undefined
    const drawn = this.refocus.awaitFrame(p, frame => frame.view === 'plan') // armed before the write
    this.setPlan(lines)
    p.ui.invalidate()
    return { drawn, next: { view: 'plan' as const, row: null } }
  }

  /** Writes the lines of the plan view, or drops them (`undefined`), and moves the generation: the reads that began before are obsolete. */
  private setPlan(lines: readonly PlanLine[] | undefined): void {
    this.plan = lines
    this.planGen++
  }

  /**
   * `r` in the plan view: the plan is read again and the view shows the new lines. A press that outlived the view drops them. So does
   * a read that began before the view closed and opened again, or before a newer `r` read: the generation it took has moved, and
   * its lines are older than the ones in the view.
   */
  private async readPlan(p: Ports, m: PaneHost, press: Press): Promise<void> {
    const gen = ++this.planGen
    const lines = await m.cleanPlan(p)
    if (lines === undefined || !press.still() || this.plan === undefined || gen !== this.planGen) return
    this.plan = lines
    p.ui.invalidate()
  }

  /**
   * `x` and the digits on the marked rows (issue #138). `bulk.rowIds` are the marked rows that the key allows: none means a dim key,
   * and a hotkey does nothing. A digit never asks: a priority is set again with one key. `x` asks first, unless its one target is
   * the selected row (as today). The first `x` asks the question and the pane draws it; an `x` from a drawing that showed it, for
   * the same rows, dismisses them. An `x` from an older drawing leaves the question as it is. Marks win: the key never acts on the
   * unmarked selected row (G2).
   */
  private async bulk(
    p: Ports,
    m: PaneHost,
    bulk: Bulk,
    selected: string | null,
    press: Press,
    drawing: number,
  ): Promise<void> {
    if (bulk.rowIds.length === 0) return
    // One case for each kind of bulk key. A new member of `Bulk` has no case until it gets one, and `tsc` fails here (issue #138): a
    // dismiss has no undo, so a key must never reach it by falling through.
    switch (bulk.to) {
      case 'priority':
        await m.setPriorities(p, bulk.rowIds, bulk.level)
        await this.marksDone(p, press)
        await this.refocus.to(p, m, selected, press)
        return
      case 'dismiss':
        return this.bulkDismiss(p, m, bulk.rowIds, selected, press, drawing)
      default:
        return bulk satisfies never
    }
  }

  /** `x` on the marked rows: it asks first, unless its one target is the selected row, and an `x` from a drawing that showed the question dismisses. */
  private async bulkDismiss(
    p: Ports,
    m: PaneHost,
    targets: readonly string[],
    selected: string | null,
    press: Press,
    drawing: number,
  ): Promise<void> {
    if (!(targets.length === 1 && targets[0] === selected)) {
      const answer = this.question.answer(drawing, targets)
      if (answer === 'ask') {
        this.question.ask(targets)
        p.ui.invalidate()
      }
      if (answer !== 'confirm') return // the press came from a drawing that did not show the question: it asks and never dismisses
    }
    this.question.clear()
    await this.dismissRows(p, m, targets, survivorOf(this.drawn?.rows ?? [], selected, new Set(targets)), press, true)
  }

  /** The marks did their work: they clear, and the pane draws without them. */
  private async marksDone(p: Ports, press: Press): Promise<void> {
    await writeMarks(p, press, () => [])
    if (press.still()) p.ui.invalidate()
  }

  /**
   * Dismisses `ids` and puts the selection on `next`, with the ring on its new handle. `endMarks`: the rows were marked, so
   * the marks end with the action.
   */
  private async dismissRows(
    p: Ports,
    m: PaneHost,
    ids: readonly string[],
    next: string | null,
    press: Press,
    endMarks: boolean,
  ): Promise<void> {
    // Armed before the write that takes the rows. A drawing that still holds a row is not the frame the ring waits for.
    // Rows that were hidden behind an "N more" can take their place, so the frame need not be empty.
    const drawn =
      next === null
        ? this.refocus.awaitFrame(p, frame => frame.view === 'rows' && ids.every(id => !frame.rows.has(id)))
        : undefined
    await m.dismiss(p, ids)
    if (endMarks) await this.marksDone(p, press)
    await this.refocus.to(p, m, next, press)
    // The last row went: no row is left to take the ring, and the tracker keys left the footer with it (issue #140).
    if (drawn !== undefined) {
      const none = { view: 'rows' as const, row: null }
      await this.refocus.keep(p, none, press, drawn, () => frameFromState(p, m, none))
    }
  }
}
