// The hint of a pane that has no keys: `Pane.isFocused` is false, so a key goes to the prompt box. One dim line above the
// tree says so and says how to give the keys back. The footer cannot carry it: a tall list scrolls the footer out of view.
// Pure. Issue #108, option 4.
import type { RenderElement } from 'claude-code'
import { wrapRows } from '../text/wrap'
import { box, type TableElements, text } from './el'

/**
 * How the keys come back: the chord (`verified-live`, 2.1.304). A click on a blank part of the pane gives them back too,
 * and so does a click on the arrow of a row, unless the composer holds text (issue #115). The chord works in both
 * cases, so the hint names it alone.
 */
export const NO_KEYS_HINT = 'Keys go to the prompt. ctrl+x Tab gives them back.'

/** The rows the hint takes in a body `columns` wide: the table must leave them to the line (issue #109). */
export const hintRows = (columns: number): number => wrapRows(NO_KEYS_HINT, columns)

/** `tree` under the hint line. */
export function withKeysHint(el: TableElements, tree: RenderElement): RenderElement {
  return box(el, { flexDirection: 'column' }, text(el, { dimColor: true }, NO_KEYS_HINT), tree)
}
