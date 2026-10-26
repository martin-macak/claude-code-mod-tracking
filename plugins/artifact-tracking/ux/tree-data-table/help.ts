// The help view: every key with its label by group, the config file path, the version of the mod and the problems. `h`
// swaps the pane to it and `/track help` prints the same as text (`claude -p` has no pane). Pure: the caller gathers
// the keys, the version and the problems.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10 "Help view". Plan: L6 Task 7, G14 to G16.
// Issue #65: the version line. Issue #105: the compact form fits the body (keys to a line from the width, capped problems).
// Issue #144: the config keeps the first 50 problems and the model counts the rest (`moreProblems`), so every form says how many.

import type { RenderElement } from 'claude-code'
import type { GroupSpec, HelpGroup, HelpModel, PaneKey, TreeRow } from '../../core/interfaces/view'
import { cellWidth } from '../text/cell-width'
import { wrapRows } from '../text/wrap'
import { box, type TableElements, text } from './el'
import { ROW_GAP } from './shape'

// The title says how to move: Tab, Shift+Tab and the arrows are no footer keys, so the help view is where they are named
// (issue #108). It adds no row, which a short inline pane has none to spare (issue #92).
const PANE_KEYS = 'Pane keys (Tab, Shift+Tab, Up, Down move between rows)'
const ROW_KEYS = 'Row keys (act on the selected or marked rows)'

const owns = (rows: readonly TreeRow[], owner: string): boolean =>
  rows.some(r => r.owner === owner || owns(r.children ?? [], owner))

/** What the help view reads of a group: its title and its rows. A section of a tracker has both. */
type Titled = Pick<GroupSpec, 'title' | 'rows'>

/** A tracker's group title: the titles of the groups it draws rows in, or its id when it draws none. */
function titleOf(owner: string, groups: readonly Titled[]): string {
  const titles = groups.filter(g => owns(g.rows, owner)).map(g => g.title)
  return titles.length > 0 ? titles.join(', ') : owner
}

/**
 * Groups: the core pane keys, the core row keys, then one group per tracker that has keys, in order of first key.
 * `moreProblems` says how many problems the config left out of `problems`, with the line that counts them (issue #144).
 */
export function helpModel(
  keys: readonly PaneKey[],
  drawn: readonly Titled[],
  configPath: string | undefined,
  problems: readonly string[],
  version?: string,
  moreProblems?: HelpModel['moreProblems'],
): HelpModel {
  const owners = [...new Set(keys.filter(k => k.owner !== 'core').map(k => k.owner))]
  const groups: HelpGroup[] = [
    { title: PANE_KEYS, keys: keys.filter(k => k.owner === 'core' && k.scope === 'pane') },
    { title: ROW_KEYS, keys: keys.filter(k => k.owner === 'core' && k.scope === 'row') },
    ...owners.map(owner => ({ title: titleOf(owner, drawn), keys: keys.filter(k => k.owner === owner) })),
  ]
  return { groups: groups.filter(g => g.keys.length > 0), configPath, problems, version, moreProblems }
}

/** How many problems the config left out of the model's list. */
const leftOut = (m: HelpModel): number => m.moreProblems?.count ?? 0

const configLine = (path: string | undefined) =>
  path === undefined ? 'Config file: none, the defaults apply' : `Config file: ${path}`

const versionLine = (version: string) => `Version: ${version}`

/** The lines of the problems: each one, then the count line of the ones the config left out. */
const problemList = (m: HelpModel): string[] => [
  ...m.problems,
  ...(m.moreProblems !== undefined && leftOut(m) > 0 ? [m.moreProblems.line] : []),
]

/**
 * The help view as plain text, one line each. It lists the problems of its model: the config keeps the first 50, so a
 * long list ends in one line that counts the rest and names the debug log (issue #144).
 */
