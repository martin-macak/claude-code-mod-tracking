// The status token of a row (issue #63, L2): the color that each token draws in, the status cell that takes its color from
// the token, and the count of the rows that failed. Pure: no `$`, no I/O, no tracker named. A tracker maps its own states to
// a token; this is the one place that says what a token looks like, so no tracker picks a color for a status.
// Design study of issue #63, sections 5.2 and 5.4.

import type { Cell, ColorToken, RowStatus, StatusToken, TreeRow } from '../interfaces/view'

/**
 * The color token of each status token. `none` has no color, so its cell draws plain. `done` and `gone` share the muted
 * color: both are rows that no longer ask for the person.
 */
export const STATUS_COLOR: Readonly<Record<StatusToken, ColorToken | undefined>> = {
  failed: 'error',
  waiting: 'warning',
  active: 'success',
  done: 'inactive',
  gone: 'inactive',
  none: undefined,
}

/** The state of a row that has none to say: no word, no token. */
export const NO_STATUS: RowStatus = { label: '', token: 'none' }

/** The status cell: the label, in the color of its token. */
export function statusCell(status: RowStatus): Cell {
  const fg = STATUS_COLOR[status.token]
  return fg === undefined ? { text: status.label } : { text: status.label, fg }
}

/**
 * The failures in the rows, at every depth: what the title line of a group counts. It reads the token, never the text or
 * the color of a cell, and not the band of the section: an open PR with a merge conflict counts here, and the band counts
 * it apart. A row with no facets has not failed.
 *
 * A failure counts once. A row is `failed` when it failed itself or when a row below it failed: a folded workflow run is
 * `failed` because one of its agents failed, and the run row says `2 agents · 1 failed`. So a failed row counts only when
 * no row below it failed, and a row with failed rows below it counts them and not itself. Tradeoff: a failed agent with a
 * failed agent below it counts once.
 */
export function countFailed(rows: readonly TreeRow[]): number {
  return rows.reduce((n, r) => {
    const below = countFailed(r.children ?? [])
    return n + (below > 0 ? below : r.facets?.status?.token === 'failed' ? 1 : 0)
  }, 0)
}
