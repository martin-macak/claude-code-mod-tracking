// LifecycleManager: sequences the collaborators. The start sequence, the entry of every hook, `session.end`, the
// session switch, `/track clear`, the tick and the domain events. It builds SessionWatch, Persistence, Scheduler, Replay,
// the EventBus and the TrackerHost from the ports of the first hook of a load. It names no tracker and holds no `$`.
// `end` stores the leaving session and keeps a snapshot. The switch that follows carries it (`/clear`) or loads the
// stored copy of the new id (`/resume`).
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.6. Plan: L3 Tasks 5 to 8, D4 to D9, D20.

import type { GlobalConfig } from '../interfaces/config'
import type { AgentSpawnEvent, CommandEvent, RowEvent, ToolCallEvent, TurnCompleteEvent } from '../interfaces/events'
import type { ItemsHost, Json } from '../interfaces/items'
import type { Ports } from '../interfaces/ports'
import type { DataSlot, PendingEnd, RunCopy, Snapshot } from '../interfaces/slots'
import type { DismissPort, FactsPort, Tracker } from '../interfaces/tracker'
import { EventBus } from './bus'
import { Facts } from './facts'
import { Persistence } from './persistence'
import { Replay } from './replay'
import { Scheduler } from './scheduler'
import { SessionWatch, type Switch } from './session'
import { TrackerHost } from './tracker-host'

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

/** How a start was reached. `session.start` carries the cwd and loads the stored session; a lazy start does neither (D5). */
export type Launch = { cwd?: string; fromSessionStart: boolean }

