// GhTool: refreshes GitHub issues and PRs with `gh` (spec section 7.2, KB github.md).
// One batched GraphQL call per host and chunk. No `$`: it gets a Runner and a clock.

import type {
  Checks,
  GitHubDiscoveryApi,
  GitHubState,
  GitHubTarget,
  GraphqlOutcome,
  Now,
  ReplyClass,
  RepoRef,
  Runner,
  RunResult,
} from '../contracts'
import { LIMITS } from '../contracts'
import { dig, isRecord, type Json } from '../json'
import type { CircuitBreaker } from './circuit-breaker'
import { firstLine, Tool } from './tool'

/** Aliases per GraphQL call. 50 aliases cost 1 rate point (KB github.md section 5). */
const CHUNK = 50
const NAME_OK = /^[A-Za-z0-9_.-]+$/
// Exit 4 and the "gh auth login" hint mean logged out. HTTP 401 is a plain failure for the breaker (spec section 8).
const AUTH_TEXT = /gh auth login/
const DEFAULT_HOST = 'github.com'

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export function rollupToChecks(state: string | null | undefined): Checks {
  switch (state) {
    case 'SUCCESS':
      return 'success'
    case 'FAILURE':
    case 'ERROR':
      return 'failure'
    case 'PENDING':
    case 'EXPECTED':
      return 'pending'
    default:
      return 'none'
  }
}

/**
 * One classifier for `graphql` and `refreshChunk` (spec A21). The order matters:
 * data (alias errors ride along), auth, truncated, query-error, unparsable.
 */
export function classifyReply(r: RunResult): ReplyClass {
  const parsed = parseJson(r.stdout)
  if (isRecord(parsed) && isRecord(parsed.data)) {
    return { kind: 'data', data: parsed.data, errors: Array.isArray(parsed.errors) ? parsed.errors : [] }
  }
  if (r.exitCode === 4 || AUTH_TEXT.test(r.stderr)) return { kind: 'auth', detail: firstLine(r.stderr) }
  if (r.isStdoutTruncated) return { kind: 'truncated' }
  if (isRecord(parsed) && Array.isArray(parsed.errors)) {
    const m = dig(parsed.errors, 0, 'message')
    return { kind: 'query-error', ...(typeof m === 'string' ? { detail: firstLine(m) } : {}) }
  }
  const detail = firstLine(r.stderr)
  return { kind: 'unparsable', ...(detail ? { detail } : {}) }
}

/** One alias per distinct item key. Items with the same key share an alias. */
export function buildQuery(items: readonly GitHubTarget[]): { query: string; aliases: Map<string, GitHubTarget[]> } {
  const byKey = new Map<string, GitHubTarget[]>()
  for (const it of items) {
    const group = byKey.get(it.key)
    if (group) group.push(it)
    else byKey.set(it.key, [it])
  }
  const aliases = new Map<string, GitHubTarget[]>()
  const fields: string[] = []
  let i = 0
  for (const group of byKey.values()) {
    const alias = `a${i++}`
    aliases.set(alias, group)
    const first = group[0] as GitHubTarget
    fields.push(
      `  ${alias}: repository(owner: ${JSON.stringify(first.owner)}, name: ${JSON.stringify(first.repo)}) {
    issueOrPullRequest(number: ${first.number}) {
      __typename
      ... on Issue { number title state stateReason url }
      ... on PullRequest { number title state isDraft reviewDecision url
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }
    }
  }`,
    )
  }
  return { query: `query {\n  rateLimit { cost remaining }\n${fields.join('\n')}\n}`, aliases }
}

/** Sets an optional field, or removes it when the value is not usable. */
function put<K extends keyof GitHubTarget>(it: GitHubTarget, key: K, value: GitHubTarget[K] | undefined): void {
  if (value === undefined) delete it[key]
  else it[key] = value
}

export class GhTool extends Tool<GitHubTarget> implements GitHubDiscoveryApi {
  private readonly hosts = new Map<string, boolean>()
  private readonly asking = new Map<string, Promise<boolean>>()
  private repo?: Promise<RepoRef | null>

