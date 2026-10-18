// View model for the pane, the band and the `/track` text. Pure: no `$`, no JSX, no clock.
// Spec: docs/superpowers/specs/2026-10-10-artifact-tracking-design.md section 9.

import { artifactIdOf } from '../../trackers/artifact/artifact-url'
import { relativeToRoot } from '../../trackers/file/files'
import type {
  ArtifactRecord,
  AutoState,
  Category,
  FileRecord,
  GitHubRecord,
  ItemRecord,
  JiraNode,
  JiraRecord,
  Priority,
  RepoRef,
  ToolStatus,
  WebRecord,
} from '../contracts'
import { MASTER_ID } from '../contracts'
import { artifactOrigin, childId } from '../model/keys'
import type { Effective, LevelContext } from '../model/priority'
import { byLevel, effectiveLevels, markerOf } from '../model/priority'

/** The `/track` text when nothing is tracked. */
export const EMPTY_TEXT = 'No tracked items yet.'

export type Tone = 'plain' | 'ok' | 'warn' | 'bad' | 'dim'

export type PaneRow = {
  /** Fold id: the item key for a root row, `<parent id>/<node key>` for a Jira child. */
  id: string
  depth: number
  key: string
  href?: string
  title: string
  type: string
  status: string
  tone: Tone
  extra?: string
  extraTone?: Tone
  foldable: boolean
  folded: boolean
  /** The whole row draws dimmed: a removed worktree, an ended agent, a merged PR. */
  dim?: boolean
  /** Draw an `x` button that dismisses this id (a row id or an item key). */
  dismissId?: string
  /** Wrap mode of the type cell for this row, when it differs from the layout. A stacked PR cuts at the end. */
  typeWrap?: Cell['wrap']
  /** A short marker after the other cells: `subagent` on a file row. */
  mark?: string
  /** An item row: it draws a mark Button in the prio cell, and the priority keys act on `id`. Absent on other rows. */
  prio?: RowPrio
}

/** The level a row shows: `level` absent, drawn blank; `auto`, from a rule, drawn dim. */
export type RowPrio = Effective

export type SectionId = 'worktrees' | 'agents' | 'prs' | 'processes' | 'repos' | Category
export type Layout = 'worktrees' | 'agents' | 'prs' | 'items' | 'files' | 'repos'
export type CellName = 'prio' | 'key' | 'title' | 'type' | 'status' | 'extra' | 'mark' | 'x'
/** One rendered cell. `width` absent: the cell grows. */
export type Cell = { name: CellName; width?: number; wrap: 'truncate-end' | 'truncate-middle' }

/**
 * `category` stays set on item sections. `layout` absent: 'items'. `dismissable` absent: false.
 * `prio`: the section draws the prio cell. Only item sections set it: the Processes section uses layout 'items' too.
 */
export type PaneSection = {
  id: SectionId
  category?: Category
  title: string
  note: string
  rows: PaneRow[]
  layout?: Layout
  dismissable?: boolean
  prio?: boolean
}

export type ViewContext = {
  now: number
  /** Ids of folded rows (`UiState.folded`). */
  folded: readonly string[]
  tools: { gh: ToolStatus; acli: ToolStatus }
  /** Repo of the session. A GitHub key in this repo shows as `#N`. */
  sessionRepo?: RepoRef | null
  /** The auto-tracking state, for the auto sections (`auto-view.ts`). */
  auto?: AutoState | null
  /** When the last round ran. The Worktrees note reads it before `snapshot.at` (spec A22). */
  autoCheckedAt?: number
  /** Body width of the pane. Absent for the `/track` text, which reads as wide. */
  bodyColumns?: number
  /** The level of every item, by key. `composePane` sets it once for all sections; absent, a section computes it. */
  levels?: ReadonlyMap<string, RowPrio>
}

export type Columns = { key: number; type: number; status: number; extra: number }

