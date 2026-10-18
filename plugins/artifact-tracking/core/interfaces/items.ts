// Item contracts: the stored record, the item kind and the store port. Types only.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.9 and 5.13.
//
// `Json`, `JsonObject`, `Level` and `StoredItem` live in the PluginState contract (`types/index.d.ts`, spec 5.13)
// and are re-exported here. Plan L5, Task 1: the kind hooks below are the ones the closed unions of L3 need (K3 to K5).
//
// A name clashes with older code, and tsc accepts a wrong import without a word: `Json` here is a real JSON union.
// `core/lib/json.ts` exports another `Json` (`Record<string, unknown>`). Contract code imports it from this folder,
// never from `core/lib/json`. Rename the lib one when it is next touched.

import type { Json, JsonObject, Level, StoredItem, ToolStatus } from '../../types'
import type { ConfigView } from './config'
import type { ReplayItem, RowEvent, SessionChangedEvent, ToolCallEvent } from './events'
import type { Ports } from './ports'
import type { DataSlot } from './slots'
import type { FactsPort, ToolPort, TrackerContext } from './tracker'
import type { TreeRow, ViewContext } from './view'

export type { Json, JsonObject, Level, StoredItem } from '../../types'

/** The level a person sets: `high`, `normal` or `low`. `top` comes from a kind rule only. */
export type Priority = Exclude<Level, 'top'>

/** `full`: every pattern (prompt, command, response rows). `urls-only`: explicit URLs of the kinds that claim them (tool-result rows). */
export type ScanMode = 'full' | 'urls-only'

/** What a kind found in a text: one item seen once. Capture offers it to `ItemKind.merge`. */
export interface Claim {
  readonly category: string
  /** The item key the claim is about. */
  readonly key: string
  /** Where the text came from, e.g. `prompt`. */
  readonly source: string
  /** When it was seen, epoch ms. */
  readonly at: number
  /** Where it sits in the text offered to `scan`. Absent for a URL claim: Capture knows that span. */
  readonly span?: { readonly start: number; readonly end: number }
  /** The kind's ref fields: the sighting without `category`. */
  readonly fields: JsonObject
}

/** What Capture gives a kind with each text. */
export interface KindContext {
  /** Epoch ms. */
  readonly now: number
  /** Where the text came from: `prompt`, `response`, `tool`, `auto`. */
  readonly source: string
  readonly mode: ScanMode
  /** `capture`: conversation text, strict short refs. `lookup`: `/track prio`, a PR body. */
  readonly purpose: 'capture' | 'lookup'
  /** The loop that produced the text. Absent for the main loop. */
  readonly agentId?: string
  /** The session cwd before the tool ran, for a tool call. */
  readonly cwdBefore?: string
  /** The config of the tracker that owns the kind. */
  readonly config: ConfigView<JsonObject>
  readonly facts: Pick<FactsPort, 'read'>
  readonly tools: ToolPort
  readonly fs: Pick<Ports['fs'], 'stat' | 'exists'>
  readonly env: TrackerContext['env']
  readonly session: TrackerContext['session']
  readonly log: (line: string) => void
}

/** What the coordinator needs from an item it refreshes. */
export interface Refreshable {
  readonly key: string
  readonly category: string
  canRefresh(now: number): boolean
  isDue(now: number): boolean
  toRecord(): StoredItem
}

/** What a kind's refresh gets: the ports of the owning tracker. */
export interface RefreshContext {
  readonly tools: ToolPort
  readonly config: ConfigView<JsonObject>
  readonly facts: Pick<FactsPort, 'read'>
}

/**
 * A CLI tool that refreshes items in place, as the tool classes of the item trackers do. `ItemKind.refresh` replaces
 * it for new code (plan K5). It stays for the tool classes until the refresh lanes of Task 7 own them.
 */
export interface RefreshTool<T> {
  /** The tool id. */
  readonly name: string
  /** True once the `--version` probe succeeded. False before the probe settles. */
  readonly isAvailable: boolean
  /** Available, not known to be logged out, and the breaker lets a call through. */
  canCall(now: number): boolean
  /** Refreshes the given items in place: status fields, `refreshedAt`, `error`. Never rejects. */
  refreshItems(items: T[]): Promise<void>
  /** Manual refresh: forget `loggedIn: false`, move an open breaker to half-open. */
  reset(): void
  status(): ToolStatus
}

/** How a kind refreshes: which tool, which status fields a refresh writes, and how to fetch them. */
export interface RefreshSpec<T extends StoredItem> {
  /** A `ToolSpec` id of the owning tracker. */
  readonly tool: string
  /** The status fields a refresh writes. */
  readonly fields: readonly string[]
  hydrate(item: T, ctx: RefreshContext): Refreshable
  refreshItems(items: Refreshable[], ctx: RefreshContext): Promise<void>
  /** The kind part of a refresh merge. */
  apply?(out: T, fresh: T): T
}

/** What a priority rule reads: the facts, the whole list, and the levels the earlier stages gave. */
export interface RuleEnv {
  readonly facts: Pick<FactsPort, 'read'>
  readonly items: readonly StoredItem[]
  levelOf(key: string): Level | undefined
}

/** A rule that lifts an item to a level, e.g. the PR on the session branch is `top`. Rules run in stages, lowest first. */
export interface PriorityRule {
  readonly id: string
  readonly stage: number
  level(item: StoredItem, env: RuleEnv): Level | undefined
}

/** The level of one item: the person's mark, or a rule's (`auto`). */
export type Effective = { readonly level?: Level; readonly auto?: true }

