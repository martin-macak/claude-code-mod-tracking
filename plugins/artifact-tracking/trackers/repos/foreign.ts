// The branches of the foreign repos that the PR lane polls (issue #195). A foreign repo is a Repos row with a GitHub-shaped
// remote that the session visited. The session proves a branch there by standing on it: each toplevel it visited (the roots of
// the row) gives the branch it has, or the branch it had at the last visit once git no longer lists it. The repos tracker runs
// one `git worktree list` per polled repo and round and publishes the fact `repos.branches`. The github tracker reads the fact
// by name: a tracker imports no other. Pure: the git calls come in through `PollGit`, and nothing is kept between rounds.

import type { RepoRef } from '../../core/interfaces/ports'
import { isRecord } from '../../core/lib/json'
import { findByPath, type GitWorktree } from '../../core/lib/porcelain'
import { rootsOf } from './rows'
import type { RepoRecord, RepoRoot } from './types'

export const FACT_REPO_BRANCHES = 'repos.branches'

/** A foreign repo and the branches the session proved there. Owner and repo keep the case of the remote. */
export type ForeignBranches = RepoRef & { branches: string[] }

/** The fact. `overflow` counts the repos that qualified and were not polled, over `trackers.repos.pollRepos`. */
export type BranchesOfRepos = { repos: ForeignBranches[]; overflow: number }

/** A repo the lane polls: its GitHub identity, its row key and the toplevels that prove its branches. */
export type PollTarget = { key: string; ref: RepoRef; roots: RepoRoot[] }

const KEY = /^remote:([^/:]+)\/([^/]+)\/([^/]+)$/

/**
 * The GitHub identity of a row: a `remote:<host>/<owner>/<repo>` key and the name `<Owner>/<Repo>` in the case of the
 * remote. The key is lower case, so a name that is not the same repo gives the lower-case parts. Another key (a remote with
 * sub-groups or a port, a `file:` path, `local:`) is no GitHub repo. A host that is not GitHub passes: the lane asks `gh`
 * about its login once and holds the repo when it is refused.
 */
export function githubRefOf(row: Pick<RepoRecord, 'key' | 'name'>): RepoRef | null {
  const m = KEY.exec(row.key)
  if (!m) return null
  const [host, owner, repo] = [m[1]!, m[2]!, m[3]!]
  const [o, r] = row.name.split('/')
  const cased = o?.toLowerCase() === owner && r?.toLowerCase() === repo
  return { host, owner: cased ? o! : owner, repo: cased ? r! : repo }
}

/**
 * The repos to poll: a GitHub identity and at least one root, edit before read, then the newest visit, at most `cap`. The
 * row list holds no dismissed repo and no noise folder already. `overflow` counts the repos over the cap. A cap of 0 turns
 * the poll off: nothing is polled and nothing overflows.
 */
export function pollTargets(rows: readonly RepoRecord[], cap: number): { targets: PollTarget[]; overflow: number } {
  if (cap <= 0) return { targets: [], overflow: 0 }
  const found = rows
    .map((row, i) => ({ row, i, ref: githubRefOf(row), roots: rootsOf(row) }))
    .filter(t => t.ref !== null && t.roots.length > 0)
    .sort(
      (a, b) =>
        Number(b.row.mode === 'edit') - Number(a.row.mode === 'edit') || b.row.lastSeen - a.row.lastSeen || a.i - b.i,
    )
  return {
    targets: found.slice(0, cap).map(t => ({ key: t.row.key, ref: t.ref as RepoRef, roots: t.roots })),
    overflow: Math.max(0, found.length - cap),
  }
}

/**
 * The branches the session proved in one repo. The branch of each toplevel that git lists as live comes first, newest visit
 * first: a detached or bare toplevel adds none. Then the branch each toplevel had at its last visit, for each toplevel that
 * is gone (removed, or not listed any more), as the auto tracker keeps polling the branch of a removed worktree. `list`
 * null: git could not say, so every toplevel counts as gone. Not every worktree of the repo: the worktree of another
 * session proves nothing.
 */
export function provenBranches(roots: readonly RepoRoot[], list: readonly GitWorktree[] | null): string[] {
  const live: string[] = []
  const gone: string[] = []
  for (const root of roots) {
    const rec = list ? findByPath(list, root.path) : undefined
    if (rec && rec.prunable === undefined) {
      if (rec.branch !== undefined && !rec.bare) live.push(rec.branch)
    } else if (root.branch !== undefined) gone.push(root.branch)
  }
  return [...live, ...gone]
}

