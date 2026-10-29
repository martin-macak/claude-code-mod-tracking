// TreeDataTable: the one component that draws the pane from the groups of the view (today one per section of a tracker).
// One header row for the whole table, a title row per group, one focus Button per row, a sticky selected row, caps with an "N more" row, a footer of keys, a help view, a plan view (issue #199), a budget
// guard that keeps the footer and a window over the rows that keeps the title, the header and the footer in view when
// the body is shorter than the tree, and on a docked pane a footer pinned to the last row of the body. Pure: it calls the
// global `h` through the typed wrappers and touches no state.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10. Plan: L6 Task 8, G9, G10, G16, G18, G20.
import type { RenderElement } from 'claude-code'
import type { GroupSpec } from '../../core/interfaces/view'
import { guard } from './budget'
import { box, type TableElements, text } from './el'
import { footerBox, footerRows, moveHintFits } from './footer'
import { compactForm, renderHelp } from './help'
import { type LaidGroup, layout, refOf } from './layout'
import { renderPlan, shapePlan } from './plan'
import { type Draw, drawGroups, openLinesOf } from './rows'
import {
  DEFAULT_BODY_COLUMNS,
  type Drawn,
  type DrawnRow,
  ROW_GAP,
  type TableActions,
  type TableView,
  TOO_LARGE,
  textView,
  UNAVAILABLE,
} from './shape'
import { statusLineBox, statusOf } from './status'
import { EMPTY_TEXT } from './text'
import { viewLineBox } from './viewline'
import { drawWindowed, pageOf, shownRows, type Windowed, windowOf } from './windowed'

export {
  findRow,
  findTreeRow,
  handleOf,
  type LaidGroup,
  type LaidRow,
  laidRefs,
  layout,
  neighbourOf,
  refOf,
  refsOf,
  shownSelection,
  survivorOf,
} from './layout'
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

/** The halving steps: from 1 up to the first `k` where every group's halved cap is 1. */
function halvings(groups: readonly GroupSpec[], view: TableView): number {
  const wants = groups.map(g => view.limits.sectionRows + view.shown(g.id))
  let k = 1
  while (k < 32 && wants.some(w => Math.floor(w / 2 ** k) > 1)) k++
  return k
}

/**
 * The view with the rows of the open selected row set on its quick view (`quick.open`, issue #276, review of PR #284): the detail lines
 * of an open row take room from the list, and the window cannot give them back, so the quick view leaves them. The footer and the
 * window both read this one view, so they count the quick view alike. Any other view is as it was.
 */
function withOpenLines(groups: readonly GroupSpec[], view: TableView): TableView {
  const quick = view.status?.quick
  if (view.status === undefined || quick === undefined || view.bodyRows === undefined || textView(view)) return view
  const open = openLinesOf(layout(groups, view, 0), view.selected, view.bodyColumns ?? DEFAULT_BODY_COLUMNS)
  return open === 0 ? view : { ...view, status: { ...view.status, quick: { ...quick, open } } }
}

