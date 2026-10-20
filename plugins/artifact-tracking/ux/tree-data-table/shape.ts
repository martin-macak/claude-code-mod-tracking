// The shapes TreeDataTable shares across its files: its constants, the view it reads, the actions it calls and what it
// drew. Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10. Plan: L6 Task 8.
import type { RenderElement } from 'claude-code'
import type { FooterKey, HelpModel, TreeRow } from '../../core/interfaces/view'
import type { Cost } from './budget'
import { GLYPH_BOX, INDENT } from './columns'

/** The selection marker and one gap, left of the first column. */
export const GUTTER = 2
/** The width of a surface that gives none (the inline pane has no `bodyColumns`). */
export const DEFAULT_BODY_COLUMNS = 80
/** The blank rows between the body of the pane and its footer. */
export const ROW_GAP = 1
/** A detail line is cut at this many cells. */
export const DETAIL_CELLS = 500
export const TOO_LARGE = 'The pane is too large to draw. /track prints the list.'
export const UNAVAILABLE = 'Tracking is unavailable. Run /track to try again.'
export const NOTHING_MORE = '(nothing more to show)'

/** The indent of a row in its tree column: two cells a level, never more than the column holds beside the glyph. */
export const indentOf = (columnWidth: number, depth: number): number =>
  Math.min(INDENT * depth, Math.max(0, columnWidth - GLYPH_BOX))

export interface TableView {
  readonly bodyColumns: number | undefined
  /** The most rows the pane may take (`scroll.bodyRows`). Only the help view reads it. Absent: no limit is known. */
  readonly bodyRows: number | undefined
  readonly selected: string | null
  /**
   * Whether the pane has the keys (`Pane.isFocused`). `false` draws the selected row without the live highlight: the
   * keys go to the prompt box. Absent: the pane has them.
   */
  readonly focused?: boolean
  readonly expanded: ReadonlySet<string>
  /** Rows shown beyond the cap, by section id. */
  shown(sectionId: string): number
  readonly limits: { readonly sectionRows: number; readonly maxRows: number }
  readonly footer: readonly FooterKey[]
  readonly help: HelpModel | null
  /** Default `BUDGET`. Tests pass a small one. */
  readonly budget?: Cost
}

export interface TableActions {
  toggle(rowId: string): void
  more(sectionId: string): void
  press(buttonKey: string): void
}

export interface DrawnRow {
  readonly id: string
  readonly owner: string
  readonly section: string
  readonly can: TreeRow['can']
  readonly handle: string
  readonly depth: number
}

/** The drawing, the map from row handle to row id, and the rows in drawing order. */
export interface Drawn {
  readonly tree: RenderElement
  readonly handles: ReadonlyMap<string, string>
  readonly rows: readonly DrawnRow[]
}
