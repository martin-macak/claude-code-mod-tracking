// The sections of the auto tracker: Worktrees (the root and the children this run proved) and Agents (the master and the
// agents of this run). Pure: it reads the view context and writes nothing. Titles, notes, cell texts, tones and bands
// keep the text the pane drew before L6; tests/tracker-sections.test.ts pins them. Both sections are trees: a row holds its children.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10. Plan: L5 Task 14, L6 A1.

import type { ColumnDef, SectionSpec, TreeRow, ViewContext } from '../../core/interfaces/view'
import { content, flex, textCells } from '../../core/lib/rows'
import { ago, compactIds } from '../../core/lib/text'
import type { AutoConfig } from './config'
import { FACT_CHECKED_AT } from './facts'
import type { AgentRow, AutoState, WorktreeRow } from './types'

type Ctx = ViewContext<AutoConfig, AutoState>

const OWNER = 'auto'

const WORKTREE_COLUMNS: readonly ColumnDef[] = [
  { id: 'key', header: 'Worktree', width: content(8, 32), role: 'tree' },
  { id: 'title', header: 'Branch', width: flex(10) },
  { id: 'status', header: 'State', width: content(undefined, 9), priority: 1 },
]

const AGENT_COLUMNS: readonly ColumnDef[] = [
  { id: 'key', header: 'Agent', width: content(8, 26), role: 'tree' },
  { id: 'title', header: 'Branch', width: flex(10) },
  { id: 'type', header: 'Worktree', width: content(undefined, 20), priority: 1 },
]

/** What the person can do with the row. These rows have no level, so `priority` is always off. */
const can = (dismiss: boolean): TreeRow['can'] => ({ dismiss, priority: false })

// ---------------------------------------------------------------- Worktrees

const branchText = (r: WorktreeRow): string => compactIds(r.branch ?? (r.detached ? '(detached)' : ''))

function worktreeRow(r: WorktreeRow, children?: readonly TreeRow[]): TreeRow {
  const removed = r.state === 'removed'
  const root = r.depth === 0
  return {
    id: r.id,
    owner: OWNER,
    cells: textCells({
      key: compactIds(r.name),
      title: branchText(r),
      status: removed ? 'removed' : '',
      tone: removed ? 'dim' : 'plain',
    }),
    ...(children !== undefined ? { children } : {}),
    // The root is open until the person closes it.
    ...(root ? { expandedByDefault: true } : {}),
    can: can(!root),
    ...(removed ? { dim: true } : {}),
  }
}

function worktreesSection(ctx: Ctx, auto: AutoState): SectionSpec | null {
  const snap = auto.snapshot
  if (!snap || typeof auto.root?.top !== 'string') return null
  const kids = snap.worktrees.filter(r => r.depth === 1)
  if (kids.length === 0) return null
  const root = snap.worktrees.find(r => r.depth === 0)
  const rows = kids.map(r => worktreeRow(r))
  const live = kids.filter(r => r.state === 'live').length
  const removed = kids.length - live
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
  return {
    id: 'worktrees',
    title: 'Worktrees',
    note: { text: note },
    rank: 10,
    band: { label: 'Worktrees', count: live, failing: 0, rank: 7 },
    columns: WORKTREE_COLUMNS,
    rows: root ? [worktreeRow(root, rows)] : rows,
  }
}

// ---------------------------------------------------------------- Agents

const MARKER: Record<AgentRow['state'], string> = { running: '●', waiting: '●', ended: '✓', failed: '✗' }

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

function agentRow({ row: r, kids }: AgentNode): TreeRow {
  const master = r.kind === 'master'
  const children = kids.map(agentRow)
  const wf = r.workflow ? `wf·${r.workflow.agentIndex} ` : ''
  const done = r.state === 'ended' || r.state === 'failed'
  return {
    id: r.id,
    owner: OWNER,
    cells: textCells({
      key: compactIds(`${MARKER[r.state]} ${wf}${r.label}`),
      title: compactIds(r.branch ?? ''),
      type: compactIds(r.worktree ?? ''),
    }),
    ...(children.length > 0 ? { children } : {}),
    // The master is open until the person closes it.
    ...(master ? { expandedByDefault: true } : {}),
    can: can(!master),
    ...(done ? { dim: true } : {}),
  }
}

function agentsSection(auto: AutoState): SectionSpec | null {
  const snap = auto.snapshot
  if (!snap || snap.agents.length <= 1) return null
  let running = 0
  let ended = 0
  for (const r of snap.agents) {
    if (r.kind === 'master') continue
    if (r.state === 'running' || r.state === 'waiting') running++
    else ended++
  }
  const parts = [...(running > 0 ? [`${running} running`] : []), ...(ended > 0 ? [`${ended} ended`] : [])]
  if (!snap.agentList.ok) parts.push('agent list failed')
  return {
    id: 'agents',
    title: 'Agents',
    note: { text: parts.join(' · ') },
    rank: 11,
    band: { label: 'Agents', count: running, failing: 0, rank: 8 },
    columns: AGENT_COLUMNS,
    rows: nest(snap.agents).map(agentRow),
  }
}

/** Worktrees, then Agents. A section with nothing to show is left out. */
export function sections(ctx: Ctx): readonly SectionSpec[] {
  const auto = ctx.data
  if (!auto) return []
  return [worktreesSection(ctx, auto), agentsSection(auto)].filter((s): s is SectionSpec => s !== null)
}
