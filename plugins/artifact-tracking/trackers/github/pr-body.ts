// The refs inside one PR body (spec A9, 8.5): strip HTML comments, run the scan of the kinds, add closing refs.
// One level only: the caller never scans the body of a PR found this way.

import type { Claim } from '../../core/interfaces/items'
import type { RepoRef } from '../../core/interfaces/ports'
import { GITHUB_DEFAULTS } from './config'
import type { DiscoveredPr } from './types'
import { githubKey, prKey } from './urls'

/**
 * Replaces each `<!--` ... `-->` with one space. The first `-->` ends a comment, as GitHub renders it.
 * An unclosed `<!--` removes the rest of the text. Linear: `indexOf` only moves forward.
 */
export function stripHtmlComments(text: string): string {
  let out = ''
  let i = 0
  for (;;) {
    const open = text.indexOf('<!--', i)
    if (open < 0) return out + text.slice(i)
    out += text.slice(i, open)
    const close = text.indexOf('-->', open + 4)
    if (close < 0) return out
    out += ' '
    i = close + 3
  }
}

/** The scan of a PR body: the claims the kinds find in `text`, reading a bare `#N` as an issue of `repo`. */
export type BodyScan = (text: string, repo: RepoRef) => readonly Claim[]

/**
 * The claims of one PR: its closing issues first, then the claims in the body text, at most `max` (`maxBodyRefs`). The
 * PR itself and a key seen before are left out. A claim carries source `pr-body`; the step stamps the time (`at` is 0 here).
 */
export function prBodyRefs(pr: DiscoveredPr, scanBody: BodyScan, max: number = GITHUB_DEFAULTS.maxBodyRefs): Claim[] {
  const clean = stripHtmlComments(pr.body)
  const fromText = scanBody(clean, { host: pr.host, owner: pr.owner, repo: pr.repo })
  // Closing refs go first: they are exact (type issue, with URL), so a text ref for the same item adds nothing.
  const closing: Claim[] = pr.closing.map(c => ({
    category: 'github',
    key: githubKey(c.host, c.owner, c.repo, c.number),
    source: 'pr-body',
    at: 0,
    fields: { host: c.host, owner: c.owner, repo: c.repo, number: c.number, type: 'issue', url: c.url },
  }))
  const seen = new Set<string>([prKey(pr)])
  const out: Claim[] = []
  for (const claim of [...closing, ...fromText]) {
    if (seen.has(claim.key)) continue
    seen.add(claim.key)
    out.push(claim)
    if (out.length >= max) break
  }
  return out
}
