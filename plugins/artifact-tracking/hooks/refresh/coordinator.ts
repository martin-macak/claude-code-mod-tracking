// Refresh coordinator (spec sections 7 and 7.1). No `$`: it gets plain functions.
// It picks the due items, hands them to the tools in one batch each, and saves the result.

import type { GitHubTarget, HydratedItem, ItemRecord, JiraTarget, Now, Tools } from '../contracts'
import { LIMITS } from '../contracts'

export type Timer = { cancel(): void }

export type CoordinatorDeps = {
  now: Now
  load: () => Promise<ItemRecord[]>
  /** Persist refreshed records; the caller merges them by key (registry.mergeResults). */
  save: (refreshed: ItemRecord[]) => Promise<void>
  hydrate: (rec: ItemRecord) => HydratedItem
  tools: Tools
  after: (ms: number, fn: () => void | Promise<void>) => Timer
  /** Called after every finished run, also when nothing was due (to publish tool status). */
  onRun?: () => void | Promise<void>
  onError?: (err: unknown) => void
}

export type RunOptions = { force?: boolean; keys?: readonly string[] }
export type Reason = 'capture' | 'open' | 'tick' | 'manual'

/** Folds two requests into one. No keys means all items, so it wins. Force is sticky. */
function merge(a: RunOptions | undefined, b: RunOptions): RunOptions {
  if (!a) return { ...b }
  const out: RunOptions = {}
  if (a.force || b.force) out.force = true
  if (a.keys && b.keys) out.keys = [...new Set([...a.keys, ...b.keys])]
  return out
}

export class RefreshCoordinator {
  private running = false
  private queued?: RunOptions
  private timer?: Timer
  /** When the capture timer was armed. A timer the engine refused never fires; this tells it apart. */
  private timerAt = 0
  private waiters: Array<() => void> = []
  private pendingKeys = new Set<string>()
  /** A capture kick without keys asks for all items. */
  private pendingAll = false

  constructor(private readonly deps: CoordinatorDeps) {}

  get busy(): boolean {
    return this.running
  }

  kick(reason: Reason, keys?: readonly string[]): void {
    switch (reason) {
      case 'capture': {
        if (keys) for (const k of keys) this.pendingKeys.add(k)
        else this.pendingAll = true
        const at = this.deps.now()
        if (this.timer && at - this.timerAt > 2 * LIMITS.captureDebounceMs) {
          // The timer is long overdue: the engine never ran it. Arm a new one.
          this.timer.cancel()
          this.timer = undefined
        }
        if (this.timer) return
        this.timerAt = at
        this.timer = this.deps.after(LIMITS.captureDebounceMs, () => {
          const opts: RunOptions = this.pendingAll ? {} : { keys: [...this.pendingKeys] }
          this.pendingKeys = new Set()
          this.pendingAll = false
          this.timer = undefined
          return this.runDue(opts).then(() => {})
        })
        return
      }
      case 'open':
      case 'tick':
        void this.runDue({})
        return
      case 'manual':
        try {
          this.deps.tools.gh.reset()
          this.deps.tools.acli.reset()
        } catch (err) {
          this.fail(err)
        }
        void this.runDue({ force: true })
        return
    }
  }

  /** Never rejects. */
  async runDue(opts: RunOptions = {}): Promise<{ refreshed: number; skipped: boolean }> {
    if (this.running) {
      this.queued = merge(this.queued, opts)
      return { refreshed: 0, skipped: true }
    }
    this.running = true
    try {
      const refreshed = await this.runOnce(opts)
      while (this.queued) {
        const next = this.queued
        this.queued = undefined
        await this.runOnce(next)
      }
      return { refreshed, skipped: false }
    } finally {
      this.running = false
      const done = this.waiters
      this.waiters = []
      for (const w of done) w()
    }
  }

  /**
   * Settles when no run is in flight or queued. A `runDue` that finds a run in flight only queues its request and
   * returns at once. A caller that needs the result of that request (`/track refresh`) waits here.
   */
  idle(): Promise<void> {
    if (!this.running) return Promise.resolve()
    return new Promise<void>(resolve => {
      this.waiters.push(resolve)
    })
  }

  private async runOnce(opts: RunOptions): Promise<number> {
    let refreshed = 0
    try {
      const { tools, now } = this.deps
      const at = now()
      const wanted = opts.keys ? new Set(opts.keys) : undefined
      const items = (await this.deps.load()).map(r => this.deps.hydrate(r))
      const selected: HydratedItem[] = []
      for (const item of items) {
        if (item.category === 'web') continue
        if (wanted && !wanted.has(item.key)) continue
        if (opts.force) delete item.error
        const ok = opts.force ? item.canRefresh(at) : item.isDue(at) && item.canRefresh(at)
        if (!ok) continue
        const tool = item.category === 'github' ? tools.gh : tools.acli
        if (!tool.canCall(at)) continue
        selected.push(item)
      }
      const github = selected.filter(
        (i): i is HydratedItem & GitHubTarget & { category: 'github' } => i.category === 'github',
      )
      const jira = selected.filter((i): i is HydratedItem & JiraTarget & { category: 'jira' } => i.category === 'jira')
      // Run both tools to the end, then report the first failure. A failing tool must not hide the other one.
      const results = await Promise.allSettled([
        github.length > 0 ? tools.gh.refreshItems(github) : undefined,
        jira.length > 0 ? tools.acli.refreshItems(jira) : undefined,
      ])
      for (const r of results) if (r.status === 'rejected') this.fail(r.reason)
      if (selected.length > 0) {
        await this.deps.save(selected.map(i => i.toRecord()))
        refreshed = selected.length
      }
    } catch (err) {
      this.fail(err)
    }
    try {
      await this.deps.onRun?.()
    } catch (err) {
      this.fail(err)
    }
    return refreshed
  }

  private fail(err: unknown): void {
    try {
      this.deps.onError?.(err)
    } catch {
      // The error handler must not break a run.
    }
  }
}
