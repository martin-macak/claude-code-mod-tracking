// The windowed drawing of the pane (issue #109). The engine scrolls a pane tree as a whole, so a tree taller than the body
// loses its footer, its title and its header out of view. When the tree is taller than `bodyRows`, the pane draws only the
// units that fit, with the title and header of the sections that show one, a hint where rows are hidden and the footer,
// and it follows the selected row (window.ts picks the units).
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
import type { LaidRow, LaidSection } from './layout'
import { bareSection, type Draw, headParts, moreRowOf, rowLines, rowParts, type Solving, solving } from './rows'
import { DEFAULT_BODY_COLUMNS, GUTTER, ROW_GAP } from './shape'
import { type Plan, planWindow, rowsIn, type Unit } from './window'

type Kind = 'row' | 'more' | 'block'

/** A unit with what draws it: a row of the section (`at` indexes its laid rows), its "N more" row, or the section itself. */
interface Placed extends Unit {
  readonly kind: Kind
  readonly at: number
}

export interface Windowed {
  readonly plan: Plan
  readonly units: readonly Placed[]
  /** The solved columns of each section that has a row. */
  readonly solved: readonly (Solving | undefined)[]
}

const MORE = '▼'
const LESS = '▲'

/** The title and the header take two lines of a section that has a row. A section with none holds its own lines. */
const CHROME = 2

function unitsOf(d: Draw, laid: readonly LaidSection[]): Pick<Windowed, 'units' | 'solved'> & { chrome: number[] } {
  const units: Placed[] = []
  const chrome: number[] = []
  const solved: (Solving | undefined)[] = []
  laid.forEach((s, section) => {
    if (s.rows.length === 0) {
      const width = d.view.bodyColumns ?? DEFAULT_BODY_COLUMNS
      const empty =
        s.spec.rows.length === 0 && s.spec.empty !== undefined ? wrapRows(normaliseCell(s.spec.empty), width) : 0
      units.push({ section, kind: 'block', at: 0, rows: 0, lines: 1 + empty + (s.more > 0 ? 1 : 0) })
      chrome.push(0)
      solved.push(undefined)
      return
    }
    const g = solving(d, s)
    solved.push(g)
    chrome.push(CHROME)
    for (const [at, r] of s.rows.entries()) {
      units.push({ section, kind: 'row', at, rows: 1, lines: rowLines(d, s, g, r) })
    }
    if (s.more > 0) units.push({ section, kind: 'more', at: 0, rows: 0, lines: 1 })
  })
  return { units, chrome, solved }
}

/**
 * The window over the laid sections, or undefined when every row is drawn: no body height is known, or the tree fits it.
 * The budget is the body less the footer and the gap above it. The focus is the unit of the "N more" row the ring sits
 * on, else the unit of the selected row.
 */
export function windowOf(d: Draw, laid: readonly LaidSection[]): Windowed | undefined {
  const { view } = d
  if (view.bodyRows === undefined) return undefined
  const { units, chrome, solved } = unitsOf(d, laid)
  // The footer takes the same rows with or without the move hint: the table draws it only where it adds no row.
  const budget = view.bodyRows - footerRows(view.footer, view.bodyColumns ?? DEFAULT_BODY_COLUMNS, false) - ROW_GAP
  const find = (pick: (u: Placed, s: LaidSection) => boolean): number =>
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
export function shownRows(w: Windowed, laid: readonly LaidSection[]): LaidRow[] {
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
function stopOf(d: Draw, s: LaidSection, u: Placed): RenderElement | undefined {
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
 * The sections that show a unit, one Box each (the root Box puts a gap between them and the footer). The stops of the
 * units before the window lead the first Box, the stops after it end the last, so the Buttons keep their order. The hint
 * above sits under the header of the first Box, the hint below ends the last.
 */
export function drawWindowed(d: Draw, laid: readonly LaidSection[], w: Windowed): RenderElement[] {
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
  const sections = [...shown.keys()]
  return sections.map((index, i) => {
    const s = laid[index] as LaidSection
    const g = w.solved[index]
    const first = i === 0
    const last = i === sections.length - 1
    const parts: RenderElement[] = first ? [...lead] : []
    if (g === undefined) {
      parts.push(bareSection(d, s))
      if (first && above > 0) parts.push(hint(d, LESS, above, 'above'))
    } else {
      parts.push(...headParts(d, s, g))
      if (first && above > 0) parts.push(hint(d, LESS, above, 'above'))
      for (const u of shown.get(index) ?? []) {
        const r = u.kind === 'row' ? s.rows[u.at] : undefined
        parts.push(...(r !== undefined ? rowParts(d, s, g, r) : [moreRowOf(d, s, g)]))
      }
    }
    if (last && below > 0) parts.push(hint(d, MORE, below, 'below'))
    if (last) parts.push(...tail)
    return box(d.el, { flexDirection: 'column' }, ...parts)
  })
}
