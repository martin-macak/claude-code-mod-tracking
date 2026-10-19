// The dismiss list (spec A14): ids of rows and keys of items that the person hid for this run.

import type { AgentRow, AutoState, ItemRecord } from '../../hooks/contracts'
import { AUTO_SOURCES } from '../../hooks/contracts'
import { GLOBAL_DEFAULTS } from '../lib/global-config'

/** The ids of every current auto row and item. Never the root or the master. */
export function autoIds(s: AutoState, items: readonly ItemRecord[]): string[] {
  const ids: string[] = []
  for (const r of s.snapshot?.worktrees ?? []) if (r.depth === 1) ids.push(r.id)
  for (const r of s.snapshot?.agents ?? []) if (r.kind !== 'master') ids.push(r.id)
  for (const it of items) if (it.sources.some(x => AUTO_SOURCES.has(x))) ids.push(it.key)
  return ids
}

/** Rows without the dismissed ones and their subtrees. */
function withoutSubtrees(rows: readonly AgentRow[], gone: ReadonlySet<string>): AgentRow[] {
  const out: AgentRow[] = []
  let skipBelow: number | null = null
  for (const r of rows) {
    if (skipBelow !== null && r.depth > skipBelow) continue
    skipBelow = null
    if (gone.has(r.id)) {
      skipBelow = r.depth
      continue
    }
    out.push(r)
  }
  return out
}

/**
 * Adds the ids and drops their rows (and the subtree of an agent) from the snapshot. Known ids: the same object. The
 * list keeps the last `max` ids (`global.store.maxDismissed`).
 */
export function dismiss(
  s: AutoState,
  ids: readonly string[],
  max: number = GLOBAL_DEFAULTS.store.maxDismissed,
): AutoState {
  const known = new Set(s.dismissed)
  const fresh = [...new Set(ids)].filter(id => !known.has(id))
  if (fresh.length === 0) return s
  const gone = new Set(ids)
  const dismissed = [...s.dismissed, ...fresh].slice(-max)
  const snap = s.snapshot
  return {
    ...s,
    dismissed,
    snapshot: snap
      ? {
          ...snap,
          worktrees: snap.worktrees.filter(r => !gone.has(r.id)),
          agents: withoutSubtrees(snap.agents, gone),
        }
      : null,
  }
}
