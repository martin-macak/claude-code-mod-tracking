// The groups of the pane: what the one table draws from the sections of the trackers. A view turns the sections into groups.
// Five views (issue #63, L3): by list (each section is one group, the pane as it was), by tracker, by status, by reason and
// flat. Every view puts the pinned rows in a group of their own, first, and may hide the rows nobody touched. A view groups,
// sorts and filters on the facets of the top-level rows, the owner and the section: never on the text of a cell. Pure: no
// `$`, no I/O, no tracker named.
// Design study of issue #63, sections 5.2 and 5.8; owner decisions of 2026-10-21.

import type { CoreReason } from '../interfaces/reasons'
import type { GroupSpec, SectionSpec, StatusToken, TreeRow, ViewId } from '../interfaces/view'
import { byLevel } from './levels'
import { REASON_ORDER } from './reasons'
import { countFailed } from './status'

/** The view the pane draws by default: one group for each section of a tracker. */
export const LIST_VIEW: ViewId = 'list'

/** The views, in the order the docs name them. `ui.views` takes any of them. */
export const VIEW_IDS: readonly ViewId[] = ['list', 'tracker', 'status', 'reason', 'flat']

export const isViewId = (v: unknown): v is ViewId =>
  typeof v === 'string' && (VIEW_IDS as readonly string[]).includes(v)

/** The view that `g` goes to: the one after `current` in `views`, wrapping. A view the list lacks goes to the first. */
export function nextView(current: ViewId, views: readonly ViewId[]): ViewId {
  if (views.length === 0) return current
  return views[(views.indexOf(current) + 1) % views.length] ?? current
}

/** The view the pane draws: the person's choice (the session atom), else `fallback` (`global.ui.view`). A value that is no view reads as no choice. */
export const resolveView = (choice: string | null, fallback: ViewId): ViewId => (isViewId(choice) ? choice : fallback)

/** What the view line says: the view, the filter, the rows it hid and whether the TTL-hidden rows show. */
export interface ViewSummary {
  readonly view: ViewId
  readonly touchedOnly: boolean
  readonly showAll: boolean
  /** The rows that `touchedOnly` hid. */
  readonly hidden: number
}

/** `View: status · touched only · 2 hidden · showing all`: the line of the pane and the first line of `/track`. */
export function viewSummary(s: ViewSummary): string {
  const parts = [
    `View: ${s.view}`,
    ...(s.touchedOnly ? ['touched only', ...(s.hidden > 0 ? [`${s.hidden} hidden`] : [])] : []),
    ...(s.showAll ? ['showing all'] : []),
  ]
  return parts.join(' · ')
}

/** `<view>:<group key>`, e.g. `list:prs`. The caps of the table key the rows that "N more" opened by it. */
export const groupId = (view: string, key: string): string => `${view}:${key}`

/**
 * The by-list view: a group for each section, in the order given. The count is the one the section sets, else its
 * top-level rows, and the failing count is the failures read from the status token `failed`, each once (issue #63, L2,
 * `countFailed`). The band of the section counts on its own terms and keeps its numbers: the band line above the prompt
 * does not change.
 */
export function listGroups(sections: readonly SectionSpec[]): readonly GroupSpec[] {
  return sections.map(s => ({
    id: groupId(LIST_VIEW, s.id),
    title: s.title,
    ...(s.note !== undefined ? { note: s.note } : {}),
    rows: s.rows,
    count: s.count ?? s.rows.length,
    failing: countFailed(s.rows),
    ...(s.empty !== undefined ? { empty: s.empty } : {}),
  }))
}

// ---------------------------------------------------------------- the views

export interface GroupOptions {
  /** `t`: hide the top-level rows that nobody touched (the strongest reason is `discovered` or `mentioned`). */
  readonly touchedOnly: boolean
}

export interface Grouped {
  readonly groups: readonly GroupSpec[]
  /** How many rows `touchedOnly` hid. The view line says it. */
  readonly hidden: number
}

