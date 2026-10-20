// The reason of a sighting, for the tests that build claims and records by hand. A source stands for a reason as in
// production (`reasonOfSource`).
import type { CoreReason, ReasonSet } from '../../core/interfaces/reasons'
import { addReason, reasonOfSource, reasonSet } from '../../core/lib/reasons'

export const reasonFor = (source: string): CoreReason => reasonOfSource(source)

/** The reasons of a record that one sighting from `source` made. */
export const reasonsFor = (source: string): ReasonSet => reasonSet(reasonFor(source))

/** The reasons of a record that a text named. */
export const MENTIONED: ReasonSet = reasonSet('mentioned')

/** The reasons of a record that only discovery found (the PR lane, or the body of a PR). */
export const DISCOVERED: ReasonSet = reasonSet('discovered')

/**
 * What a PR that the PR lane found carries: no channel, the reason `discovered` and the `lane` marker (issue #62:
 * `sources` holds channels only, so the lane no longer writes `auto` there). Spread it into a `GitHubRecord`.
 */
export const LANE = { sources: [] as string[], reasons: DISCOVERED, lane: true as const }

/**
 * The record as the conversation alone made it: one `prompt` channel, the reason `mentioned`, and no lane marker (the
 * key is left out, not set to undefined). Use it where a test needs a PR that the PR lane did not find.
 */
export function named<T extends { lane?: unknown }>(rec: T): T {
  const out = { ...rec, sources: ['prompt'], reasons: MENTIONED }
  delete out.lane
  return out
}

/** The reasons of a record that was seen from each of `sources`, the first one first. No source: a mention. */
export const reasonsOfSources = (sources: readonly string[]): ReasonSet =>
  sources.length === 0
    ? MENTIONED
    : sources.slice(1).reduce((set, s) => addReason(set, reasonFor(s)), reasonSet(reasonFor(sources[0]!)))

/** The reasons of a file record, from its counters, as the file kind makes them: made, edited, read, named. */
export function fileReasons(n: { created?: unknown; edits?: unknown; views?: unknown; mentions?: unknown }): ReasonSet {
  const seen: CoreReason[] = [
    ...(n.created ? (['created'] as const) : []),
    ...(n.edits ? (['updated'] as const) : []),
    ...(n.views ? (['read'] as const) : []),
    ...(n.mentions ? (['mentioned'] as const) : []),
  ]
  return seen.slice(1).reduce((set, r) => addReason(set, r), reasonSet(seen[0] ?? 'mentioned'))
}