export const TreeDataTable = {
  /**
   * The guard tries a full drawing, one with no detail lines, then the caps halved until each is 1, then one dim
   * line. `handles` and `rows` describe the drawing that was kept.
   */
  render(groups: readonly GroupSpec[], given: TableView, el: TableElements, actions: TableActions): Drawn {
    const view = withOpenLines(groups, given)
    const columns = view.bodyColumns ?? DEFAULT_BODY_COLUMNS
    // The move hint only where it adds no footer row (issue #108), so it never turns the help view compact by itself.
    const hint = moveHintFits(view.footer, columns)
    const keys = footerBox(el, view.footer, actions, hint)
    // The view line sits right above the keys, in the same Box, so the gap above the bottom is one and the window counts the
    // rows of both. The help view has no view line: its footer draws the keys of the view line as dim Buttons (issue #200), so
    // a letter of it does not reach the prompt. Only `r` and `h` work, and the compact form is budgeted to the footer rows.
    // The full status area (issue #138) puts the selected-row line above the view line and the health line below it: all of it
    // in the Box of the footer, so the dock pins it and the budget guard keeps it. The quick view of the selected row (issue #276)
    // adds its lines under the selected-row line, as many as `statusOf` says: the window budgets the same lines. The help view has none.
    const lines = statusOf(view)
    const viewLine = textView(view) ? undefined : view.viewLine
    const footer =
      viewLine === undefined && lines === undefined
        ? keys
        : box(
            el,
            { flexDirection: 'column' },
            ...(lines === undefined ? [] : lines.selected.map(line => statusLineBox(el, line, columns))),
            ...(viewLine === undefined ? [] : [viewLineBox(el, viewLine, columns, actions)]),
            ...(lines?.health === undefined ? [] : [statusLineBox(el, lines.health, columns)]),
            keys,
          )
    // The help view is one tree, so a short body turns it compact, with no gap, once for every attempt. The compact form
    // fits the body: it takes the keys to a line from the width and names only the problems it has rows for (issue #105).
    const compact =
      view.help === null
        ? undefined
        : compactForm(view.help, footerRows(view.footer, columns, hint), columns, view.bodyRows)
    // The plan view (issue #199) is one tree too, cut to the body under the footer: a plan that fits whole keeps the gap, a cut plan has none.
    const planned =
      view.help !== null || view.plan === undefined
        ? undefined
        : shapePlan(view.plan, footerRows(view.footer, columns, hint), columns, view.bodyRows)
    const laids: (readonly LaidGroup[])[] = []
    const windows: (Windowed | undefined)[] = []
    const attempt = (halve: number, detail: boolean) => (): RenderElement[] => {
      if (view.help !== null) {
        laids.push([])
        windows.push(undefined)
        return [box(el, { flexDirection: 'column' }, ...renderHelp(el, view.help, compact ?? false))]
      }
      if (planned !== undefined) {
        laids.push([])
        windows.push(undefined)
        return [box(el, { flexDirection: 'column' }, ...renderPlan(el, planned.lines))]
      }
      if (groups.length === 0) {
        laids.push([])
        windows.push(undefined)
        return [text(el, { dimColor: true }, EMPTY_TEXT)]
      }
      const laid = layout(groups, view, halve)
      laids.push(laid)
      const rows = laid.flatMap(s => s.rows)
      // A body shorter than the tree shows a window of it (windowed.ts). The ring goes to the selected row when it is drawn
      // (issue #108), else to the first row in view.
      const win = windowOf({ el, view, actions, detail, focus: undefined }, laid)
      windows.push(win)
      const shown = win === undefined ? rows : shownRows(win, laid)
      const focus = (rows.find(r => r.row.id === view.selected) ?? shown[0])?.handle
      const draw: Draw = { el, view, actions, detail, focus }
      return win === undefined ? drawGroups(draw, laid) : drawWindowed(draw, laid, win)
    }
    const attempts =
      textView(view) || groups.length === 0
        ? [attempt(0, true)]
        : [
            attempt(0, true),
            attempt(0, false),
            ...Array.from({ length: halvings(groups, view) }, (_, i) => attempt(i + 1, false)),
          ]
    const { body, step } = guard(footer, attempts, () => [text(el, { dimColor: true }, TOO_LARGE)], view.budget)
    const win = windows[step]
    const rows: DrawnRow[] = (laids[step] ?? []).flatMap(s =>
      s.rows.map(r => ({ ...refOf(r.row, s.spec.id), handle: r.handle, depth: r.depth })),
    )
    // A docked body has a fixed height: the tree takes all of it and the footer grows to the end of the column (issue #109).
    // The wrapper replaces the footer in the root, so it adds no child and no gap row. `minHeight` never clips: a tree that
    // counts taller than the body only loses the pad.
    const pinned = view.placement === 'dock' && view.bodyRows !== undefined
    const root = {
      flexDirection: 'column',
      rowGap: compact === undefined && planned?.gap !== false ? ROW_GAP : 0,
      ...(pinned ? { minHeight: view.bodyRows } : {}),
    } as const
    const end = { flexDirection: 'column', flexGrow: 1, flexShrink: 0, justifyContent: 'flex-end' } as const
    return {
      tree: box(el, root, ...body, pinned ? box(el, end, footer) : footer),
      handles: new Map(rows.map(r => [r.handle, r.id])),
      rows,
      stops: (laids[step] ?? []).flatMap(s => [...s.rows.map(r => r.handle), ...(s.more > 0 ? [`m${s.index}`] : [])]),
      top: win?.plan.from ?? 0,
      page: win === undefined ? undefined : pageOf(win),
    }
  },

  /** The notice for a pane that failed to build. */
  unavailable(el: TableElements): RenderElement {
    return text(el, { dimColor: true }, UNAVAILABLE)
  },
}
