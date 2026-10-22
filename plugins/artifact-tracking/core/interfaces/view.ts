// View contracts: the data a tracker gives to TreeDataTable. Types only.
// The /track text and the band derive from the same SectionSpec values. The pane draws one table: its columns are the
// same for every row (`ColumnId`), and a section of a tracker is one group of it (`GroupSpec`).
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10. Design study of issue #63, section 5.

import type { ToolStatus } from '../../types'
import type { ConfigView } from './config'
import type { Effective, Json, JsonObject, ReasonSet, StoredItem } from './items'
import type { FactsPort, TrackerContext } from './tracker'

/** A closed set by design. `ux/theme.ts` maps each token to a theme key or a named color. */
export type ColorToken = 'success' | 'warning' | 'error' | 'claude' | 'inactive' | 'subtle' | 'accent' | 'selected'

export interface Cell {
  readonly text: string
  readonly fg?: ColorToken
  readonly bg?: ColorToken
  readonly weight?: 'regular' | 'bold'
  readonly dim?: boolean
  readonly href?: string
  /** Overrides the `clip` of the column for this one cell. */
  readonly clip?: 'end' | 'middle'
}

/**
 * The columns of the one table. Every row writes the same ones, so the rows of two trackers scan alike. `control` holds the
 * level marker, `name` the key (it carries the tree glyph), `description` the title, and `extras` the badges of
 * `TreeRow.extras`. The header has words for `name`, `description`, `type` and `status`.
 */
export type ColumnId = 'control' | 'name' | 'description' | 'type' | 'status' | 'extras'

/** The columns that a row fills with one `Cell`: all but `extras`, which holds a list of them. */
export type CellId = Exclude<ColumnId, 'extras'>

export interface ColumnDef {
  readonly id: string
  readonly header: string
  readonly width:
    | { readonly kind: 'fixed'; readonly cells: number }
    | { readonly kind: 'content'; readonly min?: number; readonly max?: number }
    | { readonly kind: 'flex'; readonly min: number }
  readonly align?: 'left' | 'center' | 'right'
  /** Exactly one in the column set of the table: indent and expand glyph. */
  readonly role?: 'tree'
  /** Dropped first when the pane is narrow. */
  readonly priority?: number
  /** Where a cell too long for its column is cut. Default 'end'. 'middle' keeps both ends of a branch or a path. */
  readonly clip?: 'end' | 'middle'
}

/**
 * Where a row stands, in one closed set, whatever its tracker. A tracker maps its own states to a token (design study of
 * issue #63, section 5.4). The pane takes the color of the status cell from it (`core/lib/status.ts`), and a view groups
 * by it, so no view reads the text of a cell.
 *
 * `failed`: broke, and needs the person. `waiting`: not broken, but it waits for something. `active`: live and well.
 * `done`: over, as it should be. `gone`: removed, or not known to exist any more. `none`: no state to speak of.
 */
export type StatusToken = 'failed' | 'waiting' | 'active' | 'done' | 'gone' | 'none'

/**
 * The views of the pane (issue #63, L3): how the one table groups its rows. `list`: one group for each section of a tracker,
 * today's pane. `tracker`: one group for each tracker. `status`: one group for each status token. `reason`: one group for each
 * strongest reason. `flat`: one group of every row. Every view puts the pinned rows in a group of their own, first.
 */
export type ViewId = 'list' | 'tracker' | 'status' | 'reason' | 'flat'

/** A state as the status cell says it: a free word, and the token that sorts it. */
export interface RowStatus {
  readonly label: string
  readonly token: StatusToken
}

/**
 * What a view groups, sorts and filters a row by. A view reads these and never the text of a cell. A tracker sets them on
 * the top-level rows it draws, and a view groups and sorts only those. A row below may carry a `status` too: the
 * `(n failed)` of a group reads it at every depth (`countFailed`).
 */
export interface Facets {
  readonly status?: RowStatus
  /**
   * The level of the row, from `ViewContext.levelOf`: the person's mark, or a rule's. Absent: the row has no level, as the
   * rows of the slot trackers (processes, agents, worktrees, repos) have none, and it sorts as `normal`.
   */
  readonly level?: Effective
  /** Epoch ms of the first sighting of the thing the row stands for: the record, the process, the agent or the worktree. Absent: not known. */
  readonly firstSeen?: number
  /** What kind of thing the row is, in a word that is the same on every surface (`pr`, `issue`, `docker-container`). Absent: no kind. Files get one with issue #57. */
  readonly kind?: string
}

/** One line of a row's detail. */
export interface DetailLine {
  readonly label?: string
  readonly cell: Cell
}