/** One kind of item in the shared store. A tracker adds its kinds through `Tracker.kinds`. */
export interface ItemKind<T extends StoredItem = StoredItem> {
  readonly category: string
  /** Claim order, lowest first. `web` is last. */
  readonly rank: number
  /** Runs before each scan, e.g. to resolve what the scan needs. */
  prepare?(ctx: KindContext): Promise<void>
  claimUrl?(url: string, label: string | undefined, ctx: KindContext): Claim | null
  scan?(maskedText: string, mode: ScanMode, ctx: KindContext): readonly Claim[]
  /** Claims a tool call makes, by tool name. */
  readonly fromTool?: Readonly<Record<string, (ev: ToolCallEvent, ctx: KindContext) => Promise<readonly Claim[]>>>
  /** An async filter over the claims of one text, e.g. an open check through a tool. */
  accept?(claims: readonly Claim[], ctx: KindContext): Promise<readonly Claim[]>
  /** Guards a stored record and gives the typed view. null: not this kind's. */
  decode(item: StoredItem): T | null
  /** Merges a sighting into the record. Returns `cur` when nothing changed, and null when the sighting adds no item. */
  merge(cur: T | null, seen: Claim): T | null
  /** Folds two records of one key. `out` has the generic fold; the kind adds its own fields. */
  fold?(winner: T, loser: T, out: T): T
  /** Carries the marks a refresh does not own from the live record to the merged one. */
  keepMarks?(merged: T, live: T): T
  /** Re-homes a record of another kind that this kind claims. null: not this kind's. */
  migrate?(item: StoredItem): T | null
  /** Filters the records of a stored copy at load. */
  restore?(items: readonly T[], ctx: KindContext): Promise<readonly T[]>
  /** True when a replayed record beats the stored one. Default: the stored one wins. */
  replayWins?(fresh: T, stored: T): boolean
  readonly refresh?: RefreshSpec<T>
  readonly rules?: readonly PriorityRule[]
  /** Sets or removes the mark of a row inside an item, e.g. a child node. null: no such row. */
  setLevel?(item: T, rowId: string, level: Level | undefined): T | null
  /** The row id inside an item that a typed reference names. */
  findRow?(item: T, ref: string): string | undefined
  /** Optional in L5a, required from Task 13 (K24). */
  row?(item: T, ctx: ViewContext): TreeRow
}

/**
 * The part of the ItemStore a tracker sees. The store owns the list, the eviction, dismissal and priority.
 * Every call is async: the list lives in the plugin state.
 */
export interface ItemStorePort {
  list(): Promise<readonly StoredItem[]>
  /**
   * Runs the session check, reads the list, calls `change` at least once and writes the result.
   * `change` gets the run's dismissed set. When it returns its input, nothing is written.
   * `since` is a generation from `TrackerContext.current()`: an older one drops the write.
   * Resolves to whether it wrote.
   */
  update(
    change: (list: StoredItem[], dismissed: ReadonlySet<string>) => StoredItem[],
    opts?: { since?: number },
  ): Promise<boolean>
  /** Offers claims to the kinds and merges the result. A claim carries its source. */
  track(claims: readonly Claim[]): Promise<void>
  /** Marks the keys due, or all items when none are named, and kicks the refresh. Fire and forget. */
  refresh(keys?: readonly string[]): void
  /**
   * The claims in a text, from the live kinds. Optional until the item service of Task 8 implements it (K3).
   * `facts` overrides what the kinds read for this call.
   */
  scan?(
    text: string,
    o: { mode: ScanMode; purpose: 'capture' | 'lookup'; facts?: Readonly<Record<string, Json>> },
  ): readonly Claim[]
  /** The record a claim makes, from its kind. null: no such kind. Optional until Task 8. */
  build?(claim: Claim): StoredItem | null
}

/**
 * Which trackers are on, and what the config says of them. The transitional item host reads it, because it runs the
 * five item kinds before they have handlers (D13). L5 gives each kind its own context and removes this.
 */
export interface TrackerConfigs {
  /**
   * False for a tracker the config turned off, as it read at the first start of the load, and for a tracker that
   * failed to start. An id no tracker has reads as live: nothing turned it off.
   */
  live(id: string): boolean
  /** The slice of a tracker, read at call time. An id no tracker has gives a frozen `{}`. */
  slice<C extends JsonObject>(id: string): Readonly<C>
}

/** What an item host gets at start: a tracker context without `items` and `data`, plus a persist signal. */
export type HostContext = Omit<TrackerContext<JsonObject, never>, 'items' | 'data'> & {
  /** The host changed its list. Persistence writes the session copy soon. */
  persisted(): void
  /** The toggles and the slices of the trackers. */
  readonly trackers: TrackerConfigs
}

/**
 * The part of core that owns the item list and the five item trackers' shared work (capture, refresh, replay).
 * L3 builds it as the transitional `ItemRuntime`. L5 splits it into ItemStore, Capture, ItemKind and ToolSpec.
 */
export interface ItemsHost extends ItemStorePort {
  /** The `items` slot: Persistence stores it, a switch carries it. */
  readonly slot: DataSlot
  start(ctx: HostContext): Promise<void>
  /** Reads one row for items: the capture funnel. */
  capture(ev: RowEvent): Promise<void>
  /** Merges a transcript read back: rows and tool calls, in order. */
  replay(batch: readonly ReplayItem[]): Promise<void>
  tick(): Promise<void>
  /** The session id moved. The manager calls it first in a switch, before any slot carries or loads and before replay. */
  sessionChanged(ev: SessionChangedEvent): Promise<void>
  dispose(): void
}
