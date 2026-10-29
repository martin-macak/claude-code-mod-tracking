// The press of the band Button `9: open` and of the open Button of a strip (issue #69): open `/track` with the pane focused and
// the first entry of a turn selected, and run the refresh that `/track` runs on open (`kick('open')`, owner decision of
// 2026-10-21). The band names no turn, so it takes the newest turn that tracked anything; the strip names its own (P2). The press
// selects the first entry and marks every listed entry that `m` can mark (issue #232): `writeMarks` in `pane-marks.ts` is the write
// that the marks of #138 take, and a second press on the same turn clears them.
// PaneSession calls it with its own Refocus; nothing here touches the engine but the `ui` ports.
// Spec: issue #69, the design study (section 5, "Band") and the owner decisions of 2026-10-21.

import { NO_ROOM } from '../core/infra/command-text'
import { takesMark } from '../core/infra/keys'
import type { TurnBand } from '../core/infra/turn-ledger'
import type { ItemsHost } from '../core/interfaces/items'
import type { Ports } from '../core/interfaces/ports'
import { turnMarked } from '../core/lib/marks'
import { laidRefs } from '../ux/tree-data-table/table'
import { writeMarks } from './pane-marks'
import { type Press, type Refocus, unlessClosed } from './pane-refocus'
import { type PaneHost, paneGroups, shownOf } from './pane-text'

/** The pane host, what the band press reads of the ledger and the refresh it runs. The LifecycleManager fits it as it is. */
export type TurnPaneHost = PaneHost & {
  /** The newest turn that tracked anything, or the turn `ord` when it is named. */
  bandTurn(ord?: number): Promise<TurnBand | undefined>
  readonly items: Pick<ItemsHost, 'kick'>
}

/**
 * What a drawing of the pane lists of a turn: `first`, the first key that it lists (the entry to select), `marks`, the listed
 * keys that `m` could mark (`takesMark`), in the order of the turn, and `laid`, every row that the drawing counts. A row that the
 * caps leave out, a row the TTL hides, a child of a closed row and an item that was dismissed are not listed (`laidRefs` is the
 * list that the marks, the labels and the press read).
 */
async function listedOf(
  p: Ports,
  m: TurnPaneHost,
  keys: readonly string[],
): Promise<{ first: string | undefined; marks: readonly string[]; laid: ReadonlySet<string> }> {
  const expanded = new Set(await p.state.expanded.get())
  const groups = await paneGroups(p, m, { selected: null, expanded })
  const shown = await shownOf(p, groups)
  const view = { expanded, shown: (id: string) => shown.get(id) ?? 0, limits: m.config.global().ui }
  const laid = new Map(laidRefs(groups, view).map(r => [r.id, r] as const))
  const listed = keys.flatMap(k => laid.get(k) ?? [])
  return {
    first: listed[0]?.id,
    marks: listed.filter(r => takesMark(r, o => m.isItemOwner(o))).map(r => r.id),
    laid: new Set(laid.keys()),
  }
}

/** The turn that the last press set the marks to: the one fact that `turnMarked` needs and the rows cannot tell (issue #232). */
export interface MarkedTurn {
  get(): number | undefined
  set(ord: number): void
}

/**
 * `ord` names the turn (the strip of an answer); absent, the press is the band's and takes the newest turn that tracked
 * anything. A named turn that the ledger no longer keeps (the cap dropped it) opens the pane with a toast that says so.
 *
 * Selects the entry before the pane opens, so the first drawing of a pane that opens now selects the row and takes the ring
 * (the table marks the selected row `autoFocus`). A pane that is open already gets the ring by a request, as after `x`. With a
 * turn but no entry listed, nothing is selected: an older selection must not stand for a turn whose rows are not there, and
 * the pane opens with a toast that names the turn. With no room for the pane, the selection goes back to what it was and a
 * toast says so: no pane came, so a later `/track` must not open on a row the person never chose (a write of the person
 * between the press and the answer of the engine stays).
 *
 * A pane that opened gets the marks of the turn (issue #232): the listed entries that `m` could mark, set as the marks (older marks
 * go, as `x` and the digits act on the marks first). A second press on the same turn, with the marks that the pane counts still
 * those rows, clears them (`marked` says which turn the last press set, and a press that a closing made stale does not set it): the band draws no Button while the pane is shown, so only
 * the open Button of a strip reaches it. A turn with no such row sets no marks, so the older marks go too. A turn that the ledger
 * no longer keeps is no press on a turn: the marks stay as they were.
 *
 * A pane that opened gets the refresh of `/track` (`kick('open')` asks the item refresh for a round), so the rows of a turn
 * are fresh when the person looks at them. `/track` refreshes also when no room is left, because it prints the list; a press
 * prints nothing, so a refused open refreshes nothing.
 *
 * `press` is the token of this press (issue #130, #139): the band is drawn while the pane is closed, so it has no keys to ask
 * for (`ui.open` grants them), and a pane that closed since the press began gets no selection, no restore and no ring.
 */
export async function openTurn(
  p: Ports,
  m: TurnPaneHost,
  refocus: Pick<Refocus, 'to'>,
  press: Press,
  marked: MarkedTurn,
  ord?: number,
): Promise<void> {
  const turn = await m.bandTurn(ord)
  const { first, marks, laid } =
    turn === undefined ? { first: undefined, marks: [], laid: new Set<string>() } : await listedOf(p, m, turn.keys)
  const before = await p.state.selected.get()
  const want = turn === undefined ? before : (first ?? null)
  if (want !== before) await p.state.selected.update(unlessClosed(press, () => want))
  if (!(await p.ui.open())) {
    if (want !== before) await p.state.selected.update(unlessClosed(press, cur => (cur === want ? before : cur)))
    p.ui.toast(NO_ROOM)
    return
  }
  m.items.kick('open')
  // The marks follow the open, so a refused open leaves nothing to put back. They come before the ring request: the count on `dismiss`
  // can add a footer row at 40 cells, so the ring is asked for once the layout is final (issue #138, G22).
  if (turn !== undefined) {
    const sameTurn = marked.get() === turn.ord
    await writeMarks(p, press, cur => turnMarked(cur, marks, { laid, sameTurn }))
    // A closing since the press began wrote no marks and reset the turn of the last press: the stale press must not set it again.
    if (press.still()) marked.set(turn.ord)
  }
  if (first !== undefined) await refocus.to(p, m, first, press)
  else if (turn !== undefined) p.ui.toast(`turn ${turn.ord}: its rows are not listed`)
  else if (ord !== undefined) p.ui.toast(`turn ${ord} is no longer kept`)
}
