// TrackerHost: gives each tracker its context, runs `init` and `store`, fills the bus with the declared handlers,
// turns a tracker's data spec into a DataSlot, and owns the timers a tracker starts. A tracker that throws at init is
// marked failed for the load: its handlers never run. A tracker the config turned off (read once, at the first start of
// the load) gets `store` but no `init`, no handler and no command. It names no tracker and holds no `$`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.5, 5.7, 5.8 and 6.
// Plan: L3 Task 8, D1, D15, D16. L4 Task 5, C4, C5.

import type { ConfigSource } from '../interfaces/config'
import type { HostContext, ItemStorePort, Json, JsonObject } from '../interfaces/items'
import type { EnvName, Ports, RunOpts, Timer } from '../interfaces/ports'
import type { DataSlot } from '../interfaces/slots'
import type { CommandSpec, DismissPort, FactsPort, ToolPort, Tracker, TrackerContext } from '../interfaces/tracker'
import type { TurnPort, TurnTarget } from '../interfaces/turns'
import { isRecord } from '../lib/json'
import type { BusKind, EventBus } from './bus'
import type { SessionWatch } from './session'
import { type Due, declaredHandlers } from './tracker-events'

export interface TrackerHostDeps {
  trackers: readonly Tracker[]
  /** The ports of the first hook of the load: the slots and `init` use them. A handler gets its own dispatch's ports. */
  ports: Ports
  /** The config file's views, read at call time: a tracker's `ctx.config` never holds a copy. */
  config: ConfigSource
  facts: FactsPort
  dismiss: DismissPort
  items: ItemStorePort
  /**
   * What `ctx.items` is for one tracker. The item host exists after this host (it reads `live` from it), so the manager
   * hands a function. Absent: every tracker gets `items`.
   */
  itemsOf?(owner: string): ItemStorePort
  /** The tools of one tracker: the handles of the ToolRunner. undefined before the tools are built. */
  toolsOf?(owner: string): ToolPort | undefined
  /**
   * What `ctx.turn` is for an event of a turn (issue #133): the turn the ledger named for it. The ledger exists after this
   * host, so the manager hands a function. Absent: no handler gets a turn.
   */
  turnPort?(target: TurnTarget): TurnPort
  watch: Pick<SessionWatch, 'generation' | 'check' | 'current'>
  /** True once per period per owner (the Scheduler). */
  due(owner: string, everyMs: number, now: number): boolean
  /** A persisted slot of this owner changed. */
  persisted(owner: string): void
  log(line: string): void
}

/** The state family and the item list share one namespace of ids. This one belongs to the item list. */
const ITEMS = 'items'

/**
 * These kinds run inside the start sequence or a session switch. The session check is single flight and would wait
 * for the run it sits in (Review Focus 2), so their contexts write without it.
 */
const UNGUARDED: ReadonlySet<BusKind> = new Set<BusKind>(['start', 'sessionChanged', 'replay'])

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e))

type Base = Omit<TrackerContext<JsonObject, Json>, 'data' | 'items'>

export class TrackerHost {
  private readonly ordered: readonly Tracker[]
  private readonly failedIds = new Set<string>()
  private readonly slices = new Map<string, JsonObject>()
  /** The trackers the config turned off, as the file read at the first start of the load. Set once (C5). */
  private off: ReadonlySet<string> | undefined
  private readonly timers = new Map<string, Set<Timer>>()
  private readonly disposed = new Set<string>()
  private filled = false

  constructor(private readonly d: TrackerHostDeps) {
    this.ordered = [...d.trackers].sort((a, b) => a.order - b.order)
  }

  /**
   * `init`, then `store`, for each tracker in `order`. A tracker the config turned off gets `store` only. A throw marks
   * that tracker failed; the others still run.
   */
  async init(): Promise<void> {
    this.readToggles()
    for (const t of this.ordered) {
      if (this.failedIds.has(t.id)) continue
      try {
        if (t.id === ITEMS) throw new Error(`the id ${ITEMS} belongs to the item list`)
        const ctx = this.contextOf(t, this.d.ports, false)
        if (this.live(t.id)) await t.init(ctx)
        this.slices.set(t.id, t.store(ctx) as JsonObject)
      } catch (e) {
        this.failedIds.add(t.id)
        this.d.log(`host: init of ${t.id} failed: ${reason(e)}`)
      }
    }
  }