/** `session.end` reasons after which the process goes away. `clear` and `resume` are switches. */
const EXITS: ReadonlySet<string> = new Set(['prompt_input_exit', 'logout', 'other'])

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export class LifecycleManager {
  readonly facts: FactsPort = new Facts()
  readonly watch: SessionWatch
  /** The session store. Public for the lifecycle tests; the hooks reach it through the manager only. */
  readonly persistence: Persistence
  private readonly scheduler: Scheduler
  private readonly bus: EventBus
  private readonly replayer: Replay
  private readonly host: TrackerHost
  /** The start sequence of this load. Set by the first start, lazy or from `session.start`. */
  private started: Promise<void> | undefined
  private starts = 0
  private swept = false

  constructor(
    private readonly d: LifecycleDeps,
    private readonly ports: Ports,
  ) {
    this.watch = new SessionWatch({
      id: () => ports.session.id(),
      onSwitch: sw => this.onSwitch(sw),
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
    this.replayer = new Replay({ messages: () => ports.session.messages(), log: ports.log })
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
      this.started = this.sequence(ports, launch)
      return this.started
    }
    return this.started.then(() => this.sequence(ports, launch))
  }

  /**
   * Every non-render entry waits for the start sequence, which runs once per load as a single flight. A hot reload
   * delivers `session.start` about 0.5 s late, so an event can come first. It does not load or replay (D5).
   */
  ensureStarted(ports: Ports): Promise<void> {
    this.started ??= this.sequence(ports, { fromSessionStart: false })
    return this.started
  }

  /**
   * The steps, in the order of spec 5.6 as D4 and D20 set it: the run record and the old layout, then the item
   * runtime and the trackers (the item restore needs the active Jira site, so init comes before the session load),
   * the start event, the session load, the tick and the pane. Nothing in here may call `entry` or `ensureStarted`.
   */
  private async sequence(ports: Ports, launch: Launch): Promise<void> {
    const first = this.starts++ === 0
    const run = await this.soft('run load', () => this.persistence.loadRun(), {} as RunCopy)
    if (!this.swept) {
      this.swept = true // set first: a sweep that throws is not tried again in this load
      await this.soft('legacy sweep', () => this.persistence.dropLegacy(), 0)
    }
    const cold = await this.soft('items read', () => this.itemsEmpty(), false)
    await this.soft('item runtime', () => this.d.items.start(this.host.hostCtx(ports)), undefined)
    await this.soft('tracker init', () => this.host.init(), undefined)
    await this.soft('bus fill', async () => this.host.fill(this.bus), undefined)
    await this.bus.emit('start', { ...(launch.cwd !== undefined ? { cwd: launch.cwd } : {}), cold }, ports)
    await this.soft('session load', () => this.begin(ports, launch, run, first), undefined)
    await this.scheduler.ensure()
    await this.reattach(ports)
  }

  /**
   * Learns the session id and, on a cold `session.start`, loads the stored copy and replays the transcript. A
   * `pendingEnd` that a reload left behind makes the first start carry the session that ended (D20).
   */
  private async begin(ports: Ports, launch: Launch, run: RunCopy, first: boolean): Promise<void> {
    const id = await ports.session.id()
    const pending = run.pendingEnd
    if (first && pending && (await this.honours(ports, pending, id))) {
      this.watch.resumeFrom(pending)
      await this.watch.check()
      return
    }
    if (this.watch.lastId === undefined) this.watch.seed(id)
    else if (await this.watch.check()) return // a switch moved the data already
    if (launch.fromSessionStart && (await this.itemsEmpty())) await this.loadSession(id, 'the start')
  }

  /** A pending end counts when it was a `/clear` or `/resume` of another id, not older than two ticks (D20). */
  private async honours(ports: Ports, pending: PendingEnd, id: string): Promise<boolean> {
    if (pending.reason !== 'clear' && pending.reason !== 'resume') return false
    if (pending.fromId === id) return false
    return (await ports.clock.now()) - pending.at <= 2 * this.d.global.refresh.tickMs
  }

  /** The persisted slots from the stored copy of `id`, then the transcript. */
  private async loadSession(id: string, where: string): Promise<void> {
    const stored = await this.persistence.read(id)
    for (const slot of this.slots().filter(s => s.persist)) {
      const value = stored?.[slot.id]
      if (value !== undefined) await this.guard(slot.id, () => slot.restore(value, 'load'), where)
    }
    // The transcript fills in what the stored copy lacks, whether or not there was a copy (D7).
    await this.guard('replay', () => this.replay(), where)
  }

  /** The engine keeps a pane across a hot reload. Draw it again. */
  private async reattach(ports: Ports): Promise<void> {
    try {
      if ((await ports.ui.panes()).some(p => p.id === this.d.paneId)) ports.ui.invalidate()
    } catch {
      // A pane that cannot be listed is drawn by the next event.
    }
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

  /**
   * Reads the transcript back and gives it to the item host and the bus, on a cold load. It writes through the raw
   * paths, so it may run inside a switch. Nothing in the batch is a live row: capture and the row handlers skip it.
   */
  async replay(): Promise<void> {
    const batch = await this.replayer.collect()
    await this.d.items.replay(batch)
    await this.bus.emit('replay', batch, this.ports)
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

  // ---------------------------------------------------------------- switch

  private slots(): readonly DataSlot[] {
    return [this.d.items.slot, ...(this.d.extraSlots ?? []), ...this.host.slots()]
  }

  /**
   * The switch. Every step writes through the raw paths and never calls `watch.check()`: that is single flight and
   * would wait for this switch (Review Focus 2). A failing step is logged and the next one still runs. The item host
   * hears of the switch first, so it forgets what belonged to the old session (the repo) before a load or the replay
   * looks it up for the new one. A reset after the load would throw that lookup away.
   */
  private async onSwitch(sw: Switch): Promise<void> {
    const ev = { from: sw.from, to: sw.to, kind: sw.kind }
    await this.guard('sessionChanged', () => this.d.items.sessionChanged(ev))
    const slots = this.slots()
    const run = (await this.persistence.loadRun()).run ?? {}
    // The run-scoped slots go first: the dismiss list and the proofs must be there before an item loads (D9). `v2:run`
    // stands in only when this load saw no end (the reload gap). After an end the snapshot is the whole truth: a
    // `v2:run` that an earlier process left must not reach a slot the snapshot holds nothing for.
    for (const slot of slots)
      if (!slot.persist) await this.carry(slot, sw.snapshot ? sw.snapshot.slots[slot.id] : run[slot.id])
    const persisted = slots.filter(slot => slot.persist)
    if (sw.kind === 'clear') {
      const from = await this.persistence.read(sw.from)
      for (const slot of persisted) await this.carry(slot, sw.snapshot?.slots[slot.id] ?? from?.[slot.id])
    } else if (await this.itemsEmpty()) {
      // A resume loads the stored copy of the new id. A session that already holds items keeps them (a reload kept its state).
      await this.loadSession(sw.to, 'a switch')
    }
    await this.bus.emit('sessionChanged', ev, this.ports)
    await this.guard('clearRun', () => this.persistence.clearRun())
  }

  private async carry(slot: DataSlot, value: Json | undefined): Promise<void> {
    if (value !== undefined) await this.guard(slot.id, () => slot.restore(value, 'carry'))
  }

  /** True when the items slot holds nothing: a cold load. */
  private async itemsEmpty(): Promise<boolean> {
    const items = this.d.items.slot
    return items.empty(await items.read())
  }

  private async guard(what: string, step: () => Promise<unknown>, where = 'a switch'): Promise<void> {
    try {
      await step()
    } catch (e) {
      this.ports.log(`lifecycle: ${what} failed in ${where}: ${reason(e)}`)
    }
  }

  /** A step of the start sequence: a failure is logged and the fallback stands in, so the start always completes. */
  private async soft<T>(what: string, step: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await step()
    } catch (e) {
      this.ports.log(`lifecycle: ${what} failed in the start: ${reason(e)}`)
      return fallback
    }
  }
}
