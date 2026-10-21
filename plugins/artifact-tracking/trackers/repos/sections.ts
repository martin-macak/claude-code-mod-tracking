// The Repos section: one row for each git repository the session read from or edited, oldest first. Pure: it reads the view
// context and writes nothing. Title, note, cell texts and band keep the text the pane drew before L6. The mode word takes
// its token and color from the mode (issue #63, L2): edit is active (green), read is none (plain).
// tests/tracker-sections.test.ts and tests/status-tokens.test.ts pin them.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10. Plan: L5 Task 14, L6 A1.

import type { RowStatus, SectionSpec, TreeRow, ViewContext } from '../../core/interfaces/view'
import { textCells } from '../../core/lib/rows'
import { compactIds } from '../../core/lib/text'
import type { ReposConfig } from './config'
import { repoRowId } from './ids'
import { repoReasons } from './reasons'
import { asRepoRows } from './rows'
import type { RepoRecord } from './types'

function repoRow(r: RepoRecord): TreeRow {
  // Owner decision (issue #63, L2, comment 6321134636): a repo the session edits is active and draws green, as on main; a repo
  // it only reads has no state to speak of, so the token is none and the word draws plain.
  const status: RowStatus = r.mode === 'edit' ? { label: 'edit', token: 'active' } : { label: 'read', token: 'none' }
  return {
    id: repoRowId(r.key),
    owner: 'repos',
    cells: textCells({
      key: compactIds(r.name),
      title: compactIds(r.branch ?? ''),
      type: compactIds(r.touchedBy.join(', ')),
      titleClip: 'middle',
      typeClip: 'middle',
      status,
    }),
    can: { dismiss: true, priority: false },
    reasons: repoReasons(r),
    facets: { status, firstSeen: r.firstSeen },
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
