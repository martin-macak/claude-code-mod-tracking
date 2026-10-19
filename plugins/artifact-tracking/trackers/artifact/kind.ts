// The item kind of Claude artifacts (issue #29): its key, its record and the rules for the name of a page seen twice.
// No tool reads its status, so it has no refresh. A publish with the Artifact tool tracks the page (source `publish`), a
// delete marks its row; a page that no row knows gets no row. An error, a refusal or another action changes nothing.
// Plan: L5 Task 4 (K17: the static item class goes), K4 (`fold`, `migrate`). Task 5 adds `claimUrl`; Task 8 the Artifact
// tool call, `replayWins` and the delete claim.

import type { Claim, ItemKind, JsonObject } from '../../core/interfaces/items'
import { type BaseRecord, sighted } from '../../core/lib/records'
import { artifactEvent } from './artifact-tool'
import { artifactIdOf, artifactKeyOf, parseArtifactUrl } from './artifact-url'
import { artifactFromWeb, artifactOrigin } from './records'
import { artifactRow } from './rows'
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
  /** A mention of a page in text. A tool output (`urls-only`) names the pages of a publish call, not these. */
  claimUrl(url, label, ctx) {
    const ref = ctx.mode === 'full' ? parseArtifactUrl(url, label) : null
    if (!ref) return null
    const { category, ...fields } = ref
    return {
      category,
      key: artifactKeyOf(ref),
      source: ctx.source,
      at: ctx.now,
      fields: fields as unknown as JsonObject,
    }
  },
  /** One Artifact call: `ev.input` as the model gave it, `ev.result` as the tool answered. */
  fromTool: {
    Artifact: async (ev, ctx) => {
      const found = artifactEvent(ev.input, ev.result)
      if (!found) return []
      if (found.kind === 'deleted')
        return [{ category: 'artifact', key: found.key, source: 'publish', at: ctx.now, fields: { deleted: true } }]
      const { category, ...fields } = found.ref
      return [
        {
          category,
          key: artifactKeyOf(found.ref),
          source: 'publish',
          at: ctx.now,
          fields: fields as unknown as JsonObject,
        },
      ]
    },
  },
  decode: item => (item.category === 'artifact' ? (item as ArtifactRecord) : null),
  merge(cur, seen) {
    // A delete marks the row (R12). With no row there is nothing to mark, and a marked row stays as it is.
    if (seen.fields.deleted === true) return cur && !cur.deleted ? { ...cur, deleted: true } : cur
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
  /** A transcript knows more than a stored copy of a page only when it saw the publish or the delete after the flush. */
  replayWins: (fresh, stored) =>
    (artifactOrigin(fresh) === 'published' && artifactOrigin(stored) === 'mentioned') ||
    (!!fresh.deleted && !stored.deleted),
  row: artifactRow,
}
