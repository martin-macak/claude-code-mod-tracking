// The files of a conflicted PR (issue #50, P2): the files `git merge-tree` names when the head merges into the base.
// Two git calls: a fetch of the base and the head, so the local refs match GitHub, then `merge-tree --write-tree`, which
// writes no worktree and no index. GitHub says whether a PR conflicts; this says where. It runs when the person presses
// the `files` key, never on a tick. Pure around an injected runner: no `$`.

import type { RunResult } from '../../core/interfaces/ports'
import { firstLine } from '../../core/lib/tool'

/** The files a PR lists at most. The rest are counted. */
export const CONFLICT_CAP = 20

/** One git call, in the folder `cwd`. In production a closure over the engine's process runner. It may reject. */
export type GitRun = (argv: readonly string[], opts: { cwd: string; timeoutMs: number }) => Promise<RunResult>

export type FilesOutcome = { files: string[]; more?: number } | { error: string }

const OID = /^[0-9a-f]{40,64}$/
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * The conflicting files of `head` merged into `base`, from the remote-tracking refs after a fetch. `remote` is `origin`:
 * the mod does not know any other name. An exit 0 is a merge with no conflict, so the local refs differ from GitHub. An
 * exit 1 with a tree on stdout is a conflict; an exit 1 with none (a ref that is not there) is an error. The names come
 * NUL-separated (`-z`), so a space or a non-ASCII letter stays as written. `head` and `base` must be safe branch names:
 * the caller checks them (`isSafeRef` of core), as they reach a command line.
 */
export async function conflictFiles(
  git: GitRun,
  o: { cwd: string; head: string; base: string; timeoutMs: number; cap?: number; remote?: string },
): Promise<FilesOutcome> {
  const remote = o.remote ?? 'origin'
  const cap = o.cap ?? CONFLICT_CAP
  const opts = { cwd: o.cwd, timeoutMs: o.timeoutMs }
  try {
    const fetched = await git(
      [
        'git',
        'fetch',
        '--no-tags',
        remote,
        `+refs/heads/${o.base}:refs/remotes/${remote}/${o.base}`,
        `+refs/heads/${o.head}:refs/remotes/${remote}/${o.head}`,
      ],
      opts,
    )
    if (fetched.exitCode !== 0)
      return { error: `git fetch failed: ${firstLine(fetched.stderr) || `exit ${fetched.exitCode}`}` }
    const merged = await git(
      [
        'git',
        'merge-tree',
        '-z',
        '--write-tree',
        '--name-only',
        '--no-messages',
        `${remote}/${o.base}`,
        `${remote}/${o.head}`,
      ],
      opts,
    )
    const [tree, ...rest] = merged.stdout.split('\0')
    if ((merged.exitCode === 0 || merged.exitCode === 1) && OID.test(tree ?? '')) {
      const end = rest.indexOf('') // the empty name that ends the list; none when the output stops at the last name
      const names = [...new Set(end < 0 ? rest : rest.slice(0, end))]
      const files = merged.exitCode === 0 ? [] : names
      return files.length > cap ? { files: files.slice(0, cap), more: files.length - cap } : { files }
    }
    const said = firstLine(merged.stderr)
    if (/unknown option/.test(said)) return { error: 'git merge-tree needs git 2.38 or newer' }
    return { error: `git merge-tree failed: ${said || `exit ${merged.exitCode}`}` }
  } catch (err) {
    return { error: message(err) }
  }
}