// ---------------------------------------------------------------- small helpers

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Short age: `now`, `12s`, `4m`, `2h`, `3d`. */
export function ago(ms: number): string {
  if (!(ms >= SECOND)) return 'now'
  if (ms < MINUTE) return `${Math.floor(ms / SECOND)}s`
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`
  return `${Math.floor(ms / DAY)}d`
}

/** What a section header says about the tool behind it. First match wins. */
export function toolNote(t: ToolStatus, now: number, lastRefresh?: number): string {
  if (t.available === false) return 'not installed'
  if (t.available === null) return 'checking…'
  if (t.loggedIn === false) return 'not logged in'
  if (t.breaker === 'open') return `paused ${ago(Math.max(0, (t.openUntil ?? now) - now))}`
  if (lastRefresh !== undefined) {
    const age = ago(Math.max(0, now - lastRefresh))
    return age === 'now' ? 'refreshed just now' : `refreshed ${age} ago`
  }
  return 'ready'
}

const AGENT_ID = /(agent-)([0-9a-f]{8})[0-9a-f]+/g
const RUN_ID = /wf_([A-Za-z0-9-]+)-(\d+)(?![\w-])/g

/**
 * Agent ids compact to 8 hex after `agent-`. A workflow run id keeps 6 characters between `wf_` and the last
 * `-<digits>`, since a run id can hold `-` (spec 10.3). Any other hex string stays as it is.
 */
export function compactIds(text: string): string {
  return text
    .replace(AGENT_ID, '$1$2')
    .replace(RUN_ID, (m, body: string, n: string) => (body.length > 6 ? `wf_${body.slice(0, 6)}-${n}` : m))
}

/** Wide means a body of 70 columns or more. An unknown width reads as wide. */
export const isWide = (bodyColumns: number | undefined): boolean => (bodyColumns ?? 80) >= 70

/** The type cell stays 9 wide: it must hold the artifact origin words `published` and `mentioned`. */
export function columnsFor(bodyColumns: number | undefined): Columns {
  const cols: Columns = { key: 16, type: 9, status: 13, extra: 10 }
  if (!isWide(bodyColumns)) cols.extra = 0
  return cols
}

/**
 * The cells to render, left to right. This is the only source of widths: `pane.tsx` renders exactly these cells.
 * A hidden cell is not in the list. Narrow means a body below 70 columns. `prio` puts the 2-column prio cell first.
 */
export function cellsFor(bodyColumns: number | undefined, layout: Layout, dismissable: boolean, prio = false): Cell[] {
  const wide = isWide(bodyColumns)
  const x: Cell[] = dismissable ? [{ name: 'x', width: 2, wrap: 'truncate-end' }] : []
  const lead: Cell[] = prio ? [{ name: 'prio', width: 2, wrap: 'truncate-end' }] : []
  switch (layout) {
    case 'worktrees':
      return [
        ...lead,
        { name: 'key', width: wide ? 30 : 24, wrap: 'truncate-end' },
        { name: 'title', wrap: 'truncate-middle' },
        { name: 'status', width: wide ? 9 : 8, wrap: 'truncate-end' },
        ...x,
      ]
    case 'agents':
      return [
        ...lead,
        { name: 'key', width: wide ? 24 : 20, wrap: 'truncate-end' },
        { name: 'title', wrap: 'truncate-middle' },
        { name: 'type', width: wide ? 20 : 14, wrap: 'truncate-middle' },
        ...x,
      ]
    case 'prs':
      return [
        ...lead,
        { name: 'key', width: 8, wrap: 'truncate-end' },
        { name: 'title', wrap: 'truncate-end' },
        { name: 'type', width: wide ? 26 : 20, wrap: 'truncate-middle' },
        { name: 'status', width: 8, wrap: 'truncate-end' },
        ...(wide ? [{ name: 'extra', width: 10, wrap: 'truncate-end' } satisfies Cell] : []),
        ...x,
      ]
    case 'files':
      return [
        ...lead,
        { name: 'title', wrap: 'truncate-middle' },
        { name: 'type', width: 9, wrap: 'truncate-end' },
        { name: 'status', width: wide ? 10 : 9, wrap: 'truncate-end' },
        { name: 'extra', width: wide ? 10 : 9, wrap: 'truncate-end' },
        { name: 'mark', width: 8, wrap: 'truncate-end' },
        ...x,
      ]
    case 'repos':
      return [
        ...lead,
        { name: 'key', width: wide ? 24 : 20, wrap: 'truncate-end' },
        { name: 'title', wrap: 'truncate-middle' },
        { name: 'type', width: wide ? 20 : 14, wrap: 'truncate-middle' },
        // The read/edit mark.
        { name: 'status', width: 5, wrap: 'truncate-end' },
        ...x,
      ]
    case 'items': {
      const c = columnsFor(bodyColumns)
      return [
        ...lead,
        { name: 'key', width: c.key, wrap: 'truncate-end' },
        { name: 'title', wrap: 'truncate-end' },
        { name: 'type', width: c.type, wrap: 'truncate-end' },
        { name: 'status', width: c.status, wrap: 'truncate-end' },
        ...(c.extra > 0 ? [{ name: 'extra', width: c.extra, wrap: 'truncate-end' } satisfies Cell] : []),
        ...x,
      ]
    }
  }
}

const lower = (s: string | undefined): string => (s ?? '').toLowerCase()
/** The identity of a Jira issue across records and nodes: lower-case site, upper-case key. */
const jiraSiteKey = (site: string, key: string): string => `${lower(site)}/${key.toUpperCase()}`
const byPriority = <T extends { priority?: Priority }>(a: T, b: T): number => byLevel(a.priority, b.priority)
/** The level of a row whose level is the person's own mark: a Jira child, or an item no rule reads. */
const prioOf = (priority: Priority | undefined): RowPrio => (priority === undefined ? {} : { level: priority })

/** What the auto rules read from the view context: the session repo, and the branch of this session's cwd. */
export function levelContext(ctx: ViewContext): LevelContext {
  const branch = ctx.auto?.snapshot?.agents.find(a => a.id === MASTER_ID)?.branch
  return { sessionRepo: ctx.sessionRepo ?? null, ...(branch !== undefined ? { currentBranch: branch } : {}) }
}

/** The level of every item: `ctx.levels` when the composer set it, else computed here. */
export const levelsOf = (items: readonly ItemRecord[], ctx: ViewContext): ReadonlyMap<string, RowPrio> =>
  ctx.levels ?? effectiveLevels(items, levelContext(ctx))

/** `host/path` of a URL, without scheme, query, fragment and trailing slash. */
function hostPath(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)/i.exec(url)
  if (!m) return url
  // A backward loop: `.replace(/\/+$/, '')` is quadratic on a long slash run that is not at the end.
  const path = m[2] ?? ''
  let e = path.length
  while (e > 0 && path[e - 1] === '/') e--
  return (m[1] ?? '') + path.slice(0, e)
}

/** Every top-level item row can be dismissed by key. */
const dismissFor = (rec: ItemRecord): { dismissId?: string } => ({ dismissId: rec.key })

/** `↳#7,#9 ` for an item that PR bodies name (spec 10.3), else an empty string. */
function viaPrefix(via: readonly string[] | undefined): string {
  const numbers = (via ?? []).flatMap(k => {
    const n = /#(\d+)$/.exec(k)?.[1]
    return n === undefined ? [] : [`#${n}`]
  })
  return numbers.length > 0 ? `↳${numbers.join(',')} ` : ''
}

// ---------------------------------------------------------------- rows

function categoryTone(statusCategory: string | undefined): Tone {
  if (statusCategory === 'done') return 'ok'
  if (statusCategory === 'indeterminate') return 'warn'
  return 'plain'
}

/** A tracked Jira record, as its nested row shows it: the via marker and the level. */
type TrackedJira = { via?: readonly string[]; prio: RowPrio }
/** What the nested rows of one Jira root read: the root's site, the folds, the tracked records by `site/KEY`. */
type JiraTree = { site: string; folded: ReadonlySet<string>; tracked: ReadonlyMap<string, TrackedJira> }

function nodeRows(parentId: string, nodes: readonly JiraNode[], depth: number, tree: JiraTree, out: PaneRow[]): void {
  for (const n of [...nodes].sort(byPriority)) {
    const id = childId(parentId, n.key)
    const isFolded = n.children.length > 0 && tree.folded.has(id)
    const tracked = tree.tracked.get(jiraSiteKey(tree.site, n.key))
    out.push({
      id,
      depth,
      key: n.key,
      href: `https://${tree.site}/browse/${n.key}`,
      title: viaPrefix(tracked?.via) + n.summary,
      type: n.issueType,
      status: n.status,
      tone: categoryTone(n.statusCategory),
      foldable: n.children.length > 0,
      folded: isFolded,
      prio: tracked?.prio.level !== undefined ? tracked.prio : prioOf(n.priority),
    })
    if (!isFolded) nodeRows(id, n.children, depth + 1, tree, out)
  }
}

function jiraRows(
  item: JiraRecord,
  ctx: ViewContext,
  folded: ReadonlySet<string>,
  tracked: ReadonlyMap<string, TrackedJira>,
  out: PaneRow[],
  prio: RowPrio = prioOf(item.priority),
): void {
  const activeSite = ctx.tools.acli.site
  let status: string
  let tone: Tone
  if (item.error?.kind === 'not-found') {
    status = 'not found'
    tone = 'bad'
  } else if (item.trackOnly || (activeSite && lower(item.site) !== lower(activeSite))) {
    status = 'track-only'
    tone = 'dim'
  } else {
    status = item.status ?? ''
    tone = categoryTone(item.statusCategory)
  }
  const id = item.key
  const isFolded = item.children.length > 0 && folded.has(id)
  out.push({
    id,
    depth: 0,
    key: item.issueKey,
    href: item.url,
    title: viaPrefix(item.via) + (item.summary ?? item.label),
    ...dismissFor(item),
    type: item.issueType ?? '',
    status,
    tone,
    foldable: item.children.length > 0,
    folded: isFolded,
    prio,
  })
  if (!isFolded) nodeRows(id, item.children, 1, { site: item.site, folded, tracked }, out)
}

const CHECKS: Record<NonNullable<GitHubRecord['checks']>, { extra?: string; extraTone?: Tone }> = {
  failure: { extra: '✗ checks', extraTone: 'bad' },
  pending: { extra: '… checks', extraTone: 'warn' },
  success: { extra: '✓ checks', extraTone: 'ok' },
  none: {},
}

/** `prio`: the item's level as the composer found it; absent, the person's own mark. */
export function githubRow(item: GitHubRecord, ctx: ViewContext, prio: RowPrio = prioOf(item.priority)): PaneRow {
  const unresolved = !item.owner || !item.repo
  const s = ctx.sessionRepo
  const inSession =
    !unresolved &&
    !!s &&
    lower(item.owner) === lower(s.owner) &&
    lower(item.repo) === lower(s.repo) &&
    lower(item.host) === lower(s.host)
  const key = unresolved || inSession ? `#${item.number}` : `${item.owner}/${item.repo}#${item.number}`

  let status: string
  let tone: Tone
  if (item.error?.kind === 'not-found') {
    status = 'not found'
    tone = 'bad'
  } else if (item.isDraft) {
    status = 'draft'
    tone = 'dim'
  } else {
    status = item.state ?? ''
    tone = item.state === 'open' ? 'ok' : item.state === 'merged' || item.state === 'closed' ? 'dim' : 'plain'
  }

  const checks = CHECKS[item.checks ?? 'none']
  return {
    id: item.key,
    depth: 0,
    key,
    href: item.url,
    title: viaPrefix(item.via) + (item.title ?? (unresolved ? 'unresolved: no repo' : '')),
    type: item.type === 'pr' ? 'PR' : item.type === 'issue' ? 'Issue' : '',
    status,
    tone,
    ...checks,
    ...dismissFor(item),
    foldable: false,
    folded: false,
    prio,
  }
}

function webRow(item: WebRecord, prio: RowPrio = prioOf(item.priority)): PaneRow {
  return {
    id: item.key,
    depth: 0,
    key: item.label,
    href: item.url,
    title: viaPrefix(item.via) + hostPath(item.url),
    ...dismissFor(item),
    type: '',
    status: '',
    tone: 'plain',
    foldable: false,
    folded: false,
    prio,
  }
}

/** Name as key, the id as title (blank when the name is the id), the origin as type. A deleted row: dim, no link. */
function artifactRow(item: ArtifactRecord, prio: RowPrio = prioOf(item.priority)): PaneRow {
  const id = artifactIdOf(item.url)
  return {
    id: item.key,
    depth: 0,
    key: item.label,
    ...(item.deleted ? { dim: true } : { href: item.url }),
    title: item.label === id ? '' : id,
    ...dismissFor(item),
    type: artifactOrigin(item),
    status: item.deleted ? 'deleted' : '',
    tone: item.deleted ? 'dim' : 'plain',
    foldable: false,
    folded: false,
    prio,
  }
}

/** One cell per activity, each naming itself; an activity that never happened leaves its cell empty (issue #28). */
function fileRow(item: FileRecord, ctx: ViewContext, prio: RowPrio = prioOf(item.priority)): PaneRow {
  const root = ctx.auto?.root?.cwd
  return {
    id: item.key,
    depth: 0,
    key: '',
    title: root ? relativeToRoot(item.label, root) : item.label,
    ...dismissFor(item),
    type: item.created ? 'created' : item.mentions > 0 ? 'mentioned' : '',
    status: item.edits > 0 ? `edited ${item.edits}` : '',
    tone: 'plain',
    extra: item.views > 0 ? `viewed ${item.views}` : '',
    mark: item.bySubagent ? 'subagent' : '',
    foldable: false,
    folded: false,
    prio,
  }
}

/**
 * Order, titles, band words and layouts of the item sections. `unit`: the note counts rows; the others name their
 * tool. `layout` absent: 'items'.
 */
const SECTIONS: { category: Category; title: string; band: string; unit?: string; layout?: Layout }[] = [
  { category: 'jira', title: 'Jira work items', band: 'Jira' },
  { category: 'github', title: 'GitHub', band: 'GitHub' },
  { category: 'artifact', title: 'Artifacts', band: 'Artifacts', unit: 'artifacts' },
  { category: 'web', title: 'Web links', band: 'Links', unit: 'links' },
  { category: 'file', title: 'Files', band: 'Files', unit: 'files', layout: 'files' },
]

/** The `site/KEY` of every node that the root's rows draw, with the same folds as `jiraRows`. */
function drawnKeys(root: JiraRecord, folded: ReadonlySet<string>): Set<string> {
  const out = new Set<string>()
  const walk = (parentId: string, nodes: readonly JiraNode[]): void => {
    for (const n of nodes) {
      const id = childId(parentId, n.key)
      out.add(jiraSiteKey(root.site, n.key))
      if (!(n.children.length > 0 && folded.has(id))) walk(id, n.children)
    }
  }
  if (!(root.children.length > 0 && folded.has(root.key))) walk(root.key, root.children)
  return out
}

/**
 * The `site/KEY` of each Jira record that renders nested under another shown root, so it gets no root row (#48).
 * Roots are chosen top down: a record that no other open record draws above it becomes a root, and its drawn
 * keys close the records they show. A fold or a short snapshot draws less, so the record stays a root.
 * Records in a cycle (stale data) reach each other, so they all stay roots.
 */
function nestedJira(records: readonly JiraRecord[], folded: ReadonlySet<string>): Set<string> {
  const idOf = (r: JiraRecord): string => jiraSiteKey(r.site, r.issueKey)
  const drawn = new Map(records.map(r => [idOf(r), drawnKeys(r, folded)]))
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set([from])
    const stack = [from]
    while (stack.length > 0) {
      for (const k of drawn.get(stack.pop()!) ?? []) {
        if (k === to) return true
        if (drawn.has(k) && !seen.has(k)) {
          seen.add(k)
          stack.push(k)
        }
      }
    }
    return false
  }
  const above = (p: JiraRecord, r: JiraRecord): boolean =>
    p !== r && drawn.get(idOf(p))!.has(idOf(r)) && !reaches(idOf(r), idOf(p))
  const shown = new Set<string>()
  const closed = new Set<string>()
  let left = [...records]
  for (;;) {
    const open = left.filter(r => !closed.has(idOf(r)))
    if (open.length === 0) break
    const tops = open.filter(r => !open.some(p => above(p, r)))
    for (const t of tops) {
      shown.add(idOf(t))
      for (const k of drawn.get(idOf(t))!) closed.add(k)
    }
    left = left.filter(r => !tops.includes(r))
  }
  return new Set(records.map(idOf).filter(id => !shown.has(id)))
}

