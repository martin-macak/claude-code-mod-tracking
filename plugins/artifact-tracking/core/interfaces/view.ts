// View contracts: the data a tracker gives to TreeDataTable. Types only.
// The /track text and the band derive from the same SectionSpec values.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10.

import type { ToolStatus } from '../../types'
import type { ConfigView } from './config'
import type { Json, JsonObject, StoredItem } from './items'
import type { FactsPort } from './tracker'

/** A closed set by design. `ux/theme.ts` maps each token to a theme key or a named color. */
export type ColorToken = 'success' | 'warning' | 'error' | 'claude' | 'inactive' | 'subtle' | 'accent' | 'selected'

export interface Cell {
  readonly text: string
  readonly fg?: ColorToken
  readonly bg?: ColorToken
  readonly weight?: 'regular' | 'bold'
  readonly dim?: boolean
  readonly href?: string
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
  /** E.g. Jira child trees, as today. */
  readonly expandedByDefault?: boolean
  readonly detail?: () => readonly DetailLine[]
  readonly can?: { readonly dismiss?: boolean; readonly priority?: boolean }
  readonly dim?: boolean
}

export interface SectionSpec {
  readonly id: string
  readonly title: string
  /** E.g. `gh · ok 2m ago`, from the tool status. */
  readonly note?: Cell
  /** Today's band words and counts. */
  readonly band?: { readonly label: string; readonly count: number; readonly failing: number }
  readonly columns: readonly ColumnDef[]
  readonly rows: readonly TreeRow[]
  readonly empty?: string
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
}

/** What a key does, built at render. `state` says if the key works for the selected row. */
export type ActionImpls = Readonly<
  Record<
    string,
    {
      readonly run: () => void | Promise<void>
      readonly state?: () => 'enabled' | 'disabled'
    }
  >
>
