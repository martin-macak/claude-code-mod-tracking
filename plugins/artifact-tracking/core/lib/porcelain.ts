// Parse `git worktree list --porcelain` (spec 9.1). Pure: no `$`, no I/O.

/** One entry of `git worktree list --porcelain`. */
export type GitWorktree = {
  path: string
  head?: string
  /** Without `refs/heads/`. Absent when detached or bare. */
  branch?: string
  detached: boolean
  bare: boolean
  /** Lock reason ('' when locked with none). */
  locked?: string
  prunable?: string
}

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

/** Whether `inner` is `outer` or a folder inside it. A path that only starts with the same letters is not inside. */
export function holds(outer: string, inner: string): boolean {
  const o = normPath(outer)
  const i = normPath(inner)
  return i === o || i.startsWith(o === '/' ? o : `${o}/`)
}

/** The record whose path equals `path` or holds it (longest prefix wins). */
export function locate(list: readonly GitWorktree[], path: string): GitWorktree | undefined {
  let best: GitWorktree | undefined
  let bestLen = -1
  for (const w of list) {
    const len = normPath(w.path).length
    if (holds(w.path, path) && len > bestLen) {
      best = w
      bestLen = len
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

/** The record whose checked-out branch is `branch`. A prunable record has no directory left, so it never counts. */
export function worktreeOfBranch(list: readonly GitWorktree[], branch: string): GitWorktree | undefined {
  return list.find(w => w.branch === branch && w.prunable === undefined && !w.bare)
}

/** `<main>/.claude/worktrees/agent-<id>`. The one source of the convention path for T3 and T4 (A4, A6). */
export function agentWorktreePath(main: string, id: string): string {
  return `${normPath(main)}/.claude/worktrees/agent-${id}`
}

/** `<runId>-<agentIndex>`: the folder name of a workflow agent's worktree. The one source of the name. */
export const workflowWorktreeName = (runId: string, agentIndex: number): string => `${runId}-${agentIndex}`

/**
 * `<main>/.claude/worktrees/<runId>-<agentIndex>`: where a workflow agent that runs with `isolation: 'worktree'` works.
 * The number is the place of the agent among the `agent()` calls of the run, so it counts agents that run in no worktree.
 */
export function workflowWorktreePath(main: string, runId: string, agentIndex: number): string {
  return `${normPath(main)}/.claude/worktrees/${workflowWorktreeName(runId, agentIndex)}`
}
