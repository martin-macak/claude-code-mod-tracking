// The strip on the duration line of a turn (issue #69, P2): what the turn tracked, and a plain open Button. It draws the
// engine's own `TurnDuration` line first and one row under it: the counts, then the Button. The Button is a mouse target of
// the fullscreen layout only (design study S10: a click on a transcript Button reaches the mod there, and on the main screen
// it does not), so the main screen gets the counts alone. The text line under the answer is not drawn here: `turn.complete`
// returns it as a notice row.
// Spec: issue #69, the design study "Show what each turn tracked", section 5 ("Strip").
import type { RenderElement, RenderNode } from 'claude-code'
import type { DurationStrip } from '../core/interfaces/turns'
import { box, button, type TableElements, text } from './tree-data-table/el'

/** The key of the open Button: a hook that finds it names the strip of a duration line. */
export const STRIP_KEY = 'turn-strip-open'

/**
 * The engine's line, then the strip in one column. `press` is the open Button's work: it opens `/track` on the first entry
 * of the turn. Absent: the counts show and no Button is drawn (the main screen, where a click on it is not delivered).
 */
export function renderStrip(
  el: Pick<TableElements, 'Box' | 'Text' | 'Button'>,
  engine: RenderNode,
  strip: DurationStrip,
  press?: () => void | Promise<void>,
): RenderElement {
  const part = { wrap: 'truncate-end' } as const
  return box(
    el,
    { flexDirection: 'column' },
    engine,
    box(
      el,
      { columnGap: 1, marginLeft: 2 }, // under the words of the duration line, which follow its glyph and a space
      text(el, { ...part, dimColor: true }, strip.counts),
      ...(press !== undefined ? [button(el, { key: STRIP_KEY, plain: true, label: 'open', onPress: press })] : []),
    ),
  )
}