export interface TreeRow {
  /** A stable id, e.g. the item key. */
  readonly id: string
  /** The tracker id. */
  readonly owner: string
  readonly cells: Readonly<Partial<Record<CellId, Cell>>>
  /**
   * Badges: one-cell signals that a tracker adds to the `extras` column, e.g. the merge chip and the checks of a PR. Display
   * only: a badge is no Button and takes no Tab stop. The table joins them with one space and clips them to the column.
   */
  readonly extras?: readonly Cell[]
  readonly children?: readonly TreeRow[]
  /** E.g. child trees of an item, as today. */
  readonly expandedByDefault?: boolean
  readonly detail?: () => readonly DetailLine[]
  readonly can?: { readonly dismiss?: boolean; readonly priority?: boolean }
  readonly dim?: boolean
  /**
   * Why the row is tracked. The detail lists all of them, and the pane filters of #63 read `strongest`. A row that is
   * context, not a find (the root worktree, the master agent), has none.
   */
  readonly reasons?: ReasonSet
  /**
   * The first and the last main-loop turn that tracked the item (issue #69), by ordinal. Core puts it on the row of an item
   * from its record, so a kind draws none. Absent: no turn tracked the item (the PR lane found it, or the record is older).
   */
  readonly turns?: { readonly first: number; readonly last: number }
  /** What a view groups, sorts and filters by. Set on the top-level rows of every tracker (issue #63, L2). */
  readonly facets?: Facets
  /**
   * The rows below this row are rows of their own, not parts of it: the root worktree and the master agent hold the others
   * only to show where they came from. The by-list view draws them below it. Every other view draws each at the top level,
   * so a failed sub-agent lands in the failed group and not under its healthy master (issue #63, L3). The lifted row keeps
   * no child. A row below a row that does not say `lift` is a part of it (a sub-task of an item, the agents of a folded run) and
   * stays under it in every view. Rows below a lifted row may say `lift` too: the lift goes on through them.
   */
  readonly lift?: true
}

export interface SectionSpec {
  readonly id: string
  readonly title: string
  /** E.g. `tool · ok 2m ago`, from the tool status. */
  readonly note?: Cell
  /**
   * Where the pane places the section. Default: the `order` of the tracker. A tracker that draws two sections, or whose
   * `order` is not today's pane order, sets it (plan L5, K2).
   */
  readonly rank?: number
  /** Today's band words and counts. `rank` places the part in the band; default: the section's `rank`, else the `order`. */
  readonly band?: {
    readonly label: string
    readonly count: number
    readonly failing: number
    /** Items with a merge conflict, read after the failing count: `PRs 3 (1 ✗ · 2 conflicts)`. Absent or 0: none. */
    readonly conflicts?: number
    readonly rank?: number
  }
  readonly rows: readonly TreeRow[]
  /**
   * The number the title line shows. Default: the top-level `rows`. A section that hangs every row under one root row (the
   * worktrees under the root worktree, the agents under the master) sets the rows it holds, or its title would say 1.
   */
  readonly count?: number
  /**
   * The rows this section leaves out until `/track show-all` (the TTL of the ended rows, the row cap). A count to say, not
   * rows: the note says it too, but only the by-list view draws the notes, and the view line of every view adds this up.
   * Absent: nothing is left out.
   */
  readonly hiddenRows?: number
  readonly empty?: string
  /**
   * What the `/track` text prints of the section: `rows` (the default) the title line and every row, `title` the title line
   * only. The rows stay in the pane. The model reads every `/track` reply, so a section whose words are private keeps its
   * rows out of the text (the questions of issue #71).
   */
  readonly text?: 'rows' | 'title'
}

/**
 * What the table draws per group: a title line, then the rows. The by-list view makes one group of each section (`id`
 * `list:<section id>`). `count` and `failing` ride on the title line of the pane. The `/track` text prints the title and
 * the rows, or the title only when `text` says so.
 */
export interface GroupSpec {
  /** `<view>:<group key>`, e.g. `list:prs`. The table keys the rows that "N more" opened by it. */
  readonly id: string
  readonly title: string
  /** The note of the section, in the by-list view. */
  readonly note?: Cell
  readonly rows: readonly TreeRow[]
  /** The number the title line shows: the `count` of the section, else its top-level rows. The caps of the table do not change it. */
  readonly count: number
  /**
   * The failures in the rows of the group, at every depth, read from the status token `failed`. A failure counts once: a
   * row whose failure comes from a row below it (a folded workflow run) counts those rows and not itself (`countFailed`).
   * It is not the failing count of the band of the section.
   */
  readonly failing: number
  /** Shown when the group has no row. */
  readonly empty?: string
  /** The `text` of the section: `title` keeps the rows out of the `/track` text. Default `rows`. */
  readonly text?: 'rows' | 'title'
}

