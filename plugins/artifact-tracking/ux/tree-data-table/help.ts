// The help view: every key with its label by group, the config file path and the problems. `h` swaps the pane to it and
// `/track help` prints the same as text (`claude -p` has no pane). Pure: the caller gathers the keys and the problems.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10 "Help view". Plan: L6 Task 7, G14 to G16.

import type { RenderElement } from 'claude-code'
import type { HelpGroup, HelpModel, PaneKey, SectionSpec, TreeRow } from '../../core/interfaces/view'
import { box, type TableElements, text } from './el'

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
): HelpModel {
  const owners = [...new Set(keys.filter(k => k.owner !== 'core').map(k => k.owner))]
  const groups: HelpGroup[] = [
    { title: PANE_KEYS, keys: keys.filter(k => k.owner === 'core' && k.scope === 'pane') },
    { title: ROW_KEYS, keys: keys.filter(k => k.owner === 'core' && k.scope === 'row') },
    ...owners.map(owner => ({ title: titleOf(owner, sections), keys: keys.filter(k => k.owner === owner) })),
  ]
  return { groups: groups.filter(g => g.keys.length > 0), configPath, problems }
}

const configLine = (path: string | undefined) =>
  path === undefined ? 'Config file: none, the defaults apply' : `Config file: ${path}`

/** The help view as plain text, one line each. */
export function helpText(m: HelpModel): string {
  return [
    ...m.groups.flatMap(g => [g.title, ...g.keys.map(k => `  ${k.key}  ${k.label}`)]),
    configLine(m.configPath),
    ...(m.problems.length > 0 ? ['Problems', ...m.problems.map(p => `  ${p}`)] : []),
  ].join('\n')
}

/** The help view as elements: a bold title per group, one two-column row per key, the config line and the problems. */
export function renderHelp(el: TableElements, m: HelpModel): readonly RenderElement[] {
  return [
    ...m.groups.flatMap(g => [
      text(el, { weight: 'bold' }, g.title),
      ...g.keys.map(k => box(el, { paddingLeft: 2, columnGap: 2 }, text(el, {}, k.key), text(el, {}, k.label))),
    ]),
    text(el, {}, configLine(m.configPath)),
    ...(m.problems.length > 0
      ? [text(el, { weight: 'bold' }, 'Problems'), ...m.problems.map(p => text(el, { wrap: 'wrap' }, p))]
      : []),
  ]
}
