// The rows of the GitHub and Pull requests sections: an issue or a PR as the pane shows it. A PR row is the GitHub row
// with the branch in the type cell. Pure: it reads the record, the session repo fact and the level of the item.
// The cells keep the text the pane drew before L6; tests/item-sections.test.ts pins them.
// Plan: L5 Task 13, L6 A1.

import type { Json } from '../../core/interfaces/items'
import type { RepoRef } from '../../core/interfaces/ports'
import type { TreeRow, ViewContext } from '../../core/interfaces/view'
import { itemRow, type Tone, toned, viaPrefix } from '../../core/lib/rows'
import { compactIds } from '../../core/lib/text'
import { conflictNote, type MergeEnv, mergeChip } from './merge'
import { blockedHint } from './resolve'
import type { Checks, ConflictFiles, GitHubRecord } from './types'

/**
 * What a row reads of the view context. `merge` is what the lane knows of the merge state (issue #50). A caller with no
 * lane state leaves it out, and the rows then draw no merge chip, hint or file rows.
 */
export type GithubEnv = Pick<ViewContext, 'facts' | 'levelOf'> & { merge?: MergeEnv }

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
  const row = itemRow({
    id: item.key,
    owner: 'github',
    level: env.levelOf(item.key),
    dismiss: true,
    reasons: item.reasons,
    text: {
      key: unresolved || inSession ? `#${item.number}` : `${item.owner}/${item.repo}#${item.number}`,
      href: item.url,
      title: viaPrefix(item.via) + (item.title ?? (unresolved ? 'unresolved: no repo' : '')),
      type: item.type === 'pr' ? 'PR' : item.type === 'issue' ? 'Issue' : '',
      ...statusOf(item),
      ...CHECKS[item.checks ?? 'none'],
    },
  })
  // The merge chip is a badge of its own, in front of the checks, so a conflict hides no checks glyph. No chip: no badge.
  const chip = mergeChip(item, env.merge)
  return chip === null ? row : { ...row, extras: [toned(chip.text, chip.tone), ...(row.extras ?? [])] }
}

/** The id of the i-th child row under a conflicted PR. The id of a PR row is its key. */
const fileRowId = (key: string, i: number): string => `${key}#files:${i}`

/** The key of the PR a row belongs to: the id of a child row under a PR (a file, or a note) loses its suffix. */
export const prKeyOfRow = (id: string): string => id.replace(/#files:\d+$/, '')

/** One dim line under a conflicted PR: the answer of the `files` key when it is not a list of files. */
const noteRow = (item: GitHubRecord, i: number, text: string): TreeRow => ({
  id: fileRowId(item.key, i),
  owner: 'github',
  cells: { description: { text, dim: true } },
})

/** The rows under a conflicted PR that the `files` key looked into: one per file, or one line that says why not. */
function fileRows(item: GitHubRecord, found: ConflictFiles): TreeRow[] {
  if (found.pending) return [noteRow(item, 0, 'looking for the files…')]
  if (found.error !== undefined) return [noteRow(item, 0, `files unknown: ${found.error}`)]
  const files = found.files ?? []
  if (files.length === 0) return [noteRow(item, 0, 'no conflicts found locally: the local refs may be behind GitHub')]
  return [
    ...files.map(
      (file, i): TreeRow => ({ id: fileRowId(item.key, i), owner: 'github', cells: { description: { text: file } } }),
    ),
    ...((found.more ?? 0) > 0 ? [noteRow(item, files.length, `+${found.more} more`)] : []),
  ]
}

/**
 * A discovered PR in the Pull requests section: the GitHub row with the title without the via marker, the branch
 * (`→base` when stacked on a branch other than the default) in the type cell, and a merged or closed PR dimmed. The
 * checks are a badge, and so is the hint that says why a key is off: the pane drops the extras column when it is narrow.
 */
export function prRow(item: GitHubRecord, env: GithubEnv, defaultBranch: string | undefined): TreeRow {
  const base = githubRow(item, env)
  const stacked = defaultBranch !== undefined && item.baseRefName !== undefined && item.baseRefName !== defaultBranch
  const done = item.state === 'merged' || item.state === 'closed'
  const found = conflictNote(item, env.merge)?.files
  const files = found === undefined ? undefined : fileRows(item, found)
  const hint = blockedHint(item, env.merge, defaultBranch)
  return {
    ...base,
    cells: {
      ...base.cells,
      description: { text: item.title ?? '' },
      // A head branch keeps both ends; `→base` is cut at the end, so the arrow and the start of the base stay.
      type: stacked
        ? { text: compactIds(`→${item.baseRefName}`), clip: 'end' }
        : { text: compactIds(item.headRefName ?? ''), clip: 'middle' },
    },
    ...(hint !== undefined ? { extras: [...(base.extras ?? []), toned(hint, 'dim')] } : {}),
    ...(files !== undefined ? { children: files, expandedByDefault: true } : {}),
    ...(done ? { dim: true } : {}),
  }
}