  constructor(run: Runner, now: Now, breaker?: CircuitBreaker) {
    super('gh', run, now, breaker)
  }

  async refreshItems(items: GitHubTarget[]): Promise<void> {
    const byHost = new Map<string, GitHubTarget[]>()
    for (const it of items) {
      if (!it.owner || !it.repo || !Number.isSafeInteger(it.number) || it.number < 1) continue
      if (!NAME_OK.test(it.owner) || !NAME_OK.test(it.repo)) {
        it.error = { kind: 'not-found', message: 'invalid repo', at: this.now() }
        continue
      }
      const list = byHost.get(it.host)
      if (list) list.push(it)
      else byHost.set(it.host, [it])
    }

    for (const [host, list] of byHost) {
      const groups = new Map<string, GitHubTarget[]>()
      for (const it of list) {
        const g = groups.get(it.key)
        if (g) g.push(it)
        else groups.set(it.key, [it])
      }
      const all = [...groups.values()]
      for (let i = 0; i < all.length; i += CHUNK) {
        const goOn = await this.refreshChunk(host, all.slice(i, i + CHUNK).flat())
        if (!goOn) return
      }
    }
  }

  /** One call. Returns false when later calls make no sense: not logged in, or the breaker is open. */
  private async refreshChunk(host: string, items: GitHubTarget[]): Promise<boolean> {
    const { query, aliases } = buildQuery(items)
    const r = await this.exec(['gh', 'api', 'graphql', '--hostname', host, '-f', 'query=' + query])
    if (!r) return this.breaker.peek(this.now()) // blocked, or rejected and already recorded

    const c = classifyReply(r)
    if (c.kind === 'data') {
      this.record('ok')
      for (const [alias, group] of aliases) for (const it of group) this.apply(it, alias, c.data, c.errors)
      return true
    }
    if (c.kind === 'auth') {
      this.record('auth', c.detail)
      return false
    }
    this.record('tool-failure', firstLine(r.stderr) || 'unparsable gh output')
    return this.breaker.peek(this.now())
  }

  /**
   * One discovery call (spec A21). `available`, `breaker` and `exec` are protected in `Tool`, so `tool.ts` does not change.
   * Only auth and transport failures count against the breaker. A query-level error or a cut reply is an item error:
   * the tool worked, the answer was not usable.
   */
  async graphql(host: string, query: string): Promise<GraphqlOutcome> {
    if (this.available !== true) return { ok: false, kind: 'no-gh' }
    if (!this.breaker.peek(this.now())) return { ok: false, kind: 'blocked' }
    const r = await this.exec(['gh', 'api', 'graphql', '--hostname', host, '-f', 'query=' + query], {
      timeoutMs: LIMITS.discoveryTimeoutMs,
    })
    // A null after `peek` said yes is a rejected run, which `exec` recorded as a tool failure.
    // A lost half-open slot also gives null; it reads as transport too, which is harmless.
    if (!r) return { ok: false, kind: 'transport', ...(this.lastError ? { error: this.lastError } : {}) }
    const c = classifyReply(r)
    switch (c.kind) {
      case 'data':
        this.record('ok')
        return { ok: true, reply: { data: c.data, errors: c.errors } }
      case 'auth':
        this.record('auth', c.detail)
        return { ok: false, kind: 'auth', ...(c.detail ? { error: c.detail } : {}) }
      case 'truncated':
        this.record('item-error')
        return { ok: false, kind: 'truncated' }
      case 'query-error':
        this.record('item-error')
        return { ok: false, kind: 'query-error', ...(c.detail ? { error: c.detail } : {}) }
      case 'unparsable':
        this.record('tool-failure', c.detail || 'unparsable gh output')
        return { ok: false, kind: 'transport', error: c.detail || 'unparsable gh output' }
    }
  }