const repoOrder = (r: RepoRef): string => `${r.host}/${r.owner}/${r.repo}`.toLowerCase()

/**
 * The fact of the repos found. The repos are sorted by repo and the branches of each are sorted, so the text depends on what
 * was proven and not on the order of the rows, the roots or the visits: a publish that finds the same branches changes
 * nothing, and the lane starts no step for it (Facts compares text). A repo with no branch is left out.
 */
function factOf(found: readonly ForeignBranches[], overflow: number): BranchesOfRepos {
  const repos = found
    .map(f => ({ ...f, branches: [...new Set(f.branches)].sort() }))
    .filter(f => f.branches.length > 0)
    .sort((a, b) => {
      const [x, y] = [repoOrder(a), repoOrder(b)]
      return x < y ? -1 : x > y ? 1 : 0
    })
  return { repos, overflow }
}

/** The fact from the rows alone, with no git: the branch of each root at its last visit. For `init`, a restore and `/track clear`. */
export function storedFact(rows: readonly RepoRecord[], cap: number): BranchesOfRepos {
  const { targets, overflow } = pollTargets(rows, cap)
  return factOf(
    targets.map(t => ({ ...t.ref, branches: provenBranches(t.roots, null) })),
    overflow,
  )
}

/** What a poll reads of the rows: the polled repos and their roots. A change of it is a reason to poll again. */
export const pollKey = (rows: readonly RepoRecord[], cap: number): string =>
  JSON.stringify(pollTargets(rows, cap).targets.map(t => [t.key, t.roots]))

/**
 * The repos of a published fact, read back for the next round. A value that is not the fact reads as none. A poll that git
 * cannot answer keeps what the last good poll proved (see `pollForeign`).
 */
export function reposOfFact(v: unknown): ForeignBranches[] {
  if (!isRecord(v) || !Array.isArray(v.repos)) return []
  const out: ForeignBranches[] = []
  for (const e of v.repos) {
    if (!isRecord(e) || typeof e.host !== 'string' || typeof e.owner !== 'string' || typeof e.repo !== 'string')
      continue
    if (!Array.isArray(e.branches)) continue
    out.push({ host: e.host, owner: e.owner, repo: e.repo, branches: e.branches.filter(b => typeof b === 'string') })
  }
  return out
}

/** The two git calls of a poll. The repos tracker runs them with its breaker, its timeout and its caches. */
export interface PollGit {
  /**
   * The git common dir of a repo: of the first of its toplevels that git can enter, so a toplevel that is gone costs one
   * lookup. The tracker keeps the answer by row `key` for the load, and forgets it when a list fails. null: no toplevel can
   * be entered.
   */
  commonDir(key: string, roots: readonly RepoRoot[]): Promise<string | null>
  /** `git -C <common dir> worktree list --porcelain`. null: git could not say. */
  worktreeList(common: string): Promise<GitWorktree[] | null>
}

/**
 * One round: one `git worktree list` per polled repo, run in its common dir, so a toplevel that is gone costs no second
 * call. A repo that git cannot read has no list this round and fails nothing: the poll keeps the branch each toplevel had
 * at the last visit, and what the last good poll (`previous`, the fact as published) proved in that repo. Else a checkout
 * that the person made outside the session would drop its PR from the lane for a round, and bring it back at the next. A repo
 * that git reads takes nothing from `previous`: its list is the proof.
 */
export async function pollForeign(
  git: PollGit,
  rows: readonly RepoRecord[],
  cap: number,
  previous: readonly ForeignBranches[] = [],
): Promise<BranchesOfRepos> {
  const { targets, overflow } = pollTargets(rows, cap)
  const found: ForeignBranches[] = []
  for (const t of targets) {
    let list: GitWorktree[] | null = null
    try {
      const dir = await git.commonDir(t.key, t.roots)
      if (dir !== null) list = await git.worktreeList(dir)
    } catch {
      // git could not run: this repo has no list this round, the others go on
    }
    const branches =
      list === null
        ? [...provenBranches(t.roots, null), ...(previous.find(p => repoOrder(p) === repoOrder(t.ref))?.branches ?? [])]
        : provenBranches(t.roots, list)
    found.push({ ...t.ref, branches })
  }
  return factOf(found, overflow)
}
