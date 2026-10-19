// The state and the facts that the pane, the band and the `/track` text draw from. Reads only: a render must not write
// (E8), so this is the one function the three views share. The slots come from the `trackers` family, the probe state
// and the session repo from the facts. A missing slot reads as empty.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.3. Plan: L3 Task 12.

import type { Json } from '../core/interfaces/items'
import type { Ports } from '../core/interfaces/ports'
import type { FactsPort } from '../core/interfaces/tracker'
import { FACT_CHECKED_AT } from '../trackers/auto'
import { emptyAuto } from '../trackers/auto/ledger'
import { UI_FACT } from '../trackers/processes/watch'
import type { ItemRecord, ProcessRecord, ProcessUiState, RepoRecord, RepoRef, ToolStatus } from './contracts'
import type { ViewContext } from './ui/view'

export const IDLE_GH: ToolStatus = { name: 'gh', available: null, loggedIn: null, breaker: 'closed' }
export const IDLE_ACLI: ToolStatus = { name: 'acli', available: null, loggedIn: null, breaker: 'closed' }

export type ViewInputs = {
  items: ItemRecord[]
  processes: ProcessRecord[]
  processUi: ProcessUiState
  repos: RepoRecord[]
  ctx: ViewContext
}

/** One member of the `trackers` family, typed. The family stores Json; a member never written reads as `empty()`. */
async function member<T>(p: Ports, id: string, empty: () => T): Promise<T> {
  return ((await p.state.slot.get(id)) as unknown as T | undefined) ?? empty()
}

const none = (): never[] => []

/**
 * Everything a drawing needs. It does not wait for the repo: a render must not wait on `gh`. The session repo is the
 * fact `session.repo`; every reader of the view context treats "not looked up" and "no repo" alike.
 */
export async function viewInputs(
  p: Ports,
  facts: FactsPort,
  o: { bodyColumns?: number | undefined },
): Promise<ViewInputs> {
  const [items, processes, repos, auto, ui, tools] = await Promise.all([
    p.state.items.get() as unknown as Promise<ItemRecord[]>,
    member<ProcessRecord[]>(p, 'processes', none),
    member<RepoRecord[]>(p, 'repos', none),
    member(p, 'auto', emptyAuto),
    p.state.ui.get(),
    p.state.tools.get(),
  ])
  // When the last auto round ended. The Worktrees note reads it before `snapshot.at` (A22).
  const checkedAt = facts.read<number>(FACT_CHECKED_AT)
  const sessionRepo = facts.read<Json>('session.repo') as unknown as RepoRef | undefined
  return {
    items,
    processes,
    repos,
    processUi: (facts.read<Json>(UI_FACT) as unknown as ProcessUiState | undefined) ?? { breaker: 'closed' },
    ctx: {
      now: p.clock.wall(),
      folded: ui.folded,
      tools: { gh: tools.gh ?? IDLE_GH, acli: tools.acli ?? IDLE_ACLI },
      ...(sessionRepo !== undefined ? { sessionRepo } : {}),
      auto,
      ...(checkedAt !== undefined ? { autoCheckedAt: checkedAt } : {}),
      ...(o.bodyColumns !== undefined ? { bodyColumns: o.bodyColumns } : {}),
    },
  }
}
