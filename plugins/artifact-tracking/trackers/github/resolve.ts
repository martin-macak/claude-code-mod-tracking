// The checks behind the resolve and files keys of a conflicted PR, and the prompt the resolve key sends (issue #50).
// Pure: no `$`, no clock. The caller passes the record, what the lane noted, and the time.
// The mod never rebases, merges or pushes. The prompt asks Claude to do it in the session, under the permission rules of
// the person, and to ask before any push.

import { isLanePr } from './lane-pr'
import { isQueued, type MergeEnv } from './merge'
import type { GitHubRecord } from './types'

/**
 * The branch names that go into a prompt or a git argument: letters, digits and `. _ / + @ -`, and no leading dash or dot.
 * A name made by someone else must not add words to a prompt or an option to a command line. GitHub allows more.
 */
export const SAFE_REF = /^[A-Za-z0-9_][A-Za-z0-9._/+@-]*$/

/** A look for the conflicting files that has not ended after this long never will: the key may be pressed again. */
export const FILES_PENDING_MS = 3 * 60_000

/**
 * A check says yes with what the key needs, or no with `why` (for the toast of a press that cannot act). `hint` is the
 * short word the row shows when a key is off for a reason the person can see and fix. It is absent for a reason the row
 * says in another way (the PR is queued) or that is no news (no PR, not open, no conflict, stale values, no look yet).
 */
export type Check<T> = { ok: true; target: T } | { ok: false; why: string; hint?: string }

const no = (why: string, hint?: string): { ok: false; why: string; hint?: string } => ({
  ok: false,
  why,
  ...(hint !== undefined ? { hint } : {}),
})

/** What the resolve prompt says of a PR. */
export type ResolveTarget = {
  number: number
  url: string
  head: string
  base: string
  defaultBranch: string
  /** The worktree that has the head branch checked out. */
  path: string
}

/** What the files key needs of a PR: its branches, and the worktree when one has the head branch. */
export type FilesTarget = { head: string; base: string; path?: string }

/** The words a row shows when the resolve key is off. The `mark` column that draws them is 11 columns wide at most. */
export const HINT = {
  fork: 'fork PR',
  otherRepo: 'other repo',
  branch: 'odd branch',
  noWorktree: 'no worktree',
  noDefault: 'no default',
  path: 'odd path',
  url: 'odd url',
} as const

/** The gate both keys share: an open PR that the lane found, that GitHub reports CONFLICTING, that the lane looked at. */
function conflicted(rec: GitHubRecord | undefined, env: MergeEnv) {
  if (rec === undefined || rec.type !== 'pr') return no('no such PR')
  if (!isLanePr(rec) || rec.headRefName === undefined || rec.baseRefName === undefined)
    return no('the PR lane did not find this PR, so its branches are not known')
  if (rec.state !== 'open') return no('the PR is not open')
  if (rec.mergeable !== 'CONFLICTING') return no('GitHub does not report a conflict')
  if (!env.fresh) return no('gh cannot be asked, so the state is stale')
  const note = env.notes[rec.key]
  if (note === undefined) return no('the PR lane has not looked at it yet')
  // A fork PR has a head branch of the fork: a local branch of that name, if any, is another branch.
  if (rec.crossRepo) return no('the head branch is in a fork, not in this repo', HINT.fork)
  // A PR the session created in another repo (issue #158): its branches are that repo's, and git runs in the session repo.
  if (rec.otherRepo)
    return no('the PR is in another repo, so its branches are not branches of this one', HINT.otherRepo)
  if (!SAFE_REF.test(rec.headRefName) || !SAFE_REF.test(rec.baseRefName))
    return no('the branch name has a character that is not put in a prompt', HINT.branch)
  return { ok: true as const, rec, head: rec.headRefName, base: rec.baseRefName, note }
}

