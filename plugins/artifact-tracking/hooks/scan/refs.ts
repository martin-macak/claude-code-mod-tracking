// Reference extraction: text -> GitHub, Jira, artifact and web refs (spec section 6.1).
// A binding over the capture scan and the item kinds (plan L5, Task 5): the old signatures stay, the work is done by
// `scanClaims` with the claims and scans of the shipped kinds. Task 15 moves it to the test fixtures.
// Pure code. No `$`, no I/O.

import { scanClaims } from '../../core/infra/capture'
import type { Json } from '../../core/interfaces/items'
import { parseRemote as parseGitRemote } from '../../core/lib/git'
import { scanContext } from '../../core/lib/kind-context'
import { commandArgs, hostPath } from '../../core/lib/links'
import { GITHUB_DEFAULTS } from '../../trackers/github/config'
import { HOST_ALIASES } from '../../trackers/github/remote'
import { parseGitHubUrl } from '../../trackers/github/urls'
import { parseJiraUrl } from '../../trackers/jira/urls'
import type { ExtractOptions, Ref, RepoRef } from '../contracts'
import { KINDS } from '../model/registry'

// These moved to their owners in plan L5, Tasks 4 and 5. The old callers read them here until Task 15.
export { commandArgs, hostPath, parseGitHubUrl, parseJiraUrl }

/** `owner/repo` of a git remote, with the host aliases of GitHub (`ssh.github.com`). */
export const parseRemote = (remote: string): RepoRef | null => parseGitRemote(remote, HOST_ALIASES)

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
