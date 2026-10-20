// The tracker contract: the one shape core knows. A tracker is data plus pure functions. Types only.
// No tracker receives `on` or `$`, so a plain array registers them (E1).
// Names may change in later layers. The shape may not.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.8, 5.5 and 5.12.

import type { BreakerState, ToolStatus } from '../../types'
import type { ConfigSpec, ConfigView, GlobalConfig } from './config'
import type {
  AgentSpawnEvent,
  CommandEvent,
  DismissedEvent,
  FactEvent,
  ReplayItem,
  RowEvent,
  SessionChangedEvent,
  StartEvent,
  TickEvent,
  ToolCallEvent,
  TurnCompleteEvent,
} from './events'
import type { ItemKind, ItemStorePort, Json, JsonObject } from './items'
import type { AgentInfo, EnvName, Ports, RepoRemote, RunOpts, RunResult, Timer } from './ports'
import type { ActionImpls, SectionSpec, ViewContext } from './view'

export type { BreakerState, ToolStatus } from '../../types'

/** A CLI a tracker owns. ToolRunner keeps one circuit breaker per tool id. */
export interface ToolSpec {
  readonly id: string
  /** The probe argv, e.g. `['tool', '--version']`. */
  readonly probe: readonly string[]
  /** Overrides `global.tools.timeoutMs`. */
  readonly timeoutMs?: number
  /** Overrides `global.tools.breaker`. */
  readonly breaker?: Partial<GlobalConfig['tools']['breaker']>
}

/** A footer key a tracker adds. KeyRegistry rejects an invalid or duplicate key at init. */
export interface KeySpec {
  readonly id: string
  /** One of `a-z` or `0-9`, folded to lowercase. */
  readonly key: string
  /** The short label on the footer button. */
  readonly label: string
  /** `row`: acts on the selected row. `section`: acts on the tracker as a whole. Both show while a row of the section is selected. */
  readonly scope: 'row' | 'section'
}

/** A `/track` sub-command a tracker adds. The first tracker in `order` that declares it runs it. */
export interface CommandSpec {
  readonly sub: string
  /** The argument hint. */
  readonly hint: string
}

/**
 * A handler has the form `(ctx, event) => void | Promise<void>`.
 * Bivariant in `ctx`, so a `Tracker<MyConfig, MyData>` fits a `Tracker` list.
 */
export type Handler<C extends JsonObject = JsonObject, D extends Json = Json, E = unknown> = {
  bivarianceHack(ctx: TrackerContext<C, D>, ev: E): void | Promise<void>
}['bivarianceHack']

/**
 * Handlers as data. TrackerHost fills the bus from them at init. Each call is isolated.
 * `start`, `agentSpawn`, `sessionChanged`, `command` and `dismissed` run one tracker after the other, in `order`.
 * `row`, `toolCall`, `turnComplete`, `tick`, `replay` and `facts` run in parallel (plan decision D11).
 */
export interface TrackerEvents<C extends JsonObject = JsonObject, D extends Json = Json> {
  readonly start?: Handler<C, D, StartEvent>
  /** Rows of the listed doors. The bus filters by door. */
  readonly row?: { readonly doors: readonly string[]; readonly run: Handler<C, D, RowEvent> }
  /** Keyed by tool name. */
  readonly toolCall?: Readonly<Record<string, Handler<C, D, ToolCallEvent>>>
  readonly agentSpawn?: Handler<C, D, AgentSpawnEvent>
  readonly turnComplete?: Handler<C, D, TurnCompleteEvent>
  /** Periodic work. Runs when `now - last >= everyMs`. The default period is `global.refresh.tickMs`. */
  readonly tick?: { everyMs?(config: Readonly<C>): number; readonly run: Handler<C, D, TickEvent> }
  readonly sessionChanged?: Handler<C, D, SessionChangedEvent>
  /** Runs the sub-commands the tracker declared in `commands`. */
  readonly command?: Handler<C, D, CommandEvent>
  readonly dismissed?: Handler<C, D, DismissedEvent>
  /** One batch: the transcript read back on a cold start or a cold resume (plan decision D7). */
  readonly replay?: Handler<C, D, readonly ReplayItem[]>
  /**
   * Keyed by fact name: runs when a publish gives that fact a new value. Core starts every such handler before `publish`
   * returns, so the quick part of a handler runs first and `publish` never waits for the slow part (plan decision K14).
   */
  readonly facts?: Readonly<Record<string, Handler<C, D, FactEvent>>>
}

