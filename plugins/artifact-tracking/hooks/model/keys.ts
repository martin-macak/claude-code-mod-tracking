// Item keys and the auto-only test (spec 6.2, A9). No state, no I/O. Scan, model and ui import these from here,
// so none of them has to pull in `registry.ts` or `discovered.ts` for a key.

import { normalizeUrl } from '../../core/lib/links'
import type { ArtifactOrigin, DiscoveredPr, ItemRecord, Ref, Source } from '../contracts'
import { AUTO_SOURCES, githubKey } from '../contracts'

const withoutFragment = (url: string): string => {
  const i = url.indexOf('#')
  return i < 0 ? url : url.slice(0, i)
}

export function keyOf(ref: Ref): string {
  switch (ref.category) {
    case 'github':
      return ref.owner && ref.repo ? githubKey(ref.host, ref.owner, ref.repo, ref.number) : `gh:?#${ref.number}`
    case 'jira':
      return `jira:${ref.site.toLowerCase()}/${ref.issueKey}`
    case 'artifact':
      return `art:${ref.uuid}`
    case 'web':
      return `web:${withoutFragment(normalizeUrl(ref.url))}`
  }
}

/** The item key of a Markdown file, `file:<path>`, where `path` is where the file landed (issue #28). */
export const fileKey = (path: string): string => `file:${path}`

/** The row id of a Jira child: its parent's row id, a slash, its own key. The fold, the mark and the pane use it. */
export const childId = (parentId: string, nodeKey: string): string => `${parentId}/${nodeKey}`

/** The item key of the PR, `gh:<host>/<owner>/<repo>#<n>`. */
export function prKey(pr: DiscoveredPr): string {
  return keyOf({ category: 'github', host: pr.host, owner: pr.owner, repo: pr.repo, number: pr.number, type: 'pr' })
}

/** Every source is an auto source: no conversation mention backs the item. */
export function isAutoOnly(rec: ItemRecord): boolean {
  return rec.sources.length > 0 && rec.sources.every(s => AUTO_SOURCES.has(s))
}

/** An artifact is `published` once the session's Artifact tool wrote it, else `mentioned`. */
export function artifactOrigin(rec: { sources: readonly Source[] }): ArtifactOrigin {
  return rec.sources.includes('publish') ? 'published' : 'mentioned'
}
