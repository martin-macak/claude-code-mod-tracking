// ItemService: the item host of core. It owns the item list and the five item trackers' shared work: capture, the
// tools, the refresh, replay and the priority levels. It composes the ItemStore (the list), the `items` slot, Capture (the
// scan of a text), ItemLifecycle (the context of the load, the tools and the refresh) and ItemLevels, and delegates the
// ItemsHost calls to them. A tracker that is off (`live`) runs no CLI, claims its spans and drops them, and leaves no
// record at start, replay, load or carry.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.7, 5.8 and 5.9. Plan: L5 Task 8, K3, K9.

import type { ConfigSource } from '../interfaces/config'
import type { ReplayItem, RowEvent, SessionChangedEvent, ToolCallEvent } from '../interfaces/events'
import type { Effective, HostContext, ItemStorePort, ItemsHost, Level } from '../interfaces/items'
import type { StatePorts } from '../interfaces/ports'
import type { DataSlot } from '../interfaces/slots'
import type { DismissPort, FactsPort, ToolPort, Tracker } from '../interfaces/tracker'
import { Capture } from './capture-runtime'
import { ItemLevels } from './item-levels'
import { ItemLifecycle } from './item-lifecycle'
import { storePort } from './item-port'
import { itemSlot } from './item-slot'
import { ItemStore } from './item-store'
import { Kinds } from './kinds'
import type { SessionWatch } from './session'
import { reason } from './steps'

export interface ItemServiceDeps {
  trackers: readonly Tracker[]
  /** False for a tracker the config turned off, or that failed to start. */
  live(id: string): boolean
  config: ConfigSource
  facts: FactsPort
  dismiss: DismissPort
  watch: Pick<SessionWatch, 'generation' | 'check' | 'current'>
  /** The item list changed: Persistence writes the session copy soon. */
  persisted(): void
  /** The `items` and `tools` atoms. */
  state: Pick<StatePorts, 'items' | 'tools'>
  log(line: string): void
}

export class ItemService implements ItemsHost {
  readonly slot: DataSlot
  private readonly kinds: Kinds
  private readonly store: ItemStore
  private readonly capturer: Capture
  private readonly priority: ItemLevels
  private readonly life: ItemLifecycle
  private readonly shared: ItemStorePort
  // The store port is the service's own (ItemsHost extends it).
  readonly list: ItemStorePort['list']
  readonly update: ItemStorePort['update']
  readonly track: ItemStorePort['track']
  readonly refresh: ItemStorePort['refresh']
  readonly scan: ItemStorePort['scan']
  readonly build: ItemStorePort['build']

  constructor(private readonly d: ItemServiceDeps) {
    const cap = () => d.config.global().store.maxItems
    // The collaborators reach one another through `life` after the construction, so the order here is free.
    this.kinds = new Kinds({
      trackers: d.trackers,
      live: d.live,
      config: d.config,
      facts: d.facts,
      host: () => this.life.ctx,
      tools: owner => this.life.tools(owner),
      items: {
        update: change => this.store.rawUpdate(list => change(list, new Set())),
        refresh: k => this.store.refresh(k),
      },
    })
    this.store = new ItemStore({
      atom: d.state.items,
      kinds: this.kinds,
      dismiss: d.dismiss,
      current: () => d.watch.current(),
      cap,
      persisted: d.persisted,
      kick: keys => this.life.kick('capture', keys),
      started: () => this.life.started,
    })
    this.capturer = new Capture(this.kinds, d.log)
    this.life = new ItemLifecycle({ ...d, kinds: this.kinds, store: this.store, capture: this.capturer })
    this.slot = itemSlot(this.store, {
      kinds: this.kinds,
      dismiss: d.dismiss,
      cap,
      loading: () => void this.kinds.prepare({ wait: false }),
      loaded: () => this.life.afterLoad(),
    })
    this.priority = new ItemLevels({
      store: this.store,
      kinds: this.kinds,
      facts: d.facts,
      prepare: () => this.life.prepare(),
    })
    this.shared = storePort({ store: this.store, capture: this.capturer })
    ;({
      list: this.list,
      update: this.update,
      track: this.track,
      refresh: this.refresh,
      scan: this.scan,
      build: this.build,
    } = this.shared)
  }

  // ---------------------------------------------------------------- what ItemLifecycle, ItemLevels and Kinds answer

  readonly start = (ctx: HostContext) => this.life.start(ctx)
  readonly replay = (batch: readonly ReplayItem[]) => this.life.replay(batch)
  readonly tick = () => this.life.tick()
  readonly sessionChanged = (_ev: SessionChangedEvent) => this.life.sessionChanged()
  readonly prepare = () => this.life.prepare()
  readonly settle = () => this.life.settle()
  readonly kick = (reason: 'open' | 'manual') => this.life.kick(reason)
  readonly refreshAll = () => this.life.refreshAll()
  readonly tools = (owner: string): ToolPort | undefined => this.life.tools(owner)
  readonly setPriority = (rowId: string, level: Level | undefined) => this.priority.setPriority(rowId, level)
  readonly rowIdOf = (ref: string) => this.priority.rowIdOf(ref)
  readonly levels = (): Promise<ReadonlyMap<string, Effective>> => this.priority.levels()
  readonly wants = (tool: string) => this.kinds.wants(tool)
  /** Every owner sees the same list. */
  readonly port = (_owner: string): ItemStorePort => this.shared

  get ready(): boolean {
    return this.life.ready
  }

  // ---------------------------------------------------------------- capture

  async capture(ev: RowEvent): Promise<void> {
    await this.store.track(await this.capturer.row(ev))
  }

  /** Each live kind that reads the tool makes its claims; a fault in one kind (or in its write) stops only that kind. */
  async toolCall(ev: ToolCallEvent, ctx?: HostContext): Promise<void> {
    for (const kind of this.kinds.liveKinds()) {
      if (!this.kinds.reader(kind, ev.tool)) continue
      try {
        await this.store.track(await this.capturer.fromTool(kind, ev, ctx))
      } catch (e) {
        this.d.log(`items: toolCall failed in ${kind.category}: ${reason(e)}`)
      }
    }
  }

  dispose(): void {
    // Nothing to release: the refresh arms its capture timer through `ctx.clock.after`, which TrackerHost tracks and
    // cancels at dispose.
  }
}