export function lastRefreshOf(items: readonly ItemRecord[]): number | undefined {
  let last: number | undefined
  for (const i of items)
    if (i.refreshedAt !== undefined && (last === undefined || i.refreshedAt > last)) last = i.refreshedAt
  return last
}

function noteFor(category: Category, unit: string | undefined, items: readonly ItemRecord[], ctx: ViewContext): string {
  if (unit) return `${items.length} ${unit}`
  const last = lastRefreshOf(items)
  if (category === 'github') return `gh · ${toolNote(ctx.tools.gh, ctx.now, last)}`
  const site = ctx.tools.acli.site
  return ['acli', ...(site ? [site] : []), toolNote(ctx.tools.acli, ctx.now, last)].join(' · ')
}

/** Sections in the fixed order jira, github, artifact, web, file. Empty sections are left out. */
export function buildPane(items: readonly ItemRecord[], ctx: ViewContext): PaneSection[] {
  const folded = new Set(ctx.folded)
  const levels = levelsOf(items, ctx)
  const prioFor = (i: ItemRecord): RowPrio => levels.get(i.key) ?? prioOf(i.priority)
  const sections: PaneSection[] = []
  for (const { category, title, unit, layout } of SECTIONS) {
    const own = items
      .filter(i => i.category === category && !(i.category === 'github' && i.sources.includes('auto')))
      .sort((a, b) => byLevel(prioFor(a).level, prioFor(b).level) || a.firstSeen - b.firstSeen)
    if (own.length === 0) continue
    const rows: PaneRow[] = []
    const jira = own.filter((i): i is JiraRecord => i.category === 'jira')
    const nested = nestedJira(jira, folded)
    const tracked = new Map(jira.map(r => [jiraSiteKey(r.site, r.issueKey), { via: r.via, prio: prioFor(r) }]))
    for (const item of own) {
      if (item.category === 'jira') {
        if (nested.has(jiraSiteKey(item.site, item.issueKey))) continue
        jiraRows(item, ctx, folded, tracked, rows, prioFor(item))
      } else if (item.category === 'github') rows.push(githubRow(item, ctx, prioFor(item)))
      else if (item.category === 'artifact') rows.push(artifactRow(item, prioFor(item)))
      else if (item.category === 'web') rows.push(webRow(item, prioFor(item)))
      else if (item.category === 'file') rows.push(fileRow(item, ctx, prioFor(item)))
    }
    sections.push({
      id: category,
      category,
      title,
      note: noteFor(category, unit, own, ctx),
      rows,
      ...(layout ? { layout } : {}),
      dismissable: rows.some(r => r.dismissId !== undefined),
      prio: true,
    })
  }
  return sections
}

