// GhTool: refreshes GitHub issues and PRs with `gh` (spec section 7.2, KB github.md).
// One batched GraphQL call per host and chunk. No `$`: it gets a Runner and a clock.

import type { Now, RepoRef, Runner, RunOpts, RunResult } from '../../core/interfaces/ports'
import type { Breaker, ToolHandle, ToolOutcome } from '../../core/interfaces/tracker'
import { dig, isRecord, type Json } from '../../core/lib/json'
import { firstLine, Tool, type ToolTimeouts } from '../../core/lib/tool'
import { GITHUB_DEFAULTS, type GithubConfig } from './config'
import type {
  Checks,
  GitHubDiscoveryApi,
  GitHubState,
  GitHubTarget,
  GraphqlOutcome,
  Mergeable,
  ReplyClass,
} from './types'
import { githubKey } from './urls'

const NAME_OK = /^[A-Za-z0-9_.-]+$/
// Exit 4 and the "gh auth login" hint mean logged out. HTTP 401 is a plain failure for the breaker (spec section 8).
const AUTH_TEXT = /gh auth login/
// `gh auth status --hostname <host>` for a host with no account, with the account of no host at all (gh 2.40 to 2.102,
// `pkg/cmd/auth/status`). The first has no `gh auth login` in it. KB: sources/gh-2.102.0-auth-status-2026-10-22, `auth-status-host-no-login.txt`.
// A gh before 2.40 says `Hostname "<host>" not found among authenticated GitHub hosts` for a host with no account.
const NO_LOGIN_TEXT = /not logged into any (accounts on|GitHub hosts)|not found among authenticated GitHub hosts/
// What an older gh says to `--json` on `gh auth status`, from cobra. The flag came in gh 2.81.0 (`status.go` has no JSON
// flags at v2.80.0, and has them at v2.81.0).
const NO_JSON_FLAG = /unknown flag: --json/
// The `error` of a `gh auth status --json hosts` entry whose token the host refused: a bad token, as opposed to a host that
// cannot be reached (`dial tcp: lookup ... no such host`, `i/o timeout`). A stored token (keyring, hosts.yml: what
// `gh auth login` leaves) fails the REST call of gh: `HTTP 401: Bad credentials (<api url>)`. An env token (GH_TOKEN,
// GH_ENTERPRISE_TOKEN) fails the GraphQL call: `non-200 OK status code: 401 ...`. KB: `auth-status-host-stored-bad-token-json.txt`
// and `auth-status-host-bad-token-json.txt`.
const REFUSED_TOKEN = /\b(?:HTTP|status code:) 401\b/
const DEFAULT_HOST = 'github.com'

/** What the check of a host found: a login, a login the host refuses or no login at all (denied), or no answer (failed). */
type HostVerdict = { kind: 'authed' } | { kind: 'denied' } | { kind: 'failed'; detail: string }

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The text form of `gh auth status`: exit 0 is a login, the no-login and re-authenticate lines are a denial, the rest is no answer. */
function textVerdict(r: RunResult): HostVerdict {
  if (r.exitCode === 0) return { kind: 'authed' }
  const text = `${r.stderr}\n${r.stdout}`
  if (NO_LOGIN_TEXT.test(text) || AUTH_TEXT.test(text)) return { kind: 'denied' }
  return { kind: 'failed', detail: firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.exitCode}` }
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

const MERGEABLE: ReadonlySet<unknown> = new Set<Mergeable>(['MERGEABLE', 'CONFLICTING', 'UNKNOWN'])

/** The `mergeable` of a reply when it is one of the three words GitHub documents. Else undefined: no value. */
export const mergeableOf = (v: unknown): Mergeable | undefined => (MERGEABLE.has(v) ? (v as Mergeable) : undefined)

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

/** One alias per distinct item key. Items with the same key share an alias. `closingRefs` is `closingRefsPerPr`. */
export function buildQuery(
  items: readonly GitHubTarget[],
  closingRefs: number = GITHUB_DEFAULTS.closingRefsPerPr,
): { query: string; aliases: Map<string, GitHubTarget[]> } {
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
      ... on PullRequest { number title state isDraft reviewDecision url mergeable mergeStateStatus
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        closingIssuesReferences(first: ${closingRefs}) { nodes { number repository { nameWithOwner } } } }
    }
  }`,
    )
  }
  return { query: `query {\n  rateLimit { cost remaining }\n${fields.join('\n')}\n}`, aliases }
}

