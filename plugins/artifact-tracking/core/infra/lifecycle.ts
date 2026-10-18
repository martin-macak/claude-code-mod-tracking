// LifecycleManager: sequences the collaborators. It owns the single flight of the start, the entry of every hook,
// `session.end`, `/track clear`, the tick and the domain events. The steps of the start live in StartSequence and the
// steps of a session switch in SwitchRunner. It builds SessionWatch, Persistence, Scheduler, Replay, the EventBus and
// the TrackerHost from the ports of the first hook of a load. It names no tracker and holds no `$`.
// `end` stores the leaving session and keeps a snapshot. The switch that follows carries it (`/clear`) or loads the
// stored copy of the new id (`/resume`).
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.6. Plan: L3 Tasks 5 to 8, D4 to D9, D20.

import type { GlobalConfig } from '../interfaces/config'
import type { AgentSpawnEvent, CommandEvent, RowEvent, ToolCallEvent, TurnCompleteEvent } from '../interfaces/events'
import type { ItemsHost } from '../interfaces/items'
import type { Ports } from '../interfaces/ports'
import type { DataSlot, PendingEnd, Snapshot } from '../interfaces/slots'
import type { DismissPort, FactsPort, Tracker } from '../interfaces/tracker'
import { EventBus } from './bus'
import { Facts } from './facts'
import { Persistence } from './persistence'
import { Replay } from './replay'
import { Scheduler } from './scheduler'
import { SessionWatch } from './session'
import { type Launch, StartSequence } from './start-sequence'
import { guard, reason } from './steps'
import { SwitchRunner } from './switch-runner'
import { TrackerHost } from './tracker-host'

export type { Launch } from './start-sequence'

export interface LifecycleDeps {
  trackers: readonly Tracker[]
  /** The item host: its list is the `items` slot, and it owns capture, replay and its share of every beat. */
  items: ItemsHost
  /**
   * Slots that no tracker owns. register.tsx passes none since the last tracker took its slot (L3 Task 10). The
   * lifecycle unit tests use it to run the switch over fake slots.
   */
  extraSlots?: readonly DataSlot[]
  /** The run-scoped dismiss list over the ports of a dispatch. */
  dismiss(ports: Ports): DismissPort
  global: GlobalConfig
  /** The pane the start sequence reattaches when the engine kept it across a hot reload. */
  paneId: string
}

/** `session.end` reasons after which the process goes away. `clear` and `resume` are switches. */
const EXITS: ReadonlySet<string> = new Set(['prompt_input_exit', 'logout', 'other'])

export class LifecycleManager {
  readonly facts: FactsPort = new Facts()
  readonly watch: SessionWatch
  /** The session store. Public for the lifecycle tests; the hooks reach it through the manager only. */
  readonly persistence: Persistence
  private readonly scheduler: Scheduler
  private readonly bus: EventBus
  private readonly host: TrackerHost
  private readonly switcher: SwitchRunner
  private readonly sequence: StartSequence
  /** The start sequence of this load. Set by the first start, lazy or from `session.start`. */
  private started: Promise<void> | undefined

  constructor(
    private readonly d: LifecycleDeps,
    private readonly ports: Ports,
  ) {
    this.watch = new SessionWatch({
      id: () => ports.session.id(),
      onSwitch: sw => this.switcher.run(sw),
      log: ports.log,
    })
    this.scheduler = new Scheduler({
      now: () => ports.clock.now(),
      every: (ms, fn) => ports.clock.every(ms, fn),
      periodMs: () => d.global.refresh.tickMs,
      beat: () => this.tick(),
      log: ports.log,
    })
    this.bus = new EventBus({ log: ports.log })
    this.persistence = new Persistence({
      store: ports.store,
      clock: ports.clock,
      sessionId: () => ports.session.id(),
      slots: () => this.slots(),
      limits: () => ({
        flushMs: d.global.refresh.flushMs,
        keepSessions: d.global.store.keepSessions,
        maxBytes: d.global.store.maxBytes,
      }),
      beforeFlush: async () => {
        await this.watch.check() // a flush is an entry: a /clear since the last change is carried first
      },
      log: ports.log,
    })
    this.switcher = new SwitchRunner({
      items: d.items,
      persistence: this.persistence,
      bus: this.bus,
      replayer: new Replay({ messages: () => ports.session.messages(), log: ports.log }),
      slots: () => this.slots(),
      ports,
    })
    this.host = new TrackerHost({
      trackers: d.trackers,
      ports,
      global: d.global,
      facts: this.facts,
      dismiss: d.dismiss(ports),
      items: d.items,
      watch: this.watch,
      due: (owner, everyMs, now) => this.scheduler.due(owner, everyMs, now),
      persisted: () => void this.persistence.touch(),
      log: ports.log,
    })
    this.sequence = new StartSequence({
      items: d.items,
      persistence: this.persistence,
      host: this.host,
      bus: this.bus,
      watch: this.watch,
      scheduler: this.scheduler,
      switcher: this.switcher,
      paneId: d.paneId,
      tickMs: () => d.global.refresh.tickMs,
      ports,
    })
  }

  get generation(): number {
    return this.watch.generation
  }

  // ---------------------------------------------------------------- start

  /**
   * `session.start`: runs the start sequence. After a lazy start it runs again with the cwd and the stored session
   * (D5). The sequence never rejects.
   */
  start(ports: Ports, launch: Launch): Promise<void> {
    if (!this.started) {
      this.started = this.sequence.run(ports, launch)
      return this.started
    }
    return this.started.then(() => this.sequence.run(ports, launch))
  }

