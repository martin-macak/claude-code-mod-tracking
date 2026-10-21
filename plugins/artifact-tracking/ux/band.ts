// The band above the prompt: one line with the counts, made from the sections that carry a band part, and its drawing.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10 "Other renderers". Plan: L6 Task 9, G17, G20.
import type { RenderElement, RenderNode } from 'claude-code'
import type { SectionSpec } from '../core/interfaces/view'
import { box, button, type TableElements, text } from './tree-data-table/el'

/**
 * `Links 2 · Repos 1 (1 ✗)`: each part is its label and count, plus ` (n ✗)` when some fail, and ` (n ✗ · m conflicts)`
 * when some conflict too. A part with a zero count is left out. The parts keep the order of the sections. Null when no
 * part is left.
 */
export function bandText(sections: readonly SectionSpec[]): string | null {
  const parts = sections.flatMap(({ band }) => {
    if (band === undefined || band.count <= 0) return []
    const conflicts = band.conflicts ?? 0
    const flags = [
      ...(band.failing > 0 ? [`${band.failing} ✗`] : []),
      ...(conflicts > 0 ? [`${conflicts} conflict${conflicts === 1 ? '' : 's'}`] : []),
    ]
    return [`${band.label} ${band.count}${flags.length > 0 ? ` (${flags.join(' · ')})` : ''}`]
  })
  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * The hotkey of the band Button that opens `/track` on the last turn's items (owner decision of 2026-10-21). A bare digit in
 * an empty prompt presses a band Button. The pane uses 0 to 3 and a survey 1 to 3, so 9 is free.
 */
export const TURN_KEY = '9'

/** The turn part of the band (issue #69): the words of the newest turn that tracked anything, and what its Button does. */
export interface TurnPart {
  readonly ord: number
  /** `+3 new · 1 seen again`. */
  readonly text: string
  /**
   * The press: open `/track` with the first entry of the turn selected. It returns its work, so the engine keeps the press
   * open while the work runs: a pane that a press asks for is placed at any width, one that nothing asked for needs 144 columns.
   * Absent: the words show and no Button is drawn. A band with a Button is a focus target of `ctrl+x Tab`, which then stops
   * there before it reaches the pane, so the Button stays out while the pane is open.
   */
  press?(): void | Promise<void>
}

/**
 * The band Box, then what the engine draws there (`engine`), in one column. `line` is the counts of the sections, null when
 * none has a count. The turn part follows it: `turn 7 +3 new · 1 seen again` and a plain Button `9: open`.
 */
export function renderBand(
  el: Pick<TableElements, 'Box' | 'Text' | 'Button'>,
  line: string | null,
  engine: RenderNode,
  turn?: TurnPart,
): RenderElement {
  const part = { wrap: 'truncate-end' } as const
  const { press } = turn ?? {}
  return box(
    el,
    { flexDirection: 'column' },
    box(
      el,
      { columnGap: 1 },
      text(el, { ...part, dimColor: true }, 'tracking'),
      ...(line !== null ? [text(el, part, line)] : []),
      ...(turn !== undefined ? [text(el, part, `turn ${turn.ord} ${turn.text}`)] : []),
      ...(press !== undefined
        ? [button(el, { key: 'turn-open', plain: true, hotkey: TURN_KEY, label: 'open', onPress: press })]
        : []),
      text(el, { ...part, dimColor: true }, '/track'),
    ),
    engine,
  )
}
