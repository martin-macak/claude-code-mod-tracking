// The plan view (issue #199): the plan of `/track clean` in the slot of the help view. The pane shows the same typed lines that the
// command prints (`planLines`), cut to the rows of the body by `fitPlan`. A tall body shows every line, so its text is the reply of
// the command. A short body, such as the 11 rows of an inline pane at 100x40, keeps what the person needs to act: the title, every
// head (each kind head names the `/track clean --yes <kind>` that applies it), the first step of each kind and a count line that
// says how many steps the cut left out and where the full list is. Pure: it counts rows with `wrapRows`, as the help view does.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10 "Footer" and 5.12. Design study: issue #199, section 5.

import type { RenderElement } from 'claude-code'
import type { PlanLine } from '../../core/interfaces/clean'
import { normaliseCell } from '../text/cell-width'
import { wrapRowsIndented } from '../text/wrap'
import { box, type TableElements, text } from './el'
import { ROW_GAP } from './shape'

/** The end of the count line of a cut: it tells where the full list is. A head already names the `--yes` of its kind. */
export const MORE_SUFFIX = ': /track clean'

/**
 * The rows a line takes in a body `columns` wide, as the engine wraps it. The text of a step or a problem comes from outside (a
 * process name, a path, the message of a tracker that failed), so a tab, a carriage return or an escape byte becomes a space
 * first (`normaliseCell`), as everywhere in the pane: the count and the drawing read the same string. A blank line takes one row.
 */
const lineRows = (l: PlanLine, columns: number): number => wrapRowsIndented(normaliseCell(l.text), columns)

/** The rows of the lines in a body `columns` wide. */
export const planRows = (lines: readonly PlanLine[], columns: number): number =>
  lines.reduce((n, l) => n + lineRows(l, columns), 0)

/** One kind in the plan: the steps under its head, and the count line that the plan itself put after them, if it did. */
interface Run {
  /** The steps. A step is its first line and the lines that continue it (`PlanLine.cont`). */
  readonly steps: readonly (readonly PlanLine[])[]
  readonly more: PlanLine | undefined
}

/** A plain line of the plan, or the run of steps that follows a head. */
type Part = { readonly line: PlanLine } | { readonly run: Run }

/** The lines as parts: the steps that follow each other become one run, with the count line of the plan if one follows them. */
function partsOf(lines: readonly PlanLine[]): Part[] {
  const parts: Part[] = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as PlanLine
    if (l.role !== 'step') {
      parts.push({ line: l })
      continue
    }
    const steps: PlanLine[][] = []
    for (; lines[i]?.role === 'step'; i++) {
      const step = lines[i] as PlanLine
      const last = steps.at(-1)
      if (step.cont === true && last !== undefined) last.push(step)
      else steps.push([step])
    }
    const next = lines[i]
    const more = next?.role === 'more' ? next : undefined
    if (more === undefined) i--
    parts.push({ run: { steps, more } })
  }
  return parts
}

/** The count line of a cut: `and 3 more: /track clean` after some steps, `14 steps: /track clean` when the cut shows none of the kind. */
const countLine = (count: number, shown: number): PlanLine => ({
  role: 'more',
  text: shown > 0 ? `  and ${count} more${MORE_SUFFIX}` : `  ${count} ${count === 1 ? 'step' : 'steps'}${MORE_SUFFIX}`,
  count,
})

/**
 * The parts with the first `shown[r]` steps of each run `r`. A run that shows fewer steps than it has ends in a count line for
 * the steps left out and the steps that the plan itself left out. A run that shows all of them keeps the count line of the plan.
 */
function compose(parts: readonly Part[], shown: readonly number[]): PlanLine[] {
  let r = 0
  return parts.flatMap(part => {
    if ('line' in part) return [part.line]
    const { steps, more } = part.run
    const n = shown[r++] as number
    const left = steps.length - n
    const tail = left > 0 ? [countLine(left + (more?.count ?? 0), n)] : more === undefined ? [] : [more]
    return [...steps.slice(0, n).flat(), ...tail]
  })
}

/**
 * The lines of `lines` that fit `rows` rows of a body `columns` wide, in the order of the plan.
 * - All the lines, when they fit.
 * - Else the lines with no blank line and no hint, when those fit.
 * - Else the title, every head and every problem, and the steps of each kind from the start, as many as fit, in the order of the
 *   plan: a kind that is cut ends in a count line. The first step of each kind stays while it fits. When the first steps do not
 *   fit, they go from the last kind to the first, and the count line of the kind says how many steps it holds.
 *
 * It never drops the title, a head, a problem or a count line, so a body too short for that draws more than `rows` rows, and the
 * view opens scrolled to the footer as the compact help form does. It adds no line but the count line, so a kind that a module
 * adds later goes through.
 */
export function fitPlan(lines: readonly PlanLine[], rows: number, columns: number): readonly PlanLine[] {
  if (planRows(lines, columns) <= rows) return lines
  const dense = lines.filter(l => l.role !== 'blank' && l.role !== 'hint')
  if (planRows(dense, columns) <= rows) return dense
  const parts = partsOf(dense)
  const runs = parts.flatMap(p => ('run' in p ? [p.run] : []))
  const shown = runs.map(() => 1)
  const fitsNow = (): boolean => planRows(compose(parts, shown), columns) <= rows
  // The first step of each kind goes last kind first when the heads, the problems and the counts leave no room for all of them.
  for (let r = runs.length - 1; r >= 0 && !fitsNow(); r--) shown[r] = 0
  growing: for (const [r, run] of runs.entries()) {
    while ((shown[r] as number) < run.steps.length) {
      shown[r] = (shown[r] as number) + 1
      if (!fitsNow()) {
        shown[r] = (shown[r] as number) - 1
        break growing // the room goes to the steps in the order of the plan: the kinds after this one keep their first step
      }
    }
  }
  return compose(parts, shown)
}

/**
 * What the plan view draws in a body of `bodyRows` rows under a footer of `footer` rows: the lines, and whether the gap row between
 * them and the footer stays. A plan that fits whole keeps the gap. A cut plan has none, as the compact help form has none: the
 * row goes to the plan. No body height known: every line, with the gap.
 */
export function shapePlan(
  lines: readonly PlanLine[],
  footer: number,
  columns: number,
  bodyRows: number | undefined,
): { readonly lines: readonly PlanLine[]; readonly gap: boolean } {
  if (bodyRows === undefined || planRows(lines, columns) + ROW_GAP + footer <= bodyRows) return { lines, gap: true }
  return { lines: fitPlan(lines, bodyRows - footer, columns), gap: false }
}

/**
 * The lines as elements: a wrapped Text each, the title and the heads bold, the hints dim, and a blank line as a Box of one row.
 * The words go through `normaliseCell`, as `planRows` counts them: no control character reaches the engine.
 */
export function renderPlan(el: TableElements, lines: readonly PlanLine[]): readonly RenderElement[] {
  return lines.map(l => {
    if (l.role === 'blank') return box(el, { height: 1 })
    const words = normaliseCell(l.text)
    if (l.role === 'title' || l.role === 'head') return text(el, { weight: 'bold', wrap: 'wrap' }, words)
    if (l.role === 'hint') return text(el, { dimColor: true, wrap: 'wrap' }, words)
    return text(el, { wrap: 'wrap' }, words)
  })
}
