// The one place that turns a ColorToken into an engine color. A tracker passes a token, never a color string, because a
// colon in one color refuses the whole pane (E14). Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md,
// sections 5.10 and 11 ("a new color token edits ux/theme.ts").
import type { BoxProps, Color, TextProps } from 'claude-code'
import type { Cell, ColorToken } from '../core/interfaces/view'

/**
 * Token to engine color. Six tokens map to the theme key of the same name. `accent` has no theme key, so it takes
 * `suggestion`. `selected` has none either: it takes the named color `blue`, painted from the theme palette (the
 * highlight of the live `tbl` spike).
 */
export const COLOR: Readonly<Record<ColorToken, Color>> = {
  success: 'success',
  warning: 'warning',
  error: 'error',
  claude: 'claude',
  inactive: 'inactive',
  subtle: 'subtle',
  accent: 'suggestion',
  selected: 'blue',
}

/** Each glyph is one cell wide (East Asian Width N, Bun width 1). */
export const GLYPH = { closed: '▸', open: '▾', selected: '>', unselected: ' ', marked: '*' } as const

/** The Text props of one cell. The data is clipped to its column first, so the engine never cuts. */
export function cellText(cell: Cell, rowDim: boolean): TextProps {
  const props: TextProps = { wrap: 'truncate-end' }
  if (cell.fg !== undefined) props.color = COLOR[cell.fg]
  if (cell.weight !== undefined) props.weight = cell.weight
  if (cell.dim === true || rowDim) props.dimColor = true
  return props
}

/** The Box props of one cell: its background. The fill covers the whole column width. */
export function cellBox(cell: Cell): Pick<BoxProps, 'backgroundColor'> {
  return cell.bg === undefined ? {} : { backgroundColor: COLOR[cell.bg] }
}
