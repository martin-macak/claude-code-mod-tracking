// The turns of the repo rows (issue #133, P1b of #69). A row is stamped with the turn of each visit that named the repo, so
// `lastTurn` moves when a later turn touches it again. `Traceable.turnsOf` hands the stamps to the pane, and the sightings tell
// the ledger which repos a lookup added (`new`) and which it saw again. The reason of a sighting is the one of the modes of
// the visits of that lookup: a read, or an edit that Claude made there in that turn. The rules of the stamps are in
// `core/lib/turn-span.ts`.

import type { Sightings, TurnSpan } from '../../core/interfaces/turns'
import { rowSightings, turnSpan } from '../../core/lib/turn-span'
import type { RepoMode } from './hints'
import { repoRowId } from './ids'
import { repoReasons } from './reasons'
import { asRepoRows } from './rows'
import type { RepoVisit } from './tracker'
import type { RepoRecord } from './types'

/** `Traceable.turnsOf` of the repos tracker: the first and the last turn of the row `rp:<key>`, or undefined. */
export function repoTurnsOf(data: readonly RepoRecord[] | undefined, rowId: string): TurnSpan | undefined {
  const row = asRepoRows(data).find(r => repoRowId(r.key) === rowId)
  return row === undefined ? undefined : turnSpan(row)
}

/**
 * The sightings of the repos that a lookup visited in `turn`. `held` is the list before the visits, `now` the list after:
 * a repo that the cap or a dismiss dropped has no row in `now` and is not listed. The reason comes from the modes of the
 * `visits` of this lookup, not from the row: a row keeps its `edit` for good, but a turn that only read the repo edited
 * nothing. An edit among the visits of a repo says `updated`, though the first visit was a read.
 */
export function repoSightings(
  turn: number,
  visits: readonly Pick<RepoVisit, 'key' | 'mode'>[],
  held: readonly RepoRecord[],
  now: readonly RepoRecord[],
): Sightings {
  const modes = new Map<string, RepoMode>()
  for (const v of visits) modes.set(v.key, v.mode === 'edit' || modes.get(v.key) === 'edit' ? 'edit' : 'read')
  return rowSightings(
    turn,
    [...modes].flatMap(([key, mode]) =>
      now.some(r => r.key === key)
        ? [
            {
              id: repoRowId(key),
              category: 'repo',
              reason: repoReasons({ mode }).strongest,
              held: held.find(r => r.key === key),
            },
          ]
        : [],
    ),
  )
}
