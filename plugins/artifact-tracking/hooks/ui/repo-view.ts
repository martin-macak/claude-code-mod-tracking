// The Repos section of the pane and its band part. Pure: no `$`, no JSX, no clock.

import type { RepoRecord } from '../contracts'
import { repoRowId } from '../contracts'
import type { PaneRow, PaneSection } from './view'
import { compactIds } from './view'

function repoRows(rows: readonly RepoRecord[]): PaneRow[] {
  return rows
    .slice()
    .sort((a, b) => a.firstSeen - b.firstSeen)
    .map(r => ({
      id: repoRowId(r.key),
      depth: 0,
      key: compactIds(r.name),
      title: compactIds(r.branch ?? ''),
      type: compactIds(r.touchedBy.join(', ')),
      status: '',
      tone: 'plain' as const,
      foldable: false,
      folded: false,
      dismissId: repoRowId(r.key),
    }))
}

/** One row for each repo, oldest first. The x button dismisses a row. Null when there is none. */
export function repoSection(rows: readonly RepoRecord[]): PaneSection | null {
  if (rows.length === 0) return null
  return {
    id: 'repos',
    title: 'Repos',
    note: `${rows.length} tracked`,
    rows: repoRows(rows),
    layout: 'repos',
    dismissable: true,
  }
}

/** `Repos 2`. Null when there is no repo. */
export function repoBandPart(rows: readonly RepoRecord[]): string | null {
  return rows.length === 0 ? null : `Repos ${rows.length}`
}
