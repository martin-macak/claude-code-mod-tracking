// Config contracts: what a tracker declares, what the user's file holds, what a tracker sees. Types only.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.7 and 5.8.

import type { JsonObject } from './items'
import type { FsStat } from './ports'
import type { ViewId } from './view'

/** A tracker's config: its defaults and the rule that turns a raw file slice into a valid one. */
export interface ConfigSpec<C extends JsonObject> {
  readonly defaults: Readonly<C>
  /**
   * Per-field fallback to `defaults`, a min and a max on every number, unknown keys kept.
   * Pure. Calls `warn` once per problem. The caller freezes the result.
   */
  normalise(raw: Readonly<JsonObject>, defaults: Readonly<C>, warn: (problem: string) => void): Readonly<C>
}

/** The `global` block of the config file. Core owns it. Trackers read it only. */
export interface GlobalConfig {
  readonly refresh: {
    readonly tickMs: number
    readonly staleMs: number
    readonly captureDebounceMs: number
    readonly flushMs: number
  }
  readonly tools: {
    readonly timeoutMs: number
    readonly probeTimeoutMs: number
    readonly breaker: { readonly threshold: number; readonly openMs: number }
  }
  readonly store: {
    readonly keepSessions: number
    readonly maxItems: number
    readonly maxDismissed: number
    readonly maxBytes: number
  }
  readonly ui: {
    readonly maxRows: number
    readonly sectionRows: number
    readonly turnStrip: TurnStripMode
    /** The view the pane opens in, until the person picks another (a session choice that `/clear` resets). */
    readonly view: ViewId
    /** The views that `g` cycles, in order. At least one. */
    readonly views: readonly ViewId[]
  }
}

/** What the strip under each answer is (issue #69): nothing, one line of text, or the counts and an open Button on the duration line. */
export type TurnStripMode = 'off' | 'text' | 'interactive'

/** The live view of the config a tracker gets. A changed file shows on the next call. */
export interface ConfigView<C> {
  slice(): Readonly<C>
  global(): Readonly<GlobalConfig>
}

/** The four fs calls the ConfigManager makes. `Ports['fs']` satisfies it. `stat` gives null on any refusal. */
export interface ConfigFs {
  read(path: string): Promise<string>
  write(path: string, text: string): Promise<void>
  exists(path: string): Promise<boolean>
  stat(path: string): Promise<FsStat | null>
}

/** One step of a file upgrade: a pure function from version `from` to version `to`. `up` gets a copy it may change. */
export interface Migration {
  readonly from: number
  readonly to: number
  up(raw: JsonObject): JsonObject
}

/**
 * The problems the config left out of its list (issue #144): how many, and the count line that says so and names the
 * place of the log. The same line is the last entry of `ConfigSource.problems()`.
 */
export interface MoreProblems {
  readonly count: number
  readonly line: string
}

/** What a consumer reads of the config file. Every view is frozen. A changed file shows on the next call. */
export interface ConfigSource {
  global(): Readonly<GlobalConfig>
  /** The slice of a tracker. An id no spec has gives a frozen `{}`. */
  slice(id: string): Readonly<JsonObject>
  /** False only when the slice says `enabled: false`. */
  enabled(id: string): boolean
  /**
   * The problems of the file, in the order of the Copy table. Empty when all is well. At most 50, then one count line
   * when more exist (issue #144): a reader that shows this list shows the cap. The log has every problem.
   */
  problems(): readonly string[]
  /**
   * What `problems()` leaves out: the count and the count line. Undefined when all problems show. When set, its `line`
   * is the last entry of `problems()`, so a reader that lists the named problems drops that entry (`namedProblems`).
   */
  moreProblems(): MoreProblems | undefined
  /** Where the file is, or undefined when the mod has no place for it. */
  path(): string | undefined
}

/** The manager side: the lifecycle refreshes the source and reconciles the file once per load. */
export interface ConfigService extends ConfigSource {
  /** Checks the file and reads it again when it changed. True when the views or the problems changed. Never writes. */
  refresh(): Promise<boolean>
  /** Writes the first-run defaults and any missing keys, once per load. `stored` holds each tracker's store result. */
  reconcile(stored: ReadonlyMap<string, JsonObject>): Promise<void>
}