/**
 * Whether the resolve key works for a row, and with what. The reasons are for the toast of a press that cannot act. The
 * key is off, not hidden, when the answer is no (the footer keeps every key). The PR needs a worktree with its head
 * branch: Claude works there, and the prompt names the path.
 */
export function resolveCheck(
  rec: GitHubRecord | undefined,
  env: MergeEnv,
  defaultBranch: string | undefined,
): Check<ResolveTarget> {
  const gate = conflicted(rec, env)
  if (!gate.ok) return gate
  if (isQueued(gate.note, env.now)) return no('the resolve prompt was already sent')
  const path = gate.note.worktree
  if (path === undefined) return no(`no local worktree has the branch ${gate.head}`, HINT.noWorktree)
  if (defaultBranch === undefined) return no('the default branch is not known', HINT.noDefault)
  if (!SAFE_REF.test(defaultBranch))
    return no('the branch name has a character that is not put in a prompt', HINT.branch)
  if (/[\u0000-\u001f\u007f]/.test(path)) return no('the worktree path has a control character', HINT.path)
  if (!/^https?:\/\/\S+$/.test(gate.rec.url)) return no('the PR url is not one plain link', HINT.url)
  return {
    ok: true,
    target: { number: gate.rec.number, url: gate.rec.url, head: gate.head, base: gate.base, defaultBranch, path },
  }
}

/**
 * The short word for a conflicted PR whose resolve key is off, or undefined. The row and the key read the same check, so
 * the hint says what the key would say. A queued PR has none: its chip reads `queued`. The footer draws an off key dim and
 * inert, so the toast of a press never reaches a person for these reasons: the hint is where they read it.
 */
export function blockedHint(
  rec: GitHubRecord | undefined,
  env: MergeEnv | undefined,
  defaultBranch: string | undefined,
): string | undefined {
  if (env === undefined) return undefined
  const c = resolveCheck(rec, env, defaultBranch)
  return c.ok ? undefined : c.hint
}

/** Whether the files key works for a row. A look under way stands, unless it is older than `FILES_PENDING_MS`. */
export function filesCheck(rec: GitHubRecord | undefined, env: MergeEnv): Check<FilesTarget> {
  const gate = conflicted(rec, env)
  if (!gate.ok) return gate
  const found = gate.note.files
  if (found?.pending && env.now - found.at < FILES_PENDING_MS) return no('a look for the files is already under way')
  return {
    ok: true,
    target: {
      head: gate.head,
      base: gate.base,
      ...(gate.note.worktree !== undefined ? { path: gate.note.worktree } : {}),
    },
  }
}

/**
 * The text of the resolve key. The words and the guardrails are those of issue #50: rebase, never merge the base in, ask
 * before any push, and push only with `--force-with-lease`. One place, so a later setting can change it (`{number}`,
 * `{head}`, `{base}`, `{path}`, `{url}`).
 */
export function resolvePrompt(t: ResolveTarget): string {
  const note = t.base === t.defaultBranch ? '' : " (stacked: it targets another PR's branch)"
  return [
    `Resolve the merge conflicts on PR #${t.number} (${t.url}).`,
    `Head branch: ${t.head}. Base branch: ${t.base}${note}. Worktree: ${t.path}.`,
    '',
    '1. Work in that worktree. Leave every other worktree alone.',
    '2. Check git status first. If the worktree is dirty, stop and tell me.',
    `3. Fetch, then rebase ${t.head} onto origin/${t.base}. Do not merge the base in (linear history).`,
    `   If ${t.base} was already merged, or its PR was squash-merged, rebase onto origin/${t.defaultBranch}`,
    `   with \`git rebase --onto origin/${t.defaultBranch} <old base tip> ${t.head}\`.`,
    '4. Resolve each conflict. Keep the intent of both sides. Show me any conflict you are not sure about.',
    "5. Run the repo's build and tests that cover the changed files.",
    '6. Show me the result (branch state, test output). Ask me before you push.',
    '   Push only with --force-with-lease, and only after I say yes.',
  ].join('\n')
}
