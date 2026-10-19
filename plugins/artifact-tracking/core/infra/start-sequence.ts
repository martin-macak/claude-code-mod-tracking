// StartSequence: the steps of the start of a load, in the order of spec 5.6 as D4 and D20 set it. It runs once per
// `session.start` and once for a lazy start. The LifecycleManager owns the single flight; this class owns the steps and the
// two once-per-load facts (the first start, the legacy sweep). It names no tracker and holds no `$`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.6 (Start sequence). Plan: L3 Task 5, D4, D5, D20.

import type { ConfigService } from '../interfaces/config'
import type { ItemsHost } from '../interfaces/items'
import type { Ports } from '../interfaces/ports'
import type { PendingEnd, RunCopy } from '../interfaces/slots'
import type { EventBus } from './bus'
import type { Persistence } from './persistence'
import type { Scheduler } from './scheduler'
import type { SessionWatch } from './session'
import { soft } from './steps'
import type { SwitchRunner } from './switch-runner'
import type { TrackerHost } from './tracker-host'

/**
 * How a start was reached. `session.start` carries the cwd and loads the stored session; a lazy start does neither (D5).
 * `reconcile: false` skips the config write of this run. `session.end` sets it for its lazy start (C16).
 */
export type Launch = { cwd?: string; fromSessionStart: boolean; reconcile?: boolean }

/**
 * What the first start of a load made of the `pendingEnd` that an earlier load left in `v2:run` (D20). `carried`: the
 * switch it names is honoured. `awaited`: it is a recent end of the id that is still current, so the reload came before
 * the id flipped, and the flip may still come in this load with no snapshot (the reload gap). `stale`: it is nothing.
 */
type RunFate = 'carried' | 'awaited' | 'stale'

export interface StartDeps {
  items: ItemsHost
  persistence: Persistence
  host: TrackerHost
  /** The pane keys: rebuilt right after the trackers ran `init`, so a tracker that is off or failed adds none. */
  keys: { rebuild(): void }
  bus: EventBus
  watch: SessionWatch
  scheduler: Scheduler
  /** The session load and the cold test are shared with the switch. */
  switcher: SwitchRunner
  /** The last step of every start, after the session load and the pane: the prompt text is built over the loaded items. */
  after(ports: Ports): Promise<unknown>
  /** The config file: read first, written once per load after the trackers stored their slices. */
  config: ConfigService
  /** The pane the sequence reattaches when the engine kept it across a hot reload. */
  paneId: string
  /** The tick period: a pending end counts when it is not older than two of them. */
  tickMs(): number
  /** The ports of the first hook of the load. */
  ports: Ports
}

export class StartSequence {
  private starts = 0
  private swept = false

  constructor(private readonly d: StartDeps) {}

  /**
   * The steps: the config file, the run record and the old layout, then the item host and the trackers (the item
   * restore needs the site a tool acts on, so init comes before the session load), the config write, the start event, the
   * session load, the tick and the pane. Nothing in here may call `entry` or `ensureStarted`. A failing step is logged
   * and the sequence goes on.
   */
  async run(ports: Ports, launch: Launch): Promise<void> {
    const { items, persistence, host, bus, scheduler, config } = this.d
    const first = this.starts++ === 0
    // The toggles and the limits of this load come from the file, so it is read before anything else uses them.
    await this.soft('config refresh', () => config.refresh(), false)
    await this.soft('toggles', async () => host.readToggles(), undefined) // once per load; the item host asks first
    const run = await this.soft('run load', () => persistence.loadRun(), {} as RunCopy)
    if (!this.swept) {
      this.swept = true // set first: a sweep that throws is not tried again in this load
      await this.soft('legacy sweep', () => persistence.dropLegacy(), 0)
    }
    const cold = await this.soft('items read', () => this.d.switcher.itemsEmpty(), false)
    await this.soft('item runtime', () => items.start(host.hostCtx(ports)), undefined)
    await this.soft('tracker init', () => host.init(), undefined)
    await this.soft('pane keys', async () => this.d.keys.rebuild(), undefined)
    // The store phase is done: the first run writes the defaults, an upgrade adds the missing keys. Once per load.
    if (launch.reconcile !== false) await this.soft('config write', () => config.reconcile(host.stored()), undefined)
    await this.soft('bus fill', async () => host.fill(bus), undefined)
    await bus.emit('start', { ...(launch.cwd !== undefined ? { cwd: launch.cwd } : {}), cold }, ports)
    const fate = await this.soft<RunFate | undefined>(
      'session load',
      () => this.begin(ports, launch, run, first),
      undefined,
    )
    // The first start of a load that carries no pending end, and awaits none, has nothing to carry: what `v2:run` holds
    // is an older process's, and a switch with no snapshot must not take it for this session's. A start whose session
    // load failed (no fate) leaves it: the end may have been honourable.
    if (first && fate === 'stale') await this.soft('stale run', () => persistence.dropRun(run), undefined)
    await scheduler.ensure()
    await this.reattach(ports)
    await this.soft('prompt text', () => this.d.after(ports), undefined)
  }

  /**
   * Learns the session id and, on a cold `session.start`, loads the stored copy and replays the transcript. A
   * `pendingEnd` that a reload left behind makes the first start carry the session that ended (D20). Resolves to what
   * the first start made of that record.
   */
  private async begin(ports: Ports, launch: Launch, run: RunCopy, first: boolean): Promise<RunFate> {
    const { watch, switcher } = this.d
    const id = await ports.session.id()
    const pending = run.pendingEnd
    const fate = first && pending ? await this.judge(ports, pending, id) : 'stale'
    if (fate === 'carried' && pending) {
      watch.resumeFrom(pending)
      await watch.check()
      return fate
    }
    if (watch.lastId === undefined) watch.seed(id)
    else if (await watch.check()) return 'stale' // a switch moved the data already
    if (launch.fromSessionStart && (await switcher.itemsEmpty())) await switcher.loadSession(id, 'the start')
    return fate
  }

  /**
   * A pending end counts when it was a `/clear` or `/resume`, not older than two ticks (D20). Of another id than the
   * current one it is carried. Of the current id it is awaited: the end ran in the last load, and the id has not flipped.
   */
  private async judge(ports: Ports, pending: PendingEnd, id: string): Promise<RunFate> {
    if (pending.reason !== 'clear' && pending.reason !== 'resume') return 'stale'
    const recent = (await ports.clock.now()) - pending.at <= 2 * this.d.tickMs()
    if (!recent) return 'stale'
    return pending.fromId === id ? 'awaited' : 'carried'
  }

  /** The engine keeps a pane across a hot reload. Draw it again. */
  private async reattach(ports: Ports): Promise<void> {
    try {
      if ((await ports.ui.panes()).some(p => p.id === this.d.paneId)) ports.ui.invalidate()
    } catch {
      // A pane that cannot be listed is drawn by the next event.
    }
  }

  private soft<T>(what: string, step: () => Promise<T>, fallback: T): Promise<T> {
    return soft(this.d.ports.log, what, step, fallback)
  }
}
