// The write callbacks of the pane: fold, refresh, dismiss, focus and the priority keys. `ux/` cannot write, so
// register.tsx hands the drawing these functions over the ports of the render. Each one is fire and forget: a failure
// leaves the state as it was and the person can press again.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.3 and 5.10. Plan: L3 Task 12.

import type { LifecycleManager } from '../core/infra/lifecycle'
import type { Ports } from '../core/interfaces/ports'
import type { PaneActions } from '../ux/pane'
import type { Priority } from './contracts'
import { composePane } from './ui/auto-view'
import { markKeys } from './ui/view'
import { viewInputs } from './view-inputs'

/**
 * The row the priority keys act on, and the element key to row id map of the last drawing (`focusTargets`).
 * Never stored: a close, a reload or /clear forgets it.
 */
export type PaneFocus = { row: string | undefined; rows: ReadonlyMap<string, string> }

/**
 * The person moves the pane's ring. A Button of an item row picks that row; the footer keys keep the pick, so
 * Enter on `1: high` still acts on it. Another Button, or one of the engine's own stops, drops it.
 */
export function pickRow(focus: PaneFocus, e: { element?: string; origin?: { kind: string } }): void {
  const id = e.element === undefined ? undefined : focus.rows.get(e.element)
  if (id !== undefined) focus.row = id
  else if (e.element !== undefined ? !e.element.startsWith('prio-') : e.origin?.kind === 'person') focus.row = undefined
}

/**
 * The priority keys act on the picked row. `undefined` (key `0`) removes the person's mark. The row moves when it
 * sorts again, but the ring stays at its old place (study S3). So the ring is moved to the row's new mark Button, whose
 * key only the next drawing has (S4). In a test kit the engine's focus call has no implementation, and live it may be refused:
 * the move is best effort.
 */
async function prioritize(p: Ports, m: LifecycleManager, focus: PaneFocus, level: Priority | undefined): Promise<void> {
  const id = focus.row
  if (id === undefined) return
  try {
    await m.setPriority(p, id, level)
  } catch {
    return // The mark stays. The person can press again.
  }
  try {
    const v = await viewInputs(p, m.facts, { live: id => m.live(id) })
    const key = markKeys(composePane(v.items, v.processes, v.processUi, v.ctx, v.repos)).get(id)
    if (key !== undefined) await p.ui.focus(key)
  } catch {
    // The ring stays where it is. The next Tab moves it.
  }
}

const quiet = (task: Promise<unknown>): void => void task.catch(() => {})

export function paneActions(p: Ports, m: LifecycleManager, focus: PaneFocus): PaneActions {
  return {
    fold: id =>
      quiet(
        p.state.ui.update(u => {
          const folded = u?.folded ?? []
          return { folded: folded.includes(id) ? folded.filter(x => x !== id) : [...folded, id] }
        }),
      ),
    refresh: () => quiet(m.refreshManual(p)),
    // The manager adds the id to the dismiss list first, drops the item key second, then the trackers hear of it.
    dismiss: id => quiet(m.dismiss(p, [id])),
    focus: id => {
      focus.row = id
    },
    prioritize: level => quiet(prioritize(p, m, focus, level)),
  }
}
