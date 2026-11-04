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
import { box, button, text } from './el'
import { glyphOf, hasStop, type LaidGroup, type LaidRow } from './layout'
import {
  bareParts,
  type Draw,
  emptyOf,
  groupRowLine,
  groupTitle,
  moreRowOf,
  rowParts,
  type Solving,
  solving,
  tableHeader,
} from './rows'
import { DEFAULT_BODY_COLUMNS, GUTTER, HEADER_ROWS, TITLE_ROWS } from './shape'
import { bottomRows, statusRows } from './status'
import { type Plan, planWindow, rowsIn, type Unit } from './window'

type Kind = 'row' | 'more' | 'block' | 'head' | 'empty'

/**
 * A unit with what draws it: a row of the group (`at` indexes its laid rows), its "N more" row, the group itself, or, in a foldable
 * group (issue #256), its group row (`head`) and the empty text under it (`empty`).
 */
interface Placed extends Unit {
  readonly kind: Kind
  readonly at: number
  /** A group row that takes a Button: a page key moves over it as over a row. */
  readonly stop?: true
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
const CHROME = TITLE_ROWS

function unitsOf(d: Draw, laid: readonly LaidGroup[]): Pick<Windowed, 'units' | 'solved'> & { chrome: number[] } {
  const units: Placed[] = []
  const chrome: number[] = []
  const solved = laid.some(s => s.rows.length > 0 || s.head !== undefined) ? solving(d, laid) : undefined
  const width = d.view.bodyColumns ?? DEFAULT_BODY_COLUMNS
  laid.forEach((s, section) => {
    if (s.head !== undefined) {
      // The group row is the title line of the group (issue #256): a unit of one line that counts no row, so no chrome line stands
      // above it. A window that starts after it draws a copy of it as chrome, so the chrome of the group is one line.
      chrome.push(CHROME)
      units.push({
        section,
        kind: 'head',
        at: 0,
        rows: 0,
        lines: 1,
        head: true,
        ...(hasStop(s.head) ? { stop: true as const } : {}),
      })
      if (s.spec.rows.length === 0 && s.spec.empty !== undefined) {
        units.push({ section, kind: 'empty', at: 0, rows: 0, lines: wrapRows(normaliseCell(s.spec.empty), width) })
      }
      for (const at of s.rows.keys()) {
        units.push({ section, kind: 'row', at, rows: 1, lines: 1 })
      }
      if (s.more > 0) units.push({ section, kind: 'more', at: 0, rows: 0, lines: 1 })
      return
    }
    if (s.rows.length === 0 || solved === undefined) {
      const empty =
        s.spec.rows.length === 0 && s.spec.empty !== undefined ? wrapRows(normaliseCell(s.spec.empty), width) : 0
      units.push({ section, kind: 'block', at: 0, rows: 0, lines: 1 + empty + (s.more > 0 ? 1 : 0) })
      chrome.push(0)
      return
    }
    chrome.push(CHROME)
    for (const at of s.rows.keys()) {
      units.push({ section, kind: 'row', at, rows: 1, lines: 1 })
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
  const header = solved === undefined ? 0 : HEADER_ROWS
  // The bottom is the footer, the view line and the gap above them (`bottomRows`; the footer takes the same rows with or without the
  // move hint, as the table draws it only where it adds no row). The view line is in the Box of the footer, so its rows come off the
  // budget with the footer's (issue #63, L3). So do the lines of the status area (issue #138): the selected-row line with the lines
  // of the quick view (issue #276), and the health line.
  const budget = view.bodyRows - bottomRows(view) - statusRows(view) - header
  const find = (pick: (u: Placed, s: LaidGroup) => boolean): number =>
    units.findIndex(u => {
      const s = laid[u.section]
      return s !== undefined && pick(u, s)
    })
  // An `onMore` whose Button is gone (Enter showed the rest of the rows, and the drawing ran before the press cleared the
  // mark) matches no unit: the window then follows the selected row.
  const more =
    view.onMore === undefined
      ? -1
      : find((u, s) => (u.kind === 'more' || u.kind === 'block') && s.more > 0 && view.onMore === `m${s.index}`)
  const focus =
    more >= 0
      ? more
      : find(
          (u, s) =>
            (u.kind === 'row' && s.rows[u.at]?.row.id === view.selected) ||
            (u.kind === 'head' && hasStop(s.head) && s.head.row.id === view.selected),
        )
  // The first row that Enter on an "N more" row added (issue #374): the unit after the last row the group had, in the same group.
  const last = view.reveal === undefined ? -1 : find((u, s) => u.kind === 'row' && s.rows[u.at]?.row.id === view.reveal)
  const next = last < 0 ? undefined : units[last + 1]
  const also = next?.kind === 'row' && next.section === units[last]?.section ? last + 1 : undefined
  const plan = planWindow({
    units,
    chrome,
    budget,
    anchor: view.top ?? 0,
    focus: focus < 0 ? undefined : focus,
    ...(also === undefined ? {} : { also }),
  })
  return plan === undefined ? undefined : { plan, units, solved }
}

/** The rows drawn in full that take a Button, in order: the group rows (issue #256) and the rows. */
export function shownRows(w: Windowed, laid: readonly LaidGroup[]): LaidRow[] {
  return w.units
    .slice(w.plan.from, w.plan.to)
    .flatMap(u => {
      if (u.kind === 'head') return [laid[u.section]?.head].filter(hasStop)
      return u.kind === 'row' ? [laid[u.section]?.rows[u.at]] : []
    })
    .filter((r): r is LaidRow => r !== undefined)
}

/**
 * The rows drawn in full that the ring can stop on: a page of the list, for the keys that move by a page. A group row (issue #256)
 * counts, so a window of folded groups pages by the group rows it shows. The hints count data rows only (`rowsIn`).
 */
export const pageOf = (w: Windowed): number =>
  rowsIn(w.units, w.plan.from, w.plan.to) + w.units.slice(w.plan.from, w.plan.to).filter(u => u.stop === true).length

/**
 * The focus stop of a unit that is out of the window: the one Button, in a Box that has no height and clips. It does what
 * the Button it stands for does, so an Enter that lands before the next drawing still acts.
 */
function stopOf(d: Draw, s: LaidGroup, u: Placed): RenderElement | undefined {
  const row = u.kind === 'row' ? s.rows[u.at] : u.kind === 'head' && hasStop(s.head) ? s.head : undefined
  const more = (u.kind === 'more' || u.kind === 'block') && s.more > 0
  if (row === undefined && !more) return undefined
  return box(
    d.el,
    { height: 0, overflow: 'hidden', flexShrink: 0 },
    button(d.el, {
      key: row?.handle ?? `m${s.index}`,
      plain: true,
      label: row === undefined ? `${s.more} more` : glyphOf(row),
      onPress: row === undefined ? () => d.actions.more(s.spec.id) : () => d.actions.enter(row.row.id),
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
    if (g !== undefined && s.head !== undefined) {
      // A foldable group (issue #256): its group row opens the Box. When the window starts inside the group, the Button of the row is a
      // stop before the window (`lead`), so the row is drawn as a copy with no Button here, and the Tab order stays.
      const units = shown.get(index) ?? []
      parts.push(groupRowLine(g, d, s.head, !units.some(u => u.kind === 'head')))
      if (first && above > 0) parts.push(hint(d, LESS, above, 'above'))
      for (const u of units) {
        const hold = u.kind === 'row' ? s.rows[u.at] : undefined
        if (u.kind === 'empty') {
          const e = emptyOf(d, s)
          if (e !== null) parts.push(e)
        } else if (hold !== undefined) parts.push(...rowParts(d, g, hold))
        else if (u.kind === 'more') parts.push(moreRowOf(d, s, g))
      }
    } else if (g === undefined || s.rows.length === 0) {
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
