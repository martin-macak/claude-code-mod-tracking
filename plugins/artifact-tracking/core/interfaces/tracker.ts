// The tracker contract: the one shape core knows. A tracker is data plus pure functions. Types only.
// No tracker receives `on` or `$`, so a plain array registers them (E1).
// Names may change in later layers. The shape may not.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.8, 5.5 and 5.12.

import type { ConfigSpec, ConfigView, GlobalConfig } from './config'
import type {
  AgentSpawnEvent,
  CommandEvent,
  RowEvent,
  SessionChangedEvent,
  ToolCallEvent,
  TurnCompleteEvent,
} from './events'
import type { ItemKind, ItemStorePort, Json, JsonObject } from './items'
import type { Ports, RepoRemote, RunOpts, RunResult } from './ports'
import type { ActionImpls, SectionSpec, ViewContext } from './view'

/** A CLI a tracker owns. ToolRunner keeps one circuit breaker per tool id. */
export interface ToolSpec {
  readonly id: string
  /** The probe argv, e.g. `['gh', '--version']`. */
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
export type EventHandler<E, C extends JsonObject = JsonObject, D extends Json = Json> = {
  bivarianceHack(ctx: TrackerContext<C, D>, event: E): void | Promise<void>
}['bivarianceHack']

/** Handlers as data. TrackerHost fills the bus from them at init. Each call is isolated. */
export interface TrackerEvents<C extends JsonObject = JsonObject, D extends Json = Json> {
  /** Rows of the listed doors. The bus filters by door. */
  readonly row?: { readonly doors: readonly string[]; readonly handle: EventHandler<RowEvent, C, D> }
  /** Keyed by tool name. */
  readonly toolCall?: Readonly<Record<string, EventHandler<ToolCallEvent, C, D>>>
  readonly agentSpawn?: EventHandler<AgentSpawnEvent, C, D>
  readonly turnComplete?: EventHandler<TurnCompleteEvent, C, D>
  readonly sessionChanged?: EventHandler<SessionChangedEvent, C, D>
  /** Periodic work. Runs when `now - last >= everyMs`. The default period is `global.refresh.tickMs`. */
  readonly tick?: {
    everyMs?(config: Readonly<C>): number
    run(ctx: TrackerContext<C, D>): void | Promise<void>
  }
  /** Runs the sub-commands the tracker declared in `commands`. */
  readonly command?: EventHandler<CommandEvent, C, D>
}

/** Named values one tracker publishes and others read. A missing fact reads as `undefined`. */
export interface FactsPort {
  publish(name: string, value: Json): void
  read(name: string): Json | undefined
}

/** The run-scoped dismiss list: row ids and item keys. */
export interface DismissPort {
  has(id: string): boolean
  add(ids: readonly string[]): Promise<void>
}

/** Runs a CLI by tool id, with the probe, the timeout and the breaker of its `ToolSpec`. */
export interface ToolPort {
  /** True when the probe succeeded. Cached. */
  probe(tool: string): Promise<boolean>
  /** True when the tool probed fine and its breaker lets a call through. */
  canCall(tool: string): boolean
  /** Rejects when the breaker is open or the tool cannot start. A non-zero exit resolves. */
  run(tool: string, argv: readonly string[], opts?: RunOpts): Promise<RunResult>
}

/** What TrackerHost gives one tracker. Only its own slices and scoped services. */
export interface TrackerContext<C extends JsonObject = JsonObject, D extends Json = Json> {
  readonly id: string
  /** Bumps on a session switch. A write of an older generation is dropped. */
  readonly generation: number
  readonly config: ConfigView<C>
  /** The tracker's StateFamily slot. */
  readonly data: { get(): D | undefined; update(fn: (cur: D | undefined) => D): Promise<void> }
  readonly items: ItemStorePort
  readonly facts: FactsPort
  readonly dismiss: DismissPort
  readonly session: {
    id(): Promise<string>
    cwd(): Promise<string>
    repo(): Promise<RepoRemote | null>
    root(): string | undefined
  }
  /** Run by tool id: probe, timeout, breaker. */
  readonly tools: ToolPort
  readonly fs: Pick<Ports['fs'], 'stat' | 'exists'>
  readonly env: Pick<Ports, 'settings' | 'agents'>
  readonly clock: {
    now(): Promise<number>
    wall(): number
    /** TrackerHost tracks the timer and cancels it at the next `init` and at dispose. */
    after(ms: number, fn: () => void): Promise<void>
  }
  readonly log: (line: string) => void
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
  /** Idempotent. Reads its data from `ctx.data` and `ctx.items`. Timers only through `ctx.clock.after`. */
  init(ctx: TrackerContext<C, D>): void | Promise<void>
  /** The slice this tracker wants in the config file. Config only: data persistence stays in core. */
  store(ctx: TrackerContext<C, D>): C
  /** Pure. Read the view context, return values, write nothing. */
  sections?(ctx: ViewContext<C, D>): readonly SectionSpec[]
  /** The `run` and `state` per key id, at render. */
  actions?(ctx: ViewContext<C, D>): ActionImpls
  /** One line per item. */
  prompt?(ctx: ViewContext<C, D>): readonly string[]
  /** Best effort, synchronous. A reload gives no call (E7). */
  dispose?(): void
}
