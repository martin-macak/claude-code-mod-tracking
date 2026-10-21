// The Repos section: one row for each git repository the session read from or edited, oldest first. Pure: it reads the view
// context and writes nothing. Title, note, cell texts, tones and band keep the text the pane drew before L6;
// tests/tracker-sections.test.ts pins them.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10. Plan: L5 Task 14, L6 A1.

import type { SectionSpec, TreeRow, ViewContext } from '../../core/interfaces/view'
import { textCells } from '../../core/lib/rows'
import { compactIds } from '../../core/lib/text'
import type { ReposConfig } from './config'
import { repoRowId } from './ids'
import { repoReasons } from './reasons'
import { asRepoRows } from './rows'
import type { RepoRecord } from './types'

function repoRow(r: RepoRecord): TreeRow {
  const edit = r.mode === 'edit'
  return {
    id: repoRowId(r.key),
    owner: 'repos',
    cells: textCells({
      key: compactIds(r.name),
      title: compactIds(r.branch ?? ''),
      type: compactIds(r.touchedBy.join(', ')),
      titleClip: 'middle',
      typeClip: 'middle',
      status: edit ? 'edit' : 'read',
      tone: edit ? 'ok' : 'dim',
    }),
    can: { dismiss: true, priority: false },
    reasons: repoReasons(r),
  }
}

/** The Repos section. Left out when no repo was found. */
export function sections(ctx: ViewContext<ReposConfig, RepoRecord[]>): readonly SectionSpec[] {
  const rows = asRepoRows(ctx.data)
  if (rows.length === 0) return []
  return [
    {
      id: 'repos',
      title: 'Repos',
      note: { text: `${rows.length} tracked` },
      rank: 50,
      band: { label: 'Repos', count: rows.length, failing: 0, rank: 6 },
      rows: [...rows].sort((a, b) => a.firstSeen - b.firstSeen).map(repoRow),
    },
  ]
}
