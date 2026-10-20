// A PR the PR lane found, told from a record that the conversation made. Pure: it reads one record.
// Issue #62: `sources` keeps channels only, so a lane PR is no longer marked by the source `auto`. The reason
// `discovered` says that discovery found the record; the `lane` marker says that the lane found this PR, not a PR body.

import type { GitHubRecord } from './types'

/**
 * True for a PR that the lane finds now: the `lane` marker and the reason `discovered` together.
 *
 * Both are needed. A record that was stored with the marker comes back from a `--resume` load without the reason
 * (`dropAuto` takes `discovered` away, and core does not know the marker). Until the first complete PR step sets both
 * again or clears the marker, that record reads as a PR the conversation named, as it did before the marker existed.
 */
export const isLanePr = (rec: GitHubRecord): boolean => rec.lane === true && rec.reasons.all.includes('discovered')
