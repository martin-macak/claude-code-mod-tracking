// ItemRuntime: the transitional item host. It holds what the five item trackers share until layer L5 builds the real
// ItemStore, Capture, ItemKind and ToolSpec: the item list, the capture funnel, the refresh coordinator, the `gh` and
// `acli` tools, the session repo and the statuses of the tools. It is the `items` slot of Persistence.
// It never sees `$`. The manager hands it a HostContext at `start` and it keeps that context (the ports of the first
// hook of the load). The atoms it writes come in at construction.
// A kind that the config turned off (`ctx.trackers.live`) runs no CLI, claims its spans and drops them, and leaves no
// record at start, replay, load or carry.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.7, 5.8 and 5.9.
// Plan: L3 Task 11, D13. L4 Task 6, C12.

import { RefreshCoordinator } from '../../core/infra/coordinator'
import type { GlobalConfig } from '../../core/interfaces/config'
import type { ReplayItem, RowEvent, SessionChangedEvent } from '../../core/interfaces/events'
import type { Claim, HostContext, ItemsHost, Json, StoredItem } from '../../core/interfaces/items'
import type { StatePorts } from '../../core/interfaces/ports'
import type { DataSlot } from '../../core/interfaces/slots'
import { CircuitBreaker } from '../../core/lib/circuit-breaker'
import { GLOBAL_DEFAULTS } from '../../core/lib/global-config'
import type { ToolTimeouts } from '../../core/lib/tool'
import type { AutoGithub } from '../../trackers/auto'
import { FILE_DEFAULTS, type FileConfig } from '../../trackers/file/config'
import { FileSight } from '../../trackers/file/sighting'
import { GITHUB_DEFAULTS, type GithubConfig } from '../../trackers/github/config'
import { GhTool } from '../../trackers/github/gh-tool'
import { AcliTool } from '../../trackers/jira/acli-tool'
import { JIRA_DEFAULTS, type JiraConfig } from '../../trackers/jira/config'
import type { GitHubDiscoveryApi, ItemRecord, Priority, RepoRef, Runner, ToolStatus } from '../contracts'
import { rowIdOf, setPriority } from '../model/priority'
import {
  carryOver,
  hydrate,
  mergeResults,
  rekeyArtifacts,
  resolveBareRefs,
  type Ttl,
  unionRecords,
} from '../model/registry'
import { Capture, type CaptureLimits } from './capture'
import { itemsFromBatch, onlyNew } from './replay'
import { ItemStore, storedForLoad } from './store'

/** The status as the pane sees it. `lastRunAt` moves on every call and no view shows it, so it is not compared (A22). */
const shown = (x: Record<string, ToolStatus>): string =>
  JSON.stringify([
    { ...x.gh, lastRunAt: undefined },
    { ...x.acli, lastRunAt: undefined },
  ])

const isEmpty = (v: Json | undefined): boolean => !Array.isArray(v) || v.length === 0

export class ItemRuntime implements ItemsHost {
  readonly slot: DataSlot
  private readonly store: ItemStore
  private readonly funnel: Capture
  private readonly facet: AutoGithub
  /** The context of the first hook of the load. Absent until `start`. */
  private ctx: HostContext | undefined
  private gh: GhTool | undefined
  private acli: AcliTool | undefined
  private coordinator: RefreshCoordinator | undefined
  private sight: FileSight | undefined
  /** undefined: not resolved yet. null: this session has no known repo. */
  private repoNow: RepoRef | null | undefined
  private repoTask: Promise<void> | undefined
  private hostList: string[] = []

