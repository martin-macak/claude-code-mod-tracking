// The footer of the pane: one Button per key, then the hints, and the rows it takes. Pure.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10. Plan: L6 Task 8, G16. Issue #108: the move hint.
import type { RenderElement } from 'claude-code'
import type { FooterKey } from '../../core/interfaces/view'
import { cellWidth } from '../text/cell-width'
import { box, button, type TableElements, text } from './el'
import type { TableActions } from './shape'

/**
 * The hints that end the footer: how to move between rows (issue #108), then how to leave. The move hint is drawn only
 * where it adds no row (`moveHintFits`): a short inline pane has no row to spare (issue #92).
 */
const MOVE_HINT = 'Tab ↑↓ move'
const ESC_HINT = 'Esc close'
/** The cells between two footer keys. */
const KEY_GAP = 2

/** The cells between two items of the footer and of the view line. */
export const ITEM_GAP = KEY_GAP

/**
 * The Button of one key, as the footer and the view line draw it. A disabled key stays, dim, and does no work: a letter with
 * no Button leaves the pane. A click on it still gives the pane the keys (`actions.keys`, issue #129), as a click on a live
 * key does: a Button moves no focus, so it would leave the keys in the prompt.
 */
export function keyButton(el: TableElements, k: FooterKey, actions: TableActions): RenderElement {
  return button(el, {
    key: k.buttonKey,
    plain: true,
    hotkey: k.key,
    label: k.label,
    ...(k.enabled ? {} : { dimColor: true }),
    onPress: k.enabled ? () => actions.press(k.buttonKey) : () => actions.keys(),
  })
}

/** What a plain Button of the key draws: `key: label`. */
export const keyWidth = (k: FooterKey): number => cellWidth(`${k.key}: ${k.label}`)

/**
 * One Button per key, then the hints (the move hint only when `hint`).
 */
export function footerBox(
  el: TableElements,
  keys: readonly FooterKey[],
  actions: TableActions,
  hint: boolean,
): RenderElement {
  return box(
    el,
    { columnGap: KEY_GAP, flexWrap: 'wrap' },
    ...keys.map(k => keyButton(el, k, actions)),
    ...(hint ? [text(el, { dimColor: true }, MOVE_HINT)] : []),
    text(el, { dimColor: true }, ESC_HINT),
  )
}

/**
 * The rows that items of these widths take in a body `columns` wide, `ITEM_GAP` apart. The engine wraps whole items onto the
 * next row, so the count is a greedy fill.
 */
export function fillRows(widths: readonly number[], columns: number): number {
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

/**
 * How many rows the footer takes in a body `columns` wide, with the move hint or without it. A plain Button draws
 * `key: label`.
 */
export function footerRows(keys: readonly FooterKey[], columns: number, hint: boolean): number {
  return fillRows([...keys.map(keyWidth), ...(hint ? [cellWidth(MOVE_HINT)] : []), cellWidth(ESC_HINT)], columns)
}

/** Whether the move hint costs the footer no row in a body `columns` wide. The footer then draws it, else it leaves it out. */
export function moveHintFits(keys: readonly FooterKey[], columns: number): boolean {
  return footerRows(keys, columns, true) === footerRows(keys, columns, false)
}
