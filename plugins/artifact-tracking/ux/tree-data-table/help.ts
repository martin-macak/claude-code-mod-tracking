// The help view: every key with its label by group, the config file path, the version of the mod and the problems. `h`
// swaps the pane to it and `/track help` prints the same as text (`claude -p` has no pane). Pure: the caller gathers
// the keys, the version and the problems.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10 "Help view". Plan: L6 Task 7, G14 to G16.
// Issue #65: the version line. Issue #105: the compact form fits the body (keys to a line from the width, capped problems).

import type { RenderElement } from 'claude-code'
import type { HelpGroup, HelpModel, PaneKey, SectionSpec, TreeRow } from '../../core/interfaces/view'
import { cellWidth } from '../text/cell-width'
import { wrapRows } from '../text/wrap'
import { box, type TableElements, text } from './el'
import { ROW_GAP } from './shape'

// The title says how to move: Tab, Shift+Tab and the arrows are no footer keys, so the help view is where they are named
// (issue #108). It adds no row, which a short inline pane has none to spare (issue #92).
const PANE_KEYS = 'Pane keys (Tab, Shift+Tab, Up, Down move between rows)'
const ROW_KEYS = 'Row keys (act on the selected row)'

const owns = (rows: readonly TreeRow[], owner: string): boolean =>
  rows.some(r => r.owner === owner || owns(r.children ?? [], owner))

/** A tracker's group title: the titles of the sections it draws rows in, or its id when it draws none. */
function titleOf(owner: string, sections: readonly SectionSpec[]): string {
  const titles = sections.filter(s => owns(s.rows, owner)).map(s => s.title)
  return titles.length > 0 ? titles.join(', ') : owner
}

/** Groups: the core pane keys, the core row keys, then one group per tracker that has keys, in order of first key. */
export function helpModel(
  keys: readonly PaneKey[],
  sections: readonly SectionSpec[],
  configPath: string | undefined,
  problems: readonly string[],
  version?: string,
): HelpModel {
  const owners = [...new Set(keys.filter(k => k.owner !== 'core').map(k => k.owner))]
  const groups: HelpGroup[] = [
    { title: PANE_KEYS, keys: keys.filter(k => k.owner === 'core' && k.scope === 'pane') },
    { title: ROW_KEYS, keys: keys.filter(k => k.owner === 'core' && k.scope === 'row') },
    ...owners.map(owner => ({ title: titleOf(owner, sections), keys: keys.filter(k => k.owner === owner) })),
  ]
  return { groups: groups.filter(g => g.keys.length > 0), configPath, problems, version }
}

const configLine = (path: string | undefined) =>
  path === undefined ? 'Config file: none, the defaults apply' : `Config file: ${path}`

const versionLine = (version: string) => `Version: ${version}`

/** The help view as plain text, one line each. */
export function helpText(m: HelpModel): string {
  return [
    ...m.groups.flatMap(g => [g.title, ...g.keys.map(k => `  ${k.key}  ${k.label}`)]),
    configLine(m.configPath),
    ...(m.version === undefined ? [] : [versionLine(m.version)]),
    ...(m.problems.length > 0 ? ['Problems', ...m.problems.map(p => `  ${p}`)] : []),
  ].join('\n')
}

/**
 * Keys to a line in the compact form, the cells between them and the indent of a key line. The compact form starts with
 * `PER_LINE` keys to a line, so the columns read well. A body too short for that takes more keys to a line (`compactForm`).
 * At 100x40 inline the body holds 11 rows. With the footer, the config line (two rows for a long path), the version line
 * and the three groups of a started mod (core pane keys, core row keys, the row keys of one tracker), three keys to a line
 * fill it exactly and leave no row for a problem. Two keys to a line do not fit: `Pane keys` scrolls out of view (issue #92).
 */
const PER_LINE = 3
const KEY_GAP = 2
const KEY_INDENT = 2

const keyText = (k: PaneKey): string => `${k.key}${' '.repeat(KEY_GAP)}${k.label}`

/**
 * The rows of the full form in a body `columns` wide: every line `helpText` prints, each as many rows as it takes.
 * The count reads those lines, not a copy of how they are made, so a line added to the help view counts with no edit here.
 */
export function helpRows(m: HelpModel, columns: number): number {
  return helpText(m)
    .split('\n')
    .reduce((n, line) => n + wrapRows(line, columns), 0)
}

/**
 * Whether the help view must take the compact form: the full form, the gap and the footer need more than `bodyRows`.
 * The engine keeps the focused footer Button in view, so a view that is too tall opens scrolled and hides its first
 * lines. With no `bodyRows` (a surface that gives none) the full form stays.
 */
export function compactHelp(m: HelpModel, footerRows: number, columns: number, bodyRows: number | undefined): boolean {
  return bodyRows !== undefined && helpRows(m, columns) + ROW_GAP + footerRows > bodyRows
}

/**
 * How the compact form is drawn: the keys to a line and how many problems it names. It names the first `problems` and counts
 * the rest, with the place to read them (`/track help` prints every problem).
 */
export interface CompactForm {
  readonly perLine: number
  readonly problems: number
}

/** The line that counts the problems the view does not name and says where to read them. It says `more` only after a named problem. */
const hiddenText = (count: number, more: boolean): string =>
  `${count}${more ? ' more' : ''} ${count === 1 ? 'problem' : 'problems'}: /track help`

