// The prompt lines of the github tracker: one data line per issue or PR, in the order of the pane. The title is text
// from outside, so it is quoted and clipped. The ref and the facts are validated values. Pure.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.11. Plan: L7 Task 4 (S5, S9).

import type { ViewContext } from '../../core/interfaces/view'
import { promptLine, promptRecords } from '../../core/lib/prompt-text'
import { githubKind } from './kind'
import type { GitHubRecord } from './types'

const TITLE_MAX = 100

/** `owner/repo#N`, with the host in front when it is not github.com. `#N` while the repo is not known. */
function refOf(r: GitHubRecord): string {
  if (!r.owner || !r.repo) return `#${r.number}`
  const base = `${r.owner}/${r.repo}#${r.number}`
  return r.host && r.host.toLowerCase() !== 'github.com' ? `${r.host}/${base}` : base
}

/** The strongest reason, then the type, one of not found, draft or the state, and for a PR the checks and the review decision. */
function factsOf(r: GitHubRecord): string[] {
  const facts: string[] = [r.reasons.strongest]
  if (r.type === 'pr' || r.type === 'issue') facts.push(r.type)
  if (r.error?.kind === 'not-found') facts.push('not found')
  else if (r.isDraft) facts.push('draft')
  else if (r.state) facts.push(r.state)
  if (r.type === 'pr') {
    if (r.checks && r.checks !== 'none') facts.push(`checks ${r.checks}`)
    if (r.reviewDecision) facts.push(r.reviewDecision.toLowerCase().replace(/_/g, ' '))
  }
  return facts
}

/** One line per tracked issue or PR that the person has not dismissed. The composer caps the list. */
export function githubPrompt(ctx: Pick<ViewContext, 'items' | 'isDismissed'>): readonly string[] {
  return promptRecords(ctx, githubKind.decode).map(r =>
    promptLine(`github: ${refOf(r)}`, factsOf(r), r.title ?? '', TITLE_MAX),
  )
}
