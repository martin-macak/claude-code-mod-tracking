// Git fixtures for the auto-tracking tests. Paths are shortened to /x/repo.
// Sources: docs/knowledge-base/claude-code-auto-tracking/sources/git-2.56.0/git-worktree-list-porcelain-sample.txt
// and sources/live-probe-2026-10-10/events-run1.jsonl.

/** Main tree, a prunable record, a locked one, a detached one and a bare-looking one. */
export const PORCELAIN_SAMPLE = `worktree /x/repo
HEAD b8168631aad3bc31d4f728ade0e9d72b2a5e9d89
branch refs/heads/feat/parent

worktree /x/repo-gone
HEAD b8168631aad3bc31d4f728ade0e9d72b2a5e9d89
branch refs/heads/gone-ggg
prunable gitdir file points to non-existent location

worktree /x/repo-locked
HEAD b8168631aad3bc31d4f728ade0e9d72b2a5e9d89
branch refs/heads/locked-fff
locked claude agent running

worktree /x/repo/.claude/worktrees/detached-eee
HEAD 82e354a52b568141a4e32dcb8e0eef810c2e3c46
detached

worktree /x/bare.git
bare
`

/** The live session: root, EnterWorktree child, an agent worktree and a manual worktree. */
export const PORCELAIN_SESSION = `worktree /x/repo
HEAD 3720b54095fed6bb6ffe5db1f07f03e205a9a1a8
branch refs/heads/main

worktree /x/repo/.claude/worktrees/probe-wt
HEAD 3720b54095fed6bb6ffe5db1f07f03e205a9a1a8
branch refs/heads/worktree-probe-wt

worktree /x/repo/.claude/worktrees/agent-a94bdd45b56e2c631
HEAD 3720b54095fed6bb6ffe5db1f07f03e205a9a1a8
branch refs/heads/worktree-agent-a94bdd45b56e2c631

worktree /x/manual-wt
HEAD 3720b54095fed6bb6ffe5db1f07f03e205a9a1a8
branch refs/heads/manual
`

export const NOT_A_REPO_STDERR = 'fatal: not a git repository (or any of the parent directories): .git\n'

/**
 * `git worktree list --porcelain` for a main tree on `main` and child worktrees under `<main>/.claude/worktrees/`.
 * Each child is `[folder name, branch]`.
 */
export const porcelain = (main: string, ...kids: [string, string][]): string =>
  [
    `worktree ${main}\nHEAD abc\nbranch refs/heads/main\n`,
    ...kids.map(
      ([name, branch]) => `worktree ${main}/.claude/worktrees/${name}\nHEAD abc\nbranch refs/heads/${branch}\n`,
    ),
  ].join('\n')
