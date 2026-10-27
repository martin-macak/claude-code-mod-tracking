// The Files section. Pure: it reads the view context and writes nothing. The rows sort by level, then the files that were
// written before the files that were only named before the files that were only read, then type, then path (issue #57).
// The band counts the files that were written, deleted or named; the note adds the count of the files that were only read, and
// so does the one line that the `/track` text prints in place of their rows (`textMore`).
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10. Plan: L5 Task 13, L6 A1.

import type { Json } from '../../core/interfaces/items'
import type { SectionSpec, ViewContext } from '../../core/interfaces/view'
import { byLevel } from '../../core/lib/levels'
import { fileRank, isOnlyRead, readOnlyLine } from './activity'
import type { FileConfig } from './config'
import { FILE_TYPES, fileTypeOf } from './file-type'
import { fileKind } from './kind'
import type { FileRecord } from './types'

const byPath = (a: FileRecord, b: FileRecord): number => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)

export function sections(ctx: ViewContext<FileConfig, Json>): readonly SectionSpec[] {
  const own = ctx.items
    .flatMap(item => fileKind.decode(item) ?? [])
    .sort(
      (a, b) =>
        byLevel(ctx.levelOf(a.key).level, ctx.levelOf(b.key).level) ||
        fileRank(b) - fileRank(a) ||
        FILE_TYPES.indexOf(fileTypeOf(a)) - FILE_TYPES.indexOf(fileTypeOf(b)) ||
        byPath(a, b),
    )
  if (own.length === 0) return []
  const reads = own.filter(isOnlyRead)
  const shown = own.length - reads.length
  return [
    {
      id: 'file',
      title: 'Files',
      note: { text: reads.length > 0 ? `${shown} files · ${reads.length} read` : `${shown} files` },
      rank: 70,
      band: { label: 'Files', count: shown, failing: 0, rank: 5 },
      rows: own.map(rec => fileKind.row(rec, ctx)),
      ...(reads.length > 0 ? { textMore: { line: readOnlyLine(reads.length), rows: reads.map(r => r.key) } } : {}),
    },
  ]
}