  constructor(private readonly state: Pick<StatePorts, 'items' | 'tools'>) {
    this.store = new ItemStore({
      atom: state.items,
      host: () => this.ctx,
      kick: keys => this.coordinator?.kick('capture', keys === undefined ? undefined : [...keys]),
      live: category => this.kindLive(category),
    })
    this.funnel = new Capture({
      repo: () => this.repoNow,
      hosts: () => this.hostList,
      ensureRepo: () => this.ensureRepo(),
      site: () => this.activeSite(),
      gh: () => this.ghTool(),
      items: this.store,
      files: () => (this.kindLive('file') ? this.sight : undefined),
      limits: () => this.captureLimits(),
    })
    this.facet = this.buildFacet()
    this.slot = {
      id: 'items',
      persist: true,
      read: async () => (await this.store.records()) as unknown as Json,
      empty: isEmpty,
      settle: async (live, stored) => {
        // The stored copy can predate the last presses: an item the person dismissed since, or a mark they changed (D6).
        const dismissed = await this.need().dismiss.list()
        const kept = ((stored ?? []) as unknown as ItemRecord[]).filter(rec => !dismissed.has(rec.key))
        return rekeyArtifacts(carryOver((live ?? []) as unknown as ItemRecord[], kept, this.cap())) as unknown as Json
      },
      restore: async (value, how) => {
        const list = value as unknown as ItemRecord[]
        if (how === 'load') return this.loadItems(list)
        const kept = this.onlyOn(list)
        if (kept.length > 0) await this.store.set(cur => unionRecords(kept, cur, this.cap()))
      },
      clear: () => this.store.set(() => []),
    }
  }

  // ---------------------------------------------------------------- ItemsHost

  /**
   * Builds the tools and the coordinator once per load (plan decision D16): a second start keeps them, so a pending
   * capture debounce survives it. Probes without waiting: acli takes about 0.6 s, and until a probe settles a tool
   * reads as not available. A warm list is re-keyed (R13).
   */
  async start(ctx: HostContext): Promise<void> {
    this.ctx ??= ctx
    this.buildTools()
    // One write for both: a warm list is re-keyed and loses the records of a kind that is off.
    const live = await this.store.records()
    if (this.onlyOn(rekeyArtifacts(live)) !== live) await this.store.set(list => this.onlyOn(rekeyArtifacts(list)))
  }

  capture(ev: RowEvent): Promise<void> {
    return this.funnel.row(ev)
  }

  /**
   * The transcript of a cold load or a cold resume, after the stored copy. A stored key wins over the transcript,
   * except for what only the transcript may know of an artifact: a publish or a delete after the last flush.
   */
  async replay(batch: readonly ReplayItem[]): Promise<void> {
    const repoReady = this.ensureRepo().catch(() => {})
    await this.activeSite() // learns the site now, so the first refresh finds it cached
    const dismissed = await this.need().dismiss.list()
    const have = await this.store.records()
    const sight = this.sight
    const files = this.kindLive('file')
    const found = batch.length === 0 || !sight ? [] : await itemsFromBatch({ ...this.deps(), sight, files }, batch)
    const fresh = this.onlyOn(onlyNew(have, found)).filter(r => !dismissed.has(r.key))
    if (fresh.length === 0) return
    await this.store.set(list => unionRecords(list, fresh, this.cap()))
    this.afterLoad(repoReady)
  }

  /** The share of one beat that is not the session check: find the repo again (after /clear), then one refresh. */
  async tick(): Promise<void> {
    try {
      await this.ensureRepo()
    } catch {
      // The beat still kicks the refresh.
    }
    this.coordinator?.kick('tick')
  }

  /**
   * The switch begins: the session has its own repo, so the old one is forgotten before the stored copy loads and the
   * transcript is read. The load and the replay look it up again, against the new session.
   */
  async sessionChanged(_ev: SessionChangedEvent): Promise<void> {
    this.resetRepo()
    await this.publishTools() // the tools atom was reset too
  }

  dispose(): void {
    // Nothing to release: the coordinator arms its capture timer through `ctx.clock.after`, which TrackerHost tracks and
    // cancels at dispose.
  }

  list(): Promise<readonly StoredItem[]> {
    return this.store.list()
  }

  update(
    change: (list: StoredItem[], dismissed: ReadonlySet<string>) => StoredItem[],
    opts?: { since?: number },
  ): Promise<boolean> {
    return this.store.update(change, opts)
  }

  track(refs: readonly Claim[], source?: string): Promise<void> {
    return this.store.track(refs, source)
  }

  refresh(keys?: readonly string[]): void {
    this.store.refresh(keys)
  }

  // ---------------------------------------------------------------- what /track and the panes use

  /** True once the tools and the coordinator exist (the start sequence built them). */
  get ready(): boolean {
    return !!(this.gh && this.acli && this.coordinator)
  }

