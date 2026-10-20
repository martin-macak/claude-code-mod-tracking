// View contracts: the data a tracker gives to TreeDataTable. Types only.
// The /track text and the band derive from the same SectionSpec values.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10.

import type { ToolStatus } from '../../types'
import type { ConfigView } from './config'
import type { Effective, Json, JsonObject, StoredItem } from './items'
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

export interface ColumnDef {
  readonly id: string
  readonly header: string
  readonly width:
    | { readonly kind: 'fixed'; readonly cells: number }
    | { readonly kind: 'content'; readonly min?: number; readonly max?: number }
    | { readonly kind: 'flex'; readonly min: number }
  readonly align?: 'left' | 'center' | 'right'
  /** Exactly one per section: indent and expand glyph. */
  readonly role?: 'tree'
  /** Dropped first when the pane is narrow. */
  readonly priority?: number
  /** Where a cell too long for its column is cut. Default 'end'. 'middle' keeps both ends of a branch or a path. */
  readonly clip?: 'end' | 'middle'
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
  readonly cells: Readonly<Record<string, Cell>>
  readonly children?: readonly TreeRow[]
  /** E.g. child trees of an item, as today. */
  readonly expandedByDefault?: boolean
  readonly detail?: () => readonly DetailLine[]
  readonly can?: { readonly dismiss?: boolean; readonly priority?: boolean }
  readonly dim?: boolean
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
  readonly columns: readonly ColumnDef[]
  readonly rows: readonly TreeRow[]
  readonly empty?: string
}

/** What the pane remembers of the person's view: the selected row and the rows the person opened. */
export interface PaneView {
  readonly selected: string | null
  readonly expanded: ReadonlySet<string>
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
  readonly section: string
  readonly can: TreeRow['can']
}

export interface HelpGroup {
  readonly title: string
  readonly keys: readonly PaneKey[]
}

/** What the help view shows: every key by group, the config file path and the problems. */
export interface HelpModel {
  readonly groups: readonly HelpGroup[]
  readonly configPath: string | undefined
  readonly problems: readonly string[]
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
