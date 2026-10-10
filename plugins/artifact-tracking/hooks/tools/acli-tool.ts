// AcliTool: Jira work items through the Atlassian CLI (spec section 7.3, KB jira.md).
// No `$`: it gets a Runner and a clock. It never runs `acli jira auth switch`, `login` or `logout`.

import { JIRA_KEY, LIMITS } from '../contracts'
import type { CircuitBreaker } from './circuit-breaker'
import type { JiraNode, JiraTarget, JiraToolApi, Now, Runner, ToolStatus } from '../contracts'
import { Tool, firstLine } from './tool'
import type { Outcome } from './tool'

const VIEW_FIELDS = 'issuetype,status,summary,parent,subtasks'
const SEARCH_FIELDS = 'issuetype,status,summary'

// ---------------------------------------------------------------- pure helpers

/** Host from the `Site:` line of `acli jira auth status`, lower-case. null when there is none. */
export function parseAuthStatus(stdout: string): string | null {
  const m = /^\s*Site:\s*(\S+)/im.exec(stdout)
  if (!m?.[1]) return null
  const host = m[1].replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase()
  return host || null
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/**
 * One Jira REST issue (`view` object, `search` element or `subtasks[]` entry) as a tree node.
 * Missing fields read as unknown (empty string). Children come from `fields.subtasks`.
 * Returns null when there is no key.
 */
export function nodeFromIssue(json: unknown): JiraNode | null {
  if (!isObject(json)) return null
  const key = str(json.key)
  if (!key) return null
  const f = isObject(json.fields) ? json.fields : {}
  const issuetype = isObject(f.issuetype) ? f.issuetype : {}
  const status = isObject(f.status) ? f.status : {}
  const category = isObject(status.statusCategory) ? str(status.statusCategory.key) : undefined
  const node: JiraNode = {
    key,
    summary: str(f.summary) ?? '',
    issueType: str(issuetype.name) ?? '',
    status: str(status.name) ?? '',
    children: [],
  }
  if (category !== undefined) node.statusCategory = category
  if (Array.isArray(f.subtasks)) {
    for (const s of f.subtasks) {
      const c = nodeFromIssue(s)
      if (c) node.children.push(c)
    }
  }
  return node
}

/** Classifies the stderr of a failed acli call (KB jira.md section 5). */
export function classifyAcliFailure(stderr: string): Outcome {
  if (/does not exist or you do not have permission/i.test(stderr)) return 'item-error'
  if (/unauthorized/i.test(stderr)) return 'auth'
  return 'tool-failure'
}

/** A tiny concurrency limiter: at most `n` tasks run at once, the rest wait in order. */
export function limit(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: Array<() => void> = []
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < n) active++
    else await new Promise<void>((resolve) => waiting.push(resolve)) // the finishing task hands its slot over
    try {
      return await fn()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}

/** Parses acli JSON stdout. Tolerates a notice before the JSON. Returns undefined when it is not JSON. */
function parseJson(stdout: string): unknown {
  const text = stdout.trim()
  try {
    return JSON.parse(text)
  } catch {
    const at = text.search(/[[{]/)
    if (at <= 0) return undefined
    try {
      return JSON.parse(text.slice(at))
    } catch {
      return undefined
    }
  }
}

// ---------------------------------------------------------------- tool

export class AcliTool extends Tool<JiraTarget> implements JiraToolApi {
  private site: string | null | undefined
  private loading?: Promise<string | null>
  private readonly gate = limit(LIMITS.acliConcurrency)

  constructor(run: Runner, now: Now, breaker?: CircuitBreaker) {
    super('acli', run, now, breaker)
  }

  /** Host of acli's active site. undefined: not loaded. null: none (not logged in). */
  get activeSite(): string | null | undefined {
    return this.site
  }

  override status(): ToolStatus {
    const s = super.status()
    if (this.site) s.site = this.site
    return s
  }

  /** Manual refresh: also forget a "no site" answer, so the next refresh asks acli again. */
  override reset(): void {
    super.reset()
    if (this.site === null) this.site = undefined
  }

  /** Runs `acli jira auth status` and caches the site. Concurrent callers share one call. */
  loadActiveSite(): Promise<string | null> {
    this.loading ??= this.loadSite().finally(() => {
      this.loading = undefined
    })
    return this.loading
  }

  private async loadSite(): Promise<string | null> {
    const r = await this.gate(() => this.exec(['acli', 'jira', 'auth', 'status']))
    if (!r) return this.site ?? null // blocked by the breaker, or rejected (already recorded)
    const site = r.exitCode === 0 ? parseAuthStatus(r.stdout) : null
    if (site) {
      this.site = site
      this.record('ok')
      return site
    }
    if (/unauthorized/i.test(r.stderr)) {
      this.site = null
      this.record('auth')
      return null
    }
    this.record('tool-failure', firstLine(r.stderr) || 'no Site line in acli auth status')
    return this.site ?? null
  }

  async refreshItems(items: JiraTarget[]): Promise<void> {
    try {
      await this.refresh(items)
    } catch (err) {
      this.record('tool-failure', err instanceof Error ? err.message : String(err)) // never reject
    }
  }

  private async refresh(items: JiraTarget[]): Promise<void> {
    if (this.available === false || this.isLoggedOut()) return
    if (!this.breaker.peek(this.now())) return
    if (this.site === undefined || this.breaker.state !== 'closed') await this.loadActiveSite()
    const site = this.site
    if (!site || this.isLoggedOut()) return

    // Skip what acli cannot or must not refresh. Items with the same key share one fetch.
    const groups = new Map<string, JiraTarget[]>()
    for (const it of items) {
      if (it.trackOnly || !JIRA_KEY.test(it.issueKey) || it.site.toLowerCase() !== site) continue
      const g = groups.get(it.issueKey)
      if (g) g.push(it)
      else groups.set(it.issueKey, [it])
    }
    await Promise.all([...groups].map(([key, targets]) => this.refreshKey(key, targets)))
  }

  /** A call proved acli is logged out. A method, so the check is not narrowed across awaits. */
  private isLoggedOut(): boolean {
    return this.loggedIn === false
  }

  /** acli call through the concurrency limit and the breaker. */
  private call(argv: readonly string[]) {
    return this.gate(() => this.exec(argv))
  }

  private async refreshKey(key: string, targets: JiraTarget[]): Promise<void> {
    const r = await this.call(['acli', 'jira', 'workitem', 'view', key, '--fields', VIEW_FIELDS, '--json'])
    if (!r) return
    if (r.exitCode !== 0) {
      const detail = firstLine(r.stderr)
      const outcome = classifyAcliFailure(r.stderr)
      this.record(outcome, detail || undefined)
      if (outcome === 'item-error') {
        const at = this.now()
        for (const t of targets) {
          t.error = { kind: 'not-found', message: detail || 'not found', at }
          t.refreshedAt = at
        }
      }
      return
    }
    const node = nodeFromIssue(parseJson(r.stdout))
    if (!node) {
      this.record('tool-failure', 'unparsable acli output')
      return
    }
    this.record('ok')

    // An Epic lists no subtasks. Its children come from a search. A failed search keeps the old tree.
    let children: JiraNode[] | undefined = node.children
    if (node.issueType === 'Epic') children = await this.epicChildren(key)

    const at = this.now()
    for (const t of targets) {
      t.summary = node.summary
      t.issueType = node.issueType
      t.status = node.status
      t.statusCategory = node.statusCategory
      if (children) t.children = children.map(cloneNode)
      delete t.error
      t.refreshedAt = at
    }
  }

  /** Children of an Epic, each with its subtasks. undefined when the search failed. */
  private async epicChildren(epicKey: string): Promise<JiraNode[] | undefined> {
    const r = await this.call([
      'acli', 'jira', 'workitem', 'search',
      '--jql', `parent = ${epicKey}`,
      '--fields', SEARCH_FIELDS,
      '--limit', String(LIMITS.epicChildLimit),
      '--json',
    ])
    if (!r) return undefined
    if (r.exitCode !== 0) {
      this.record(classifyAcliFailure(r.stderr), firstLine(r.stderr) || undefined)
      return undefined
    }
    const json = parseJson(r.stdout)
    if (!Array.isArray(json)) {
      this.record('tool-failure', 'unparsable acli output')
      return undefined
    }
    this.record('ok')
    const children: JiraNode[] = []
    for (const j of json) {
      const c = nodeFromIssue(j)
      if (c) children.push(c)
    }
    await Promise.all(children.map((c) => this.fillSubtasks(c)))
    return children
  }

  /** One `view` for a child gives its subtasks. A failed view leaves `children` empty. */
  private async fillSubtasks(child: JiraNode): Promise<void> {
    if (!JIRA_KEY.test(child.key)) return
    const r = await this.call(['acli', 'jira', 'workitem', 'view', child.key, '--fields', VIEW_FIELDS, '--json'])
    if (!r) return
    if (r.exitCode !== 0) {
      this.record(classifyAcliFailure(r.stderr), firstLine(r.stderr) || undefined)
      return
    }
    const node = nodeFromIssue(parseJson(r.stdout))
    if (!node) {
      this.record('tool-failure', 'unparsable acli output')
      return
    }
    this.record('ok')
    child.children = node.children
  }
}

function cloneNode(n: JiraNode): JiraNode {
  return { ...n, children: n.children.map(cloneNode) }
}