/**
 * The issue keys a PR's closing references name, so an issue can take the level of the PR (R8). A ref with no
 * repository is in the PR's own repo, as discovery reads it. No `nodes` in the reply: undefined, the stored list stays.
 */
function closesOf(pr: GitHubTarget, nodes: unknown): string[] | undefined {
  if (!Array.isArray(nodes) || !pr.owner || !pr.repo) return undefined
  const out: string[] = []
  for (const c of nodes) {
    if (!isRecord(c) || typeof c.number !== 'number') continue
    const nameWithOwner = dig(c, 'repository', 'nameWithOwner')
    const [owner, name] = (typeof nameWithOwner === 'string' ? nameWithOwner : '').split('/')
    out.push(githubKey(pr.host, owner || pr.owner, name || pr.repo, c.number))
  }
  return out
}

/** Sets an optional field, or removes it when the value is not usable. */
function put<K extends keyof GitHubTarget>(it: GitHubTarget, key: K, value: GitHubTarget[K] | undefined): void {
  if (value === undefined) delete it[key]
  else it[key] = value
}

/** The github values the tool reads, at each call: a changed config file shows at the next one. */
export type GhLimits = () => Pick<GithubConfig, 'chunkSize' | 'closingRefsPerPr' | 'discoveryTimeoutMs'>

export class GhTool extends Tool<GitHubTarget> implements GitHubDiscoveryApi {
  private readonly hosts = new Map<string, boolean>()
  private readonly asking = new Map<string, Promise<boolean>>()
  /**
   * The host the tool-wide login flag and breaker stand for: the session repo's host, else github.com. A call to any other
   * host (a PR the session created there, an item of it) has its own breaker and its own login (`hosts`): a refusal or a
   * run of failures of that host must not log the whole tool out or open its breaker (issue #158).
   * The breaker of a host has the numbers of the tool (`ToolHandle.spare`).
   */
  private home = DEFAULT_HOST
  private readonly hostBreakers = new Map<string, Breaker>()
  private readonly hostErrors = new Map<string, string>()
  private repo?: Promise<RepoRef | null>
  private readonly limits: GhLimits

  constructor(
    run: Runner | ToolHandle,
    now: Now,
    breaker?: Breaker,
    opts: { limits?: GhLimits; timeouts?: ToolTimeouts } = {},
  ) {
    super('gh', run, now, breaker, opts.timeouts)
    this.limits = opts.limits ?? (() => GITHUB_DEFAULTS)
  }

  /**
   * The session repo's host (undefined: none, so github.com). The tool-wide flag and breaker stand for this host. A new
   * home host starts clean: the flag and the breaker were the old host's, so this is a manual refresh (`reset`).
   */
  setHome(host: string | undefined): void {
    const next = (host ?? DEFAULT_HOST).toLowerCase()
    if (next === this.home) return
    this.home = next
    this.reset()
  }

  /** The key of a host in every map of the tool: host names do not depend on the case. */
  private static keyOf(host: string): string {
    return host.toLowerCase()
  }

  /** A host that is not the home host: its login and its failures stay its own. */
  private isForeign(host: string): boolean {
    return GhTool.keyOf(host) !== this.home
  }

  private breakerOf(host: string): Breaker {
    const key = GhTool.keyOf(host)
    let breaker = this.hostBreakers.get(key)
    if (!breaker) {
      breaker = this.handle.spare()
      this.hostBreakers.set(key, breaker)
    }
    return breaker
  }

  /**
   * `canCall` for a call to `host`: the home host asks the tool (login flag, breaker). Another host asks its own denial
   * and its own breaker, so the home host being logged out or at rest does not hold it up (issue #158).
   */
  canCallHost(host: string, now: number): boolean {
    if (!this.isForeign(host)) return this.canCall(now)
    return this.isAvailable && this.hosts.get(GhTool.keyOf(host)) !== false && this.breakerOf(host).peek(now)
  }

  /** The breaker alone, for a call to `host`. */
  private allowsHost(host: string): boolean {
    return this.isForeign(host) ? this.breakerOf(host).peek(this.now()) : this.breakerAllows
  }

