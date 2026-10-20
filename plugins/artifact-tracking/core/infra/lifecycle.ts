// LifecycleManager: sequences the collaborators. It owns the single flight of the start, the entry of every hook,
// `session.end`, `/track clear`, the tick and the domain events. The steps of the start live in StartSequence and the
// steps of a session switch in SwitchRunner. It builds SessionWatch, Persistence, Scheduler, Replay, the EventBus and
// the TrackerHost from the ports of the first hook of a load. It names no tracker and holds no `$`.
// `end` keeps a snapshot of the leaving session. The switch that follows carries it (`/clear`) or loads the stored copy
// of the new id (`/resume`).
// Without an item host of its own it builds the ItemService after the TrackerHost, whose `live` the service reads.
// `/track` is routed by Commands (core/infra/commands.ts), `session.end` by SessionEnd, the pane is read by Views
// and its keys are served by PaneKeys (the manager extends PaneApi, which hands both their calls). The parts the
// constructor wires are in lifecycle-parts.ts.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.6. Plan: L3 Tasks 5 to 8, D4 to D9, D20.
// L5 Tasks 9 and 13, K15, K19. L7 Task 6: PromptRebuild keeps the prompt text (S1, S2, S14).

import type { ConfigService, ConfigSource } from '../interfaces/config'
import type { AgentSpawnEvent, CommandEvent, RowEvent, ToolCallEvent, TurnCompleteEvent } from '../interfaces/events'
import type { ItemsHost, Level } from '../interfaces/items'
import type { Ports } from '../interfaces/ports'
import type { DataSlot } from '../interfaces/slots'
import type { DismissPort, FactsPort, Tracker } from '../interfaces/tracker'
import { EventBus } from './bus'
import type { Commands } from './commands'
import { Facts } from './facts'
import { commandsOf, configRefresher, itemHostOf, persistenceOf, schedulerOf } from './lifecycle-parts'
import { PaneApi } from './pane-api'
import { PaneKeys } from './pane-keys'
import type { Persistence } from './persistence'
import { PromptRebuild } from './prompt-rebuild'
import { Replay } from './replay'
import type { Scheduler } from './scheduler'
import { SessionWatch } from './session'
import { SessionEnd } from './session-end'
import { type Launch, StartSequence } from './start-sequence'
import { guard } from './steps'
import { SwitchRunner } from './switch-runner'
import { TrackerHost } from './tracker-host'
import { Views } from './views'

export type { Launch } from './start-sequence'

export interface LifecycleDeps {
  trackers: readonly Tracker[]
  /** The item host: its list is the `items` slot; it owns capture, replay and its beat. Absent: an ItemService. */
  items?: ItemsHost
  /** Slots that no tracker owns. register.tsx passes none (L3 Task 10); the lifecycle tests run a switch over fakes. */
  extraSlots?: readonly DataSlot[]
  /** The run-scoped dismiss list over the ports of a dispatch. It reads its limit from the config. */
  dismiss(ports: Ports, config: ConfigSource): DismissPort
  /** The config file's manager, built once over the ports of the first hook of the load. */
  config(ports: Ports): ConfigService
  /** The pane the start sequence reattaches when the engine kept it across a hot reload. */
  paneId: string
  /** The tracking list for `/track` (the draw path is not core). Absent: no list text. The router adds the problems. */
  listText?(ports: Ports): Promise<string>
  /** The help view as text, for `/track help`. Absent: the reply holds no text. */
  helpText?(ports: Ports): Promise<string>
}

export class LifecycleManager extends PaneApi {
  readonly facts: FactsPort = new Facts({ onChange: ev => void this.bus.emit('fact', ev, this.ports) })
  readonly watch: SessionWatch
  /** The session store. Public for the lifecycle tests; the hooks reach it through the manager only. */
  readonly persistence: Persistence
  /** The item host of this load: the one the deps gave, else the ItemService the manager built. */
  readonly items: ItemsHost
  /** The router of `/track`. The hook asks it for the answer and for the argument hint. */
  readonly commands: Commands
  private readonly cfg: ConfigService
  private readonly scheduler: Scheduler
  private readonly bus: EventBus
  private readonly prompt: PromptRebuild
  private readonly host: TrackerHost
  private readonly switcher: SwitchRunner
  private readonly sequence: StartSequence
  private readonly ending: SessionEnd
  /** Checks the config file; when it changed, re-arms the tick, redraws the pane, rebuilds the prompt. Never rejects. */
  readonly refreshConfig: (ports: Ports) => Promise<boolean>
  /** The `prompt.compose` call: sync, no ports, never throws. The text is rebuilt at the boundaries (PromptRebuild). */
  readonly compose: PromptRebuild['compose'] = (...a) => this.prompt.compose(...a)
  protected readonly views: Views
  protected readonly paneKeys: PaneKeys
  /** The start sequence of this load. Set by the first start, lazy or from `session.start`. */
  private started: Promise<void> | undefined
  private manifestVersion: string | undefined

