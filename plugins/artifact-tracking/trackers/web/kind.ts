// The item kind of plain web links. A link has no status, so it has no refresh. It is the last kind to claim a URL.
// Plan: L5 Task 4 (K17: the static item class goes). Task 5 adds `claimUrl`.

import type { Claim, ItemKind } from '../../core/interfaces/items'
import { normalizeUrl } from '../../core/lib/links'
import { sighted } from '../../core/lib/records'
import type { WebRecord, WebRef } from './types'

const withoutFragment = (url: string): string => {
  const i = url.indexOf('#')
  return i < 0 ? url : url.slice(0, i)
}

/** The item key: the normalised URL without its fragment. */
export const webKeyOf = (ref: Pick<WebRef, 'url'>): string => `web:${withoutFragment(normalizeUrl(ref.url))}`

/** The ref a claim carries: the kind's ref fields under the category. */
const refOf = (claim: Claim): WebRef => ({ category: 'web', ...claim.fields }) as unknown as WebRef

function webRecord(ref: WebRef, claim: Claim): WebRecord {
  return {
    key: webKeyOf(ref),
    category: 'web',
    url: ref.url,
    label: ref.label,
    sources: [claim.source],
    firstSeen: claim.at,
    lastSeen: claim.at,
    seenCount: 1,
  }
}

export const webKind: ItemKind<WebRecord> = {
  category: 'web',
  rank: 90,
  decode: item => (item.category === 'web' ? (item as WebRecord) : null),
  merge: (cur, seen) => (cur === null ? webRecord(refOf(seen), seen) : sighted(cur, seen)),
}
