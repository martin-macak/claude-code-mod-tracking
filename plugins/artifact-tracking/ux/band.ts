// The band above the prompt: one line with the counts, made from the sections that carry a band part, and its drawing.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10 "Other renderers". Plan: L6 Task 9, G17, G20.
import type { RenderElement, RenderNode } from 'claude-code'
import type { SectionSpec } from '../core/interfaces/view'
import { box, type TableElements, text } from './tree-data-table/el'

/**
 * `Links 2 · Repos 1 (1 ✗)`: each part is its label and count, plus ` (n ✗)` when some fail. A part with a zero count
 * is left out. The parts keep the order of the sections. Null when no part is left.
 */
export function bandText(sections: readonly SectionSpec[]): string | null {
  const parts = sections.flatMap(({ band }) =>
    band !== undefined && band.count > 0
      ? [`${band.label} ${band.count}${band.failing > 0 ? ` (${band.failing} ✗)` : ''}`]
      : [],
  )
  return parts.length > 0 ? parts.join(' · ') : null
}

/** The band Box, then what the engine draws there (`engine`), in one column. */
export function renderBand(el: Pick<TableElements, 'Box' | 'Text'>, line: string, engine: RenderNode): RenderElement {
  const part = { wrap: 'truncate-end' } as const
  return box(
    el,
    { flexDirection: 'column' },
    box(
      el,
      { columnGap: 1 },
      text(el, { ...part, dimColor: true }, 'tracking'),
      text(el, part, line),
      text(el, { ...part, dimColor: true }, '/track'),
    ),
    engine,
  )
}