/** The reasons that `touchedOnly` hides: the row was found or named, and no one did anything with it. */
const UNTOUCHED: ReadonlySet<CoreReason> = new Set<CoreReason>(['discovered', 'mentioned'])

/** The rows of a tree, every level. */
const sizeOf = (r: TreeRow): number => 1 + (r.children ?? []).reduce((n, c) => n + sizeOf(c), 0)

/** `row` without its children. */
function leaf(row: TreeRow): TreeRow {
  const { children: _children, ...rest } = row
  return rest
}

/**
 * A row that the person set to `high`, or a rule set to `top`. A `high` that a rule gave (an issue that a high PR closes) is
 * no pin.
 */
function isPinned(row: TreeRow): boolean {
  const level = row.facets?.level
  return level?.level === 'top' || (level?.level === 'high' && level.auto !== true)
}

const hides = (row: TreeRow): boolean => row.reasons !== undefined && UNTOUCHED.has(row.reasons.strongest)

/** What a filter dropped: the top-level rows, and every row of the dropped trees (a section that sets `count` loses those). */
interface Tally {
  hidden: number
  rows: number
}

/**
 * The rows that `touchedOnly` keeps. A row that nobody touched goes with its children. The children of a row that says `lift`
 * are rows of their own, so the filter reaches them too, in every view: the by-list view draws them below the root, and the
 * others draw them at the top. A row with no reasons is context and stays. The same array comes back when nothing goes.
 */
function touchedRows(rows: readonly TreeRow[], tally: Tally): readonly TreeRow[] {
  const out: TreeRow[] = []
  for (const row of rows) {
    if (hides(row)) {
      tally.hidden++
      tally.rows += sizeOf(row)
      continue
    }
    const kids = row.lift === true && row.children !== undefined ? touchedRows(row.children, tally) : undefined
    if (kids === undefined || kids === row.children) out.push(row)
    else out.push(kids.length === 0 ? leaf(row) : { ...row, children: kids })
  }
  return out.length === rows.length && out.every((r, i) => r === rows[i]) ? rows : out
}

/** The rows with every `lift` row stripped of its children and followed by them, which lift in their turn. */
function lifted(rows: readonly TreeRow[]): TreeRow[] {
  return rows.flatMap(r => (r.lift === true && r.children !== undefined ? [leaf(r), ...lifted(r.children)] : [r]))
}

const firstSeenOf = (r: TreeRow): number => r.facets?.firstSeen ?? Number.NEGATIVE_INFINITY

/**
 * Priority level, then first seen, then id. A row with no first sighting (the root worktree, the master agent: context)
 * comes before the rows that have one.
 */
