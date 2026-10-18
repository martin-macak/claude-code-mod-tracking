// Refresh coordinator (spec sections 7 and 7.1). No `$`: it gets plain functions.
// It picks the due items, hands them to the lane of their category in one batch each, and saves the result.
// A lane is the refresh of one kind: the kind that has a refresh spec brings its own, and a record of a category with no
// lane is never selected (a web link, an artifact or a file has no status to fetch). Plan: L5 Task 7.

import type { Refreshable, StoredItem } from '../interfaces/items'
import type { Now, Timer } from '../interfaces/ports'
import { GLOBAL_DEFAULTS } from '../lib/global-config'

/** How the items of one category refresh: which tool may be called, and how to fetch their status. */
export interface RefreshLane {
  readonly category: string
  /** The tool of the lane lets a call through now: it is available, not logged out, and its breaker allows. */
  canCall(now: number): boolean
  /** Manual refresh: the tool forgets its failures. */
  reset(): void
  /** The item of a stored record. Called only for a record of this category. */
  hydrate(rec: StoredItem): Refreshable
  /** Refreshes the items in place. A rejection goes to `onError`; the other lanes still run. */
  refreshItems(items: Refreshable[]): Promise<void>
}

export type CoordinatorDeps = {
  now: Now
  load: () => Promise<StoredItem[]>
  /** Persist refreshed records; the caller merges them by key (registry.mergeResults). */
  save: (refreshed: StoredItem[]) => Promise<void>
  /** One lane per category that refreshes, in the order its tools run. */
  lanes: readonly RefreshLane[]
  /** The capture debounce, read at each kick. Default: `global.refresh.captureDebounceMs`. */
  debounceMs?: () => number
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
        const debounce = this.deps.debounceMs?.() ?? GLOBAL_DEFAULTS.refresh.captureDebounceMs
        if (this.timer && at - this.timerAt > 2 * debounce) {
          // The timer is long overdue: the engine never ran it. Arm a new one.
          this.timer.cancel()
          this.timer = undefined
        }
        if (this.timer) return
        this.timerAt = at
        this.timer = this.deps.after(debounce, () => {
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
          for (const lane of this.deps.lanes) lane.reset()
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
      const { lanes, now } = this.deps
      const at = now()
      const wanted = opts.keys ? new Set(opts.keys) : undefined
      const byCategory = new Map<string, RefreshLane>()
      for (const lane of lanes) if (!byCategory.has(lane.category)) byCategory.set(lane.category, lane)
      const batches = new Map<RefreshLane, Refreshable[]>()
      const selected: Refreshable[] = []
      for (const rec of await this.deps.load()) {
        // A category with no lane has no tool and no status to fetch: it is not even hydrated.
        const lane = byCategory.get(rec.category)
        if (!lane || (wanted && !wanted.has(rec.key))) continue
        const item = lane.hydrate(rec)
        // A forced run tries a not-found item again. The error is a field of the item, not of the `Refreshable` contract.
        if (opts.force) delete (item as { error?: unknown }).error
        const ok = opts.force ? item.canRefresh(at) : item.isDue(at) && item.canRefresh(at)
        if (!ok || !lane.canCall(at)) continue
        selected.push(item)
        const batch = batches.get(lane)
        if (batch) batch.push(item)
        else batches.set(lane, [item])
      }
      // Run every lane to the end, then report the first failure. A failing tool must not hide the other one.
      const runs: Promise<void>[] = []
      for (const lane of lanes) {
        const batch = batches.get(lane)
        if (batch) runs.push(lane.refreshItems(batch))
      }
      const results = await Promise.allSettled(runs)
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