  failed(): readonly string[] {
    return [...this.failedIds]
  }

  /**
   * Reads the toggles from the config, once per load: a later call changes nothing, so an edit of the file waits for the
   * next load (C5). The start sequence calls it right after it read the file. `init` calls it too.
   */
  readToggles(): void {
    this.off ??= new Set(this.ordered.filter(t => !this.d.config.enabled(t.id)).map(t => t.id))
  }

  /**
   * True unless the config turned the tracker off or it failed to start. Before the toggles are read nothing is off:
   * a render ahead of the start draws from state only and must not fix the toggles from values the file has not set yet.
   */
  live(id: string): boolean {
    return !this.off?.has(id) && !this.failedIds.has(id)
  }

  /** What each tracker's `store` gave: the slice it wants in the file. The ConfigManager merges it once per load. */
  stored(): ReadonlyMap<string, JsonObject> {
    return this.slices
  }

  /** The `/track` sub-commands of the live trackers, in `order`. The Commands router asks for them. */
  commands(): readonly { owner: string; spec: CommandSpec }[] {
    return this.ordered
      .filter(t => this.live(t.id))
      .flatMap(t => (t.commands ?? []).map(spec => ({ owner: t.id, spec })))
  }

  /** The data of every live tracker that declares any, as slots for Persistence and the switch. Run-scoped when `persist` is false. */
  slots(): readonly DataSlot[] {
    return this.ordered.filter(t => t.data && t.id !== ITEMS && !this.failedIds.has(t.id)).map(t => this.slotOf(t))
  }

  /** Adds every handler of every live tracker. Once: a second start of the load keeps the bus as it is. */
  fill(bus: EventBus): void {
    if (this.filled) return
    this.filled = true
    for (const t of this.ordered) {
      if (!t.events || !this.live(t.id)) continue
      const due: Due = (everyMs, now) => this.d.due(t.id, everyMs, now)
      for (const { kind, run, filter } of declaredHandlers(t.events, due))
        bus.add(
          kind,
          t.id,
          t.order,
          async (e, via, turn) => {
            if (this.failedIds.has(t.id)) return
            await run(this.contextOf(t, via as Ports, !UNGUARDED.has(kind), turn), e)
          },
          filter,
        )
    }
  }

  /**
   * The context of one tracker for one dispatch. With `guard` (the default of a handler) `data.update` runs the
   * session check first. A switch passes `guard: false` (Review Focus 2).
   */
  ctx(owner: string, ports: Ports, opts: { guard?: boolean } = {}): TrackerContext<JsonObject, Json> {
    const t = this.ordered.find(x => x.id === owner)
    if (!t) throw new Error(`host: no tracker ${owner}`)
    return this.contextOf(t, ports, opts.guard ?? true)
  }

  /** The item host's context: no data and no items of its own, and a signal that its list changed. */
  hostCtx(ports: Ports): HostContext {
    return this.make(ITEMS, ports, { persisted: () => this.d.persisted(ITEMS) }) as unknown as HostContext
  }

  /** Cancels the timers the trackers started, then calls each tracker's `dispose` once. A throw is logged. */
  dispose(): void {
    for (const set of this.timers.values()) for (const timer of [...set]) timer.cancel()
    this.timers.clear()
    for (const t of this.ordered) {
      if (this.disposed.has(t.id) || this.off?.has(t.id)) continue // a tracker that is off never ran `init`
      this.disposed.add(t.id)
      try {
        t.dispose?.()
      } catch (e) {
        this.d.log(`host: dispose of ${t.id} failed: ${reason(e)}`)
      }
    }
  }