/**
 * Named values one tracker publishes and others read. A missing fact reads as `undefined`. A publish that changes the
 * value starts the handlers that declared `events.facts[name]`.
 */
export interface FactsPort {
  /** `undefined` withdraws the fact. */
  publish(name: string, value: Json | undefined): void
  read<T extends Json>(name: string): T | undefined
}

/** The run-scoped dismiss list: row ids and item keys. */
export interface DismissPort {
  list(): Promise<ReadonlySet<string>>
  add(ids: readonly string[]): Promise<void>
}

/**
 * How one call ended, for the breaker.
 * `ok` and `item-error` (not found, no permission) are successes for the tool.
 * `tool-failure` (cannot start, timeout, network, 401, unparsable) and `auth` (not logged in) count.
 */
export type ToolOutcome = 'ok' | 'item-error' | 'tool-failure' | 'auth'

/**
 * The circuit breaker of one tool. Pure: the caller passes the time. `CircuitBreaker` in `core/lib` is the shipped one.
 * `closed` -> (enough failures in a row) -> `open` -> (the wait is over) -> `half-open`: one call goes through.
 */
export interface Breaker {
  readonly state: BreakerState
  /** When an open breaker lets the next call through. undefined unless open. */
  readonly openUntil: number | undefined
  /** Would `allows(now)` say yes? Changes nothing. */
  peek(now: number): boolean
  /** May a call start now? An open breaker whose wait is over becomes half-open and lets one call through. */
  allows(now: number): boolean
  success(): void
  failure(now: number): void
  /** Manual refresh: an open breaker becomes half-open at once. */
  reset(): void
}

/** One declared CLI: its probe, its timeouts and its circuit breaker. ToolRunner owns one per `ToolSpec`. */
export interface ToolHandle {
  readonly id: string
  /** True once the probe succeeded. False before the probe settles. */
  readonly isAvailable: boolean
  /** Runs the probe argv once and caches the answer. Never rejects. */
  probe(): Promise<boolean>
  /** Available, not known to be logged out, and the breaker lets a call through. No side effects. */
  canCall(now: number): boolean
  /** The breaker alone: would it let a call through? Not the probe, not the login flag. No side effects. */
  peek(now: number): boolean
  /** Manual refresh: forget `loggedIn: false`, move an open breaker to half-open. */
  reset(): void
  status(): ToolStatus
  /** Runs one command through the breaker. null: the breaker blocked it, or it rejected (recorded as a failure). */
  exec(argv: readonly string[], init?: RunOpts): Promise<RunResult | null>
  /** Runs one command on the tool's timeout, outside the breaker: nothing is recorded, a rejection reaches the caller. */
  raw(argv: readonly string[], init?: RunOpts): Promise<RunResult>
  /** Feeds one outcome to the breaker and the login flag. */
  record(outcome: ToolOutcome, detail?: string): void
  /** The site or account the tool acts on, when it has one. */
  setSite(site: string | undefined): void
}

/** What a tracker runs CLIs through. */
export interface ToolPort {
  /** The handle of a tool this tracker declared. undefined: no such id, or another tracker's. */
  handle(id: string): ToolHandle | undefined
  /** A raw run with no probe, timeout or breaker. A non-zero exit resolves. */
  run(tool: string, argv: readonly string[], opts: RunOpts): Promise<RunResult>
}

