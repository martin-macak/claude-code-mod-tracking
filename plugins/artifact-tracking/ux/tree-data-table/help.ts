// The help view: every key with its label by group, the config file path, the version of the mod and the problems. `h`
// swaps the pane to it and `/track help` prints the same as text (`claude -p` has no pane). Pure: the caller gathers
// the keys, the version and the problems.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10 "Help view". Plan: L6 Task 7, G14 to G16.
// Issue #65: the version line.

import type { RenderElement } from 'claude-code'
import type { HelpGroup, HelpModel, PaneKey, SectionSpec, TreeRow } from '../../core/interfaces/view'
import { cellWidth } from '../text/cell-width'
import { box, type TableElements, text } from './el'
import { ROW_GAP } from './shape'

const PANE_KEYS = 'Pane keys'
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
 * Keys to a line in the compact form, the cells between them and the indent of a key line. The body of a short inline
 * pane (100x40) holds 11 rows. With the footer, the config line (two rows for a long path), the version line and the
 * three groups of a started mod (core pane keys, core row keys, the row keys of one tracker), three keys to a line fill
 * it exactly.
 * Two keys to a line do not fit: `Pane keys` scrolls out of view (issue #92).
 */
const PER_LINE = 3
const KEY_GAP = 2
const KEY_INDENT = 2

const keyText = (k: PaneKey): string => `${k.key}${' '.repeat(KEY_GAP)}${k.label}`

/**
 * The rows a line takes in a body `columns` wide. The engine wraps a Text with no `wrap` at spaces and breaks a word
 * longer than a row. A long config path moves to its own row after `Config file:`, so the count must see words.
 */
function rowsOf(line: string, columns: number): number {
  const width = Math.max(1, columns)
  let rows = 1
  let used = 0
  for (const word of line.split(' ')) {
    const cells = cellWidth(word)
    if (used === 0 || used + 1 + cells > width) {
      if (used > 0) rows++
      used = cells
    } else {
      used += 1 + cells
    }
    while (used > width) {
      rows++
      used -= width
    }
  }
  return rows
}

/**
 * The rows of the full form in a body `columns` wide: every line `helpText` prints, each as many rows as it takes.
 * The count reads those lines, not a copy of how they are made, so a line added to the help view counts with no edit here.
 */
export function helpRows(m: HelpModel, columns: number): number {
  return helpText(m)
    .split('\n')
    .reduce((n, line) => n + rowsOf(line, columns), 0)
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
 * The compact form of one group's keys: `PER_LINE` keys to a line. Every key but the last column sits in a column
 * `width` cells wide, so each column starts in the same cell on every line.
 */
function keyLines(el: TableElements, keys: readonly PaneKey[], width: number): RenderElement[] {
  const lines: RenderElement[] = []
  for (let i = 0; i < keys.length; i += PER_LINE) {
    const cells = keys
      .slice(i, i + PER_LINE)
      .map((k, column) =>
        column < PER_LINE - 1 ? box(el, { width }, text(el, {}, keyText(k))) : text(el, {}, keyText(k)),
      )
    lines.push(box(el, { paddingLeft: KEY_INDENT, columnGap: KEY_GAP }, ...cells))
  }
  return lines
}

/**
 * The help view as elements: a bold title per group, one two-column row per key, the config line and the problems.
 * `compact` puts three keys on a line, so the view takes fewer rows. Both forms draw every key.
 */
export function renderHelp(el: TableElements, m: HelpModel, compact = false): readonly RenderElement[] {
  const width = Math.max(0, ...m.groups.flatMap(g => g.keys.map(k => cellWidth(keyText(k)))))
  return [
    ...m.groups.flatMap(g => [
      text(el, { weight: 'bold' }, g.title),
      ...(compact
        ? keyLines(el, g.keys, width)
        : g.keys.map(k =>
            box(el, { paddingLeft: KEY_INDENT, columnGap: KEY_GAP }, text(el, {}, k.key), text(el, {}, k.label)),
          )),
    ]),
    text(el, {}, configLine(m.configPath)),
    ...(m.version === undefined ? [] : [text(el, {}, versionLine(m.version))]),
    ...(m.problems.length > 0
      ? [text(el, { weight: 'bold' }, 'Problems'), ...m.problems.map(p => text(el, { wrap: 'wrap' }, p))]
      : []),
  ]
}
