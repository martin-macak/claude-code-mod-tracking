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
/** The row of column names above the groups. The one header of the table, drawn once a row is drawn. */
export const HEADER_ROWS = 1
/** A detail line is cut at this many cells. */
export const DETAIL_CELLS = 500
export const TOO_LARGE = 'The pane is too large to draw. /track prints the list.'
export const UNAVAILABLE = 'Tracking is unavailable. Run /track to try again.'
export const NOTHING_MORE = '(nothing more to show)'

/** The indent of a row in its tree column: two cells a level, never more than the column holds beside the glyph. */
export const indentOf = (columnWidth: number, depth: number): number =>
  Math.min(INDENT * depth, Math.max(0, columnWidth - GLYPH_BOX))

/**
 * The view line (issue #63, L3): one line above the footer. `text` says the view, the filters and the rows they hid. `keys` are
 * the Buttons of `g`, `a` and `t`: they sit here and not in the footer, so the footer keeps its rows. The line is clipped to
 * the width, and its Buttons wrap like the footer's.
 */
export interface ViewLine {
  readonly text: string
  readonly keys: readonly FooterKey[]
}

export interface TableView {
  readonly bodyColumns: number | undefined
  /**
   * The most rows the table may take: `scroll.bodyRows`, less the rows of a hint line the pane draws above the table. The
   * help view, the window over the rows and the pin of the footer (`placement`) read it. Absent: no limit is known, and
   * every row is drawn.
   */
  readonly bodyRows: number | undefined
  readonly selected: string | null
  /**
   * Whether the pane has the keys (`Pane.isFocused`). `false` draws the selected row without the live highlight: the
   * keys go to the prompt box. Absent: the pane has them.
   */
  readonly focused?: boolean
  /**
   * Where the surface seated the pane (`Pane.placement`). A `dock` pane has a body of a fixed height (`bodyRows`): the
   * footer sits at its bottom. An `inline` pane is as tall as its tree, so padding it would stretch every pane to its
   * full height: the footer stays under the last row. Absent: as `inline`.
   */
  readonly placement?: 'dock' | 'inline'
  /** The first unit the last drawing showed in full (`Drawn.top`). The window keeps its place until the focus leaves it. */
  readonly top?: number
  /** The key of the "N more" Button the ring sits on (`m0`, …). Its group row must show, so the window follows it. */
  readonly onMore?: string
  readonly expanded: ReadonlySet<string>
  /** Rows shown beyond the cap, by group id (`<view>:<group>`, e.g. `list:prs`). */
  shown(groupId: string): number
  readonly limits: { readonly sectionRows: number; readonly maxRows: number }
  readonly footer: readonly FooterKey[]
  /** The line above the footer. Absent: none is drawn. The help view never draws it. */
  readonly viewLine?: ViewLine
  readonly help: HelpModel | null
  /** Default `BUDGET`. Tests pass a small one. */
  readonly budget?: Cost
}

export interface TableActions {
  toggle(rowId: string): void
  more(groupId: string): void
  /** A press of a footer key. `surface` is the one the press came from (`UiPressArgument.surface`): absent when the press names none. */
  press(buttonKey: string, surface?: string): void
  /** A press that does no work: it only gives the pane the keys (issue #129). A dim footer key calls it. */
  keys(): void
}

export interface DrawnRow {
  readonly id: string
  readonly owner: string
  /** The id of the group the row sits in. */
  readonly group: string
  readonly can: TreeRow['can']
  readonly handle: string
  readonly depth: number
}

/**
 * The drawing, the map from row handle to row id, and the rows in drawing order. A windowed drawing still lists every
 * row: a row out of the window keeps its focus stop (windowed.ts), so `handles` and `rows` hold all of them.
 */
export interface Drawn {
  readonly tree: RenderElement
  readonly handles: ReadonlyMap<string, string>
  readonly rows: readonly DrawnRow[]
  /**
   * The key of every focus stop of the body, in drawing order: the row handles, and `m<n>` after the rows of a section that
   * has more rows (windowed or not, as the Buttons keep their order). A press compares two drawings by it (`Refocus.keep`):
   * the ring sits on a position among the Buttons, and an `m<n>` that appears or goes shifts every Button after it.
   */
  readonly stops: readonly string[]
  /** The first unit drawn in full: give it back as `TableView.top`. 0 when the whole tree fits. */
  readonly top: number
  /** The rows drawn in full when the window cuts the tree, else undefined. A page key moves the selection by about this many. */
  readonly page: number | undefined
}
