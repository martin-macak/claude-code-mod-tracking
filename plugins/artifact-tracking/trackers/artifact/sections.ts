// The Artifacts section. Pure: it reads the view context and writes nothing. Title, note, columns and band keep
// the text the pane drew before L6; tests/item-sections.test.ts pins them.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10. Plan: L5 Task 13, L6 A1.

import type { Json } from '../../core/interfaces/items'
import type { ColumnDef, SectionSpec, ViewContext } from '../../core/interfaces/view'
import { content, flex, PRIO_COLUMN, sortedByLevel } from '../../core/lib/rows'
import type { ArtifactConfig } from './config'
import { artifactKind } from './kind'

const COLUMNS: readonly ColumnDef[] = [
  PRIO_COLUMN,
  { id: 'key', header: 'Name', width: content(6, 24), role: 'tree' },
  { id: 'title', header: 'Id', width: flex(8) },
  { id: 'type', header: 'Origin', width: content(undefined, 9), priority: 1 },
  { id: 'status', header: 'State', width: content(undefined, 8) },
]

export function sections(ctx: ViewContext<ArtifactConfig, Json>): readonly SectionSpec[] {
  const own = sortedByLevel(
    ctx.items.flatMap(item => artifactKind.decode(item) ?? []),
    ctx.levelOf,
  )
  if (own.length === 0) return []
  return [
    {
      id: 'artifact',
      title: 'Artifacts',
      note: { text: `${own.length} artifacts` },
      rank: 40,
      band: { label: 'Artifacts', count: own.filter(i => !i.deleted).length, failing: 0, rank: 3 },
      columns: COLUMNS,
      rows: own.map(rec => artifactKind.row(rec, ctx)),
    },
  ]
}
