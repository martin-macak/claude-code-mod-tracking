// The sections of the auto tracker: Worktrees (the root and the children this run proved) and Agents (the master and the
// agents of this run). Pure: it reads the view context and writes nothing. Titles, notes and bands keep the text the pane
// drew before L6, and so do the cells but the new Status cell of an agent (issue #63, L2); tests/tracker-sections.test.ts
// pins them. Both sections are trees: a row holds its children.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10. Plan: L5 Task 14, L6 A1.

import type { RowStatus, SectionSpec, StatusToken, TreeRow, ViewContext } from '../../core/interfaces/view'
import { sweptAway } from '../../core/lib/hidden'
import { textCells } from '../../core/lib/rows'
import { ago, compactIds } from '../../core/lib/text'
import type { AutoConfig } from './config'
import { FACT_CHECKED_AT } from './facts'
import { agentRowId, shortRunId, workflowRowId, worktreeId } from './ids'
import { autoReasonsOf } from './reasons'
import type { AgentRow, AutoState, WorktreeRow } from './types'

type Ctx = ViewContext<AutoConfig, AutoState>

const OWNER = 'auto'

/** The rows of a tree, every level: what a title line counts when one root row holds the rest. */
const countRows = (rows: readonly TreeRow[]): number => rows.reduce((n, r) => n + 1 + countRows(r.children ?? []), 0)

/** What the person can do with the row. These rows have no level, so `priority` is always off. */
const can = (dismiss: boolean): TreeRow['can'] => ({ dismiss, priority: false })

// ---------------------------------------------------------------- Worktrees

const branchText = (r: WorktreeRow): string => compactIds(r.branch ?? (r.detached ? '(detached)' : ''))

/** When this run proved each child worktree, by row id. The root has no proof. */
type ProvenAt = ReadonlyMap<string, number>

function worktreeRow(auto: AutoState, r: WorktreeRow, provenAt: ProvenAt, children?: readonly TreeRow[]): TreeRow {
  const removed = r.state === 'removed'
  const root = r.depth === 0
  const reasons = autoReasonsOf(auto, r.id)
  // A live worktree is active and says no word: every live row would say the same. A removed one is gone.
  const status: RowStatus = removed ? { label: 'removed', token: 'gone' } : { label: '', token: 'active' }
  const first = provenAt.get(r.id)
  return {
    id: r.id,
    owner: OWNER,
    cells: textCells({
      key: compactIds(r.name),
      title: branchText(r),
      titleClip: 'middle',
      status,
    }),
    facets: { status, ...(first !== undefined ? { firstSeen: first } : {}) },
    ...(children !== undefined ? { children } : {}),
    // The root is open until the person closes it. The worktrees below it are worktrees of their own: a view that groups
    // by status lifts them, so a removed one lands in the gone group, not under its live root (issue #63, L3).
    ...(root ? { expandedByDefault: true, lift: true as const } : {}),
    can: can(!root),
    ...(reasons ? { reasons } : {}),
    ...(removed ? { dim: true } : {}),
  }
}

/**
 * True for a removed child that was removed longer ago than `removedTtlMs`. The time is the `removedAt` of the child's
 * proof, by row id. A row with no proof or no `removedAt` is never expired, and a live row never is. Rule: issue #49.
 */
function expiredWorktree(
  r: WorktreeRow,
  removedAt: ReadonlyMap<string, number | undefined>,
  cfg: AutoConfig,
  now: number,
): boolean {
  if (r.state !== 'removed') return false
  const at = removedAt.get(r.id)
  return at !== undefined && now - at >= cfg.removedTtlMs
}