// ---------------------------------------------------------------- element keys of a row's Buttons

export const foldKey = (rowId: string): string => `fold-${rowId}`
export const dismissKey = (id: string): string => `dismiss-${id}`

/**
 * The key of each mark Button, by row id: the row's place among the rows with a prio cell, its level, its id.
 * A row that moved or changed level gets a key the old drawing lacks, so the engine's focus call waits for the new drawing
 * and lands on that row. A stable key would resolve against the old drawing, at the old place (study S3, S4).
 */
export function markKeys(sections: readonly PaneSection[]): Map<string, string> {
  const out = new Map<string, string>()
  let i = 0
  for (const s of sections)
    for (const r of s.rows) if (r.prio) out.set(r.id, `mark:${i++}:${r.prio.level ?? '-'}:${r.id}`)
  return out
}

/**
 * Element key to row id, for every Button of a row with a prio cell: its mark, its fold and its x. A focus on any of them
 * picks the row for the priority keys. The map is built from the drawing, so no element key is ever parsed.
 */
export function focusTargets(sections: readonly PaneSection[]): Map<string, string> {
  const keys = markKeys(sections)
  const out = new Map<string, string>()
  for (const s of sections)
    for (const r of s.rows) {
      const k = keys.get(r.id)
      if (k === undefined) continue
      out.set(k, r.id)
      if (r.foldable) out.set(foldKey(r.id), r.id)
      if (r.dismissId !== undefined) out.set(dismissKey(r.dismissId), r.id)
    }
  return out
}