function byOrder(a: TreeRow, b: TreeRow): number {
  const [x, y] = [firstSeenOf(a), firstSeenOf(b)]
  return (
    byLevel(a.facets?.level?.level, b.facets?.level?.level) ||
    (x < y ? -1 : x > y ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

/** Where a row stands: `failed` when it or a row below it failed (a tree is one unit), else its own token. */
const tokenOf = (r: TreeRow): StatusToken => (countFailed([r]) > 0 ? 'failed' : (r.facets?.status?.token ?? 'none'))

const STATUS_ORDER: readonly StatusToken[] = ['failed', 'waiting', 'active', 'done', 'gone', 'none']
const STATUS_TITLE: Readonly<Record<StatusToken, string>> = {
  failed: 'Failed',
  waiting: 'Waiting',
  active: 'Active',
  done: 'Done',
  gone: 'Gone',
  none: 'No status',
}

/** The strongest reason of the row, or `context` for a row that is no find (the root worktree, the master agent). */
type ReasonKey = CoreReason | 'context'
const REASON_KEYS: readonly ReasonKey[] = [...REASON_ORDER, 'context']

/** A row and the section it came from. A lifted row stays with the section of its root. */
interface Unit {
  readonly row: TreeRow
  readonly section: SectionSpec
}

const unique = <T>(list: readonly T[]): T[] => [...new Set(list)]
const capital = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1)

/** The by-list view: the sections as groups, less the pinned rows, which come out first in a group of their own. */
function listView(
  kept: readonly { s: SectionSpec; rows: readonly TreeRow[]; gone: number }[],
  make: (key: string, title: string, rows: readonly TreeRow[]) => GroupSpec,
): readonly GroupSpec[] {
  const pinned: TreeRow[] = []
  const sections = kept.map(({ s, rows, gone }) => {
    const own = rows.filter(r => !isPinned(r))
    const taken = rows.filter(isPinned)
    pinned.push(...taken)
    // A section that sets its own count (a tree under one root row) loses the rows of what left it.
    const count = s.count === undefined ? undefined : s.count - gone - taken.reduce((n, r) => n + sizeOf(r), 0)
    return { ...s, rows: taken.length === 0 ? rows : own, ...(count === undefined ? {} : { count }) }
  })
  return [
    ...(pinned.length === 0 ? [] : [make('pinned', 'Pinned', [...pinned].sort(byOrder))]),
    ...listGroups(sections),
  ]
}

/**
 * The groups of one view over the sections, with the pinned rows first.
 *
 * - By list: one group for each section, in the order given, with its note and its empty text. The rows keep the order the
 *   tracker gave them, and every tree stays whole.
 * - By tracker: one group for each owner of a row, in the order the owners first show, titled by the sections they hold rows in.
 * - By status: one group for each token that a row has, failed first. A tree is in the failed group when a row below it failed.
 * - By reason: one group for each strongest reason, strongest first, then the rows with none (context).
 * - Flat: one group of every row.
 *
 * The other views sort each group by level, first seen and id, and lift the children of a `lift` row to the top. A group with
 * no row is left out, and so is the Pinned group. A pinned row is in no other group. `touchedOnly` drops rows first, so a
 * pinned row that nobody touched is hidden too.
 */
export function viewGroups(sections: readonly SectionSpec[], view: ViewId, options: GroupOptions): Grouped {
  const tally: Tally = { hidden: 0, rows: 0 }
  const kept = sections.map(s => {
    const before = tally.rows
    const rows = options.touchedOnly ? touchedRows(s.rows, tally) : s.rows
    return { s, rows, gone: tally.rows - before }
  })
  const make = (key: string, title: string, rows: readonly TreeRow[]): GroupSpec => ({
    id: groupId(view, key),
    title,
    rows,
    count: rows.length,
    failing: countFailed(rows),
  })
  if (view === 'list') return { groups: listView(kept, make), hidden: tally.hidden }
  const units: Unit[] = kept.flatMap(({ s, rows }) => lifted(rows).map(row => ({ row, section: s })))
  const pinned = units.filter(u => isPinned(u.row)).map(u => u.row)
  const rest = units.filter(u => !isPinned(u.row))
  /** One group for each key that has a row, in the order of `keys`; the rows sort by level, first seen and id. */
  const by = <K extends string>(
    keys: readonly K[],
    keyOf: (u: Unit) => K,
    title: (key: K, mine: readonly Unit[]) => string,
  ): GroupSpec[] =>
    keys.flatMap(key => {
      const mine = rest.filter(u => keyOf(u) === key)
      return mine.length === 0 ? [] : [make(key, title(key, mine), mine.map(u => u.row).sort(byOrder))]
    })
  const grouped = (): GroupSpec[] => {
    switch (view) {
      case 'status':
        return by(
          STATUS_ORDER,
          u => tokenOf(u.row),
          key => STATUS_TITLE[key],
        )
      case 'reason':
        return by(
          REASON_KEYS,
          u => u.row.reasons?.strongest ?? 'context',
          key => capital(key),
        )
      case 'tracker':
        return by(
          unique(rest.map(u => u.row.owner)),
          u => u.row.owner,
          (_key, mine) => unique(mine.map(u => u.section.title)).join(', '),
        )
      default:
        return by(
          ['all'],
          () => 'all',
          () => 'All',
        )
    }
  }
  const first = pinned.length === 0 ? [] : [make('pinned', 'Pinned', [...pinned].sort(byOrder))]
  return { groups: [...first, ...grouped()], hidden: tally.hidden }
}
