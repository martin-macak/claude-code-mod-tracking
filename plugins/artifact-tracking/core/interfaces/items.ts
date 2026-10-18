// Item contracts: the stored record, the item kind and the store port. Types only.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.9 and 5.13.
//
// `Json`, `JsonObject`, `Level` and `StoredItem` are declared here for now. Spec 5.13 gives them to the
// PluginState contract (`types/index.d.ts`); layer L3 moves them there and this file re-exports them.
//
// Two names clash with older code, and tsc accepts a wrong import without a word:
// - `Json` here is a real JSON union. `core/lib/json.ts` exports another `Json` (`Record<string, unknown>`).
//   Contract code imports it from this folder, never from `core/lib/json`. When L3 moves these types, rename the lib one.
// - `Level` is also declared in `hooks/model/priority.ts`. The two have the same members. When L3 moves the types, drop that copy.

import type { ConfigView } from './config'
import type { FactsPort, ToolPort } from './tracker'
import type { TreeRow, ViewContext } from './view'

/** A JSON value. Arrays and objects are read-only, so a frozen config or a stored record fits. */
export type Json = null | boolean | number | string | readonly Json[] | JsonObject

/**
 * A JSON object. A tracker config type must be a `type` alias, not an `interface`:
 * only an alias has the implicit index signature that `C extends JsonObject` needs.
 */
export interface JsonObject {
  readonly [key: string]: Json | undefined
}

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

/** The part of the ItemStore a tracker sees. The store owns the list, the eviction, dismissal and priority. */
export interface ItemStorePort {
  /** All items, or those of one category. */
  list(category?: string): readonly StoredItem[]
  get(key: string): StoredItem | undefined
  /** Merges claims through the owning kinds. A dismissed or disabled kind's claim is dropped. */
  merge(claims: readonly Claim[]): Promise<void>
  remove(key: string): Promise<void>
}
