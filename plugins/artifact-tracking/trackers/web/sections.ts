// The Web links section. Pure: it reads the view context and writes nothing. Title, note and band keep the
// text the pane drew before L6; tests/item-sections.test.ts pins them.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10. Plan: L5 Task 13, L6 A1.

import type { Json } from '../../core/interfaces/items'
import type { SectionSpec, ViewContext } from '../../core/interfaces/view'
import { sortedByLevel } from '../../core/lib/rows'
import type { WebConfig } from './config'
import { webKind } from './kind'

export function sections(ctx: ViewContext<WebConfig, Json>): readonly SectionSpec[] {
  const own = sortedByLevel(
    ctx.items.flatMap(item => webKind.decode(item) ?? []),
    ctx.levelOf,
  )
  if (own.length === 0) return []
  return [
    {
      id: 'web',
      title: 'Web links',
      note: { text: `${own.length} links` },
      rank: 60,
      band: { label: 'Links', count: own.length, failing: 0, rank: 4 },
      rows: own.map(rec => webKind.row(rec, ctx)),
    },
  ]
}
