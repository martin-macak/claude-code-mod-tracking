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
 * key does: a Button moves no focus, so it would leave the keys in the prompt. `pressOff`: a dim key still goes to the pane as a press,
 * so the pane can say why it is off (the key line of the preview, issue #57, L2: a mode that is off says its reason in a toast).
 */
export function keyButton(el: TableElements, k: FooterKey, actions: TableActions, pressOff = false): RenderElement {
  return button(el, {
    key: k.buttonKey,
    plain: true,
    hotkey: k.key,
    label: k.label,
    ...(k.enabled ? {} : { dimColor: true }),
    onPress: k.enabled || pressOff ? e => actions.press(k.buttonKey, e?.surface) : () => actions.keys(),
  })
}

/** What a plain Button of the key draws: `key: label`. */
export const keyWidth = (k: FooterKey): number => cellWidth(`${k.key}: ${k.label}`)

/** How a row of keys ends: the words that say how to leave, and whether a dim key still presses (`keyButton`). */
export interface KeyRowOptions {
  /** The last words of the row. Default `Esc close`; the key line of the preview says `Esc back`. */
  readonly close?: string
  readonly pressOff?: boolean
  /** Elements before the first key: the `↩ back` Button of the preview body (issue #277). It is the first Tab stop of the row. */
  readonly lead?: readonly RenderElement[]
}

/**
 * One Button per key, then the hints (the move hint only when `hint`).
 */
export function footerBox(
  el: TableElements,
  keys: readonly FooterKey[],
  actions: TableActions,
  hint: boolean,
  { close = ESC_HINT, pressOff = false, lead = [] }: KeyRowOptions = {},
): RenderElement {
  return box(
    el,
    { columnGap: KEY_GAP, flexWrap: 'wrap' },
    ...lead,
    ...keys.map(k => keyButton(el, k, actions, pressOff)),
    ...(hint ? [text(el, { dimColor: true }, MOVE_HINT)] : []),
    text(el, { dimColor: true }, close),
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

/** The rows the footer of the help view keeps its labels in: the 2 rows it takes at 96 cells (issue #200). */
const HELP_LABELLED_ROWS = 2
/** The label of a dim key in a narrow help footer: the letter stays, the word does not (the list above it names the key). */
export const TERSE_LABEL = '·'

/**
 * The keys the help footer draws in a body `columns` wide (issue #287). Its dim Buttons (`g`, `a`, `t`, `p`, `m`, `e`, the row keys)
 * only keep the letters from the prompt, and the list above names them, so where the labelled footer takes more than
 * `HELP_LABELLED_ROWS` rows they shrink to `key: ·` and flow in fewer rows. The live keys keep their words. At 96 cells the
 * footer is labelled, as before.
 */
export function helpFooterKeys(keys: readonly FooterKey[], columns: number): readonly FooterKey[] {
  if (footerRows(keys, columns, moveHintFits(keys, columns)) <= HELP_LABELLED_ROWS) return keys
  return keys.map(k => (k.enabled ? k : { ...k, label: TERSE_LABEL }))
}