function worktreesSection(ctx: Ctx, auto: AutoState): SectionSpec | null {
  const snap = auto.snapshot
  if (!snap || typeof auto.root?.top !== 'string') return null
  const kids = snap.worktrees.filter(r => r.depth === 1)
  if (kids.length === 0) return null
  const root = snap.worktrees.find(r => r.depth === 0)
  // The note counts every child, hidden or not. The hidden count, last, says how many removed ones the view leaves out.
  const cfg = ctx.config.slice()
  const removedAt = new Map(auto.worktrees.map(p => [worktreeId(p.path), p.removedAt]))
  const hiding = cfg.hideEnded && !ctx.hidden.showAll
  // `/track clean --hide` hides every removed child now, whatever the TTL (issue #122).
  const gone = (r: WorktreeRow) =>
    (hiding && expiredWorktree(r, removedAt, cfg, ctx.now)) ||
    (r.state === 'removed' && sweptAway(ctx.hidden, removedAt.get(r.id)))
  const shown = kids.filter(r => !gone(r))
  const provenAt: ProvenAt = new Map(auto.worktrees.map(p => [worktreeId(p.path), p.provenAt]))
  const rows = shown.map(r => worktreeRow(auto, r, provenAt))
  const live = kids.filter(r => r.state === 'live').length
  const removed = kids.length - live
  const hidden = kids.length - shown.length
  // The time of the last round is the fact; a snapshot that no round has stamped yet reads its own age.
  const checkedAt = ctx.facts.read<number>(FACT_CHECKED_AT)
  const age = ago(Math.max(0, ctx.now - (checkedAt ?? snap.at)))
  const note = snap.git.ok
    ? [
        'git',
        ...(live > 0 ? [`${live} live`] : []),
        ...(removed > 0 ? [`${removed} removed`] : []),
        age === 'now' ? 'checked just now' : `checked ${age} ago`,
      ].join(' · ')
    : `git failed: ${snap.git.error ?? 'unknown error'}`
  const tree = root ? [worktreeRow(auto, root, provenAt, rows)] : rows
  return {
    id: 'worktrees',
    title: 'Worktrees',
    note: { text: hidden > 0 ? `${note} (${hidden} hidden)` : note },
    ...(hidden > 0 ? { hiddenRows: hidden } : {}),
    rank: 10,
    band: { label: 'Worktrees', count: live, failing: 0, rank: 7 },
    rows: tree,
    count: countRows(tree),
  }
}

// ---------------------------------------------------------------- Agents

const MARKER: Record<AgentRow['state'], string> = { running: '●', waiting: '●', ended: '✓', failed: '✗' }

/** The token of each agent state (design study of issue #63, section 5.4). The state is the word of the status cell. */
const AGENT_TOKEN: Record<AgentRow['state'], StatusToken> = {
  running: 'active',
  waiting: 'waiting',
  ended: 'done',
  failed: 'failed',
}

/**
 * The state, with the spawn time of each agent by row id: a row reads its first sighting from it, and the map is made once
 * for the section, not searched for each row. The master has no proof, nor has an agent that no event named.
 */
type Drawn = AutoState & { readonly spawnedAt: ReadonlyMap<string, number> }

const drawnOf = (auto: AutoState): Drawn => ({
  ...auto,
  spawnedAt: new Map(auto.agents.map(p => [agentRowId(p.id), p.spawnedAt])),
})

/** An agent row and the rows below it. */
type AgentNode = { row: AgentRow; kids: AgentNode[] }

/**
 * The agents come as a depth-first list with a depth. A row sits under the last row one level above it. The ledger caps
 * the depth at 3, so the rows past it are siblings.
 */
function nest(list: readonly AgentRow[]): AgentNode[] {
  const roots: AgentNode[] = []
  const lastAt: AgentNode[] = []
  for (const row of list) {
    const node: AgentNode = { row, kids: [] }
    const parent = row.depth > 0 ? lastAt[row.depth - 1] : undefined
    ;(parent ? parent.kids : roots).push(node)
    lastAt.length = row.depth
    lastAt[row.depth] = node
  }
  return roots
}

/** The row of one agent, with its children already drawn. A workflow agent says the run it belongs to (issue #49). */
function agentRow(auto: Drawn, r: AgentRow, children: readonly TreeRow[]): TreeRow {
  const master = r.kind === 'master'
  const reasons = autoReasonsOf(auto, r.id)
  const wf = r.workflow ? `${shortRunId(r.workflow.runId)}·${r.workflow.agentIndex} ` : ''
  const status: RowStatus = { label: r.state, token: AGENT_TOKEN[r.state] }
  const spawnedAt = auto.spawnedAt.get(r.id)
  return {
    id: r.id,
    owner: OWNER,
    cells: textCells({
      key: compactIds(`${MARKER[r.state]} ${wf}${r.label}`),
      title: compactIds(r.branch ?? ''),
      type: compactIds(r.worktree ?? ''),
      status,
      titleClip: 'middle',
      typeClip: 'middle',
    }),
    facets: { status, kind: r.kind, ...(spawnedAt !== undefined ? { firstSeen: spawnedAt } : {}) },
    ...(children.length > 0 ? { children } : {}),
    // The master is open until the person closes it. The nesting is lineage: who spawned whom. Every agent is a row of its
    // own in the views that group by status, so a failed sub-agent is in the failed group (issue #63, L3). A folded run
    // (`runRow`) is no agent: it keeps its members.
    ...(master ? { expandedByDefault: true } : {}),
    lift: true,
    can: can(!master),
    ...(reasons ? { reasons } : {}),
    ...(isDone(r) ? { dim: true } : {}),
  }
}

const isDone = (r: AgentRow): boolean => r.state === 'ended' || r.state === 'failed'

