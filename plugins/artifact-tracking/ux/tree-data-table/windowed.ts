// The windowed drawing of the pane (issue #109). The engine scrolls a pane tree as a whole, so a tree taller than the body
// loses its footer, its titles and its header out of view. When the tree is taller than `bodyRows`, the pane draws only the
// units that fit, with the one header of the table, the title of each group that shows a unit, a hint where rows are
// hidden and the footer, and it follows the selected row (window.ts picks the units).
//
// The focus ring sits on a position among the Buttons, not on a key (README "Known limits", tree-table.md section 3.2).
// So every row keeps its stop in the same order, whatever the window: a row out of the window is a Box with no height that
// clips, around the one Button that holds its handle. Tab and the arrows then walk every row, the `ui.focus` hook selects
// it, and the next drawing moves the window onto it with the ring still on it. Pure.
import type { RenderElement } from 'claude-code'
import { normaliseCell } from '../text/cell-width'
import { wrapRows } from '../text/wrap'
import { GLYPH } from '../theme'
import { box, button, text } from './el'
import { footerRows } from './footer'
import type { LaidGroup, LaidRow } from './layout'
import {
  bareParts,
  type Draw,
  groupTitle,
  moreRowOf,
  rowLines,
  rowParts,
  type Solving,
  solving,
  tableHeader,
} from './rows'
import { DEFAULT_BODY_COLUMNS, GUTTER, HEADER_ROWS, ROW_GAP } from './shape'
import { viewLineRows } from './viewline'
import { type Plan, planWindow, rowsIn, type Unit } from './window'

type Kind = 'row' | 'more' | 'block'

/** A unit with what draws it: a row of the group (`at` indexes its laid rows), its "N more" row, or the group itself. */
interface Placed extends Unit {
  readonly kind: Kind
  readonly at: number
}

export interface Windowed {
  readonly plan: Plan
  readonly units: readonly Placed[]
  /** The solved columns of the table, or undefined when no group has a row to draw (and so no header). */
  readonly solved: Solving | undefined
}

const MORE = '▼'
const LESS = '▲'

/** The title takes one line of a group that has a row. A group with none holds its own lines. The header is the table's. */
const CHROME = 1

function unitsOf(d: Draw, laid: readonly LaidGroup[]): Pick<Windowed, 'units' | 'solved'> & { chrome: number[] } {
  const units: Placed[] = []
  const chrome: number[] = []
  const solved = laid.some(s => s.rows.length > 0) ? solving(d, laid) : undefined
  laid.forEach((s, section) => {
    if (s.rows.length === 0 || solved === undefined) {
      const width = d.view.bodyColumns ?? DEFAULT_BODY_COLUMNS
      const empty =
        s.spec.rows.length === 0 && s.spec.empty !== undefined ? wrapRows(normaliseCell(s.spec.empty), width) : 0
      units.push({ section, kind: 'block', at: 0, rows: 0, lines: 1 + empty + (s.more > 0 ? 1 : 0) })
      chrome.push(0)
      return
    }
    chrome.push(CHROME)
    for (const [at, r] of s.rows.entries()) {
      units.push({ section, kind: 'row', at, rows: 1, lines: rowLines(d, solved, r) })
    }
    if (s.more > 0) units.push({ section, kind: 'more', at: 0, rows: 0, lines: 1 })
  })
  return { units, chrome, solved }
}

/**
 * The window over the laid groups, or undefined when every row is drawn: no body height is known, or the tree fits it.
 * The budget is the body less the footer, the gap above it and the header of the table (drawn once a row is). The focus
 * is the unit of the "N more" row the ring sits on, else the unit of the selected row.
 */
export function windowOf(d: Draw, laid: readonly LaidGroup[]): Windowed | undefined {
  const { view } = d
  if (view.bodyRows === undefined) return undefined
  const { units, chrome, solved } = unitsOf(d, laid)
  // The footer takes the same rows with or without the move hint: the table draws it only where it adds no row.
  const header = solved === undefined ? 0 : HEADER_ROWS
  const columns = view.bodyColumns ?? DEFAULT_BODY_COLUMNS
  // The view line is in the Box of the footer: its rows come off the budget with the footer's (issue #63, L3).
  const budget =
    view.bodyRows - footerRows(view.footer, columns, false) - viewLineRows(view.viewLine, columns) - ROW_GAP - header
  const find = (pick: (u: Placed, s: LaidGroup) => boolean): number =>
    units.findIndex(u => {
      const s = laid[u.section]
      return s !== undefined && pick(u, s)
    })
  // An `onMore` whose Button is gone (Enter showed the rest of the rows, and the drawing ran before the press cleared the
  // mark) matches no unit: the window then follows the selected row.
  const more =
    view.onMore === undefined ? -1 : find((u, s) => u.kind !== 'row' && s.more > 0 && view.onMore === `m${s.index}`)
  const focus = more >= 0 ? more : find((u, s) => u.kind === 'row' && s.rows[u.at]?.row.id === view.selected)
  const plan = planWindow({ units, chrome, budget, anchor: view.top ?? 0, focus: focus < 0 ? undefined : focus })
  return plan === undefined ? undefined : { plan, units, solved }
}

