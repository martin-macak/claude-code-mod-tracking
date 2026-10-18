// Item contracts: the stored record, the item kind and the store port. Types only.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.9 and 5.13.
//
// `Json` and `JsonObject` live in the PluginState contract (`types/index.d.ts`, spec 5.13) and are re-exported here.
// `Level` and `StoredItem` are declared here for now. Plan decision D14: layer L5 moves `StoredItem` to the contract.
//
// Two names clash with older code, and tsc accepts a wrong import without a word:
// - `Json` here is a real JSON union. `core/lib/json.ts` exports another `Json` (`Record<string, unknown>`).
//   Contract code imports it from this folder, never from `core/lib/json`. Rename the lib one when it is next touched.
// - `Level` is also declared in `hooks/model/priority.ts`. The two have the same members. Drop that copy in L5.

import type { Json, JsonObject } from '../../types'
import type { ConfigView } from './config'
import type { ReplayItem, RowEvent, SessionChangedEvent } from './events'
import type { DataSlot } from './slots'
import type { FactsPort, ToolPort, TrackerContext } from './tracker'
import type { TreeRow, ViewContext } from './view'

export type { Json, JsonObject } from '../../types'

/** A priority level, highest first. `top` comes from a kind rule only. A person sets `high`, `normal` or `low`. */
export type Level = 'top' | 'high' | 'normal' | 'low'

/** One tracked item. The fields every kind shares are typed. The rest belong to the kind and stay flat. */
export interface StoredItem {
  /** The dedupe key, e.g. `gh:github.com/o/r#5`. */
  readonly key: string
  /** The kind: `github`, `jira`, `web`, `artifact` or `file`. */
  readonly category: string
  /** Where it was seen, e.g. `prompt`, `response`, `tool`, `auto`. */
  readonly sources: readonly string[]
  readonly firstSeen: number
  readonly lastSeen: number
  readonly priority?: Level
  /** Kind-owned fields. */
  readonly [field: string]: Json | undefined
}

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
  /** The kind fields this sighting gives. */
  readonly fields: JsonObject
}

/** What Capture gives a kind with each text. */
export interface KindContext {
  /** Epoch ms. */
  readonly now: number
  /** Where the text came from: `prompt`, `response`, `tool`, `auto`. */
  readonly source: string
  /** The loop that produced the text. Absent for the main loop. */
  readonly agentId?: string
  /** The config of the tracker that owns the kind. */
  readonly config: ConfigView<JsonObject>
  readonly facts: Pick<FactsPort, 'read'>
  readonly tools: ToolPort
}

/** A rule that lifts an item to a level, e.g. the PR on the session branch is `top`. */
export interface PriorityRule {
  readonly id: string
  readonly level: Level
  matches(item: StoredItem, ctx: KindContext): boolean
}

/** One kind of item in the shared store. A tracker adds its kinds through `Tracker.kinds`. */
export interface ItemKind<T extends StoredItem = StoredItem> {
  readonly category: string
  /** Claim order. `web` is last. */
  readonly rank: number
  claimUrl?(url: string, label: string | undefined, ctx: KindContext): Claim | null
  scan?(maskedText: string, mode: 'full' | 'urls-only', ctx: KindContext): readonly Claim[]
  /** An async filter over the claims of one text, e.g. an open check through `gh`. */
  accept?(claims: readonly Claim[], ctx: KindContext): Promise<readonly Claim[]>
  /** Guards a stored record and gives the typed view. null: not this kind's. */
  decode(item: StoredItem): T | null
  /** Merges a sighting into the record. Returns `cur` when nothing changed. */
  merge(cur: T | null, seen: Claim): T
  /** Filters at load. null drops the item. */
  restore?(item: T): T | null
  readonly refresh?: {
    readonly tool: string
    due(item: T, now: number): boolean
    run(items: readonly T[], tools: ToolPort): Promise<readonly T[]>
  }
  readonly rules?: readonly PriorityRule[]
  row(item: T, ctx: ViewContext): TreeRow
}

/**
 * The part of the ItemStore a tracker sees. The store owns the list, the eviction, dismissal and priority.
 * Every call is async: the list lives in `$.state`.
 */
export interface ItemStorePort<T extends StoredItem = StoredItem> {
  list(): Promise<readonly T[]>
  /**
   * Runs the session check, reads the list, calls `change` at least once and writes the result.
   * `change` gets the run's dismissed set. When it returns its input, nothing is written.
   * `since` is a generation from `TrackerContext.current()`: an older one drops the write.
   * Resolves to whether it wrote.
   */
  update(change: (list: T[], dismissed: ReadonlySet<string>) => T[], opts?: { since?: number }): Promise<boolean>
  /** Offers claims to the kinds and merges the result. In L3 a `Claim` is today's `Ref` (`hooks/contracts`). */
  track(refs: readonly Claim[], source: string): Promise<void>
  /** Marks the keys due, or all items when none are named, and kicks the refresh. Fire and forget. */
  refresh(keys?: readonly string[]): void
}

/** What an item host gets at start: a tracker context without `items` and `data`, plus a persist signal. */
export type HostContext = Omit<TrackerContext<JsonObject, never>, 'items' | 'data'> & {
  /** The host changed its list. Persistence writes the session copy soon. */
  persisted(): void
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
