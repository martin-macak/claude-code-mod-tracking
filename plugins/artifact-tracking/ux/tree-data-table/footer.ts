// The footer of the pane: one Button per key, then the hint, and the rows it takes. Pure.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10. Plan: L6 Task 8, G16.
import type { RenderElement } from 'claude-code'
import type { FooterKey } from '../../core/interfaces/view'
import { cellWidth } from '../text/cell-width'
import { box, button, type TableElements, text } from './el'
import type { TableActions } from './shape'

/** The hint that ends the footer. */
const ESC_HINT = 'Esc close'
/** The cells between two footer keys. */
const KEY_GAP = 2

/** One Button per key, then the hint. A disabled key stays, dim and inert: a letter with no Button leaves the pane. */
export function footerBox(el: TableElements, keys: readonly FooterKey[], actions: TableActions): RenderElement {
  return box(
    el,
    { columnGap: KEY_GAP, flexWrap: 'wrap' },
    ...keys.map(k =>
      button(el, {
        key: k.buttonKey,
        plain: true,
        hotkey: k.key,
        label: k.label,
        ...(k.enabled ? {} : { dimColor: true }),
        onPress: k.enabled ? () => actions.press(k.buttonKey) : () => undefined,
      }),
    ),
    text(el, { dimColor: true }, ESC_HINT),
  )
}

/**
 * How many rows the footer takes in a body `columns` wide. A plain Button draws `key: label`. The engine wraps whole
 * Buttons onto the next row, so the count is a greedy fill.
 */
export function footerRows(keys: readonly FooterKey[], columns: number): number {
  const widths = [...keys.map(k => cellWidth(`${k.key}: ${k.label}`)), cellWidth(ESC_HINT)]
  let rows = 1
  let used = 0
  for (const width of widths) {
    if (used > 0 && used + KEY_GAP + width > columns) {
      rows++
      used = width
    } else {
      used = used > 0 ? used + KEY_GAP + width : width
    }
  }
  return rows
}
