// The item kind of plain web links. A link has no status, so it has no refresh. It is the last kind to claim a URL.
// Plan: L5 Task 4 (K17: the static item class goes). Task 5 adds `claimUrl`.

import type { Claim, ItemKind } from '../../core/interfaces/items'
import { hostPath, normalizeUrl } from '../../core/lib/links'
import { sighted } from '../../core/lib/records'
import { webRow } from './rows'
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

/** A web URL longer than this is not tracked. It would bloat the plugin state and store. */
const MAX_WEB_URL = 2048

export const webKind: ItemKind<WebRecord> = {
  category: 'web',
  rank: 90,
  /** The last kind to claim an URL. In `urls-only` mode (tool output) only the kinds with an explicit URL claim. */
  claimUrl(url, label, ctx) {
    if (ctx.mode !== 'full' || url.length > MAX_WEB_URL) return null
    const ref: WebRef = { category: 'web', url, label: label !== undefined && label !== url ? label : hostPath(url) }
    return { category: 'web', key: webKeyOf(ref), source: ctx.source, at: ctx.now, fields: { url, label: ref.label } }
  },
  decode: item => (item.category === 'web' ? (item as WebRecord) : null),
  merge: (cur, seen) => (cur === null ? webRecord(refOf(seen), seen) : sighted(cur, seen)),
  row: webRow,
}
