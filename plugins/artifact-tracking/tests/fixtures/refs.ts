// Reference extraction: text -> GitHub, Jira, artifact and web refs (spec section 6.1).
// A test binding over the capture scan and the item kinds (plan L5, Tasks 5 and 15): the old signatures stay, the work is
// done by `scanClaims` with the claims and scans of the shipped kinds.
// Pure code. No `$`, no I/O.

import { scanClaims } from '../../core/infra/capture'
import type { Claim, Json } from '../../core/interfaces/items'
import { scanContext } from '../../core/lib/kind-context'
import { commandArgs, hostPath } from '../../core/lib/links'
import { GITHUB_DEFAULTS } from '../../trackers/github/config'
import { parseRemote } from '../../trackers/github/remote'
import { parseGitHubUrl } from '../../trackers/github/urls'
import { parseJiraUrl } from '../../trackers/jira/urls'
import type { ExtractOptions, Ref, RepoRef } from './contracts'
import { claimsOf } from './keys'
import { KINDS } from './registry'

// These moved to their owners in plan L5, Tasks 4, 5 and 15. The tests read them here.
export { commandArgs, hostPath, parseGitHubUrl, parseJiraUrl, parseRemote }

/** A `Ref` has no file member: a Markdown file is found by its own path, not by a link. */
export const REF_KINDS = KINDS.filter(kind => kind.category !== 'file')

/** Refs found in `text`, unique, in order of appearance. */
export function extractRefs(text: string, opts: ExtractOptions): Ref[] {
  const ctx = scanContext({
    mode: opts.mode,
    purpose: opts.strictShortRefs ? 'capture' : 'lookup',
    facts: {
      'session.repo': (opts.defaultRepo ?? null) as unknown as Json,
      'github.hosts': [...(opts.githubHosts ?? [])],
    },
    slice: { shortRefKeywords: [...(opts.shortRefWords ?? GITHUB_DEFAULTS.shortRefKeywords)] },
  })
  return scanClaims(text, opts.mode, REF_KINDS, ctx).map(c => ({ category: c.category, ...c.fields }) as unknown as Ref)
}

/** The claims in the text of a PR body, as the PR lane scans it: a bare `#N` is an issue of `repo`. Source `pr-body`, time 0. */
export function scanBody(text: string, repo: RepoRef): Claim[] {
  return claimsOf(extractRefs(text, { mode: 'full', defaultRepo: repo, githubHosts: [] }), 'pr-body', 0)
}
