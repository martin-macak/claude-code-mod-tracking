// The auto sections of the pane (spec 10): Worktrees, Agents, Pull requests, the band parts and the composers.
// Imports `view.ts` and the contracts. Pure: no `$`, no JSX, no clock.

import type {
  AgentRow,
  AutoState,
  GitHubRecord,
  ItemRecord,
  ProcessRecord,
  ProcessUiState,
  RepoRecord,
} from '../contracts'
import { MASTER_ID } from '../contracts'
import { processBandPart, processSection } from './process-view'
import { repoBandPart, repoSection } from './repo-view'
import type { PaneRow, PaneSection, ViewContext } from './view'
import {
  ago,
  bandParts,
  buildPane,
  compactIds,
  EMPTY_TEXT,
  githubRow,
  isWide,
  lastRefreshOf,
  textOf,
  toolNote,
} from './view'

export { compactIds } // kept here for the callers that import it from the auto view

const SKIPS_WITH_HEADER = new Set(['no-gh', 'not-logged-in', 'paused', 'host-not-authed'])

const isDiscoveredPr = (i: ItemRecord): i is GitHubRecord =>
  i.category === 'github' && i.type === 'pr' && i.sources.includes('auto')

// ---------------------------------------------------------------- Worktrees

function worktreesSection(auto: AutoState | null, ctx: ViewContext): PaneSection | null {
  const snap = auto?.snapshot
  if (!auto || !snap || typeof auto.root?.top !== 'string') return null
  const kids = snap.worktrees.filter(r => r.depth === 1)
  if (kids.length === 0) return null
  const root = snap.worktrees.find(r => r.depth === 0)
  const folded = new Set(ctx.folded)
  const rows: PaneRow[] = []
  if (root) {
    rows.push({
      id: root.id,
      depth: 0,
      key: compactIds(root.name),
      title: compactIds(root.branch ?? (root.detached ? '(detached)' : '')),
      type: '',
      status: '',
      tone: 'plain',
      foldable: true,
      folded: folded.has(root.id),
    })
  }
  if (!root || !folded.has(root.id)) {
    for (const r of kids) {
      const removed = r.state === 'removed'
      rows.push({
        id: r.id,
        depth: 1,
        key: compactIds(r.name),
        title: compactIds(r.branch ?? (r.detached ? '(detached)' : '')),
        type: '',
        status: removed ? 'removed' : '',
        tone: removed ? 'dim' : 'plain',
        foldable: false,
        folded: false,
        dismissId: r.id,
        ...(removed ? { dim: true } : {}),
      })
    }
  }
  const live = kids.filter(r => r.state === 'live').length
  const removed = kids.length - live
  const age = ago(Math.max(0, ctx.now - (ctx.autoCheckedAt ?? snap.at)))
  const note = snap.git.ok
    ? [
        'git',
        ...(live > 0 ? [`${live} live`] : []),
        ...(removed > 0 ? [`${removed} removed`] : []),
        age === 'now' ? 'checked just now' : `checked ${age} ago`,
      ].join(' · ')
    : `git failed: ${snap.git.error ?? 'unknown error'}`
  return { id: 'worktrees', title: 'Worktrees', note, rows, layout: 'worktrees', dismissable: true }
}

// ---------------------------------------------------------------- Agents

const MARKER: Record<AgentRow['state'], string> = { running: '●', waiting: '●', ended: '✓', failed: '✗' }

function agentsSection(auto: AutoState | null, ctx: ViewContext): PaneSection | null {
  const snap = auto?.snapshot
  if (!snap || snap.agents.length <= 1) return null
  const masterFolded = ctx.folded.includes(MASTER_ID)
  const rows: PaneRow[] = []
  let running = 0
  let ended = 0
  for (const r of snap.agents) {
    const isMaster = r.kind === 'master'
    if (!isMaster) {
      if (r.state === 'running' || r.state === 'waiting') running++
      else ended++
      if (masterFolded) continue
    }
    const wf = r.workflow ? `wf·${r.workflow.agentIndex} ` : ''
    const done = r.state === 'ended' || r.state === 'failed'
    rows.push({
      id: r.id,
      depth: r.depth,
      key: compactIds(`${MARKER[r.state]} ${wf}${r.label}`),
      title: compactIds(r.branch ?? ''),
      type: compactIds(r.worktree ?? ''),
      status: '',
      tone: 'plain',
      foldable: isMaster,
      folded: isMaster && masterFolded,
      ...(done ? { dim: true } : {}),
      ...(isMaster ? {} : { dismissId: r.id }),
    })
  }
  const parts = [...(running > 0 ? [`${running} running`] : []), ...(ended > 0 ? [`${ended} ended`] : [])]
  if (!snap.agentList.ok) parts.push('agent list failed')
  return { id: 'agents', title: 'Agents', note: parts.join(' · '), rows, layout: 'agents', dismissable: true }
}

// ---------------------------------------------------------------- Pull requests

const GLYPH: Record<NonNullable<GitHubRecord['checks']>, string> = {
  failure: '✗',
  pending: '…',
  success: '✓',
  none: '',
}

function prRow(rec: GitHubRecord, auto: AutoState | null, ctx: ViewContext): PaneRow {
  const base = githubRow(rec, ctx)
  const baseBranch = rec.baseRefName
  const defaultBranch = auto?.snapshot?.defaultBranch
  const stacked = defaultBranch !== undefined && baseBranch !== undefined && baseBranch !== defaultBranch
  const glyph = GLYPH[rec.checks ?? 'none']
  const done = rec.state === 'merged' || rec.state === 'closed'
  return {
    ...base,
    title: rec.title ?? '',
    type: compactIds(stacked ? `→${baseBranch}` : (rec.headRefName ?? '')),
    // Wide: the checks sit in the `extra` cell (spec 10.3). Narrow has no such cell, so the glyph joins the status.
    status: glyph && !isWide(ctx.bodyColumns) ? `${base.status} ${glyph}`.trim() : base.status,
    dismissId: rec.key,
    ...(stacked ? { typeWrap: 'truncate-end' as const } : {}),
    ...(done ? { dim: true } : {}),
  }
}