  /** The GitHub side of the auto tracker's PR lane. Its members reject with `not ready` before `start`. */
  get autoGithub(): AutoGithub {
    return this.facet
  }

  /** The session repo as far as it is known now. undefined: not looked up yet. null: none. */
  get sessionRepo(): RepoRef | null | undefined {
    return this.repoNow
  }

  /**
   * Waits for the `--version` probes of the tools whose tracker is on (cached, so cheap) and publishes the statuses for
   * the sections.
   */
  async settleProbes(): Promise<void> {
    const { gh, acli } = this
    if (!gh || !acli) return
    await Promise.allSettled(this.probes(gh, acli))
    await this.publishTools()
  }

  /** Finds the session repo once per session: git remote first, else one `gh repo view`. */
  ensureRepo(): Promise<void> {
    this.repoTask ??= this.resolveRepo()
    return this.repoTask
  }

  kick(reason: 'open' | 'manual'): void {
    this.coordinator?.kick(reason)
  }

  /** `/track refresh`: the tools forget their failures, then every item is refreshed. A run in flight is waited for. */
  async refreshAll(): Promise<void> {
    const { gh, acli, coordinator } = this
    if (!gh || !acli || !coordinator) return
    await this.settleProbes()
    gh.reset()
    acli.reset()
    const run = await coordinator.runDue({ force: true })
    if (run.skipped) {
      // A run was in flight: the forced run is queued behind it. Wait, then publish the tool status again.
      // The publish is also a write of this dispatch. Without it the reads that follow still show the moment
      // before the runs (a state read sees one moment for each dispatch).
      await coordinator.idle()
      await this.publishTools()
    }
  }

  /** The person's mark on a row. `undefined` removes it. */
  setPriority(id: string, level: Priority | undefined): Promise<void> {
    return this.store.set(list => setPriority(list, id, level))
  }

  /** `/track prio <ref> <word>`: the row of the ref, by the session repo. `auto` removes the mark. */
  async prio(ref: string, word: string): Promise<'ok' | 'not-tracked'> {
    await this.ensureRepo()
    const id = rowIdOf(await this.store.records(), ref, {
      defaultRepo: this.repoNow ?? null,
      githubHosts: this.hostList,
    })
    if (id === undefined) return 'not-tracked'
    await this.setPriority(id, word === 'auto' ? undefined : (word as Priority))
    return 'ok'
  }

  // ---------------------------------------------------------------- inside

  private need(): HostContext {
    if (!this.ctx) throw new Error('items: not started')
    return this.ctx
  }

  private deps() {
    return {
      repo: () => this.repoNow,
      hosts: () => this.hostList,
      site: () => this.activeSite(),
      gh: () => this.ghTool(),
      limits: () => this.captureLimits(),
    }
  }

  // ---------------------------------------------------------------- the config views
  // Each read goes to the live view of the host context, so a changed file shows at the next call (decision C5). The
  // slices come over their defaults: a slice that lacks a key (a host with no spec for it) reads as today's value.

  private global(): GlobalConfig {
    return this.ctx?.config.global() ?? GLOBAL_DEFAULTS
  }

  private github(): GithubConfig {
    return { ...GITHUB_DEFAULTS, ...this.ctx?.trackers.slice<GithubConfig>('github') }
  }

  private jira(): JiraConfig {
    return { ...JIRA_DEFAULTS, ...this.ctx?.trackers.slice<JiraConfig>('jira') }
  }

  private file(): FileConfig {
    return { ...FILE_DEFAULTS, ...this.ctx?.trackers.slice<FileConfig>('file') }
  }

  /** `global.store.maxItems`: the cap of every merge into the list. */
  private cap(): number {
    return this.global().store.maxItems
  }

  private captureLimits(): CaptureLimits {
    return {
      shortRefKeywords: this.github().shortRefKeywords,
      maxMentionsPerRow: this.file().maxMentionsPerRow,
      maxItems: this.cap(),
    }
  }

  /** How long an item stays current: `global.refresh.staleMs`, and `trackers.github.pendingStaleMs` for a PR with pending checks. */
  private ttl(): Ttl {
    return { staleMs: this.global().refresh.staleMs, pendingStaleMs: this.github().pendingStaleMs }
  }

