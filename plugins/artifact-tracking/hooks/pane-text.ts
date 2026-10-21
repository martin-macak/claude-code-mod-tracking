// The host contract of the pane and the text the pane's data makes: the list `/track` prints and the help view as text.
// Both read the sections the pane draws (`paneData`) with nothing selected, so the text and the pane never differ in
// content. PaneHost is what the pane session needs of the LifecycleManager; the manager fits it as it is.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.10 and 5.12. Plan: L6 Task 11, G14, G15.

import type { KeyRegistry } from '../core/infra/keys'
import type { ConfigSource } from '../core/interfaces/config'
import type { Level } from '../core/interfaces/items'
import type { Ports } from '../core/interfaces/ports'
import type { FooterKey, HelpModel, PaneView, RowRef, SectionSpec, TreeRow } from '../core/interfaces/view'
import { helpModel, helpText } from '../ux/tree-data-table/help'
import { sectionsText } from '../ux/tree-data-table/text'

/** What the pane session calls on the LifecycleManager. */
export interface PaneHost {
  entry(p: Ports): Promise<void>
  paneData(p: Ports, view: PaneView): Promise<readonly SectionSpec[]>
  footer(p: Ports, row: RowRef | undefined, help: boolean): Promise<readonly FooterKey[]>
  dismiss(p: Ports, ids: readonly string[]): Promise<void>
  setPriority(p: Ports, rowId: string, level: Level | undefined): Promise<void>
  refreshManual(p: Ports): Promise<void>
  runAction(p: Ports, owner: string, id: string, rowId: string | null): Promise<void>
  problems(): readonly string[]
  isItemOwner(owner: string): boolean
  /**
   * The version of the mod, from its manifest: `unknown` when it gave none. Read per call: the first start sets it, so a
   * pane drawn before that (after a hot reload) has none and the help view shows no version line.
   */
  readonly version: string | undefined
  readonly keys: KeyRegistry
  readonly config: Pick<ConfigSource, 'global' | 'path' | 'problems'>
}

/** `shown` of each section id, read once. */
export async function shownOf(p: Ports, sections: readonly SectionSpec[]): Promise<ReadonlyMap<string, number>> {
  return new Map(await Promise.all(sections.map(async s => [s.id, await p.state.shown.get(s.id)] as const)))
}

/** The view the text reads: nothing selected, nothing opened. */
export const TEXT_VIEW: PaneView = { selected: null, expanded: new Set() }

/** The list as `/track` prints it: the text of the sections. */
export async function listText(p: Ports, m: Pick<PaneHost, 'paneData'>): Promise<string> {
  return sectionsText(await m.paneData(p, TEXT_VIEW))
}

/** The words of a row for a line of text: its type, key and title cells, each once. */
const wordsOf = (row: TreeRow): string =>
  [...new Set(['type', 'key', 'title'].map(c => (row.cells[c]?.text ?? '').trim()).filter(t => t !== ''))].join(' ')

/**
 * The words of each row the list shows, by row id (an item's key), for `/track turn` (issue #69). Read from the sections
 * with nothing selected, like the list text. An item with no row left (dismissed, hidden by its TTL) has none.
 */
export async function turnLabels(p: Ports, m: Pick<PaneHost, 'paneData'>): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>()
  const visit = (rows: readonly TreeRow[]): void => {
    for (const row of rows) {
      const words = wordsOf(row)
      if (words !== '') out.set(row.id, words)
      visit(row.children ?? [])
    }
  }
  for (const s of await m.paneData(p, TEXT_VIEW)) visit(s.rows)
  return out
}

/** The help view's data: every key, the config file, the version, the config problems and the key and tracker problems. */
export function helpOf(
  m: Pick<PaneHost, 'keys' | 'config' | 'problems' | 'version'>,
  sections: readonly SectionSpec[],
): HelpModel {
  return helpModel(m.keys.all(), sections, m.config.path(), [...m.config.problems(), ...m.problems()], m.version)
}

/** The help view as text, for `/track help` (`claude -p` has no pane). */
export async function helpTextOf(
  p: Ports,
  m: Pick<PaneHost, 'paneData' | 'keys' | 'config' | 'problems' | 'version'>,
): Promise<string> {
  return helpText(helpOf(m, await m.paneData(p, TEXT_VIEW)))
}
