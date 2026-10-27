// A PR the PR lane found, told from a record that the conversation made. Pure: it reads one record.
// Issue #62: `sources` keeps channels only, so a lane PR is no longer marked by the source `auto`. The reason
// `discovered` says that discovery found the record; the `lane` marker says that the lane found this PR, not a PR body.

import type { StoredItem } from '../../core/interfaces/items'
import type { GitHubRecord } from './types'
import { repoKey } from './urls'

/**
 * True for a PR that the lane finds now: the `lane` marker and the reason `discovered` together.
 *
 * Both are needed. A record that was stored with the marker comes back from a `--resume` load without the reason
 * (`dropAuto` takes `discovered` away, and core does not know the marker). Until the first complete PR step sets both
 * again or clears the marker, that record reads as a PR the conversation named, as it did before the marker existed.
 */
export const isLanePr = (rec: GitHubRecord): boolean => rec.lane === true && rec.reasons.all.includes('discovered')

/**
 * A PR the lane found earlier, in a repo that got no sure answer this step (issue #195): `heldRepos` holds the repo keys
 * (`repoKey`). The prune leaves such a record its marker, as it does for a created PR that got no answer. The caller
 * skips a PR that the reply returned: it was read, so its marker follows the reply (`applyDiscovery`). This predicate reads
 * a stored record, so a value of another shape is no lane PR.
 */
export function isHeldLanePr(rec: StoredItem, heldRepos: ReadonlySet<string>): boolean {
  const { host, owner, repo, lane } = rec as Partial<GitHubRecord>
  return (
    rec.category === 'github' &&
    lane === true &&
    typeof host === 'string' &&
    typeof owner === 'string' &&
    typeof repo === 'string' &&
    heldRepos.has(repoKey({ host, owner, repo }))
  )
}

/**
 * A PR the lane found earlier in a repo other than the session repo (issue #195): the `lane` marker and `otherRepo`. Each
 * repo answers for these on its own, so a reply that is not complete for the session repo still reconciles them
 * (`applyDiscovery`). A value of another shape is no lane PR.
 */
export function isForeignLanePr(rec: StoredItem): boolean {
  const { lane, otherRepo } = rec as Partial<GitHubRecord>
  return rec.category === 'github' && lane === true && otherRepo === true
}

/**
 * A PR the lane found earlier in the session repo: the `lane` marker and no `otherRepo`. Only a reply that is complete for
 * the session repo says that the lane finds such a PR no more, so any other reply holds it (`applyDiscovery`, issue #195).
 * A value of another shape is no lane PR.
 */
export function isSessionLanePr(rec: StoredItem): boolean {
  return rec.category === 'github' && (rec as Partial<GitHubRecord>).lane === true && !isForeignLanePr(rec)
}
