// The rows of the GitHub and Pull requests sections: an issue or a PR as the pane shows it. A PR row is the GitHub row
// with the branch in the type cell. Pure: it reads the record, the session repo fact and the level of the item.
// The cells keep the text the pane drew before L6; tests/item-sections.test.ts pins them.
// Plan: L5 Task 13, L6 A1.

import type { Json } from '../../core/interfaces/items'
import type { RepoRef } from '../../core/interfaces/ports'
import type { TreeRow, ViewContext } from '../../core/interfaces/view'
import { itemRow, type Tone, viaPrefix } from '../../core/lib/rows'
import { compactIds } from '../../core/lib/text'
import type { Checks, GitHubRecord } from './types'

/** What a row reads of the view context. */
export type GithubEnv = Pick<ViewContext, 'facts' | 'levelOf'>

const CHECKS: Record<Checks, { extra: string; extraTone?: Tone }> = {
  failure: { extra: '✗ checks', extraTone: 'bad' },
  pending: { extra: '… checks', extraTone: 'warn' },
  success: { extra: '✓ checks', extraTone: 'ok' },
  none: { extra: '' },
}

const lower = (s: string | undefined): string => (s ?? '').toLowerCase()

/** The repo of the session, from the fact the kind publishes. null or undefined: none, or not looked up. */
const sessionRepoOf = (env: Pick<GithubEnv, 'facts'>): RepoRef | null | undefined =>
  env.facts.read<Json>('session.repo') as unknown as RepoRef | null | undefined

/** The state of a record as the status cell shows it, and its tone. */
function statusOf(item: GitHubRecord): { status: string; tone: Tone } {
  if (item.error?.kind === 'not-found') return { status: 'not found', tone: 'bad' }
  if (item.isDraft) return { status: 'draft', tone: 'dim' }
  const tone = item.state === 'open' ? 'ok' : item.state === 'merged' || item.state === 'closed' ? 'dim' : 'plain'
  return { status: item.state ?? '', tone }
}

/** An issue or a PR in the GitHub section. A key in the session repo reads `#N`, any other `owner/repo#N`. */
export function githubRow(item: GitHubRecord, env: GithubEnv): TreeRow {
  const unresolved = !item.owner || !item.repo
  const s = sessionRepoOf(env)
  const inSession =
    !unresolved &&
    !!s &&
    lower(item.owner) === lower(s.owner) &&
    lower(item.repo) === lower(s.repo) &&
    lower(item.host) === lower(s.host)
  return itemRow({
    id: item.key,
    owner: 'github',
    level: env.levelOf(item.key),
    dismiss: true,
    text: {
      key: unresolved || inSession ? `#${item.number}` : `${item.owner}/${item.repo}#${item.number}`,
      href: item.url,
      title: viaPrefix(item.via) + (item.title ?? (unresolved ? 'unresolved: no repo' : '')),
      type: item.type === 'pr' ? 'PR' : item.type === 'issue' ? 'Issue' : '',
      ...statusOf(item),
      ...CHECKS[item.checks ?? 'none'],
    },
  })
}

/**
 * A discovered PR in the Pull requests section: the GitHub row with the title without the via marker, the branch
 * (`→base` when stacked on a branch other than the default) in the type cell, and a merged or closed PR dimmed. The
 * checks stay in the `extra` cell: the pane drops that column when it is narrow, where the legacy row joined the glyph
 * to the state.
 */
export function prRow(item: GitHubRecord, env: GithubEnv, defaultBranch: string | undefined): TreeRow {
  const base = githubRow(item, env)
  const stacked = defaultBranch !== undefined && item.baseRefName !== undefined && item.baseRefName !== defaultBranch
  const done = item.state === 'merged' || item.state === 'closed'
  return {
    ...base,
    cells: {
      ...base.cells,
      title: { text: item.title ?? '' },
      type: { text: compactIds(stacked ? `→${item.baseRefName}` : (item.headRefName ?? '')) },
    },
    ...(done ? { dim: true } : {}),
  }
}
