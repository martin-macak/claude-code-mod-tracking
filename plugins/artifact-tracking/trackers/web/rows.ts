// The row of a web link: the label, and the host and path of its URL. Pure. The cells keep the text the pane drew
// before L6; tests/item-sections.test.ts pins them.
// Plan: L5 Task 13, L6 A1.

import type { TreeRow, ViewContext } from '../../core/interfaces/view'
import { trimEnd } from '../../core/lib/links'
import { itemRow, viaPrefix } from '../../core/lib/rows'
import type { WebRecord } from './types'

/**
 * `host/path` of a URL, without scheme, query, fragment and trailing slash. The URL is read as written: no clipping, no
 * normalising (the label of a web record, `hostPath` in core/lib/links, is another text).
 */
function urlText(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)/i.exec(url)
  return m ? (m[1] ?? '') + trimEnd(m[2] ?? '', '/') : url
}

export function webRow(item: WebRecord, env: Pick<ViewContext, 'levelOf'>): TreeRow {
  return itemRow({
    id: item.key,
    owner: 'web',
    level: env.levelOf(item.key),
    dismiss: true,
    reasons: item.reasons,
    firstSeen: item.firstSeen,
    text: { key: item.label, href: item.url, title: viaPrefix(item.via) + urlText(item.url) },
  })
}