function prsNote(auto: AutoState | null, prs: readonly GitHubRecord[], ctx: ViewContext): string {
  const snap = auto?.snapshot
  const p = snap?.prs
  const host = ctx.sessionRepo?.host ?? 'github.com'
  const toolPart = `gh · ${toolNote(ctx.tools.gh, ctx.now, lastRefreshOf(prs))}`
  let head: string
  if (p?.error) head = `gh · discovery failed: ${p.error}`
  else if (p?.skipped === 'no-repo') head = 'no GitHub repo'
  else if (p?.skipped === 'no-gh') head = 'gh not installed'
  else if (p?.skipped === 'not-logged-in' || p?.skipped === 'host-not-authed') head = `gh not logged in to ${host}`
  else head = toolPart
  const tail = [
    ...(snap && snap.overflow > 0 ? [`+${snap.overflow} branches not polled`] : []),
    ...(p?.untracked ? [`+${p.untracked} not tracked`] : []),
  ]
  return [head, ...tail].join(' · ')
}

function prsSection(auto: AutoState | null, items: readonly ItemRecord[], ctx: ViewContext): PaneSection | null {
  const prs = items.filter(isDiscoveredPr).sort((a, b) => a.firstSeen - b.firstSeen || a.number - b.number)
  const p = auto?.snapshot?.prs
  const hasBranches = (auto?.snapshot?.branches.length ?? 0) > 0
  const showHeader =
    hasBranches && p !== undefined && ((p.skipped !== undefined && SKIPS_WITH_HEADER.has(p.skipped)) || !!p.error)
  if (prs.length === 0 && !showHeader) return null
  return {
    id: 'prs',
    title: 'Pull requests',
    note: prsNote(auto, prs, ctx),
    rows: prs.map(rec => prRow(rec, auto, ctx)),
    layout: 'prs',
    dismissable: true,
  }
}

/** Worktrees, Agents, Pull requests, in that order. A section with nothing to show is left out. */
export function buildAutoSections(
  auto: AutoState | null,
  items: readonly ItemRecord[],
  ctx: ViewContext,
): PaneSection[] {
  return [worktreesSection(auto, ctx), agentsSection(auto, ctx), prsSection(auto, items, ctx)].filter(
    (s): s is PaneSection => s !== null,
  )
}

// ---------------------------------------------------------------- band and composers

/** `Worktrees 2`, `Agents 1`, `PRs 2 (1 ✗)`. Live children, running or waiting agents (master excluded), open discovered PRs. */
export function autoBandParts(auto: AutoState | null, items: readonly ItemRecord[]): string[] {
  const snap = auto?.snapshot
  const worktrees = snap ? snap.worktrees.filter(r => r.depth === 1 && r.state === 'live').length : 0
  const agents = snap
    ? snap.agents.filter(r => r.kind !== 'master' && (r.state === 'running' || r.state === 'waiting')).length
    : 0
  const open = items.filter(isDiscoveredPr).filter(i => i.state === 'open')
  const failing = open.filter(i => i.checks === 'failure').length
  return [
    ...(worktrees > 0 ? [`Worktrees ${worktrees}`] : []),
    ...(agents > 0 ? [`Agents ${agents}`] : []),
    ...(open.length > 0 ? [`PRs ${open.length}${failing > 0 ? ` (${failing} ✗)` : ''}`] : []),
  ]
}

function withRepos(itemSections: PaneSection[], repos: readonly RepoRecord[]): PaneSection[] {
  const section = repoSection(repos)
  if (!section) return itemSections
  const web = itemSections.findIndex(s => s.id === 'web')
  if (web < 0) return [...itemSections, section]
  return [...itemSections.slice(0, web), section, ...itemSections.slice(web)]
}

/** Auto sections first, then item sections, then the Processes section when it has rows or a note. */
export function composePane(
  items: readonly ItemRecord[],
  processes: readonly ProcessRecord[],
  processUi: ProcessUiState,
  ctx: ViewContext,
  repos: readonly RepoRecord[] = [],
): PaneSection[] {
  const proc = processSection(processes, processUi)
  return [
    ...buildAutoSections(ctx.auto ?? null, items, ctx),
    ...withRepos(buildPane(items, ctx), repos),
    ...(proc ? [proc] : []),
  ]
}

/** `bandParts(items)`, then auto parts, then `Processes n (k ✗)`; null when all are empty. */
export function composeBand(
  items: readonly ItemRecord[],
  processes: readonly ProcessRecord[],
  auto: AutoState | null,
  repos: readonly RepoRecord[] = [],
): string | null {
  const p = processBandPart(processes)
  const r = repoBandPart(repos)
  const parts = [...bandParts(items), ...(r ? [r] : []), ...autoBandParts(auto, items), ...(p ? [p] : [])]
  return parts.length > 0 ? parts.join(' · ') : null
}

/** The `/track` text: auto, item and process sections; nothing folded. EMPTY_TEXT when there are none. */
export function composeCommandText(
  items: readonly ItemRecord[],
  processes: readonly ProcessRecord[],
  processUi: ProcessUiState,
  ctx: ViewContext,
  repos: readonly RepoRecord[] = [],
): string {
  const sections = composePane(items, processes, processUi, { ...ctx, folded: [] }, repos)
  return sections.length === 0 ? EMPTY_TEXT : textOf(sections)
}
