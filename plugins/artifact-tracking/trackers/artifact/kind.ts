// The item kind of Claude artifacts (issue #29): its key, its record and the rules for the name of a page seen twice.
// No tool reads its status, so it has no refresh. Plan: L5 Task 4 (K17: the static item class goes), K4 (`fold`, `migrate`).
// Task 5 adds `claimUrl`; Task 8 the Artifact tool call, `replayWins` and the delete claim.

import type { Claim, ItemKind } from '../../core/interfaces/items'
import { type BaseRecord, sighted } from '../../core/lib/records'
import { artifactIdOf, artifactKeyOf } from './artifact-url'
import { artifactFromWeb } from './records'
import type { ArtifactRecord, ArtifactRef } from './types'

export { artifactKeyOf }

// ---------------------------------------------------------------- artifact names (design study on #29, G6)

/** `rank`: 3 a publish title on a sighting, 2 a stored name of a published item, 1 any other name, 0 the id. */
type Named = { url: string; label: string; published: boolean; rank: number }

function named(rec: ArtifactRecord): Named {
  const published = rec.sources.includes('publish')
  const rank = rec.label === artifactIdOf(rec.url) ? 0 : published ? 2 : 1
  return { url: rec.url, label: rec.label, published, rank }
}

/**
 * Name and URL of one artifact seen twice. A published side gives the URL. The better name wins and a tie keeps
 * `a`, so a mention never renames a published item, while the title of a new publish does (a rename).
 * An id label follows the URL it came from.
 */
function joinNames(out: ArtifactRecord, a: Named, b: Named): void {
  out.url = b.published && !a.published ? b.url : a.url
  const best = b.rank > a.rank ? b : a
  out.label = best.rank === 0 ? artifactIdOf(out.url) : best.label
}

// ---------------------------------------------------------------- the kind

/** The ref a claim carries: the kind's ref fields under the category. */
const refOf = (claim: Claim): ArtifactRef => ({ category: 'artifact', ...claim.fields }) as unknown as ArtifactRef

function artifactRecord(ref: ArtifactRef, claim: Claim): ArtifactRecord {
  return {
    key: artifactKeyOf(ref),
    category: 'artifact',
    url: ref.url,
    label: ref.label,
    sources: [claim.source],
    firstSeen: claim.at,
    lastSeen: claim.at,
    seenCount: 1,
  }
}

export const artifactKind: ItemKind<ArtifactRecord> = {
  category: 'artifact',
  rank: 30,
  decode: item => (item.category === 'artifact' ? (item as ArtifactRecord) : null),
  merge(cur, seen) {
    const ref = refOf(seen)
    if (cur === null) return artifactRecord(ref, seen)
    const next = sighted(cur, seen)
    const rank = ref.titled ? 3 : ref.label === artifactIdOf(ref.url) ? 0 : 1
    joinNames(next, named(cur), { url: ref.url, label: ref.label, published: seen.source === 'publish', rank })
    return next
  },
  fold(winner, loser, out) {
    joinNames(out, named(winner), named(loser))
    if (loser.deleted) out.deleted = true
    return out
  },
  migrate: item => (item.category === 'web' ? artifactFromWeb(item as BaseRecord) : null),
}
