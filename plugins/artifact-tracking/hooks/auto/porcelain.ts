// Parse `git worktree list --porcelain` (spec 9.1). Pure: no `$`, no I/O.

import type { GitWorktree } from '../contracts'

/** A path without trailing slashes. The root `/` stays. */
export function normPath(path: string): string {
  let e = path.length
  while (e > 1 && path[e - 1] === '/') e--
  return path.slice(0, e)
}

/** The last segment of a path, or the path itself when it has none. */
export const basename = (path: string): string => normPath(path).split('/').pop() || path

export function parsePorcelain(text: string): GitWorktree[] {
  const out: GitWorktree[] = []
  let cur: GitWorktree | null = null
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line === '') {
      cur = null
      continue
    }
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), detached: false, bare: false }
      out.push(cur)
      continue
    }
    if (!cur) continue
    if (line.startsWith('HEAD ')) cur.head = line.slice('HEAD '.length)
    else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length)
      cur.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
    } else if (line === 'detached') cur.detached = true
    else if (line === 'bare') cur.bare = true
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = line.slice('locked '.length)
    else if (line === 'prunable' || line.startsWith('prunable ')) cur.prunable = line.slice('prunable '.length)
  }
  return out
}

/** The record whose path equals `path` or holds it (longest prefix wins). */
export function locate(list: readonly GitWorktree[], path: string): GitWorktree | undefined {
  const p = normPath(path)
  let best: GitWorktree | undefined
  let bestLen = -1
  for (const w of list) {
    const wp = normPath(w.path)
    const holds = p === wp || p.startsWith(wp === '/' ? wp : wp + '/')
    if (holds && wp.length > bestLen) {
      best = w
      bestLen = wp.length
    }
  }
  return best
}

/** The record whose path equals `path` (trailing slashes ignored on both sides). `skip` holds records already taken. */
export function findByPath(
  list: readonly GitWorktree[],
  path: string,
  skip?: ReadonlySet<GitWorktree>,
): GitWorktree | undefined {
  const p = normPath(path)
  return list.find(x => !skip?.has(x) && normPath(x.path) === p)
}

/** `<main>/.claude/worktrees/agent-<id>`. The one source of the convention path for T3 and T4 (A4, A6). */
export function agentWorktreePath(main: string, id: string): string {
  return `${normPath(main)}/.claude/worktrees/agent-${id}`
}
