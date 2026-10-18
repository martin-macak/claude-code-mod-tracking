// trackWorktrees: proven children under a pinned root (spec A4, 8.1). Pure and synchronous.
// Git has no parent link, so a child needs a proof from this run. Nothing is guessed from ancestry.

import { agentWorktreePath, basename, findByPath, locate, normPath } from '../../core/lib/porcelain'
import type { AutoState, GitWorktree, WorktreeProof, WorktreeRow } from '../../hooks/contracts'
import { worktreeId } from '../../hooks/contracts'
import { AUTO_DEFAULTS, type AutoConfig } from './config'

export type WorktreeView = { state: AutoState; rows: WorktreeRow[]; branches: string[]; overflow: number }

/** Proofs 3 and 4 (A4): records under `<main>/.claude/worktrees/` that a recorded agent or workflow run made. */
function newProofs(
  s: AutoState,
  list: readonly GitWorktree[],
  main: string,
  known: Set<string>,
  at: number,
  room: number,
) {
  const byAgentPath = new Map(s.agents.map(a => [agentWorktreePath(main, a.id), a.id]))
  const runIds = [...new Set(s.agents.flatMap(a => (a.workflow ? [a.workflow.runId] : [])))]
  const dir = `${main}/.claude/worktrees/`
  const added: WorktreeProof[] = []
  for (const r of list.slice(1)) {
    if (added.length >= room) break
    const path = normPath(r.path)
    if (known.has(path)) continue
    let p: WorktreeProof | undefined
    const owner = byAgentPath.get(path)
    if (owner !== undefined) {
      p = { path, origin: 'agent', owner, provenAt: at }
    } else if (path.startsWith(dir) && !path.slice(dir.length).includes('/')) {
      const name = path.slice(dir.length)
      const runId = runIds.find(id => name.startsWith(id + '-') && /^\d+$/.test(name.slice(id.length + 1)))
      if (runId !== undefined) p = { path, origin: 'workflow', runId, provenAt: at }
    }
    if (!p) continue
    if (r.branch !== undefined) p.branch = r.branch
    added.push(p)
    known.add(path)
  }
  return added
}

/** `caps` are `maxProofs` (room for new proofs) and `maxBranches` (the branches the PR lane polls). */
export function trackWorktrees(
  s: AutoState,
  list: readonly GitWorktree[],
  at: number,
  caps: Pick<AutoConfig, 'maxProofs' | 'maxBranches'> = AUTO_DEFAULTS,
): WorktreeView {
  const top = s.root?.top
  if (typeof top !== 'string' || list.length === 0) return { state: s, rows: [], branches: [], overflow: 0 }
  const mainRec = list[0]!
  const main = normPath(mainRec.path)
  const rootRec = locate(list, top)
  const dismissed = new Set(s.dismissed)

  // 1. New proofs from the convention paths, only while there is room. A full list takes no new proof: a path that
  //    the cap evicted would be proved again every round, and each round would write `auto` (A22).
  const room = Math.max(0, caps.maxProofs - s.worktrees.length)
  const added = newProofs(s, list, main, new Set(s.worktrees.map(p => p.path)), at, room)
  const all = added.length > 0 ? [...s.worktrees, ...added] : s.worktrees

  // 2. Match each proof to a record: by path, then by branch for a symlinked path. Never the root or the main tree.
  const taken = new Set<GitWorktree>([mainRec, ...(rootRec ? [rootRec] : [])])
  const matched = new Map<string, GitWorktree>()
  for (const p of all) {
    const r = findByPath(list, p.path, taken)
    if (r) {
      matched.set(p.path, r)
      taken.add(r)
    }
  }
  for (const p of all) {
    if (matched.has(p.path) || p.branch === undefined) continue
    const r = list.find(x => !taken.has(x) && x.branch === p.branch)
    if (r) {
      matched.set(p.path, r)
      taken.add(r)
    }
  }

  // 3. Update the proofs: the branch of a matched record, and `seenAt` on a first or renewed match.
  const prevState = new Map((s.snapshot?.worktrees ?? []).map(r => [r.id, r.state]))
  let changed = added.length > 0
  const updated = all.map(p => {
    const r = matched.get(p.path)
    if (!r) return p
    const next: WorktreeProof = { ...p }
    if (r.branch !== undefined && r.branch !== p.branch) next.branch = r.branch
    // A prunable record is a removed row. It never renews `seenAt`, or each round would write `auto` (A22).
    if (r.prunable === undefined && (p.seenAt === undefined || prevState.get(worktreeId(p.path)) === 'removed'))
      next.seenAt = at
    if (next.branch === p.branch && next.seenAt === p.seenAt) return p
    changed = true
    return next
  })

  // 4. Rows: the root, then each non-dismissed proof by provenAt.
  const rootPath = rootRec?.path ?? top
  const rows: WorktreeRow[] = [
    {
      id: worktreeId(rootPath),
      path: rootPath,
      name: basename(rootPath),
      ...(rootRec?.branch !== undefined ? { branch: rootRec.branch } : {}),
      detached: rootRec?.detached ?? false,
      state: 'live',
      depth: 0,
    },
  ]
  const kids = updated
    .filter(p => !dismissed.has(worktreeId(p.path)))
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.provenAt - b.p.provenAt || a.i - b.i)
    .map(({ p }) => p)
  for (const p of kids) {
    const r = matched.get(p.path)
    // A live record speaks for itself: a detached child has no branch. The proof's last branch is for removed children.
    const branch = r ? r.branch : p.branch
    rows.push({
      id: worktreeId(p.path),
      path: p.path,
      name: basename(p.path),
      ...(branch !== undefined ? { branch } : {}),
      detached: r?.detached ?? false,
      state: r && r.prunable === undefined ? 'live' : 'removed',
      depth: 1,
    })
  }

  // 5. Branches: the root's, then live children newest first, then removed children newest first.
  const unique = new Set<string>()
  const rootBranch = rows[0]?.branch
  if (rootBranch !== undefined) unique.add(rootBranch)
  const children = rows.slice(1).reverse()
  for (const state of ['live', 'removed'] as const)
    for (const r of children) if (r.state === state && r.branch !== undefined) unique.add(r.branch)
  const ordered = [...unique]
  return {
    state: changed ? { ...s, worktrees: updated } : s,
    rows,
    branches: ordered.slice(0, caps.maxBranches),
    overflow: Math.max(0, ordered.length - caps.maxBranches),
  }
}