  private slotOf(t: Tracker): DataSlot {
    const spec = t.data as NonNullable<Tracker['data']>
    const ctx = () => this.contextOf(t, this.d.ports, false)
    return {
      id: t.id,
      persist: t.persist !== false,
      read: () => ctx().data.get(),
      empty: v => (spec.empty ? spec.empty(v) : v === undefined),
      settle: async (live, stored) => (spec.settle ? spec.settle(ctx(), live, stored) : live),
      restore: (value, how) => spec.restore(ctx(), value, how),
      ...(spec.clear ? { clear: () => (spec.clear as NonNullable<typeof spec.clear>)(ctx()) } : {}),
    }
  }

  private contextOf(t: Tracker, ports: Ports, guard: boolean, turn?: TurnTarget): TrackerContext<JsonObject, Json> {
    const { d } = this
    const persist = t.persist !== false
    const port = turn === undefined ? undefined : d.turnPort?.(turn)
    return this.make(t.id, ports, {
      data: {
        get: () => ports.state.slot.get(t.id),
        update: async (fn: (cur: Json | undefined) => Json, opts?: { since?: number }) => {
          if (guard) await d.watch.check()
          if (opts?.since !== undefined && opts.since !== d.watch.generation) return undefined
          const next = await ports.state.slot.update(t.id, cur => fn(cur))
          if (persist) d.persisted(t.id)
          return next
        },
      },
      items: d.itemsOf?.(t.id) ?? d.items,
      ...(port !== undefined ? { turn: port } : {}),
    })
  }

  /**
   * A context: everything the tracker may use, over the ports of one dispatch. `extra` adds the parts that differ
   * (`data` and `items` for a tracker, `persisted` for the item host). `generation` is a getter that reads the live
   * value, and so are the config views: a changed file shows on the next call.
   */
  private make<X extends object>(owner: string, ports: Ports, extra: X): Base & X {
    const { d } = this
    return {
      id: owner,
      get generation() {
        return d.watch.generation
      },
      current: () => d.watch.current(),
      config: { slice: () => d.config.slice(owner), global: () => d.config.global() },
      facts: d.facts,
      dismiss: d.dismiss,
      session: {
        id: () => ports.session.id(),
        cwd: () => ports.session.cwd(),
        repo: () => ports.session.repo(),
        root: () => {
          const root = d.facts.read('auto.root')
          return isRecord(root) && typeof root.cwd === 'string' ? root.cwd : undefined
        },
      },
      // The handles come from the ToolRunner of the item host; a raw run goes through the ports of this dispatch.
      tools: {
        handle: (id: string) => d.toolsOf?.(owner)?.handle(id),
        run: (_tool: string, argv: readonly string[], opts: RunOpts) => ports.run(argv, opts),
      },
      prompt: { submit: (text: string, onRefused?: (reason: string) => void) => ports.prompt.submit(text, onRefused) },
      ui: { toast: (text: string) => ports.ui.toast(text) },
      fs: {
        stat: (path: string, opts?: { resolve?: boolean }) => ports.fs.stat(path, opts),
        exists: (path: string) => ports.fs.exists(path),
      },
      env: {
        get: (name: EnvName) => ports.env.get(name),
        settings: async () => {
          try {
            return await ports.settings.read()
          } catch {
            return undefined
          }
        },
        agents: () => ports.agents.list(),
      },
      clock: {
        now: () => ports.clock.now(),
        wall: () => ports.clock.wall(),
        after: (ms: number, fn: () => void) => this.after(owner, ports, ms, fn),
      },
      log: ports.log,
      ...extra,
    }
  }

  private after(owner: string, ports: Ports, ms: number, fn: () => void): Timer {
    const set = this.timers.get(owner) ?? new Set<Timer>()
    this.timers.set(owner, set)
    // The engine ignores what the callback returns; the mini clock of the tests awaits it.
    const timer: Timer = ports.clock.after(ms, (() => {
      set.delete(timer)
      return fn()
    }) as () => void)
    set.add(timer)
    return {
      cancel: () => {
        set.delete(timer)
        timer.cancel()
      },
    }
  }
}
