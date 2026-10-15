// Item keys and the auto-only test (spec 6.2, A9). No state, no I/O. Scan, model and ui import these from here,
// so none of them has to pull in `registry.ts` or `discovered.ts` for a key.

import type { DiscoveredPr, ItemRecord, Ref } from '../contracts'
import { AUTO_SOURCES } from '../contracts'
import { normalizeUrl } from '../scan/links'

const withoutFragment = (url: string): string => {
  const i = url.indexOf('#')
  return i < 0 ? url : url.slice(0, i)
}

export function keyOf(ref: Ref): string {
  switch (ref.category) {
    case 'github':
      return ref.owner && ref.repo
        ? `gh:${ref.host.toLowerCase()}/${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`
        : `gh:?#${ref.number}`
    case 'jira':
      return `jira:${ref.site.toLowerCase()}/${ref.issueKey}`
    case 'web':
      return `web:${withoutFragment(normalizeUrl(ref.url))}`
  }
}

/** The item key of a Markdown file, `file:<path>`, where `path` is where the file landed (issue #28). */
export const fileKey = (path: string): string => `file:${path}`

/** The item key of the PR, `gh:<host>/<owner>/<repo>#<n>`. */
export function prKey(pr: DiscoveredPr): string {
  return keyOf({ category: 'github', host: pr.host, owner: pr.owner, repo: pr.repo, number: pr.number, type: 'pr' })
}

/** Every source is an auto source: no conversation mention backs the item. */
export function isAutoOnly(rec: ItemRecord): boolean {
  return rec.sources.length > 0 && rec.sources.every(s => AUTO_SOURCES.has(s))
}
