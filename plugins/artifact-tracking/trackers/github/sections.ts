// The sections of the github tracker: Pull requests (the PRs the PR lane found) and GitHub (the issues and PRs that
// the conversation named). Pure: it reads the view context and writes nothing. Titles, notes, columns and the band
// keep the text the pane drew before L6; tests/item-sections.test.ts pins them.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10. Plan: L5 Task 13, L6 A1.

import type { Json } from '../../core/interfaces/items'
import type { RepoRef } from '../../core/interfaces/ports'
import type { ToolStatus } from '../../core/interfaces/tracker'
import type { ColumnDef, SectionSpec, ViewContext } from '../../core/interfaces/view'
import { content, flex, lastRefreshOf, PRIO_COLUMN, sortedByLevel } from '../../core/lib/rows'
import { toolNote } from '../../core/lib/text'
import type { GithubConfig } from './config'
import { githubKind } from './kind'
import { branchesOf, EMPTY_LANE } from './lane'
import { conflictCount, type MergeEnv, mergeEnvOf } from './merge'
import { githubRow, prRow } from './rows'
import type { GitHubRecord, LaneState } from './types'

type Ctx = ViewContext<GithubConfig, LaneState>

/** A `gh` the tools atom does not list reads as not probed. */
const IDLE: ToolStatus = { name: 'gh', available: null, loggedIn: null, breaker: 'closed' }

const FACT_BRANCHES = 'auto.branches'

/** The lane's reasons that draw a note on top of an empty section. The others leave the section out. */
const SKIPS_WITH_HEADER: ReadonlySet<string> = new Set(['no-gh', 'not-logged-in', 'paused', 'host-not-authed'])

const PR_COLUMNS: readonly ColumnDef[] = [
  PRIO_COLUMN,
  { id: 'key', header: 'PR', width: content(4, 10), role: 'tree' },
  { id: 'title', header: 'Title', width: flex(10) },
  { id: 'type', header: 'Branch', width: content(undefined, 26), priority: 2, clip: 'middle' },
  { id: 'status', header: 'State', width: content(undefined, 8) },
  // The merge chip outlives the branch and the checks in a narrow pane (priority 0 drops last). Both new columns are left
  // out while no row has a cell for them.
  { id: 'merge', header: 'Merge', width: content(undefined, 11), priority: 0 },
  { id: 'extra', header: 'Checks', width: content(undefined, 10), priority: 1 },
  { id: 'mark', header: '', width: content(undefined, 11), priority: 3 },
]

const GITHUB_COLUMNS: readonly ColumnDef[] = [
  PRIO_COLUMN,
  { id: 'key', header: 'Ref', width: content(4, 24), role: 'tree' },
  { id: 'title', header: 'Title', width: flex(10) },
  { id: 'type', header: 'Type', width: content(undefined, 6), priority: 2 },
  { id: 'status', header: 'State', width: content(undefined, 10) },
  { id: 'merge', header: 'Merge', width: content(undefined, 11), priority: 0 },
  { id: 'extra', header: 'Checks', width: content(undefined, 10), priority: 1 },
]

/** The records of the kind among the items of the view. */
const records = (ctx: Ctx): GitHubRecord[] =>
  ctx.items.flatMap(item => {
    const rec = githubKind.decode(item)
    return rec ? [rec] : []
  })

/** A PR the PR lane found: source `auto`. A PR that the conversation also named stays in this section only. */
const isDiscoveredPr = (i: GitHubRecord): boolean => i.type === 'pr' && i.sources.includes('auto')

const failing = (list: readonly GitHubRecord[]): number => list.filter(i => i.checks === 'failure').length

/** The band part of a list of PRs: the counts, and the conflicts only when there are some. */
function bandOf(label: string, list: readonly GitHubRecord[], env: MergeEnv, rank: number) {
  const conflicts = conflictCount(list, env)
  return { label, count: list.length, failing: failing(list), ...(conflicts > 0 ? { conflicts } : {}), rank }
}

function prsNote(ctx: Ctx, lane: LaneState, prs: readonly GitHubRecord[]): string {
  const p = lane.prs
  const overflow = branchesOf(ctx.facts.read<Json>(FACT_BRANCHES))?.overflow ?? 0
  const repo = ctx.facts.read<Json>('session.repo') as unknown as RepoRef | null | undefined
  const host = repo?.host ?? 'github.com'
  let head: string
  if (p.error) head = `gh · discovery failed: ${p.error}`
  else if (p.skipped === 'no-repo') head = 'no GitHub repo'
  else if (p.skipped === 'no-gh') head = 'gh not installed'
  else if (p.skipped === 'not-logged-in' || p.skipped === 'host-not-authed') head = `gh not logged in to ${host}`
  else head = `gh · ${toolNote(ctx.tools.gh ?? IDLE, ctx.now, lastRefreshOf(prs))}`
  const tail = [
    ...(overflow > 0 ? [`+${overflow} branches not polled`] : []),
    ...(p.untracked ? [`+${p.untracked} not tracked`] : []),
  ]
  return [head, ...tail].join(' · ')
}

/** The Pull requests section. Left out when no PR was found and the lane has no reason to show. */
function prsSection(ctx: Ctx): SectionSpec | null {
  const lane = ctx.data ?? EMPTY_LANE
  const prs = sortedByLevel(records(ctx).filter(isDiscoveredPr), ctx.levelOf, (a, b) => a.number - b.number)
  const hasBranches = (branchesOf(ctx.facts.read<Json>(FACT_BRANCHES))?.branches.length ?? 0) > 0
  const showHeader =
    hasBranches && ((lane.prs.skipped !== undefined && SKIPS_WITH_HEADER.has(lane.prs.skipped)) || !!lane.prs.error)
  if (prs.length === 0 && !showHeader) return null
  const open = prs.filter(i => i.state === 'open')
  const env = mergeEnvOf(ctx)
  const rowEnv = { facts: ctx.facts, levelOf: ctx.levelOf, merge: env }
  return {
    id: 'prs',
    title: 'Pull requests',
    note: { text: prsNote(ctx, lane, prs) },
    rank: 12,
    band: bandOf('PRs', open, env, 9),
    columns: PR_COLUMNS,
    rows: prs.map(rec => prRow(rec, rowEnv, lane.defaultBranch)),
  }
}

/** The GitHub section: the issues and PRs that the conversation named, not the ones only the lane found. */
function githubSection(ctx: Ctx): SectionSpec | null {
  const own = sortedByLevel(
    records(ctx).filter(i => !i.sources.includes('auto')),
    ctx.levelOf,
  )
  if (own.length === 0) return null
  const env = mergeEnvOf(ctx)
  const rowEnv = { facts: ctx.facts, levelOf: ctx.levelOf, merge: env }
  return {
    id: 'github',
    title: 'GitHub',
    note: { text: `gh · ${toolNote(ctx.tools.gh ?? IDLE, ctx.now, lastRefreshOf(own))}` },
    rank: 30,
    band: bandOf('GitHub', own, env, 2),
    columns: GITHUB_COLUMNS,
    rows: own.map(rec => githubRow(rec, rowEnv)),
  }
}

export function sections(ctx: Ctx): readonly SectionSpec[] {
  return [prsSection(ctx), githubSection(ctx)].filter((s): s is SectionSpec => s !== null)
}
