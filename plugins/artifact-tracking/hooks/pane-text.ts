// The host contract of the pane and the text the pane's data makes: the list `/track` prints and the help view as text.
// The list reads the groups the pane draws (the sections of `paneData` in the active view, issue #63, L3) with nothing
// selected, so the text and the pane never differ in content. PaneHost is what the pane session needs of the LifecycleManager; the manager fits it as it is.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.10 and 5.12. Plan: L6 Task 11, G14, G15.

import type { KeyRegistry } from '../core/infra/keys'
import type { ConfigSource } from '../core/interfaces/config'
import type { Level } from '../core/interfaces/items'
import type { Ports } from '../core/interfaces/ports'
import type {
  FooterKey,
  GroupSpec,
  HelpModel,
  PaneView,
  RowRef,
  SectionSpec,
  TreeRow,
  ViewId,
} from '../core/interfaces/view'
import { LIST_VIEW, listGroups, resolveView, viewGroups, viewSummary } from '../core/lib/grouping'
import { namedProblems } from '../core/lib/problems'
import { helpModel, helpText } from '../ux/tree-data-table/help'
import { groupsText } from '../ux/tree-data-table/text'

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
  readonly config: Pick<ConfigSource, 'global' | 'path' | 'problems' | 'moreProblems'>
}

/**
 * What the pane draws from one read of the state: the sections of the trackers, and the groups that the active view makes of
 * them (issue #63, L3). The view is the person's choice (`g`, `/track view`), else `global.ui.view`. The filters and the
 * `hidden.showAll` toggle ride along, so the view line says them. `sections` are what the help view needs: it titles a
 * tracker's keys by the sections that hold its rows, whatever the view.
 */
export interface PaneModel {
  readonly sections: readonly SectionSpec[]
  readonly groups: readonly GroupSpec[]
  readonly view: ViewId
  readonly touchedOnly: boolean
  readonly showAll: boolean
  /** The rows that `touchedOnly` hid. */
  readonly hidden: number
}

/** The sections, the atoms and the groups, read once: the pane, the text and a refocus agree on one drawing. */
export async function paneModel(
  p: Ports,
  m: Pick<PaneHost, 'paneData' | 'config'>,
  view: PaneView,
): Promise<PaneModel> {
  const [sections, choice, filters, hide] = await Promise.all([
    m.paneData(p, view),
    p.state.view.get(),
    p.state.filters.get(),
    p.state.hidden.get(),
  ])
  const current = resolveView(choice, m.config.global().ui.view)
  const { groups, hidden } = viewGroups(sections, current, filters)
  return { sections, groups, view: current, touchedOnly: filters.touchedOnly, showAll: hide.showAll, hidden }
}

/** The groups the pane draws in the active view. The text and a refocus read the same groups. */
export async function paneGroups(
  p: Ports,
  m: Pick<PaneHost, 'paneData' | 'config'>,
  view: PaneView,
): Promise<readonly GroupSpec[]> {
  return (await paneModel(p, m, view)).groups
}

/** `shown` of each group id (`<view>:<group>`), read once. */
export async function shownOf(p: Ports, groups: readonly GroupSpec[]): Promise<ReadonlyMap<string, number>> {
  return new Map(await Promise.all(groups.map(async g => [g.id, await p.state.shown.get(g.id)] as const)))
}

/** The view the text reads: nothing selected, nothing opened. */
export const TEXT_VIEW: PaneView = { selected: null, expanded: new Set() }

/**
 * The list as `/track` prints it: the text of the groups of the active view. A view other than by list, or a filter, puts the
 * line of the view first (`View: status`), so the text says what it shows. The default reply has no such line.
 */
export async function listText(p: Ports, m: Pick<PaneHost, 'paneData' | 'config'>): Promise<string> {
  const model = await paneModel(p, m, TEXT_VIEW)
  const text = groupsText(model.groups)
  return model.view === LIST_VIEW && !model.touchedOnly ? text : `${viewSummary(model)}\n\n${text}`
}

/** The words of a row for a line of text: its type, key and title cells, each once. */
const wordsOf = (row: TreeRow): string =>
  [
    ...new Set(
      (['type', 'name', 'description'] as const).map(c => (row.cells[c]?.text ?? '').trim()).filter(t => t !== ''),
    ),
  ].join(' ')

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

/**
 * The help view's data: every key, the config file, the version, the config problems and the key and tracker problems.
 * The help titles a tracker by the groups that hold its rows, so `groups` must be the by-list groups (the sections of the
 * trackers), whatever view the pane draws: `listGroups(sections)`. The groups of the drawn view would put the keys of a
 * tracker under a title like "Failed, Active".
 * The config keeps the first 50 of its problems and ends the list with a count line (issue #144). The model takes the
 * 50 and the count apart, so the compact form counts the left-out problems right and the count line comes last.
 */
export function helpOf(
  m: Pick<PaneHost, 'keys' | 'config' | 'problems' | 'version'>,
  groups: readonly GroupSpec[],
): HelpModel {
  const more = m.config.moreProblems()
  const problems = [...namedProblems(m.config.problems(), more), ...m.problems()]
  // The config gives the count line with the count: the view prints that line, so every view says the same words.
  return helpModel(m.keys.all(), groups, m.config.path(), problems, m.version, more)
}

/** The help view as text, for `/track help` (`claude -p` has no pane). */
export async function helpTextOf(
  p: Ports,
  m: Pick<PaneHost, 'paneData' | 'keys' | 'config' | 'problems' | 'version'>,
): Promise<string> {
  return helpText(helpOf(m, listGroups(await m.paneData(p, TEXT_VIEW))))
}