/** The rows the problems take when the compact form names the first `named`: the title and the named ones, then the count. */
function problemRows(m: HelpModel, columns: number, named: number): number {
  if (m.problems.length === 0) return 0
  const hidden = m.problems.length - named
  const count = hidden > 0 ? wrapRows(hiddenText(hidden, named > 0), columns) : 0
  if (named === 0) return count
  return 1 + m.problems.slice(0, named).reduce((n, p) => n + wrapRows(p, columns), 0) + count
}

/**
 * The rows of the compact form in a body `columns` wide, in the same terms as `helpRows`: a title takes as many rows as it
 * wraps to, a line of keys takes one, a config line or a problem takes the rows it wraps to.
 */
export function compactRows(m: HelpModel, columns: number, form: CompactForm): number {
  const named = Math.min(form.problems, m.problems.length)
  const groups = m.groups.reduce((n, g) => n + wrapRows(g.title, columns) + Math.ceil(g.keys.length / form.perLine), 0)
  const lines =
    wrapRows(configLine(m.configPath), columns) +
    (m.version === undefined ? 0 : wrapRows(versionLine(m.version), columns))
  return groups + lines + problemRows(m, columns, named)
}

/** The widest `key  label` text of the help view: the cells of one column of keys. */
const widestKey = (m: HelpModel): number =>
  Math.max(0, ...m.groups.flatMap(g => g.keys.map(k => cellWidth(keyText(k)))))

/**
 * The compact form for a body `columns` wide and `bodyRows` rows, with a footer of `footerRows`. `undefined` means the
 * full form (`compactHelp`). The compact form must fit, so `Pane keys` and the footer stay in view:
 * - It starts with `PER_LINE` keys to a line, fewer when a longer key would wrap a narrow body.
 * - When the keys, the config lines and one count line do not fit, it takes one more key to a line, up to as many as the
 *   width holds.
 * - It names as many problems as the rows left hold and counts the rest. It names all of them when they fit. The cap is
 *   the body, not a number: the /track text names 10 (spec C6), and no body of 11 rows holds 10 with the keys.
 * A body too short for even that takes the form with the fewest rows (the widest line of keys, with the count line), so the
 * least of the top scrolls out: the view opens scrolled to the footer.
 */
export function compactForm(
  m: HelpModel,
  footerRows: number,
  columns: number,
  bodyRows: number | undefined,
): CompactForm | undefined {
  if (bodyRows === undefined || !compactHelp(m, footerRows, columns, bodyRows)) return undefined
  const most = Math.max(1, Math.floor((columns - KEY_INDENT + KEY_GAP) / (widestKey(m) + KEY_GAP)))
  const first = Math.min(PER_LINE, most)
  const fits = (perLine: number, problems: number): boolean =>
    compactRows(m, columns, { perLine, problems }) + footerRows <= bodyRows
  let tightest = { perLine: first, rows: Number.POSITIVE_INFINITY }
  for (let perLine = first; perLine <= most; perLine++) {
    if (fits(perLine, 0)) {
      let problems = m.problems.length
      while (!fits(perLine, problems)) problems--
      return { perLine, problems }
    }
    const rows = compactRows(m, columns, { perLine, problems: 0 })
    if (rows < tightest.rows) tightest = { perLine, rows }
  }
  return { perLine: tightest.perLine, problems: 0 }
}

/**
 * The compact form of one group's keys: `perLine` keys to a line. Every key but the last column sits in a column
 * `width` cells wide, so each column starts in the same cell on every line.
 */
function keyLines(el: TableElements, keys: readonly PaneKey[], width: number, perLine: number): RenderElement[] {
  const lines: RenderElement[] = []
  for (let i = 0; i < keys.length; i += perLine) {
    const cells = keys
      .slice(i, i + perLine)
      .map((k, column) =>
        column < perLine - 1 ? box(el, { width }, text(el, {}, keyText(k))) : text(el, {}, keyText(k)),
      )
    lines.push(box(el, { paddingLeft: KEY_INDENT, columnGap: KEY_GAP }, ...cells))
  }
  return lines
}

/** The problems: a bold title and every one in the full form. The compact form names the first `form.problems` and counts the rest. */
function problemLines(el: TableElements, m: HelpModel, form: CompactForm | undefined): RenderElement[] {
  if (m.problems.length === 0) return []
  const named = form === undefined ? m.problems.length : Math.min(form.problems, m.problems.length)
  const hidden = m.problems.length - named
  return [
    ...(named > 0 ? [text(el, { weight: 'bold' }, 'Problems')] : []),
    ...m.problems.slice(0, named).map(p => text(el, { wrap: 'wrap' }, p)),
    ...(hidden > 0 ? [text(el, { wrap: 'wrap' }, hiddenText(hidden, named > 0))] : []),
  ]
}

/**
 * The help view as elements: a bold title per group, one two-column row per key, the config line and the problems.
 * `compact` takes the compact form, so the view takes fewer rows: a `CompactForm` (from `compactForm`) says how many keys to
 * a line and how many problems. Both forms draw every key.
 */
export function renderHelp(
  el: TableElements,
  m: HelpModel,
  compact: CompactForm | false = false,
): readonly RenderElement[] {
  const form = compact === false ? undefined : compact
  const width = widestKey(m)
  return [
    ...m.groups.flatMap(g => [
      text(el, { weight: 'bold' }, g.title),
      ...(form
        ? keyLines(el, g.keys, width, form.perLine)
        : g.keys.map(k =>
            box(el, { paddingLeft: KEY_INDENT, columnGap: KEY_GAP }, text(el, {}, k.key), text(el, {}, k.label)),
          )),
    ]),
    text(el, {}, configLine(m.configPath)),
    ...(m.version === undefined ? [] : [text(el, {}, versionLine(m.version))]),
    ...problemLines(el, m, form),
  ]
}
