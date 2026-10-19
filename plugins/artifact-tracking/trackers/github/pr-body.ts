// The refs inside one PR body (spec A9, 8.5): strip HTML comments, run the matchers, add closing refs.
// One level only: the caller never scans the body of a PR found this way.

import type { DiscoveredPr, GitHubRef, Ref } from '../../hooks/contracts'
import { LIMITS } from '../../hooks/contracts'
import { keyOf, prKey } from '../../hooks/model/keys'
import { extractRefs } from '../../hooks/scan/refs'

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

export function prBodyRefs(pr: DiscoveredPr, githubHosts: readonly string[]): Ref[] {
  const clean = stripHtmlComments(pr.body)
  const fromText = extractRefs(clean, {
    mode: 'full',
    defaultRepo: { host: pr.host, owner: pr.owner, repo: pr.repo },
    githubHosts,
  })
  // Closing refs go first: they are exact (type issue, with URL), so a text ref for the same item adds nothing.
  const closing: GitHubRef[] = pr.closing.map(c => ({
    category: 'github',
    host: c.host,
    owner: c.owner,
    repo: c.repo,
    number: c.number,
    type: 'issue',
    url: c.url,
  }))
  const seen = new Set<string>([prKey(pr)])
  const out: Ref[] = []
  for (const ref of [...closing, ...fromText]) {
    const key = keyOf(ref)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
    if (out.length >= LIMITS.maxBodyRefs) break
  }
  return out
}
