// The Processes section: background tasks, Monitor runs, Docker, tmux, screen and detached processes. Pure: it reads the
// view context and writes nothing. Title, note, cell texts, tones and band keep the text the pane drew before
// L6; tests/tracker-sections.test.ts pins them. The note reads the probe state, the fact `processes.ui`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10. Plan: L5 Task 14, L6 A1.

import type { Json } from '../../core/interfaces/items'
import type { ColumnDef, SectionSpec, TreeRow, ViewContext } from '../../core/interfaces/view'
import { content, flex, type Tone, textCells } from '../../core/lib/rows'
import type { ProcessesConfig } from './config'
import { processReasons } from './reasons'
import { asRows } from './rows'
import { ENDED_STATES, FAILED_STATES } from './states'
import type { ProcessKind, ProcessRecord, ProcessUiState } from './types'
import { UI_FACT } from './watch'

const COLUMNS: readonly ColumnDef[] = [
  { id: 'key', header: 'Kind', width: content(3, 7), role: 'tree' },
  { id: 'title', header: 'Name', width: flex(10) },
  { id: 'type', header: 'Type', width: content(undefined, 18), priority: 1 },
  { id: 'status', header: 'State', width: content(undefined, 10) },
]

/** The states that count as a failure: they draw red and the band counts them. */
const BAD: ReadonlySet<string> = new Set(['failed', 'killed', 'exited', 'unhealthy'])

const KIND_KEY: Record<ProcessKind, string> = {
  'background-task': 'bg',
  monitor: 'monitor',
  'docker-container': 'docker',
  'docker-compose': 'compose',
  tmux: 'tmux',
  screen: 'screen',
  'detached-process': 'pid',
}

const toneOf = (state: string): Tone =>
  BAD.has(state) ? 'bad' : state === 'up' || state === 'running' ? 'ok' : 'plain'

/** A process row can be neither dismissed nor marked. */
function processRow(r: ProcessRecord): TreeRow {
  return {
    id: r.id,
    owner: 'processes',
    cells: textCells({
      key: KIND_KEY[r.kind],
      title: r.name,
      type: r.kind.replace('-', ' '),
      status: r.state,
      tone: toneOf(r.state),
    }),
    can: { dismiss: false, priority: false },
    reasons: processReasons(),
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

/** The Processes section. Left out when there is no row and no Docker issue to tell. */
export function sections(ctx: ViewContext<ProcessesConfig, Json>): readonly SectionSpec[] {
  const all = asRows(ctx.data)
  const ui = ctx.facts.read<Json>(UI_FACT) as unknown as ProcessUiState | undefined
  if (all.length === 0 && !ui?.dockerIssue) return []
  // The note, the band and the rows all read the shown rows. `/track show-all` and `hideEnded: false` show every row.
  const cfg = ctx.config.slice()
  const hiding = cfg.hideEnded && !ctx.hidden.showAll
  const rows = hiding ? all.filter(r => !expired(r, cfg, ctx.now)) : all
  const hidden = all.length - rows.length
  return [
    {
      id: 'processes',
      title: 'Processes',
      note: { text: `${ui?.dockerIssue ?? `${rows.length} tracked`}${hidden > 0 ? ` (${hidden} hidden)` : ''}` },
      rank: 80,
      band: { label: 'Processes', count: rows.length, failing: rows.filter(r => BAD.has(r.state)).length, rank: 10 },
      columns: COLUMNS,
      rows: rows.map(processRow),
    },
  ]
}
