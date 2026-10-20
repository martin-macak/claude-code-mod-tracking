// The hint of a pane that has no keys: `Pane.isFocused` is false, so a key goes to the prompt box. One dim line above the
// tree says so and says how to give the keys back. The footer cannot carry it: a tall list scrolls the footer out of view.
// Pure. Issue #108, option 4.
import type { RenderElement } from 'claude-code'
import { box, type TableElements, text } from './el'

/**
 * How the keys come back: the chord (`verified-live`, 2.1.304). A click on a blank part of the pane gives them back too,
 * but a click on a Button only presses it, so the hint names the chord alone.
 */
export const NO_KEYS_HINT = 'Keys go to the prompt. ctrl+x Tab gives them back.'

/** `tree` under the hint line. */
export function withKeysHint(el: TableElements, tree: RenderElement): RenderElement {
  return box(el, { flexDirection: 'column' }, text(el, { dimColor: true }, NO_KEYS_HINT), tree)
}
