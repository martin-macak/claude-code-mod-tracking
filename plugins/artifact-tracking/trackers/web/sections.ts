// The Web links section. Pure: it reads the view context and writes nothing. Title, note, columns and band are
// today's (hooks/ui/view.ts), which the parity test pins.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10. Plan: L5 Task 13, L6 A1.

import type { Json } from '../../core/interfaces/items'
import type { ColumnDef, SectionSpec, ViewContext } from '../../core/interfaces/view'
import { content, flex, PRIO_COLUMN, sortedByLevel } from '../../core/lib/rows'
import type { WebConfig } from './config'
import { webKind } from './kind'

const COLUMNS: readonly ColumnDef[] = [
  PRIO_COLUMN,
  { id: 'key', header: 'Label', width: content(6, 24), role: 'tree' },
  { id: 'title', header: 'URL', width: flex(10) },
]

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
      columns: COLUMNS,
      rows: own.map(rec => webKind.row(rec, ctx)),
    },
  ]
}