  constructor(
    private readonly d: LifecycleDeps,
    private readonly ports: Ports,
  ) {
    super()
    this.cfg = d.config(ports)
    this.prompt = new PromptRebuild(this, { trackers: d.trackers, log: ports.log })
    // Read per call, never held: a changed file shows on the next read.
    const g = () => this.cfg.global()
    this.watch = new SessionWatch({
      id: () => ports.session.id(),
      onSwitch: sw => this.switcher.run(sw).then(() => this.prompt.rebuild(ports)),
      log: ports.log,
    })
    this.scheduler = schedulerOf(ports, this.cfg, () => this.tick())
    this.refreshConfig = this.prompt.afterRefresh(configRefresher(this.cfg, this.scheduler))
    this.bus = new EventBus({ log: ports.log })
    this.persistence = persistenceOf(ports, this.cfg, this.watch, () => this.slots())
    const dismiss = d.dismiss(ports, this.cfg)
    this.items = itemHostOf(d.items, {
      trackers: d.trackers,
      config: this.cfg,
      facts: this.facts,
      dismiss,
      watch: this.watch,
      persistence: this.persistence,
      host: () => this.host,
      ports,
    })
    this.switcher = new SwitchRunner({
      items: this.items,
      persistence: this.persistence,
      bus: this.bus,
      replayer: new Replay({ messages: () => ports.session.messages(), log: ports.log }),
      slots: () => this.slots(),
      ports,
    })
    this.host = new TrackerHost({
      trackers: d.trackers,
      ports,
      config: this.cfg,
      facts: this.facts,
      dismiss,
      items: this.items,
      itemsOf: owner => this.items.port(owner),
      toolsOf: owner => this.items.tools(owner),
      watch: this.watch,
      due: (owner, everyMs, now) => this.scheduler.due(owner, everyMs, now),
      persisted: () => void this.persistence.touch(),
      log: ports.log,
    })
    this.views = new Views({
      trackers: d.trackers,
      config: this.cfg,
      facts: this.facts,
      dismiss: p => d.dismiss(p, this.cfg),
      levels: list => this.items.levels(list),
      live: id => this.host.live(id),
      log: ports.log,
    })
    this.paneKeys = new PaneKeys({
      trackers: d.trackers,
      host: this.host,
      views: this.views,
      kinds: this.items,
      log: ports.log,
    })
    this.sequence = new StartSequence({
      items: this.items,
      persistence: this.persistence,
      host: this.host,
      keys: this.paneKeys,
      bus: this.bus,
      watch: this.watch,
      scheduler: this.scheduler,
      switcher: this.switcher,
      after: p => this.prompt.rebuild(p),
      config: this.cfg,
      paneId: d.paneId,
      tickMs: () => g().refresh.tickMs,
      setVersion: v => {
        this.manifestVersion = v
      },
      ports,
    })
    this.ending = new SessionEnd({
      started: p => this.ensureStarted(p, { reconcile: false }),
      watch: this.watch,
      persistence: this.persistence,
      host: this.host,
      items: this.items,
      log: ports.log,
    })
    this.commands = commandsOf(this, { items: this.items, host: this.host, bus: this.bus, config: this.cfg }, d)
  }

  get generation(): number {
    return this.watch.generation
  }

  /** The config file's views. The hooks read them here, never from the manager that owns the file. */
  get config(): ConfigSource {
    return this.cfg
  }

  /** The version of the mod from its manifest. Set once, by the first start of this load: `undefined` before that. */
  get version(): string | undefined {
    return this.manifestVersion
  }

