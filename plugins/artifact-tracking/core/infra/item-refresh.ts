// ItemRefresh: the tools and the refresh of the items that have a status to fetch. It builds the ToolRunner (one handle
// per declared CLI), one lane per kind with a refresh spec over the handle the owning tracker declared, and the
// coordinator that runs the lanes. The kind brings the fetch; this brings the handle that gates the call and the context
// of the owning tracker. It names no kind and no tool and holds no `$`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.8 and 5.9. Plan: L5 Task 7 and Task 8, K5.

import type { ConfigSource } from '../interfaces/config'
import type { HostContext, JsonObject, RefreshContext, StoredItem } from '../interfaces/items'
import type { AtomPort } from '../interfaces/ports'
import type { DismissPort, FactsPort, ToolStatus, Tracker } from '../interfaces/tracker'
import { applyRefresh } from '../lib/records'
import type { ItemStore } from './item-store'
import type { Kinds } from './kinds'
import { RefreshCoordinator, type RefreshLane } from './refresh'
import { ToolRunner } from './tools'

export interface ItemRefreshDeps {
  trackers: readonly Tracker[]
  kinds: Kinds
  store: ItemStore
  config: ConfigSource
  facts: FactsPort
  dismiss: DismissPort
  host: HostContext
  /** The `tools` atom: the statuses of the handles. */
  tools: AtomPort<Record<string, ToolStatus>>
  /** False for a tracker that is off: its handles exist, but are never probed. */
  live(owner: string): boolean
  /** The list changed: Persistence writes the session copy soon. */
  persisted(): void
}

export class ItemRefresh {
  readonly runner: ToolRunner
  private readonly lanes: RefreshLane[]
  private readonly coordinator: RefreshCoordinator

  constructor(private readonly d: ItemRefreshDeps) {
    const { host } = d
    // The breakers are read once per load: they are objects that hold their numbers (C5). The probes start now, unawaited.
    this.runner = new ToolRunner({
      run: (argv, opts) => host.tools.run(argv[0] ?? '', argv, opts),
      now: host.clock.wall,
      global: () => d.config.global(),
      tools: d.tools,
      log: host.log,
      live: d.live,
    })
    this.runner.build(d.trackers.flatMap(t => (t.tools ?? []).map(spec => ({ owner: t.id, spec }))))
    this.runner.start()
    this.lanes = this.buildLanes()
    this.coordinator = new RefreshCoordinator({
      now: d.host.clock.wall,
      load: async () => [...(await d.store.list())],
      save: refreshed => this.save(refreshed),
      lanes: this.lanes,
      debounceMs: () => d.config.global().refresh.captureDebounceMs,
      after: (ms, fn) => d.host.clock.after(ms, fn),
      onRun: () => this.publish(),
      onError: () => {
        // The tools record their own failures. A run must not break the session.
      },
    })
  }

  kick(reason: 'capture' | 'open' | 'tick' | 'manual', keys?: readonly string[]): void {
    this.coordinator.kick(reason, keys === undefined ? undefined : [...keys])
  }

  /** Copies the tool statuses to the plugin state, then tells Persistence. A quiet run writes no status (A22). */
  async publish(): Promise<void> {
    await this.runner.publish()
    this.d.persisted()
  }

  /** `/track refresh`: every tool forgets its failures, then every item is refreshed. A run in flight is waited for. */
  async refreshAll(): Promise<void> {
    this.runner.resetAll()
    for (const lane of this.lanes) lane.reset() // the tool classes forget more than their handles do
    const run = await this.coordinator.runDue({ force: true })
    // A run was in flight: the forced run is queued behind it. Wait, then publish the tool status again. The publish is
    // also a write of this dispatch. Without it the reads that follow still show the moment before the runs.
    if (run.skipped) {
      await this.coordinator.idle()
      await this.publish()
    }
  }

  /** Persists a refresh. A record that turned out gone stays in this run's dismiss list, so a replay cannot bring it back. */
  private async save(refreshed: readonly StoredItem[]): Promise<void> {
    const { store, dismiss, kinds } = this.d
    const asked = new Set(refreshed.map(rec => rec.key))
    const before = await store.list()
    await store.set(list => applyRefresh(list, refreshed, kinds.table))
    const kept = new Set((await store.list()).map(rec => rec.key))
    const dropped = before.filter(rec => asked.has(rec.key) && !kept.has(rec.key)).map(rec => rec.key)
    if (dropped.length === 0) return
    try {
      await dismiss.add(dropped)
    } catch {
      // The list is already merged; dismissal tracking is best-effort.
    }
  }

  /** One lane per kind that refreshes. The owner of a kind is the tracker that lists it. */
  private buildLanes(): RefreshLane[] {
    const { trackers, host, facts, config } = this.d
    const { runner } = this
    return trackers.flatMap(tracker =>
      (tracker.kinds ?? []).flatMap((kind): RefreshLane[] => {
        const { refresh } = kind
        const port = runner.port(tracker.id)
        const handle = refresh && port.handle(refresh.tool)
        if (!refresh || !handle) return []
        const ctx: RefreshContext = {
          tools: port,
          config: {
            slice: () => ({ ...tracker.config.defaults, ...config.slice(tracker.id) }) as JsonObject,
            global: () => config.global(),
          },
          facts,
          now: host.clock.wall,
        }
        return [
          {
            category: kind.category,
            canCall: now => handle.canCall(now),
            // The tool class forgets more than its handle does (denied hosts, a missing site).
            reset: () => (refresh.reset ? refresh.reset(ctx) : handle.reset()),
            // A stored record of a malformed shape is never due: one bad record must not stop the run for the others.
            hydrate: rec => {
              const typed = kind.decode(rec)
              if (typed) return refresh.hydrate(typed, ctx)
              return {
                key: rec.key,
                category: rec.category,
                canRefresh: () => false,
                isDue: () => false,
                toRecord: () => rec,
              }
            },
            refreshItems: items => refresh.refreshItems(items, ctx),
          },
        ]
      }),
    )
  }
}
