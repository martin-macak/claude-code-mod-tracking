// TreeDataTable: the one component that draws the pane from the trackers' sections. A header row per section, one
// focus Button per row, a sticky selected row, caps with an "N more" row, a footer of keys, a help view and a budget
// guard that keeps the footer. Pure: it calls the global `h` through the typed wrappers and touches no state.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10. Plan: L6 Task 8, G9, G10, G16, G18, G20.
import type { RenderElement } from 'claude-code'
import type { SectionSpec } from '../../core/interfaces/view'
import { guard } from './budget'
import { box, type TableElements, text } from './el'
import { footerBox, footerRows } from './footer'
import { compactHelp, renderHelp } from './help'
import { type LaidSection, layout } from './layout'
import { type Draw, drawSection } from './rows'
import {
  DEFAULT_BODY_COLUMNS,
  type Drawn,
  type DrawnRow,
  ROW_GAP,
  type TableActions,
  type TableView,
  TOO_LARGE,
  UNAVAILABLE,
} from './shape'
import { EMPTY_TEXT } from './text'

export { findRow, handleOf, type LaidRow, type LaidSection, layout, neighbourOf } from './layout'
export {
  DEFAULT_BODY_COLUMNS,
  DETAIL_CELLS,
  type Drawn,
  type DrawnRow,
  GUTTER,
  NOTHING_MORE,
  type TableActions,
  type TableView,
  TOO_LARGE,
  UNAVAILABLE,
} from './shape'

/** The halving steps: from 1 up to the first `k` where every section's halved cap is 1. */
function halvings(sections: readonly SectionSpec[], view: TableView): number {
  const wants = sections.map(s => view.limits.sectionRows + view.shown(s.id))
  let k = 1
  while (k < 32 && wants.some(w => Math.floor(w / 2 ** k) > 1)) k++
  return k
}

export const TreeDataTable = {
  /**
   * The guard tries a full drawing, one with no detail lines, then the caps halved until each is 1, then one dim
   * line. `handles` and `rows` describe the drawing that was kept.
   */
  render(sections: readonly SectionSpec[], view: TableView, el: TableElements, actions: TableActions): Drawn {
    const footer = footerBox(el, view.footer, actions)
    // The help view is one tree, so a short body turns it compact, with no gap, once for every attempt.
    const columns = view.bodyColumns ?? DEFAULT_BODY_COLUMNS
    const compact =
      view.help !== null && compactHelp(view.help, footerRows(view.footer, columns), columns, view.bodyRows)
    const laids: (readonly LaidSection[])[] = []
    const attempt = (halve: number, detail: boolean) => (): RenderElement[] => {
      if (view.help !== null) {
        laids.push([])
        return [box(el, { flexDirection: 'column' }, ...renderHelp(el, view.help, compact))]
      }
      if (sections.length === 0) {
        laids.push([])
        return [text(el, { dimColor: true }, EMPTY_TEXT)]
      }
      const laid = layout(sections, view, halve)
      laids.push(laid)
      const rows = laid.flatMap(s => s.rows)
      const focus = rows.some(r => r.row.id === view.selected) ? undefined : rows[0]?.handle
      const draw: Draw = { el, view, actions, detail, focus }
      return laid.map(s => drawSection(draw, s))
    }
    const attempts =
      view.help !== null || sections.length === 0
        ? [attempt(0, true)]
        : [
            attempt(0, true),
            attempt(0, false),
            ...Array.from({ length: halvings(sections, view) }, (_, i) => attempt(i + 1, false)),
          ]
    const { body, step } = guard(footer, attempts, () => [text(el, { dimColor: true }, TOO_LARGE)], view.budget)
    const rows: DrawnRow[] = (laids[step] ?? []).flatMap(s =>
      s.rows.map(r => ({
        id: r.row.id,
        owner: r.row.owner,
        section: s.spec.id,
        can: r.row.can,
        handle: r.handle,
        depth: r.depth,
      })),
    )
    return {
      tree: box(el, { flexDirection: 'column', rowGap: compact ? 0 : ROW_GAP }, ...body, footer),
      handles: new Map(rows.map(r => [r.handle, r.id])),
      rows,
    }
  },

  /** The notice for a pane that failed to build. */
  unavailable(el: TableElements): RenderElement {
    return text(el, { dimColor: true }, UNAVAILABLE)
  },
}
