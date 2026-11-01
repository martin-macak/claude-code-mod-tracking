// The write of the row marks (issue #138): this module owns the `marks` atom. `m` toggles a row through `writeMarks` and a bulk
// action clears the marks through it. It is also the seam for marking a whole turn: the band press of #69 and the open Button of a
// strip (issue #232, `pane-turn.ts`) set the marks to the entries of the turn through `writeMarks`, and no other code needs to learn
// how the marks are stored.
// `writeMarks` is guarded by the press. `clearMarks` is not, and it is the only write that is not: the closing of the pane
// bumps the closing count first, so a press token would be stale for it, and the closing is what ends the marks anyway.
// PaneSession calls them; nothing here touches the engine but the `marks` state port.

import type { Ports } from '../core/interfaces/ports'
import { type Press, unlessClosed } from './pane-refocus'

/**
 * Writes the marks: `change` gets the marks as they are and gives the new list. A press that began before a closing writes
 * nothing after it (issue #130): the engine may apply the write after the closing, so the check is in the write.
 */
export async function writeMarks(
  p: Ports,
  press: Press,
  change: (cur: readonly string[]) => readonly string[],
): Promise<void> {
  await p.state.marks.update(unlessClosed(press, cur => [...change(cur)]))
}

/** The pane closed: no row stays marked. The one write that no press guards, as the closing is what makes a press stale. */
export async function clearMarks(p: Ports): Promise<void> {
  await p.state.marks.update(() => [])
}
