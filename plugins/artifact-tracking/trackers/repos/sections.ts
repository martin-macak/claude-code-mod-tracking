// The Repos section: one row for each git repository the session read from or edited, oldest first. Pure: it reads the view
// context and writes nothing. Title, note, cell texts, tones and band keep the text the pane drew before L6;
// tests/tracker-sections.test.ts pins them.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10. Plan: L5 Task 14, L6 A1.

import type { ColumnDef, SectionSpec, TreeRow, ViewContext } from '../../core/interfaces/view'
import { content, fixed, flex, textCells } from '../../core/lib/rows'
import { compactIds } from '../../core/lib/text'
import type { ReposConfig } from './config'
import { repoRowId } from './ids'
import { asRepoRows } from './rows'
import type { RepoRecord } from './types'

const COLUMNS: readonly ColumnDef[] = [
  { id: 'key', header: 'Repo', width: content(6, 24), role: 'tree' },
  { id: 'title', header: 'Branch', width: flex(10) },
  { id: 'type', header: 'Agents', width: content(undefined, 20), priority: 1 },
  // `edit` and `read` are 4 wide.
  { id: 'status', header: 'Mode', width: fixed(4) },
]

function repoRow(r: RepoRecord): TreeRow {
  const edit = r.mode === 'edit'
  return {
    id: repoRowId(r.key),
    owner: 'repos',
    cells: textCells({
      key: compactIds(r.name),
      title: compactIds(r.branch ?? ''),
      type: compactIds(r.touchedBy.join(', ')),
      status: edit ? 'edit' : 'read',
      tone: edit ? 'ok' : 'dim',
    }),
    can: { dismiss: true, priority: false },
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
      columns: COLUMNS,
      rows: [...rows].sort((a, b) => a.firstSeen - b.firstSeen).map(repoRow),
    },
  ]
}