  /** True when the tracker of an item kind is on. Before the start there is no config to ask: everything is on. */
  private kindLive(id: string): boolean {
    return this.ctx?.trackers.live(id) ?? true
  }

  /** The records of the kinds that are on. The same array when none is dropped. */
  private onlyOn<T extends { readonly category: string }>(list: T[]): T[] {
    const kept = list.filter(rec => this.kindLive(rec.category))
    return kept.length === list.length ? list : kept
  }

  /** `gh`, or undefined when GitHub is off: nothing may run it then. */
  private ghTool(): GhTool | undefined {
    return this.kindLive('github') ? this.gh : undefined
  }

  /** The `--version` probes of the tools that are on. */
  private probes(g: GhTool, a: AcliTool): Promise<unknown>[] {
    return [...(this.kindLive('github') ? [g.probe()] : []), ...(this.kindLive('jira') ? [a.probe()] : [])]
  }

  private buildTools(): void {
    if (this.gh && this.acli && this.coordinator) return
    const ctx = this.need()
    const run: Runner = (argv, init) => ctx.tools.run(argv[0] ?? '', argv, init ?? {})
    // The breakers and the jira concurrency are read once per load: they size an object at construction (C5).
    const b = ctx.config.global().tools.breaker
    const timeouts: ToolTimeouts = () => this.global().tools
    const g = new GhTool(run, ctx.clock.wall, new CircuitBreaker(b.threshold, b.openMs), {
      limits: () => this.github(),
      timeouts,
    })
    const a = new AcliTool(run, ctx.clock.wall, new CircuitBreaker(b.threshold, b.openMs), {
      limits: () => this.jira(),
      timeouts,
    })
    this.gh = g
    this.acli = a
    this.sight = new FileSight(ctx)
    void Promise.allSettled(this.probes(g, a))
      .then(() => this.publishTools())
      .catch(() => {})
    this.coordinator = new RefreshCoordinator({
      now: ctx.clock.wall,
      load: () => this.store.records(),
      save: async refreshed => {
        const refreshedKeys = new Set(refreshed.map(rec => rec.key))
        const before = await this.store.records()
        await this.store.set(list => mergeResults(list, refreshed))
        const after = await this.store.records()
        const kept = new Set(after.map(rec => rec.key))
        const dropped = before.filter(rec => refreshedKeys.has(rec.key) && !kept.has(rec.key)).map(rec => rec.key)
        if (dropped.length > 0) {
          // Keep discarded keys in this run's dismiss list, so transcript replay does not bring them back on /resume.
          try {
            await ctx.dismiss.add(dropped)
          } catch {
            // The list is already merged; dismissal tracking is best-effort.
          }
        }
      },
      hydrate: rec => hydrate(rec, { gh: g, acli: a }, () => this.ttl()),
      tools: { gh: g, acli: a },
      debounceMs: () => this.global().refresh.captureDebounceMs,
      after: (ms, fn) => ctx.clock.after(ms, fn),
      onRun: async () => {
        await this.publishTools()
        ctx.persisted()
      },
      onError: () => {
        // The tools record their own failures. A run must not break the session.
      },
    })
  }

  /**
   * Copies the tool statuses to the plugin state for the pane. Reads first and writes nothing when nothing the pane shows
   * changed, so a quiet tick makes no write (A22).
   */
  private async publishTools(): Promise<void> {
    const { gh, acli } = this
    if (!gh || !acli) return
    const next = { gh: gh.status(), acli: acli.status() }
    if (shown(await this.state.tools.get()) === shown(next)) return
    await this.state.tools.update(() => next)
  }

  /**
   * Active Jira site state:
   * - `undefined`: no acli runtime (do not filter Jira refs)
   * - `null`: acli runtime exists, but no active site could be loaded
   * - `<host>`: active Jira site host
   */
  private async activeSite(): Promise<string | null | undefined> {
    const a = this.kindLive('jira') ? this.acli : undefined
    if (!a) return undefined
    if (a.activeSite !== undefined) return a.activeSite
    try {
      return await a.loadActiveSite()
    } catch {
      return null
    }
  }