export function helpText(m: HelpModel): string {
  const problems = problemList(m)
  return [
    ...m.groups.flatMap(g => [g.title, ...g.keys.map(k => `  ${k.key}  ${k.label}`)]),
    configLine(m.configPath),
    ...(m.version === undefined ? [] : [versionLine(m.version)]),
    ...(problems.length > 0 ? ['Problems', ...problems.map(p => `  ${p}`)] : []),
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
 * the rest, the ones the config left out too, with the place to read them (`/track help` prints the first 50).
 */
export interface CompactForm {
  /**
   * The width of the body in cells that the form was made for. `compactRows` and `renderHelp` read it, so the rows that the form
   * counts are the rows that it draws: a caller cannot draw a form made at 96 cells in another width (issue #105).
   */
  readonly columns: number
  readonly perLine: number
  readonly problems: number
  /**
   * The width in cells that the groups of the trackers share rows for. Set: a group of a tracker (not of the core) whose title
   * and keys fit one row of that width is drawn on that row, `Notes  c  copy  f  find`. The search sets it only when no form
   * with every group on rows of its own fits, so a view that fitted before looks the same (issue #71: the fourth group of keys,
   * the copy key of the questions tracker, no longer fitted the 11-row body of an inline pane).
   */
  readonly merge?: number
}

/** The line that counts the problems the view does not name and says where to read them. It says `more` only after a named problem. */
const hiddenText = (count: number, more: boolean): string =>
  `${count}${more ? ' more' : ''} ${count === 1 ? 'problem' : 'problems'}: /track help`

/** `rows[k]` is the rows the first `k` problems take, each as many as it wraps to. One pass: the search for the cap reads it. */
function problemWraps(m: HelpModel, columns: number): readonly number[] {
  const rows = [0]
  for (const p of m.problems) rows.push((rows.at(-1) as number) + wrapRows(p, columns))
  return rows
}

/** The problems the compact form does not name: the unnamed ones of the list and the ones the config left out. */
const hiddenOf = (m: HelpModel, named: number): number => m.problems.length - named + leftOut(m)

/** The rows the problems take when the compact form names the first `named`: the title and the named ones, then the count. */
function problemRows(m: HelpModel, columns: number, wraps: readonly number[], named: number): number {
  const hidden = hiddenOf(m, named)
  if (m.problems.length + leftOut(m) === 0) return 0
  const count = hidden > 0 ? wrapRows(hiddenText(hidden, named > 0), columns) : 0
  if (named === 0) return count
  return 1 + (wraps[named] as number) + count
}

/** The width of one `key  label` line of a group: the keys side by side, `KEY_GAP` apart, after the title and one gap. */
const sharedWidth = (g: HelpGroup): number =>
  cellWidth(g.title) + g.keys.reduce((n, k) => n + KEY_GAP + cellWidth(keyText(k)), 0)

/** True when the group of a tracker fits one row of `columns` cells with its title: the shared form draws it there. */
const sharesRow = (g: HelpGroup, columns: number): boolean =>
  g.keys.length > 0 && g.keys.every(k => k.owner !== 'core') && sharedWidth(g) <= columns

/** The rows of everything but the problems in the compact form: the titles, the lines of keys, the config and version lines. */
function listRows(m: HelpModel, columns: number, perLine: number, merge = false): number {
  const groups = m.groups.reduce(
    (n, g) =>
      n +
      (merge && sharesRow(g, columns)
        ? 1
        : wrapRows(g.title, columns) + Math.ceil(g.keys.length / columnsOf(m, g, columns, perLine).per)),
    0,
  )
  const lines =
    wrapRows(configLine(m.configPath), columns) +
    (m.version === undefined ? 0 : wrapRows(versionLine(m.version), columns))
  return groups + lines
}

/**
 * The rows of the compact form in the body width that it was made for (`form.columns`), in the same terms as `helpRows`: a title
 * takes as many rows as it wraps to, a line of keys takes one, a config line or a problem takes the rows it wraps to.
 */
export function compactRows(m: HelpModel, form: CompactForm): number {
  const { columns } = form
  const named = Math.min(form.problems, m.problems.length)
  return (
    listRows(m, columns, form.perLine, form.merge !== undefined) +
    problemRows(m, columns, problemWraps(m, columns), named)
  )
}

/** The widest `key  label` text of a group: the cells of one column of its keys. */
const widestOf = (g: HelpGroup): number => Math.max(0, ...g.keys.map(k => cellWidth(keyText(k))))

/** The widest `key  label` text of the help view: the cells of one column of keys. */
const widestKey = (m: HelpModel): number => Math.max(0, ...m.groups.map(widestOf))

/** How many keys a line of `columns` cells holds, with columns `width` cells wide. */
const holds = (width: number, columns: number): number =>
  Math.max(1, Math.floor((columns - KEY_INDENT + KEY_GAP) / (width + KEY_GAP)))

/**
 * How the keys of a group run when the form asks for `perLine`: the cells of a column, and the keys to a line. Up to what the
 * widest key of the view holds, every group uses that width and takes `perLine`, so the columns of all groups line up. Asked
 * for more, a group takes its own widest key as its column and holds as many as that gives, never more than `perLine`: the
 * row keys (`m  mark`, `x  dismiss`) are shorter than the pane keys (`t  touched only`), so six of them fit a line of the body
 * where five of the pane keys do (issue #138: the sixth row key must not take a second line).
 */
function columnsOf(
  m: HelpModel,
  g: HelpGroup,
  columns: number,
  perLine: number,
): { readonly width: number; readonly per: number } {
  const all = widestKey(m)
  if (perLine <= holds(all, columns)) return { width: all, per: perLine }
  const own = widestOf(g)
  return { width: own, per: Math.min(perLine, holds(own, columns)) }
}

/**
 * The compact form for a body `columns` wide and `bodyRows` rows, with a footer of `footerRows`. `undefined` means the
 * full form (`compactHelp`). The compact form must fit, so `Pane keys` and the footer stay in view:
 * - It starts with `PER_LINE` keys to a line, fewer when a longer key would wrap a narrow body.
 * - When the keys, the config lines and one count line do not fit, it takes one more key to a line, up to as many as the
 *   width holds for the group of the shortest keys (`columnsOf`: a group never takes more than its own widest key holds).
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
  const most = Math.max(1, ...m.groups.map(g => holds(widestOf(g), columns)))
  const first = Math.min(PER_LINE, holds(widestKey(m), columns)) // the start does not depend on the shorter keys of a group
  // The rows of every prefix of the problems are counted once: a malformed config gives one problem per unknown key, with no
  // limit, and the search below asks for the rows of many candidates (a rescan of the named problems for each is quadratic).
  const wraps = problemWraps(m, columns)
  // The rows of the keys, titles and config lines (`list`) do not depend on the problems that the form names, so each form
  // counts them once and the cap loop adds only the rows of the problems (`columnsOf` makes a count of them dear).
  const fits = (list: number, problems: number): boolean =>
    list + problemRows(m, columns, wraps, problems) + footerRows <= bodyRows
  let tightest = { perLine: first, rows: Number.POSITIVE_INFINITY }
  for (let perLine = first; perLine <= most; perLine++) {
    const list = listRows(m, columns, perLine)
    if (fits(list, 0)) {
      let problems = m.problems.length
      while (!fits(list, problems)) problems--
      return { columns, perLine, problems }
    }
    const rows = list + problemRows(m, columns, wraps, 0)
    if (rows < tightest.rows) tightest = { perLine, rows }
  }
  // No form with every group on rows of its own fits. The groups of the trackers may share their rows with their titles.
  for (let perLine = first; perLine <= most; perLine++) {
    const list = listRows(m, columns, perLine, true)
    if (!fits(list, 0)) continue
    let problems = m.problems.length
    while (!fits(list, problems)) problems--
    return { columns, perLine, problems, merge: columns }
  }
  return { columns, perLine: tightest.perLine, problems: 0 }
}

/**
 * The compact form of one group's keys: `perLine` keys to a line. Every key but the last column sits in a column
 * `width` cells wide, so each column starts in the same cell on every line.
 */
function keyLines(
  el: TableElements,
  keys: readonly PaneKey[],
  { width, per: perLine }: { readonly width: number; readonly per: number },
): RenderElement[] {
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

/**
 * The problems: a bold title and every one in the full form, then the count line of the ones the config left out. The
 * compact form names the first `form.problems` and counts the rest.
 */
function problemLines(el: TableElements, m: HelpModel, form: CompactForm | undefined): RenderElement[] {
  if (m.problems.length + leftOut(m) === 0) return []
  if (form === undefined)
    return [text(el, { weight: 'bold' }, 'Problems'), ...problemList(m).map(p => text(el, { wrap: 'wrap' }, p))]
  const named = Math.min(form.problems, m.problems.length)
  const hidden = hiddenOf(m, named)
  return [
    ...(named > 0 ? [text(el, { weight: 'bold' }, 'Problems')] : []),
    ...m.problems.slice(0, named).map(p => text(el, { wrap: 'wrap' }, p)),
    ...(hidden > 0 ? [text(el, { wrap: 'wrap' }, hiddenText(hidden, named > 0))] : []),
  ]
}

/**
 * The help view as elements: a bold title per group, one two-column row per key, the config line and the problems.
 * `compact` takes the compact form, so the view takes fewer rows: a `CompactForm` (from `compactForm`) says how many keys to
 * a line and how many problems. Both forms draw every key. The form carries the body width it was made for (`form.columns`): a
 * group never takes more keys to a line than its columns hold in it.
 */
export function renderHelp(
  el: TableElements,
  m: HelpModel,
  compact: CompactForm | false = false,
): readonly RenderElement[] {
  const form = compact === false ? undefined : compact
  const shared = (g: HelpGroup): boolean => form?.merge !== undefined && sharesRow(g, form.merge)
  return [
    ...m.groups.flatMap(g =>
      shared(g)
        ? [
            box(
              el,
              { columnGap: KEY_GAP },
              text(el, { weight: 'bold' }, g.title),
              ...g.keys.map(k => text(el, {}, keyText(k))),
            ),
          ]
        : [
            text(el, { weight: 'bold' }, g.title),
            ...(form
              ? keyLines(el, g.keys, columnsOf(m, g, form.columns, form.perLine))
              : g.keys.map(k =>
                  box(el, { paddingLeft: KEY_INDENT, columnGap: KEY_GAP }, text(el, {}, k.key), text(el, {}, k.label)),
                )),
          ],
    ),
    text(el, {}, configLine(m.configPath)),
    ...(m.version === undefined ? [] : [text(el, {}, versionLine(m.version))]),
    ...problemLines(el, m, form),
  ]
}
