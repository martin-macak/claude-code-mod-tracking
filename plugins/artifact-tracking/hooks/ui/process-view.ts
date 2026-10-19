// The Processes section of the pane and its band part, as the legacy draw path reads them. The tracker draws its own
// section now (`trackers/processes/sections.ts`); L6 deletes this file with the rest of `hooks/ui/`.
import type { ProcessRecord, ProcessUiState } from '../../trackers/processes/types'
import type { PaneSection } from './view'

const bad = new Set(['failed', 'killed', 'exited', 'unhealthy'])

const kindKey: Record<ProcessRecord['kind'], string> = {
  'background-task': 'bg',
  monitor: 'monitor',
  'docker-container': 'docker',
  'docker-compose': 'compose',
  tmux: 'tmux',
  screen: 'screen',
  'detached-process': 'pid',
}

export function processBandPart(rows: readonly ProcessRecord[]): string | null {
  if (rows.length === 0) return null
  const failures = rows.filter(r => bad.has(r.state)).length
  return `Processes ${rows.length}${failures > 0 ? ` (${failures} ✗)` : ''}`
}

export function processSection(rows: readonly ProcessRecord[], ui: ProcessUiState): PaneSection | null {
  if (rows.length === 0 && !ui.dockerIssue) return null
  const note = ui.dockerIssue ?? `${rows.length} tracked`
  return {
    id: 'processes',
    title: 'Processes',
    note,
    layout: 'items',
    rows: rows.map(r => ({
      id: r.id,
      depth: 0,
      key: kindKey[r.kind],
      title: r.name,
      type: r.kind.replace('-', ' '),
      status: r.state,
      tone: bad.has(r.state) ? 'bad' : r.state === 'up' || r.state === 'running' ? 'ok' : 'plain',
      foldable: false,
      folded: false,
    })),
  }
}