  /**
   * Every non-render entry waits for the start sequence, which runs once per load as a single flight. A hot reload
   * delivers `session.start` about 0.5 s late, so an event can come first. It does not load or replay (D5).
   */
  ensureStarted(ports: Ports): Promise<void> {
    this.started ??= this.sequence.run(ports, { fromSessionStart: false })
    return this.started
  }

  // ---------------------------------------------------------------- entry, tick, events

  /**
   * The first step of every hook that reads or writes session data: the start (once per load), the session check,
   * then the watchdog of the tick. `ports` are the dispatch's own.
   */
  async entry(ports: Ports): Promise<void> {
    await this.ensureStarted(ports)
    await this.watch.check()
    await this.scheduler.ensure()
  }

  /** One beat of the tick: finds a new session id, gives the item host its share, then the trackers theirs. */
  async tick(): Promise<void> {
    await this.ensureStarted(this.ports)
    try {
      await this.watch.check()
    } catch {
      // The beat still does what it can.
    }
    await this.guard('item tick', () => this.d.items.tick(), 'a beat')
    await this.bus.emit('tick', { now: await this.ports.clock.now() }, this.ports)
  }

  /** True when a tracker declared a `toolCall` handler for the tool. Static: it needs no start. */
  wants(tool: string): boolean {
    return this.d.trackers.some(t => t.events?.toolCall !== undefined && Object.hasOwn(t.events.toolCall, tool))
  }

  /** A row was appended: capture first (the item host), then the handlers of the declared doors. */
  async row(ports: Ports, ev: RowEvent): Promise<void> {
    await this.entry(ports)
    await this.guard('capture', () => this.d.items.capture(ev), 'a row')
    await this.bus.emit('row', ev, ports)
  }

  async toolCall(ports: Ports, ev: ToolCallEvent): Promise<void> {
    await this.entry(ports)
    await this.bus.emit('toolCall', ev, ports)
  }

  async agentSpawn(ports: Ports, ev: AgentSpawnEvent): Promise<void> {
    await this.entry(ports)
    await this.bus.emit('agentSpawn', ev, ports)
  }

  async turnComplete(ports: Ports, ev: TurnCompleteEvent): Promise<void> {
    await this.entry(ports)
    await this.bus.emit('turnComplete', ev, ports)
  }

  /** A `/track <sub>` that core does not answer itself. Each tracker takes the subs it knows. */
  async command(ports: Ports, ev: CommandEvent): Promise<void> {
    await this.entry(ports)
    await this.bus.emit('command', ev, ports)
  }

  /** The x button: the dismiss list first, the item keys second, then the trackers hear of it (spec 8, 10.5). */
  async dismiss(ports: Ports, ids: readonly string[]): Promise<void> {
    await this.entry(ports)
    await this.d.dismiss(ports).add(ids)
    const gone = new Set(ids)
    await this.d.items.update(list => {
      const kept = list.filter(rec => !gone.has(rec.key))
      return kept.length === list.length ? list : kept
    })
    await this.bus.emit('dismissed', { ids }, ports)
  }

  /** Reads the transcript back and gives it to the item host and the bus, on a cold load (SwitchRunner). */
  replay(): Promise<void> {
    return this.switcher.replay()
  }

  /** Writes the session copy now (`claude -p` can exit right after the reply). */
  flushNow(): Promise<void> {
    return this.persistence.flushNow()
  }

  // ---------------------------------------------------------------- end, clear

  /**
   * `session.end`: stores the leaving session within `budgetMs` and keeps its snapshot for the switch. Run it before
   * `next(e)`. A failure is logged: the switch then carries from the stored copy. An exit reason disposes the trackers.
   * The reads of the id and the clock may fail too (a `$` call over its bound). The end then goes on with the last id
   * the watch saw and the wall clock, so the next switch still knows how the session left.
   */
  async end(ports: Ports, endReason: string, budgetMs: number): Promise<void> {
    await this.ensureStarted(ports) // an end can be the first hook of a load (a hot reload, then /clear)
    let id = this.watch.lastId
    let at = ports.clock.wall()
    try {
      await this.watch.check() // a switch no hook has seen yet is carried before this one is saved
      id = await ports.session.id()
      at = await ports.clock.now()
    } catch (e) {
      this.ports.log(`lifecycle: end could not read the session: ${reason(e)}`)
    }
    if (id !== undefined) {
      const pending: PendingEnd = { reason: endReason, fromId: id, at }
      let snapshot: Snapshot
      try {
        snapshot = await this.persistence.end(id, budgetMs, pending)
      } catch (e) {
        this.ports.log(`lifecycle: end of ${id} failed: ${reason(e)}`)
        snapshot = { from: id, slots: {} }
      }
      this.watch.ended(pending, snapshot)
    }
    if (EXITS.has(endReason)) {
      this.host.dispose()
      await this.guard('item dispose', async () => this.d.items.dispose(), 'the end')
    }
  }

  /** `/track clear`: older jobs stop writing, the persisted slots empty, the stored copy goes. Run-scoped slots stay (D10). */
  async clear(ports: Ports): Promise<void> {
    this.watch.bump()
    for (const slot of this.slots()) if (slot.persist) await slot.clear?.()
    await this.persistence.forget(await ports.session.id())
  }

  // ---------------------------------------------------------------- slots

  private slots(): readonly DataSlot[] {
    return [this.d.items.slot, ...(this.d.extraSlots ?? []), ...this.host.slots()]
  }

  private guard(what: string, step: () => Promise<unknown>, where = 'a switch'): Promise<void> {
    return guard(this.ports.log, what, step, where)
  }
}