const plainRows = (auto: Drawn, nodes: readonly AgentNode[]): TreeRow[] =>
  nodes.map(n => agentRow(auto, n.row, plainRows(auto, n.kids)))

/**
 * True for an agent row that is over and ended longer ago than its TTL: `failedTtlMs` for a failure, else `endedTtlMs`.
 * The time is the `endedAt` of the agent's proof, by row id. A row with no proof or no `endedAt` is never expired, and
 * the master never is. Rule: issue #49.
 */
function expiredAgent(
  r: AgentRow,
  endedAt: ReadonlyMap<string, number | undefined>,
  cfg: AutoConfig,
  now: number,
): boolean {
  if (r.kind === 'master' || !isDone(r)) return false
  const at = endedAt.get(r.id)
  return at !== undefined && now - at >= (r.state === 'failed' ? cfg.failedTtlMs : cfg.endedTtlMs)
}

/**
 * The nodes that stay. An expired row goes only when every row below it goes too, so a live child keeps its ended
 * parent in the tree. `hidden.n` counts the rows that went.
 */
function prune(nodes: readonly AgentNode[], gone: (r: AgentRow) => boolean, hidden: { n: number }): AgentNode[] {
  const kept: AgentNode[] = []
  for (const { row, kids } of nodes) {
    const rest = prune(kids, gone, hidden)
    if (rest.length === 0 && gone(row)) hidden.n++
    else kept.push({ row, kids: rest })
  }
  return kept
}

/** A finished workflow run drawn as one row. `members` are its agent nodes, from wherever they sit in the tree. */
type RunNode = { runId: string; members: AgentNode[] }
/** What the section draws: an agent with what is shown below it, or a finished run. */
type Shown = { row: AgentRow; kids: Shown[] } | RunNode
type RunStat = { agents: number; failed: number }

/** A finished run folds only with this many agents. A run of one is one row already. A fixed rule: issue #146. */
const MIN_FOLD_AGENTS = 2

/**
 * The run ids that fold: the run has {@link MIN_FOLD_AGENTS} agents or more, every agent of it is over, and so is every
 * agent below one. A run with one live agent, or with a live agent below one of its agents, stays as plain rows, and so
 * does a run of one agent. The agents are counted over the whole tree, wherever they sit. Rule: issues #49 and #146.
 */
function finishedRuns(roots: readonly AgentNode[]): Set<string> {
  const agents = new Map<string, number>()
  const open = new Set<string>()
  const over = (n: AgentNode): boolean => isDone(n.row) && n.kids.every(over)
  const walk = (nodes: readonly AgentNode[]): void => {
    for (const n of nodes) {
      const id = n.row.workflow?.runId
      if (id !== undefined) {
        agents.set(id, (agents.get(id) ?? 0) + 1)
        if (!over(n)) open.add(id)
      }
      walk(n.kids)
    }
  }
  walk(roots)
  return new Set([...agents].filter(([id, n]) => n >= MIN_FOLD_AGENTS && !open.has(id)).map(([id]) => id))
}

/**
 * Which folded runs go: a run goes when every agent of it, and every agent below one, is past its TTL. A young agent
 * below a run agent keeps the run whole, so the fold row, its count and its children still agree. Rule: issue #49.
 */
function goneRuns(
  roots: readonly AgentNode[],
  runs: ReadonlySet<string>,
  expired: (r: AgentRow) => boolean,
): Map<string, boolean> {
  const settled = (n: AgentNode): boolean => expired(n.row) && n.kids.every(settled)
  const gone = new Map<string, boolean>([...runs].map(id => [id, true]))
  const walk = (nodes: readonly AgentNode[]): void => {
    for (const n of nodes) {
      const id = n.row.workflow?.runId
      if (id !== undefined && gone.has(id) && !settled(n)) gone.set(id, false)
      walk(n.kids)
    }
  }
  walk(roots)
  return gone
}

/**
 * The agents of each folded run go into one run node, placed where the run's first agent was. The agents below it are
 * the members as they are. Other rows keep their place, and their children fold the same way. `open` is shared by the
 * whole tree, so a run never gets two rows, even when its agents sit below different parents.
 */
function fold(nodes: readonly AgentNode[], runs: ReadonlySet<string>, open = new Map<string, RunNode>()): Shown[] {
  const out: Shown[] = []
  for (const n of nodes) {
    const id = n.row.workflow?.runId
    if (id === undefined || !runs.has(id)) {
      out.push({ row: n.row, kids: fold(n.kids, runs, open) })
      continue
    }
    let run = open.get(id)
    if (!run) {
      run = { runId: id, members: [] }
      open.set(id, run)
      out.push(run)
    }
    run.members.push(n)
  }
  return out
}

