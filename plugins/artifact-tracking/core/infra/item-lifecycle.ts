// ItemLifecycle: the load lifecycle of the item service. It holds the context of the first hook of the load, builds the
// tools and the refresh once per load, and does the share of the item host in a start, a beat, a session switch and a
// replay. The ItemService only delegates to it. A tracker that is off (`live`) runs no CLI and leaves no record at
// start, replay, load or carry. It names no kind and no tool and holds no `$`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.6, 5.8 and 5.9. Plan: L5 Task 8, K9, K21.

import type { ConfigSource } from '../interfaces/config'
import type { ReplayItem } from '../interfaces/events'
import type { HostContext } from '../interfaces/items'
import type { StatePorts } from '../interfaces/ports'
import type { DismissPort, FactsPort, ToolPort, Tracker } from '../interfaces/tracker'
import type { Capture } from './capture-runtime'
import { ItemRefresh } from './item-refresh'
import type { ItemStore } from './item-store'
import type { Kinds } from './kinds'

export interface ItemLifecycleDeps {
  trackers: readonly Tracker[]
  live(id: string): boolean
  config: ConfigSource
  facts: FactsPort
  dismiss: DismissPort
  /** The item list changed: Persistence writes the session copy soon. */
  persisted(): void
  /** The `tools` atom. */
  state: Pick<StatePorts, 'tools'>
  kinds: Kinds
  store: ItemStore
  capture: Capture
}

export class ItemLifecycle {
  /** The context of the first hook of the load. Absent until `start`. */
  ctx: HostContext | undefined
  private refresher: ItemRefresh | undefined

  constructor(private readonly d: ItemLifecycleDeps) {}

  /** True once the item host started. */
  get started(): boolean {
    return this.ctx !== undefined
  }

  /** True once the tools and the refresh exist. */
  get ready(): boolean {
    return this.refresher !== undefined
  }

  /**
   * Builds the tools and the refresh once per load (plan decision D16): a second start keeps them, so a pending capture
   * debounce survives it. Probes without waiting: a CLI can take about 0.6 s, and until a probe settles a tool reads as not
   * available. A warm list is re-keyed (R13) and loses the records of a kind that is off, in one write.
   */
  async start(ctx: HostContext): Promise<void> {
    this.ctx ??= ctx
    const { d } = this
    this.refresher ??= new ItemRefresh({ ...d, host: ctx, tools: d.state.tools, live: owner => d.live(owner) })
    await d.store.warm()
  }

  /**
   * The transcript of a cold load or a cold resume, after the stored copy. A stored key wins over the transcript, except
   * for what only the transcript may know (a kind's `replayWins`). It runs inside a switch, which holds the session
   * check: nothing here may wait for that check, nor for a CLI (one exception: `Capture.replay`). The lookups of the
   * kinds start first, so they have a head start, and the capture waits for their quick part only.
   */
  async replay(batch: readonly ReplayItem[]): Promise<void> {
    void this.d.kinds.prepare({ wait: false })
    if (await this.d.store.replayed(await this.d.capture.replay(batch))) this.afterLoad()
  }

  /** The share of one beat that is not the session check: find the repo again (after /clear), then one refresh. */
  async tick(): Promise<void> {
    try {
      await this.prepare()
    } catch {
      // The beat still kicks the refresh.
    }
    this.refresher?.kick('tick')
  }

  /**
   * The switch begins: the session has its own repo, so each kind forgets what it found of the old one before the stored
   * copy loads and the transcript is read. The load and the replay look it up again, against the new session.
   */
  async sessionChanged(): Promise<void> {
    const { kinds } = this.d
    if (this.ctx) for (const kind of kinds.liveKinds()) await kind.sessionChanged?.(kinds.prepareContext(kind))
    await this.refresher?.runner.publish() // the tools atom was reset too
  }

  /** Runs the `prepare` of every live kind (the session repo), once per session. */
  prepare(): Promise<void> {
    return this.d.kinds.prepare()
  }

  /** Waits for the probes of the tools whose tracker is on (cached, so cheap) and publishes the statuses for the sections. */
  async settle(): Promise<void> {
    await this.refresher?.runner.settle()
    await this.refresher?.runner.publish()
  }

  /** Marks keys due after a capture, or everything for `open` and `manual`; the debounce is the coordinator's. */
  kick(reason: 'capture' | 'open' | 'manual', keys?: readonly string[]): void {
    this.refresher?.kick(reason, keys)
  }

  /** `/track refresh`: every tool forgets its failures, then every item is refreshed. */
  async refreshAll(): Promise<void> {
    if (!this.refresher) return
    await this.settle()
    await this.refresher.refreshAll()
  }

  /** The tools of one tracker. undefined before `start`. */
  tools(owner: string): ToolPort | undefined {
    return this.refresher?.runner.port(owner)
  }

  /** After items came in from a stored copy or a transcript: what needs the session finishes, then the refresh picks them up. */
  afterLoad(): void {
    void this.prepare().catch(() => {})
    this.refresher?.kick('capture')
  }
}