  private apply(it: GitHubTarget, alias: string, data: Json, errors: unknown[]): void {
    const at = this.now()
    const node = dig(data, alias, 'issueOrPullRequest')
    if (isRecord(node)) {
      const isPr = node.__typename === 'PullRequest'
      it.type = isPr ? 'pr' : 'issue'
      put(it, 'title', typeof node.title === 'string' ? node.title : undefined)
      put(it, 'state', typeof node.state === 'string' ? (node.state.toLowerCase() as GitHubState) : undefined)
      put(it, 'stateReason', !isPr && typeof node.stateReason === 'string' ? node.stateReason : undefined)
      put(it, 'isDraft', isPr && typeof node.isDraft === 'boolean' ? node.isDraft : undefined)
      put(it, 'reviewDecision', isPr && typeof node.reviewDecision === 'string' ? node.reviewDecision : undefined)
      const rollup = dig(node, 'commits', 'nodes', 0, 'commit', 'statusCheckRollup', 'state')
      put(it, 'checks', isPr ? rollupToChecks(typeof rollup === 'string' ? rollup : null) : undefined)
      delete it.error
      it.refreshedAt = at
      return
    }

    // A null item or repository: GitHub says it does not exist (or we have no access).
    const found = errors.find(e => isRecord(e) && Array.isArray(e.path) && e.path[0] === alias)
    const explicitNull = data[alias] === null || dig(data, alias, 'issueOrPullRequest') === null
    if (!found && !explicitNull) return
    const text = dig(found, 'message')
    const message = typeof text === 'string' ? firstLine(text) : 'not found'
    const type = dig(found, 'type')
    if (type === 'NOT_FOUND' || (type === undefined && explicitNull)) it.error = { kind: 'not-found', message, at }
    else it.error = { kind: 'failed', message, at }
    it.refreshedAt = at
  }

  /** Cached answer of the last `checkHost`. undefined: not asked yet. */
  isHostAuthed(host: string): boolean | undefined {
    return this.hosts.get(host)
  }

  /** `gh auth status --hostname <host>`. Exit 0 means authed. Never feeds the breaker. */
  checkHost(host: string): Promise<boolean> {
    const known = this.hosts.get(host)
    if (known !== undefined) return Promise.resolve(known)
    let p = this.asking.get(host)
    if (!p) {
      p = this.askHost(host)
      this.asking.set(host, p)
      void p.finally(() => this.asking.delete(host))
    }
    return p
  }

  private async askHost(host: string): Promise<boolean> {
    try {
      const r = await this.run(['gh', 'auth', 'status', '--hostname', host], { timeoutMs: LIMITS.toolTimeoutMs })
      const authed = r.exitCode === 0
      this.hosts.set(host, authed)
      return authed
    } catch {
      return false // could not ask (timeout, no gh): not cached, so a later call asks again
    }
  }

  /** `gh repo view` in the session cwd, once per instance. Never feeds the breaker. */
  defaultRepo(): Promise<RepoRef | null> {
    this.repo ??= this.loadRepo()
    return this.repo
  }

  private async loadRepo(): Promise<RepoRef | null> {
    let r: RunResult
    try {
      r = await this.run(['gh', 'repo', 'view', '--json', 'nameWithOwner,url'], { timeoutMs: LIMITS.toolTimeoutMs })
    } catch {
      return null
    }
    if (r.exitCode !== 0) return null
    const parsed = parseJson(r.stdout)
    const nameWithOwner = dig(parsed, 'nameWithOwner')
    if (typeof nameWithOwner !== 'string') return null
    const [owner, repo, ...rest] = nameWithOwner.split('/')
    if (!owner || !repo || rest.length > 0) return null
    const url = dig(parsed, 'url')
    let host = DEFAULT_HOST
    if (typeof url === 'string') {
      try {
        host = new URL(url).hostname || DEFAULT_HOST
      } catch {
        // keep the default host
      }
    }
    return { host, owner, repo }
  }

  /** A manual refresh also forgets host denials: the person may have run `gh auth login` since. */
  override reset(): void {
    super.reset()
    for (const [host, authed] of this.hosts) if (!authed) this.hosts.delete(host)
  }
}