// ---------------------------------------------------------------- band and command text

/**
 * `Jira 6`, `GitHub 4 (1 ✗)`, `Artifacts 2`, `Links 2`, `Files 3`. GitHub counts items without source auto,
 * Artifacts the rows that are not deleted. A zero part is left out.
 */
export function bandParts(items: readonly ItemRecord[]): string[] {
  const counts = new Map<Category, number>()
  let failing = 0
  for (const i of items) {
    if (i.category === 'github' && i.sources.includes('auto')) continue
    if (i.category === 'artifact' && i.deleted) continue
    counts.set(i.category, (counts.get(i.category) ?? 0) + 1)
    if (i.category === 'github' && i.checks === 'failure') failing++
  }
  const parts: string[] = []
  for (const { category, band } of SECTIONS) {
    const n = counts.get(category) ?? 0
    if (n > 0) parts.push(`${band} ${n}${category === 'github' && failing > 0 ? ` (${failing} ✗)` : ''}`)
  }
  return parts
}

/** The `/track` text of sections: a title line, then one indented line per row. Nothing is folded. */
export function textOf(sections: readonly PaneSection[]): string {
  const lines: string[] = []
  for (const s of sections) {
    if (lines.length > 0) lines.push('')
    lines.push(`${s.title}  ${s.note}`)
    for (const r of s.rows) {
      const lead = [markerOf(r.prio?.level), r.key].filter(c => c !== '').join(' ')
      const cells = [lead, r.title, r.type, r.status, r.extra ?? '', r.mark ?? ''].filter(c => c !== '')
      lines.push('  '.repeat(r.depth + 1) + cells.join('  '))
    }
  }
  return lines.join('\n')
}