/** The agent count and the failed count of each run, over every agent row of it, hidden or not. */
function runStats(list: readonly AgentRow[]): Map<string, RunStat> {
  const stats = new Map<string, RunStat>()
  for (const r of list) {
    if (!r.workflow) continue
    const s = stats.get(r.workflow.runId) ?? { agents: 0, failed: 0 }
    s.agents++
    if (r.state === 'failed') s.failed++
    stats.set(r.workflow.runId, s)
  }
  return stats
}

/** The row of a folded run. It is closed until the person opens it, and it cannot be dismissed as a whole. */
function runRow(auto: Drawn, run: RunNode, stat: RunStat): TreeRow {
  // A run that folds is over: it failed when an agent of it failed, else it is done. Its first sighting is the first spawn.
  const status: RowStatus = stat.failed > 0 ? { label: 'failed', token: 'failed' } : { label: 'ended', token: 'done' }
  const spawns = run.members.flatMap(m => auto.spawnedAt.get(m.row.id) ?? [])
  return {
    id: workflowRowId(run.runId),
    owner: OWNER,
    cells: textCells({
      key: `${stat.failed > 0 ? '✗' : '✓'} ${shortRunId(run.runId)}`,
      title: `${stat.agents} agents · ${stat.failed} failed`, // a fold has 2 agents or more (issue #146)
      type: '',
      status,
      titleClip: 'middle',
    }),
    facets: { status, ...(spawns.length > 0 ? { firstSeen: Math.min(...spawns) } : {}) },
    children: plainRows(auto, run.members),
    can: can(false),
    dim: true,
  }
}

function shownRow(auto: Drawn, s: Shown, stats: ReadonlyMap<string, RunStat>): TreeRow {
  if ('runId' in s) return runRow(auto, s, stats.get(s.runId) ?? { agents: s.members.length, failed: 0 })
  return agentRow(
    auto,
    s.row,
    s.kids.map(k => shownRow(auto, k, stats)),
  )
}

function agentsSection(ctx: Ctx, auto: AutoState): SectionSpec | null {
  const snap = auto.snapshot
  if (!snap || snap.agents.length <= 1) return null
  let running = 0
  let ended = 0
  for (const r of snap.agents) {
    if (r.kind === 'master') continue
    if (r.state === 'running' || r.state === 'waiting') running++
    else ended++
  }
  // The note counts every ended agent, hidden or not. The hidden count, last, says how many of them the view leaves out.
  const cfg = ctx.config.slice()
  const endedAt = new Map(auto.agents.map(p => [agentRowId(p.id), p.endedAt]))
  const hiding = cfg.hideEnded && !ctx.hidden.showAll
  const tree = nest(snap.agents)
  // A row is past its TTL, or `/track clean --hide` hides it now (issue #122). The master has no end.
  const over = (r: AgentRow): boolean =>
    (hiding && expiredAgent(r, endedAt, cfg, ctx.now)) ||
    (r.kind !== 'master' && isDone(r) && sweptAway(ctx.hidden, endedAt.get(r.id)))
  // A finished run folds as a unit (issue #49): its rows go together, when every agent of it is past its own TTL.
  const runs = cfg.foldWorkflows ? finishedRuns(tree) : new Set<string>()
  const runGone = goneRuns(tree, runs, over)
  const gone = (r: AgentRow): boolean =>
    r.workflow && runs.has(r.workflow.runId) ? runGone.get(r.workflow.runId) === true : over(r)
  const hidden = { n: 0 }
  const items = fold(prune(tree, gone, hidden), runs)
  const stats = runStats(snap.agents)
  const parts = [...(running > 0 ? [`${running} running`] : []), ...(ended > 0 ? [`${ended} ended`] : [])]
  if (!snap.agentList.ok) parts.push('agent list failed')
  const note = parts.join(' · ')
  const drawn = drawnOf(auto)
  const rows = items.map(s => shownRow(drawn, s, stats))
  return {
    id: 'agents',
    title: 'Agents',
    note: { text: hidden.n > 0 ? `${note} (${hidden.n} hidden)` : note },
    ...(hidden.n > 0 ? { hiddenRows: hidden.n } : {}),
    rank: 11,
    band: { label: 'Agents', count: running, failing: 0, rank: 8 },
    rows,
    count: countRows(rows),
  }
}

/** Worktrees, then Agents. A section with nothing to show is left out. */
export function sections(ctx: Ctx): readonly SectionSpec[] {
  const auto = ctx.data
  if (!auto) return []
  return [worktreesSection(ctx, auto), agentsSection(ctx, auto)].filter((s): s is SectionSpec => s !== null)
}
