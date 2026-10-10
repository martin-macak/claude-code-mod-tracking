// View model for the pane, the band and the `/track` text. Pure: no `$`, no JSX, no clock.
// Spec: docs/superpowers/specs/2026-10-10-artifact-tracking-design.md section 9.

import type {
  Category, GitHubRecord, ItemRecord, JiraNode, JiraRecord, RepoRef, ToolStatus, WebRecord,
} from '../contracts'

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
}

export type PaneSection = { category: Category; title: string; note: string; rows: PaneRow[] }

export type ViewContext = {
  now: number
  /** Ids of folded rows (`UiState.folded`). */
  folded: readonly string[]
  tools: { gh: ToolStatus; acli: ToolStatus }
  /** Repo of the session. A GitHub key in this repo shows as `#N`. */
  sessionRepo?: RepoRef | null
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

export function columnsFor(bodyColumns: number | undefined): Columns {
  const c = bodyColumns ?? 80
  const cols: Columns = { key: 16, type: 9, status: 13, extra: 10 }
  if (c < 70) {
    cols.extra = 0
    cols.type = 6
  }
  return cols
}

const lower = (s: string | undefined): string => (s ?? '').toLowerCase()

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

// ---------------------------------------------------------------- rows

function categoryTone(statusCategory: string | undefined): Tone {
  if (statusCategory === 'done') return 'ok'
  if (statusCategory === 'indeterminate') return 'warn'
  return 'plain'
}

function nodeRows(
  parentId: string, nodes: readonly JiraNode[], depth: number, site: string,
  folded: ReadonlySet<string>, out: PaneRow[],
): void {
  for (const n of nodes) {
    const id = parentId + '/' + n.key
    const isFolded = n.children.length > 0 && folded.has(id)
    out.push({
      id, depth, key: n.key, href: `https://${site}/browse/${n.key}`, title: n.summary, type: n.issueType,
      status: n.status, tone: categoryTone(n.statusCategory),
      foldable: n.children.length > 0, folded: isFolded,
    })
    if (!isFolded) nodeRows(id, n.children, depth + 1, site, folded, out)
  }
}

function jiraRows(item: JiraRecord, ctx: ViewContext, folded: ReadonlySet<string>, out: PaneRow[]): void {
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
    id, depth: 0, key: item.issueKey, href: item.url, title: item.summary ?? item.label,
    type: item.issueType ?? '', status, tone,
    foldable: item.children.length > 0, folded: isFolded,
  })
  if (!isFolded) nodeRows(id, item.children, 1, item.site, folded, out)
}

const CHECKS: Record<NonNullable<GitHubRecord['checks']>, { extra?: string; extraTone?: Tone }> = {
  failure: { extra: '✗ checks', extraTone: 'bad' },
  pending: { extra: '… checks', extraTone: 'warn' },
  success: { extra: '✓ checks', extraTone: 'ok' },
  none: {},
}

function githubRow(item: GitHubRecord, ctx: ViewContext): PaneRow {
  const unresolved = !item.owner || !item.repo
  const s = ctx.sessionRepo
  const inSession = !unresolved && !!s
    && lower(item.owner) === lower(s.owner) && lower(item.repo) === lower(s.repo)
    && lower(item.host) === lower(s.host)
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
    id: item.key, depth: 0, key, href: item.url,
    title: item.title ?? (unresolved ? 'unresolved: no repo' : ''),
    type: item.type === 'pr' ? 'PR' : item.type === 'issue' ? 'Issue' : '',
    status, tone, ...checks, foldable: false, folded: false,
  }
}

function webRow(item: WebRecord): PaneRow {
  return {
    id: item.key, depth: 0, key: item.label, href: item.url, title: hostPath(item.url),
    type: '', status: '', tone: 'plain', foldable: false, folded: false,
  }
}

const SECTIONS: { category: Category; title: string }[] = [
  { category: 'jira', title: 'Jira work items' },
  { category: 'github', title: 'GitHub' },
  { category: 'web', title: 'Web links' },
]

function lastRefreshOf(items: readonly ItemRecord[]): number | undefined {
  let last: number | undefined
  for (const i of items) if (i.refreshedAt !== undefined && (last === undefined || i.refreshedAt > last)) last = i.refreshedAt
  return last
}

function noteFor(category: Category, items: readonly ItemRecord[], ctx: ViewContext): string {
  if (category === 'web') return `${items.length} links`
  const last = lastRefreshOf(items)
  if (category === 'github') return `gh · ${toolNote(ctx.tools.gh, ctx.now, last)}`
  const site = ctx.tools.acli.site
  return ['acli', ...(site ? [site] : []), toolNote(ctx.tools.acli, ctx.now, last)].join(' · ')
}

/** Sections in the fixed order jira, github, web. Empty sections are left out. */
export function buildPane(items: readonly ItemRecord[], ctx: ViewContext): PaneSection[] {
  const folded = new Set(ctx.folded)
  const sections: PaneSection[] = []
  for (const { category, title } of SECTIONS) {
    const own = items.filter((i) => i.category === category).sort((a, b) => a.firstSeen - b.firstSeen)
    if (own.length === 0) continue
    const rows: PaneRow[] = []
    for (const item of own) {
      if (item.category === 'jira') jiraRows(item, ctx, folded, rows)
      else if (item.category === 'github') rows.push(githubRow(item, ctx))
      else rows.push(webRow(item))
    }
    sections.push({ category, title, note: noteFor(category, own, ctx), rows })
  }
  return sections
}

// ---------------------------------------------------------------- band and command text

/** `Jira 6 · GitHub 4 (1 ✗) · Links 2`. null when nothing is tracked. */
export function bandText(items: readonly ItemRecord[]): string | null {
  let j = 0
  let g = 0
  let w = 0
  let failing = 0
  for (const i of items) {
    if (i.category === 'jira') j++
    else if (i.category === 'github') {
      g++
      if (i.checks === 'failure') failing++
    } else w++
  }
  const parts: string[] = []
  if (j > 0) parts.push(`Jira ${j}`)
  if (g > 0) parts.push(`GitHub ${g}${failing > 0 ? ` (${failing} ✗)` : ''}`)
  if (w > 0) parts.push(`Links ${w}`)
  return parts.length > 0 ? parts.join(' · ') : null
}

/** Plain-text pane for `/track` (also in `claude -p`). It shows the whole tree: nothing is folded. */
export function commandText(items: readonly ItemRecord[], ctx: ViewContext): string {
  const sections = buildPane(items, { ...ctx, folded: [] })
  if (sections.length === 0) return 'No tracked items yet.'
  const lines: string[] = []
  for (const s of sections) {
    if (lines.length > 0) lines.push('')
    lines.push(`${s.title}  ${s.note}`)
    for (const r of s.rows) {
      const cells = [r.key, r.title, r.type, r.status, r.extra ?? ''].filter((c) => c !== '')
      lines.push('  '.repeat(r.depth + 1) + cells.join('  '))
    }
  }
  return lines.join('\n')
}
