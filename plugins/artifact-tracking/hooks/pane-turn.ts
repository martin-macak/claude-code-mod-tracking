// The press of the band Button `9: open` and of the open Button of a strip (issue #69): open `/track` with the pane focused and
// the first entry of a turn selected, and run the refresh that `/track` runs on open (`kick('open')`, owner decision of
// 2026-10-21). The band names no turn, so it takes the newest turn that tracked anything; the strip names its own (P2). The press
// selects the first entry only. The marks of the pane exist (issue #138): `writeMarks` in `pane-marks.ts` is the write that a
// press makes. Marking a whole turn waits for #232.
// PaneSession calls it with its own Refocus; nothing here touches the engine but the `ui` ports.
// Spec: issue #69, the design study (section 5, "Band") and the owner decisions of 2026-10-21.

import { NO_ROOM } from '../core/infra/command-text'
import type { TurnBand } from '../core/infra/turn-ledger'
import type { ItemsHost } from '../core/interfaces/items'
import type { Ports } from '../core/interfaces/ports'
import { handleOf } from '../ux/tree-data-table/table'
import { type Press, type Refocus, unlessClosed } from './pane-refocus'
import { type PaneHost, paneGroups, shownOf } from './pane-text'

/** The pane host, what the band press reads of the ledger and the refresh it runs. The LifecycleManager fits it as it is. */
export type TurnPaneHost = PaneHost & {
  /** The newest turn that tracked anything, or the turn `ord` when it is named. */
  bandTurn(ord?: number): Promise<TurnBand | undefined>
  readonly items: Pick<ItemsHost, 'kick'>
}

/**
 * The entry to select: the first key of the turn that a drawing of the pane lists. A row that the caps leave out, a row the
 * TTL hides and an item that was dismissed are not listed, so the press takes the next entry that is.
 */
async function firstListed(p: Ports, m: TurnPaneHost, keys: readonly string[]): Promise<string | undefined> {
  const expanded = new Set(await p.state.expanded.get())
  const groups = await paneGroups(p, m, { selected: null, expanded })
  const shown = await shownOf(p, groups)
  const view = { expanded, shown: (id: string) => shown.get(id) ?? 0, limits: m.config.global().ui }
  return keys.find(k => handleOf(groups, view, k) !== undefined)
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
  ord?: number,
): Promise<void> {
  const turn = await m.bandTurn(ord)
  const first = turn === undefined ? undefined : await firstListed(p, m, turn.keys)
  const before = await p.state.selected.get()
  const want = turn === undefined ? before : (first ?? null)
  if (want !== before) await p.state.selected.update(unlessClosed(press, () => want))
  if (!(await p.ui.open())) {
    if (want !== before) await p.state.selected.update(unlessClosed(press, cur => (cur === want ? before : cur)))
    p.ui.toast(NO_ROOM)
    return
  }
  m.items.kick('open')
  if (first !== undefined) await refocus.to(p, m, first, press)
  else if (turn !== undefined) p.ui.toast(`turn ${turn.ord}: its rows are not listed`)
  else if (ord !== undefined) p.ui.toast(`turn ${ord} is no longer kept`)
}