/** The rows drawn in full, in order. */
export function shownRows(w: Windowed, laid: readonly LaidGroup[]): LaidRow[] {
  return w.units
    .slice(w.plan.from, w.plan.to)
    .flatMap(u => (u.kind === 'row' ? [laid[u.section]?.rows[u.at]] : []))
    .filter((r): r is LaidRow => r !== undefined)
}

/** The rows drawn in full: a page of the list, for the keys that move by a page. */
export const pageOf = (w: Windowed): number => rowsIn(w.units, w.plan.from, w.plan.to)

/**
 * The focus stop of a unit that is out of the window: the one Button, in a Box that has no height and clips. It does what
 * the Button it stands for does, so an Enter that lands before the next drawing still acts.
 */
function stopOf(d: Draw, s: LaidGroup, u: Placed): RenderElement | undefined {
  const row = u.kind === 'row' ? s.rows[u.at] : undefined
  const more = u.kind !== 'row' && s.more > 0
  if (row === undefined && !more) return undefined
  return box(
    d.el,
    { height: 0, overflow: 'hidden', flexShrink: 0 },
    button(d.el, {
      key: row?.handle ?? `m${s.index}`,
      plain: true,
      label: row === undefined ? `${s.more} more` : GLYPH.closed,
      onPress: row === undefined ? () => d.actions.more(s.spec.id) : () => d.actions.toggle(row.row.id),
    }),
  )
}

const hint = (d: Draw, glyph: string, rows: number, word: string): RenderElement =>
  box(d.el, { paddingLeft: GUTTER }, text(d.el, { dimColor: true }, `${glyph} ${rows} more ${word}`))

/**
 * The groups that show a unit, one Box each (the root Box puts a gap between them and the footer). The header of the table
 * leads the first Box. The stops of the units before the window follow it, the stops after the window end the last Box,
 * so the Buttons keep their order. The hint above sits under the title of the first Box, the hint below ends the last.
 */
export function drawWindowed(d: Draw, laid: readonly LaidGroup[], w: Windowed): RenderElement[] {
  const { from, to } = w.plan
  const lead: RenderElement[] = []
  const tail: RenderElement[] = []
  const shown = new Map<number, Placed[]>()
  w.units.forEach((u, k) => {
    const s = laid[u.section]
    if (s === undefined) return
    if (k >= from && k < to) {
      shown.set(u.section, [...(shown.get(u.section) ?? []), u])
      return
    }
    const stop = stopOf(d, s, u)
    if (stop !== undefined) (k < from ? lead : tail).push(stop)
  })
  const above = rowsIn(w.units, 0, from)
  const below = rowsIn(w.units, to, w.units.length)
  const groups = [...shown.keys()]
  return groups.map((index, i) => {
    const s = laid[index] as LaidGroup
    const g = w.solved
    const first = i === 0
    const last = i === groups.length - 1
    const parts: RenderElement[] = first ? [...(g === undefined ? [] : [tableHeader(d, g)]), ...lead] : []
    if (g === undefined || s.rows.length === 0) {
      parts.push(...bareParts(d, s))
      if (first && above > 0) parts.push(hint(d, LESS, above, 'above'))
    } else {
      parts.push(groupTitle(d, s, g))
      if (first && above > 0) parts.push(hint(d, LESS, above, 'above'))
      for (const u of shown.get(index) ?? []) {
        const r = u.kind === 'row' ? s.rows[u.at] : undefined
        parts.push(...(r !== undefined ? rowParts(d, g, r) : [moreRowOf(d, s, g)]))
      }
    }
    if (last && below > 0) parts.push(hint(d, MORE, below, 'below'))
    if (last) parts.push(...tail)
    return box(d.el, { flexDirection: 'column' }, ...parts)
  })
}