  /** `exec` for a call to `host`: the home host runs under the breaker of the tool, another host under its own. */
  private async execOn(host: string, argv: readonly string[], init?: RunOpts): Promise<RunResult | null> {
    if (!this.isForeign(host)) return this.exec(argv, init)
    const breaker = this.breakerOf(host)
    if (!breaker.allows(this.now())) return null
    try {
      return await this.raw(argv, init)
    } catch (err) {
      this.noteOn(host, 'tool-failure', err instanceof Error ? err.message : String(err))
      return null
    }
  }

  /** `record` for a call to `host`. Another host feeds its own breaker, and a refusal denies that host alone. */
  private noteOn(host: string, outcome: ToolOutcome, detail?: string): void {
    if (!this.isForeign(host)) {
      this.record(outcome, detail)
      return
    }
    const breaker = this.breakerOf(host)
    const key = GhTool.keyOf(host)
    switch (outcome) {
      case 'ok':
      case 'item-error':
        this.hostErrors.delete(key)
        breaker.success()
        return
      case 'auth':
        this.hosts.set(key, false) // `canRefresh` and `checkHost` read it; a manual refresh forgets it
        breaker.success() // a refusal is no run of failures: it frees a half-open slot, nothing more
        return
      case 'tool-failure':
        this.hostErrors.set(key, detail ?? 'failed')
        breaker.failure(this.now())
        return
    }
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
      // Aliases per GraphQL call. 50 aliases cost 1 rate point (KB github.md section 5).
      const chunk = this.limits().chunkSize
      for (let i = 0; i < all.length; i += chunk) {
        const goOn = await this.refreshChunk(host, all.slice(i, i + chunk).flat())
        // That host is out (logged out, or at rest), and the others are not: each host has its own state, the home host too.
        if (!goOn) break
      }
    }
  }

  /** One call. Returns false when later calls make no sense: not logged in, or the breaker is open. */
  private async refreshChunk(host: string, items: GitHubTarget[]): Promise<boolean> {
    const { query, aliases } = buildQuery(items, this.limits().closingRefsPerPr)
    const r = await this.execOn(host, ['gh', 'api', 'graphql', '--hostname', host, '-f', 'query=' + query])
    if (!r) return this.allowsHost(host) // blocked, or rejected and already recorded

    const c = classifyReply(r)
    if (c.kind === 'data') {
      this.noteOn(host, 'ok')
      for (const [alias, group] of aliases) for (const it of group) this.apply(it, alias, c.data, c.errors)
      return true
    }
    if (c.kind === 'auth') {
      this.noteOn(host, 'auth', c.detail)
      return false
    }
    this.noteOn(host, 'tool-failure', firstLine(r.stderr) || 'unparsable gh output')
    return this.allowsHost(host)
  }

  /**
   * One discovery call (spec A21). `available`, `breakerAllows` and `exec` are protected in `Tool`.
   * Only auth and transport failures count against the breaker. A query-level error or a cut reply is an item error:
   * the tool worked, the answer was not usable.
   */
  async graphql(host: string, query: string): Promise<GraphqlOutcome> {
    if (this.available !== true) return { ok: false, kind: 'no-gh' }
    if (!this.allowsHost(host)) return { ok: false, kind: 'blocked' }
    const r = await this.execOn(host, ['gh', 'api', 'graphql', '--hostname', host, '-f', 'query=' + query], {
      timeoutMs: this.limits().discoveryTimeoutMs,
    })
    // A null after `peek` said yes is a rejected run, which `execOn` recorded as a tool failure.
    // A lost half-open slot also gives null; it reads as transport too, which is harmless.
    if (!r) {
      const error = this.isForeign(host) ? this.hostErrors.get(GhTool.keyOf(host)) : this.lastError
      return { ok: false, kind: 'transport', ...(error ? { error } : {}) }
    }
    const c = classifyReply(r)
    switch (c.kind) {
      case 'data':
        this.noteOn(host, 'ok')
        return { ok: true, reply: { data: c.data, errors: c.errors } }
      case 'auth':
        this.noteOn(host, 'auth', c.detail)
        return { ok: false, kind: 'auth', ...(c.detail ? { error: c.detail } : {}) }
      case 'truncated':
        this.noteOn(host, 'item-error')
        return { ok: false, kind: 'truncated' }
      case 'query-error':
        this.noteOn(host, 'item-error')
        return { ok: false, kind: 'query-error', ...(c.detail ? { error: c.detail } : {}) }
      case 'unparsable':
        this.noteOn(host, 'tool-failure', c.detail || 'unparsable gh output')
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
      put(it, 'mergeable', isPr ? mergeableOf(node.mergeable) : undefined)
      put(it, 'mergeStateStatus', isPr && typeof node.mergeStateStatus === 'string' ? node.mergeStateStatus : undefined)
      put(it, 'closes', isPr ? closesOf(it, dig(node, 'closingIssuesReferences', 'nodes')) : undefined)
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
    return this.hosts.get(GhTool.keyOf(host))
  }

  /**
   * `gh auth status --hostname <host>`. Exit 0 means authed. Never feeds the breaker of the tool. The check of a host that
   * is not the home host feeds the breaker of that host when it cannot run, and is not made while that host rests.
   */
  checkHost(host: string): Promise<boolean> {
    const key = GhTool.keyOf(host)
    const known = this.hosts.get(key)
    if (known !== undefined) return Promise.resolve(known)
    let p = this.asking.get(key)
    if (!p) {
      p = this.askHost(host)
      this.asking.set(key, p)
      void p.finally(() => this.asking.delete(key))
    }
    return p
  }

  private async askHost(host: string): Promise<boolean> {
    const foreign = this.isForeign(host)
    if (foreign && !this.breakerOf(host).allows(this.now())) return false // the host rests: not asked, not cached
    let verdict: HostVerdict
    try {
      verdict = await this.verdictOf(host)
    } catch (err) {
      // Could not ask (timeout, no gh): not cached, so a later call asks again, after the breaker of that host allows it.
      verdict = { kind: 'failed', detail: err instanceof Error ? err.message : String(err) }
    }
    const key = GhTool.keyOf(host)
    switch (verdict.kind) {
      case 'authed':
        this.hosts.set(key, true)
        if (foreign) this.noteOn(host, 'ok')
        return true
      case 'denied':
        this.hosts.set(key, false)
        if (foreign) this.noteOn(host, 'auth')
        return false
      case 'failed':
        // A host that cannot be reached says nothing of its login: not cached. A foreign host counts it against its own
        // breaker. The home host never feeds the breaker of the tool from a check.
        if (foreign) this.noteOn(host, 'tool-failure', verdict.detail)
        return false
    }
  }

  /**
   * One `gh auth status --hostname <host> --json hosts`: an entry per account, `state` `success`, `error` or `timeout`, exit 0
   * whatever the state. An older gh has no `--json` there, and is asked for the text. A gh (or a fake) that ignores the flag and
   * prints no JSON is judged by its text and its exit code.
   */
  private async verdictOf(host: string): Promise<HostVerdict> {
    const argv = ['gh', 'auth', 'status', '--hostname', host]
    const r = await this.raw([...argv, '--json', 'hosts'])
    if (r.exitCode !== 0 && NO_JSON_FLAG.test(r.stderr)) return textVerdict(await this.raw(argv))
    const hosts = dig(parseJson(r.stdout), 'hosts')
    if (!isRecord(hosts)) return textVerdict(r)
    const key = GhTool.keyOf(host)
    const entries = Object.entries(hosts).find(([name]) => GhTool.keyOf(name) === key)?.[1]
    const accounts = (Array.isArray(entries) ? entries : []).filter(isRecord)
    // No account on that host: no login. gh tests the active account of a host first, and that one decides.
    const account = accounts.find(a => a.active === true) ?? accounts[0]
    if (!account) return { kind: 'denied' }
    const state = typeof account.state === 'string' ? account.state : ''
    const error = typeof account.error === 'string' ? account.error : ''
    if (state === 'success') return { kind: 'authed' }
    if (state === 'error' && REFUSED_TOKEN.test(error)) return { kind: 'denied' }
    return { kind: 'failed', detail: firstLine(error) || `gh auth status: ${state || 'no state'}` }
  }

  /** `gh repo view` in the session cwd, once per instance. Never feeds the breaker. */
  defaultRepo(): Promise<RepoRef | null> {
    this.repo ??= this.loadRepo()
    return this.repo
  }

  private async loadRepo(): Promise<RepoRef | null> {
    let r: RunResult
    try {
      r = await this.raw(['gh', 'repo', 'view', '--json', 'nameWithOwner,url'])
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
    for (const breaker of this.hostBreakers.values()) breaker.reset()
    this.hostErrors.clear()
  }
}