  /** The session repo is found again for the new session. */
  private resetRepo(): void {
    this.repoNow = undefined
    this.repoTask = undefined
    const facts = this.need().facts
    facts.publish('session.repo', undefined)
    facts.publish('github.hosts', undefined)
  }

  private async resolveRepo(): Promise<void> {
    const ctx = this.need()
    let repo: RepoRef | null = null
    try {
      repo = await ctx.session.repo()
      const g = this.ghTool()
      if (g) {
        // A remote host that gh does not know is an ssh alias (git@github-work:o/r) or not GitHub at all.
        // Drop it and ask `gh repo view`, which resolves aliases.
        if (repo && repo.host !== 'github.com') {
          await g.probe()
          if (g.isAvailable && (await g.checkHost(repo.host))) this.hostList = [repo.host]
          else repo = null
        }
        if (!repo) {
          await g.probe()
          if (g.isAvailable) {
            repo = await g.defaultRepo()
            if (repo && repo.host !== 'github.com') {
              if (await g.checkHost(repo.host)) this.hostList = [repo.host]
              else repo = null
            }
          }
        }
      }
    } catch {
      repo = null // No repo: bare #N stays unresolved.
    }
    this.repoNow = repo
    ctx.facts.publish('session.repo', (repo ?? undefined) as unknown as Json | undefined)
    ctx.facts.publish('github.hosts', [...this.hostList])
    if (repo) {
      const known = repo
      try {
        await this.store.set(list => resolveBareRefs(list, known))
      } catch {
        // A refused write must not poison `repoTask`. Every later capture awaits it.
      }
      this.coordinator?.kick('capture')
    }
  }

  /**
   * The items of a stored copy. A `--resume` load and a /resume switch both come here, with the list empty: the caller
   * checked. The transcript is not read here: Replay hands it over after the load. Does not wait for the repo, which
   * may need `gh` calls of up to 30 s.
   */
  private async loadItems(storedItems: ItemRecord[]): Promise<void> {
    const repoReady = this.ensureRepo().catch(() => {}) // bare #N is re-keyed when the repo arrives
    const site = await this.activeSite()
    const dismissed = await this.need().dismiss.list()
    const stored = this.onlyOn(storedForLoad(storedItems, site, dismissed))
    if (stored.length === 0) return
    await this.store.set(list => unionRecords(list, stored, this.cap()))
    this.afterLoad(repoReady)
  }

  /** After items came in: bare #N waits for the repo, then the refresh picks them up. */
  private afterLoad(repoReady: Promise<void>): void {
    void repoReady
      .then(async () => {
        const repo = this.repoNow
        if (repo) await this.store.set(list => resolveBareRefs(list, repo))
      })
      .catch(() => {})
    this.coordinator?.kick('capture')
  }

  /**
   * The GitHub side of the auto tracker's PR lane. The tracker is built before the tools are, so every member looks the
   * tool up when it is called and fails with `not ready` before that.
   */
  private buildFacet(): AutoGithub {
    const need = (): GhTool => {
      if (!this.gh) throw new Error('gh: not ready')
      return this.gh
    }
    const live = (): GhTool | undefined => this.gh
    const discovery: GitHubDiscoveryApi = {
      get name() {
        return 'gh' as const
      },
      get isAvailable() {
        return live()?.isAvailable ?? false
      },
      canCall: now => need().canCall(now),
      refreshItems: async targets => need().refreshItems(targets),
      reset: () => need().reset(),
      status: () => need().status(),
      isHostAuthed: host => need().isHostAuthed(host),
      checkHost: async host => need().checkHost(host),
      defaultRepo: async () => need().defaultRepo(),
      graphql: async (host, query) => need().graphql(host, query),
    }
    return {
      discovery,
      ready: async () => {
        const g = need()
        if (!this.kindLive('github')) return false // the PR lane is part of the GitHub tracker
        await g.probe()
        return g.isAvailable
      },
      repo: async () => {
        need()
        await this.ensureRepo()
        return this.repoNow ?? null
      },
      hosts: () => this.hostList,
      lane: () => {
        const { headPrsPerBranch, basePrsPerBranch, closingRefsPerPr, maxBodyRefs } = this.github()
        return { headPrsPerBranch, basePrsPerBranch, closingRefsPerPr, maxBodyRefs }
      },
    }
  }
}