  /** True unless the config turned the tracker off at the first start of this load, or it failed to start. */
  live(id: string): boolean {
    return this.host.live(id)
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
   * `reconcile: false` is for `session.end`: a lazy start there reads the config file and never writes it (C16).
   */
  ensureStarted(ports: Ports, o: { reconcile?: boolean } = {}): Promise<void> {
    this.started ??= this.sequence.run(ports, { fromSessionStart: false, reconcile: o.reconcile ?? true })
    return this.started
  }

  // ---------------------------------------------------------------- entry, tick, events

  /** The first step of every hook that touches session data: the start (once per load), the session check, the tick. */
  async entry(ports: Ports): Promise<void> {
    await this.ensureStarted(ports)
    await this.watch.check()
    await this.scheduler.ensure()
  }

  /** One beat of the tick: the config file, a new session id, the item host's share, then the trackers'. */
  async tick(): Promise<void> {
    await this.ensureStarted(this.ports)
    await this.refreshConfig(this.ports)
    try {
      await this.watch.check()
    } catch {
      // The beat still does what it can.
    }
    await this.guard('item tick', () => this.items.tick(), 'a beat')
    await this.bus.emit('tick', { now: await this.ports.clock.now() }, this.ports)
  }

  /** True when a tracker declared a `toolCall` handler for the tool, or a kind reads it. Static: it needs no start. */
  wants(tool: string): boolean {
    return (
      this.d.trackers.some(t => t.events?.toolCall !== undefined && Object.hasOwn(t.events.toolCall, tool)) ||
      this.items.wants(tool)
    )
  }

  /** A row was appended: capture first (the item host), then the handlers of the declared doors. */
  async row(ports: Ports, ev: RowEvent): Promise<void> {
    await this.entry(ports)
    await this.guard('capture', () => this.items.capture(ev), 'a row')
    await this.bus.emit('row', ev, ports)
  }

  /** A finished tool call: the kinds that read the tool (the item host), then the handlers of the trackers. */
  async toolCall(ports: Ports, ev: ToolCallEvent): Promise<void> {
    await this.entry(ports)
    await this.guard('item toolCall', () => this.items.toolCall(ev, this.host.hostCtx(ports)), 'a tool call')
    await this.bus.emit('toolCall', ev, ports)
  }

  async agentSpawn(ports: Ports, ev: AgentSpawnEvent): Promise<void> {
    await this.entry(ports)
    await this.bus.emit('agentSpawn', ev, ports)
  }

  async turnComplete(ports: Ports, ev: TurnCompleteEvent): Promise<void> {
    await this.entry(ports)
    await this.bus.emit('turnComplete', ev, ports)
    await this.prompt.afterTurn(ports, ev)
  }

  /** `/track <args>`: the Commands router answers it. A failure rejects. */
  track(ports: Ports, args: string): Promise<{ text: string }> {
    return this.commands.run(ports, args)
  }

  /** A `/track <sub>` for the trackers: the broadcast of the router. Each tracker takes the subs it knows. */
  async command(ports: Ports, ev: CommandEvent): Promise<void> {
    await this.entry(ports)
    await this.bus.emit('command', ev, ports)
  }

  /** The x button: the dismiss list first, the item keys second, the trackers hear of it, the prompt text drops it. */
  async dismiss(ports: Ports, ids: readonly string[]): Promise<void> {
    await this.entry(ports)
    await this.d.dismiss(ports, this.cfg).add(ids)
    const gone = new Set(ids)
    await this.items.update(list => {
      const kept = list.filter(rec => !gone.has(rec.key))
      return kept.length === list.length ? list : kept
    })
    await this.bus.emit('dismissed', { ids }, ports)
    await this.prompt.rebuild(ports)
  }

  // ---------------------------------------------------------------- the pane (its reads and keys come from PaneApi)

  /** The person's mark on a row; `undefined` removes it. `top` is a rule's and does nothing. The prompt follows. */
  async setPriority(ports: Ports, rowId: string, level: Level | undefined): Promise<void> {
    await this.entry(ports)
    await this.items.setPriority(rowId, level)
    await this.prompt.rebuild(ports)
  }

  /** The Refresh key: the item host refreshes at once and the trackers hear `manual`, with no wait. */
  async refreshManual(ports: Ports): Promise<void> {
    await this.entry(ports)
    this.items.kick('manual')
    await this.command(ports, { sub: 'manual', args: '', wait: false })
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

  /** `session.end`: stores the leaving session, keeps its snapshot, drops the prompt text. Run it before `next(e)`. */
  end(ports: Ports, endReason: string, budgetMs: number): Promise<void> {
    return this.ending.run(ports, endReason, budgetMs).finally(() => this.prompt.reset())
  }

  /** `/track clear`: older jobs stop writing, the slots empty, the stored copy goes, the prompt text follows (D10). */
  async clear(ports: Ports): Promise<void> {
    this.watch.bump()
    for (const slot of this.slots()) if (slot.persist) await slot.clear?.()
    await this.persistence.forget(await ports.session.id())
    await this.prompt.rebuild(ports)
  }

  // ---------------------------------------------------------------- slots

  private slots(): readonly DataSlot[] {
    return [this.items.slot, ...(this.d.extraSlots ?? []), ...this.host.slots()]
  }

  private guard(what: string, step: () => Promise<unknown>, where = 'a switch'): Promise<void> {
    return guard(this.ports.log, what, step, where)
  }
}