/** What the pane remembers of the person's view: the selected row and the rows the person opened. */
export interface PaneView {
  readonly selected: string | null
  readonly expanded: ReadonlySet<string>
}

/**
 * What `/track show-all` and `/track clean --hide` set, for the session. `showAll`: every tracker that hides a row by time
 * shows it again. `before`: the time of the last `--hide`, epoch ms. A row that is over and ended at or before it is hidden,
 * whatever its TTL or `hideEnded`. `showAll` wins over both. A session atom: `/clear` resets it, and it is never written to
 * the config file.
 */
export interface HiddenState {
  readonly showAll: boolean
  readonly before?: number
}

/**
 * The filters of the pane, for the session (issue #63, L3). `touchedOnly` (`t`): the top-level rows that were only discovered or
 * mentioned are left out. A session atom like `hidden`: `/clear` resets it, and it is never written to the config file.
 */
export interface FilterState {
  readonly touchedOnly: boolean
}

/** What a tracker reads to draw. All reads, no writes: a render must not write (E8, E9). */
export interface ViewContext<C = JsonObject, D = Json> {
  /** Epoch ms. */
  readonly now: number
  readonly config: ConfigView<C>
  /** The tracker's data slot. */
  readonly data: D | undefined
  /** All items of the shared store. */
  readonly items: readonly StoredItem[]
  readonly facts: Pick<FactsPort, 'read'>
  /** One status per tool id. */
  readonly tools: Readonly<Record<string, ToolStatus>>
  /** The selected row id. */
  readonly selected: string | null
  readonly expanded: ReadonlySet<string>
  /** The pinned session root. */
  readonly root: string | undefined
  /** The home folder of the person: `HOME`, when absolute. Absent: the engine gave none, or a relative one. Display only. */
  readonly home: string | undefined
  /** The `/track show-all` toggle. A tracker that hides rows by time shows them all while `showAll` is on. */
  readonly hidden: HiddenState
  isDismissed(id: string): boolean
  /** The level of one item, by key: the person's mark, or a rule's. An item with no level, and an unknown key, give `{}`. */
  levelOf(key: string): Effective
}

/** Where a key shows and what it acts on: the whole `pane`, the selected `row`, or the tracker's `section`. */
export type KeyScope = 'pane' | 'row' | 'section'

/** A key of the pane. `owner` is `core` or a tracker id. */
export interface PaneKey {
  readonly id: string
  readonly key: string
  readonly label: string
  readonly scope: KeyScope
  readonly owner: string
  /**
   * Where the Button of the key sits. Absent: the footer. `view`: the view line above the footer (issue #63, L3): `g`, `a`
   * and `t` are there, so the footer does not grow a row. The help view lists the key either way. Only core sets it.
   */
  readonly bar?: 'view'
}

/**
 * A key as the footer draws it. A disabled key stays on the footer, dim and inert (a letter with no Button leaves the pane).
 * `buttonKey` is the key of the footer Button: the registry finds the key by it, and `ux/` only echoes it.
 */
export interface FooterKey extends PaneKey {
  readonly enabled: boolean
  readonly buttonKey: string
}

/** What the key routing needs of a drawn row. */
export interface RowRef {
  readonly id: string
  readonly owner: string
  /** The id of the group the row sits in (`list:prs` in the by-list view). It is no tracker section id. */
  readonly group: string
  readonly can: TreeRow['can']
}

export interface HelpGroup {
  readonly title: string
  readonly keys: readonly PaneKey[]
}

/** What the help view shows: every key by group, the config file path, the version of the mod and the problems. */
export interface HelpModel {
  readonly groups: readonly HelpGroup[]
  readonly configPath: string | undefined
  readonly problems: readonly string[]
  /**
   * The problems the config left out of `problems` (it keeps the first 50, issue #144): how many, and the line that counts
   * them and names the log. Absent or a count of 0: none were left out.
   */
  readonly moreProblems?: { readonly count: number; readonly line: string }
  /** The version of the mod, or `unknown`. Absent: no line (no start has read the manifest yet). */
  readonly version?: string
}

/**
 * What a key does, built at render. `run` gets the row id the key acts on, or `null` when no row is selected.
 * `state` says if the key works for that row. Method syntax keeps both bivariant, so a `Tracker<MyConfig>` fits a list.
 */
export interface ActionImpl<C extends JsonObject = JsonObject, D extends Json = Json> {
  run(ctx: TrackerContext<C, D>, rowId: string | null): void | Promise<void>
  state?(rowId: string | null): 'enabled' | 'disabled'
}

export type ActionImpls<C extends JsonObject = JsonObject, D extends Json = Json> = Readonly<
  Record<string, ActionImpl<C, D>>
>