/** What TrackerHost gives one tracker. Only its own slices and scoped services. */
export interface TrackerContext<C extends JsonObject = JsonObject, D extends Json = Json> {
  readonly id: string
  /** Bumps on a session switch and on `/track clear`. A getter: it reads the live value. */
  readonly generation: number
  /** Runs the session check, then answers the generation. A caller keeps it and passes it as `since` to `data.update`. */
  current(): Promise<number>
  readonly config: ConfigView<C>
  /** The tracker's StateFamily slot. `update` answers `undefined` when the write was dropped (an older `since`). */
  readonly data: {
    get(): Promise<D | undefined>
    update(fn: (cur: D | undefined) => D, opts?: { since?: number }): Promise<D | undefined>
  }
  readonly items: ItemStorePort
  readonly facts: FactsPort
  readonly dismiss: DismissPort
  readonly session: {
    id(): Promise<string>
    cwd(): Promise<string>
    repo(): Promise<RepoRemote | null>
    root(): string | undefined
  }
  readonly tools: ToolPort
  /** A turn the mod asks for. See `Ports['prompt']`: a press only, never awaited. */
  readonly prompt: Ports['prompt']
  /** A short message over the pane. */
  readonly ui: Pick<Ports['ui'], 'toast'>
  readonly fs: Pick<Ports['fs'], 'stat' | 'exists'>
  readonly env: {
    get(name: EnvName): Promise<string | undefined>
    settings(): Promise<Json | undefined>
    agents(): Promise<readonly AgentInfo[]>
  }
  readonly clock: {
    now(): Promise<number>
    wall(): number
    /** TrackerHost tracks the timer and cancels it at dispose. The caller may cancel it earlier. */
    after(ms: number, fn: () => void): Timer
  }
  readonly log: (line: string) => void
}

/**
 * How core stores one tracker's slot. `settle` merges the stored copy under the live value, `restore` puts a value
 * back, `clear` empties the slot. A tracker with no `data` keeps nothing across sessions.
 * Methods, not properties, so a `DataSpec<MyConfig, MyData>` fits a `DataSpec` list.
 */
export interface DataSpec<C extends JsonObject = JsonObject, D extends Json = Json> {
  /** True when the value holds nothing worth a write. Default: `undefined`. */
  empty?(v: D | undefined): boolean
  /** Default: the live value wins. */
  settle?(ctx: TrackerContext<C, D>, live: D | undefined, stored: D | undefined): Promise<D | undefined>
  /** `carry`: from the leaving session. `load`: from the stored copy of the new one. */
  restore(ctx: TrackerContext<C, D>, value: D, how: 'carry' | 'load'): Promise<void>
  clear?(ctx: TrackerContext<C, D>): Promise<void>
}

export interface Tracker<C extends JsonObject = JsonObject, D extends Json = Json> {
  /** The folder name and the config key. */
  readonly id: string
  /** Section and handler order. */
  readonly order: number
  /** Defaults and normalise. */
  readonly config: ConfigSpec<C>
  /** False: core never stores this tracker's slot. */
  readonly persist?: false
  /** Item kinds added to the shared store. */
  readonly kinds?: readonly ItemKind[]
  /** CLIs this tracker owns. */
  readonly tools?: readonly ToolSpec[]
  /** Static keys: id, key, label, scope. */
  readonly keys?: readonly KeySpec[]
  /** `/track` sub-commands: sub, hint. */
  readonly commands?: readonly CommandSpec[]
  /** Handlers as data: `(ctx, event) => ...`. */
  readonly events?: TrackerEvents<C, D>
  /** How core stores, carries and clears this tracker's slot. */
  readonly data?: DataSpec<C, D>
  /** Idempotent. Reads its data from `ctx.data` and `ctx.items`. Timers only through `ctx.clock.after`. A tracker builds its services once per load (plan decision D16). */
  init(ctx: TrackerContext<C, D>): void | Promise<void>
  /** The slice this tracker wants in the config file. Config only: data persistence stays in core. */
  store(ctx: TrackerContext<C, D>): C
  /** Pure. Read the view context, return values, write nothing. */
  sections?(ctx: ViewContext<C, D>): readonly SectionSpec[]
  /** The `run` and `state` per key id, at render. */
  actions?(ctx: ViewContext<C, D>): ActionImpls<C, D>
  /** One line per item. */
  prompt?(ctx: ViewContext<C, D>): readonly string[]
  /** Best effort, synchronous. A reload gives no call (E7). */
  dispose?(): void
}
