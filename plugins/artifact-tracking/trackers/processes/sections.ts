// The Processes section: background tasks, Monitor runs, Docker, tmux, screen and detached processes. Pure: it reads the
// view context and writes nothing. Title, note and band keep the text the pane drew before L6, and so does the Type cell;
// tests/tracker-sections.test.ts pins them. The Name cell holds the name of the process, which the Description cell held
// (issue #63, L2). The note reads the probe state, the fact `processes.ui`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10. Plan: L5 Task 14, L6 A1.

import type { Json } from '../../core/interfaces/items'
import type { SectionSpec, TreeRow, ViewContext } from '../../core/interfaces/view'
import { textCells } from '../../core/lib/rows'
import type { ProcessesConfig } from './config'
import { displayName } from './names'
import { processReasons } from './reasons'
import { asRows } from './rows'
import { ENDED_STATES, FAILED_STATES, STATE_TOKEN } from './states'
import type { ProcessRecord, ProcessUiState } from './types'
import { UI_FACT } from './watch'

/** The states that count as a failure: they draw red and the band counts them. */
const failing = (r: ProcessRecord): boolean => STATE_TOKEN[r.state] === 'failed'

/**
 * A process row can be neither dismissed nor marked. The Name cell is the name of the process, shown from `./` for a path
 * under the session root and from `~/` for a path under the home folder, and it keeps both ends when it is cut. The Type
 * cell is the kind. The Description cell is empty: the kind was once the Name cell too, as a short word (`bg`, `docker`),
 * and the name was the Description (issue #63, L2). The row has no level, so its facets hold none.
 */
function processRow(r: ProcessRecord, root: string | undefined, home: string | undefined): TreeRow {
  const status = { label: r.state, token: STATE_TOKEN[r.state] }
  return {
    id: r.id,
    owner: 'processes',
    cells: textCells({
      key: displayName(r.name, root, home),
      keyClip: 'middle',
      title: '',
      type: r.kind.replace('-', ' '),
      status,
    }),
    can: { dismiss: false, priority: false },
    reasons: processReasons(),
    facets: { status, firstSeen: r.firstSeen, kind: r.kind },
  }
}

/**
 * True for a row that is over and ended longer ago than its TTL: `failedTtlMs` for a failure, else `endedTtlMs`. A row
 * with no `endedAt` is never expired: the mod cannot date it. Rule: issue #49. `ENDED_STATES` names the end states.
 */
function expired(r: ProcessRecord, cfg: ProcessesConfig, now: number): boolean {
  if (!ENDED_STATES.has(r.state) || r.endedAt === undefined) return false
  return now - r.endedAt >= (FAILED_STATES.has(r.state) ? cfg.failedTtlMs : cfg.endedTtlMs)
}

/**
 * The ids of the rows over `max`. The oldest ended rows go first, by `endedAt` (a row with none, by its first sighting).
 * A live row never goes, so live rows alone may pass `max`. Rule: issue #49.
 */
function overCap(rows: readonly ProcessRecord[], max: number): ReadonlySet<string> {
  const extra = rows.length - max
  if (extra <= 0) return new Set()
  const ended = rows.filter(r => ENDED_STATES.has(r.state))
  ended.sort((a, b) => (a.endedAt ?? a.firstSeen) - (b.endedAt ?? b.firstSeen))
  return new Set(ended.slice(0, extra).map(r => r.id))
}

/** The Processes section. Left out when there is no row and no Docker issue to tell. */
export function sections(ctx: ViewContext<ProcessesConfig, Json>): readonly SectionSpec[] {
  const all = asRows(ctx.data)
  const ui = ctx.facts.read<Json>(UI_FACT) as unknown as ProcessUiState | undefined
  if (all.length === 0 && !ui?.dockerIssue) return []
  // The note, the band and the rows all read the shown rows. `/track show-all` and `hideEnded: false` show every row.
  // The TTL hides first. Then the rows over `maxRows` go, oldest ended first. Both count as hidden.
  const cfg = ctx.config.slice()
  const hiding = cfg.hideEnded && !ctx.hidden.showAll
  const fresh = hiding ? all.filter(r => !expired(r, cfg, ctx.now)) : all
  const capped = hiding ? overCap(fresh, cfg.maxRows) : new Set<string>()
  const rows = capped.size > 0 ? fresh.filter(r => !capped.has(r.id)) : fresh
  const hidden = all.length - rows.length
  return [
    {
      id: 'processes',
      title: 'Processes',
      note: { text: `${ui?.dockerIssue ?? `${rows.length} tracked`}${hidden > 0 ? ` (${hidden} hidden)` : ''}` },
      rank: 80,
      band: { label: 'Processes', count: rows.length, failing: rows.filter(failing).length, rank: 10 },
      rows: rows.map(r => processRow(r, ctx.root, ctx.home)),
    },
  ]
}
