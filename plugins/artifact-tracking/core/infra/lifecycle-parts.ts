// The parts the LifecycleManager hands to the collaborators it builds: the item host (the ItemService, unless a host was
// given), the host of the `/track` router, the Persistence and the Scheduler. They sit here so the manager's constructor
// only wires; each one reads the manager and the other parts lazily, because the parts are built in an order in which one
// needs another.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.6. Plan: L5 Tasks 8 and 9, K15, K19.

import type { ConfigService, ConfigSource } from '../interfaces/config'
import type { CommandEvent } from '../interfaces/events'
import type { ItemsHost } from '../interfaces/items'
import type { Ports } from '../interfaces/ports'
import type { DataSlot } from '../interfaces/slots'
import type { DismissPort, FactsPort, Tracker } from '../interfaces/tracker'
import type { EventBus } from './bus'
import type { CommandHost } from './commands'
import { ItemService } from './items'
import { Persistence } from './persistence'
import { Scheduler } from './scheduler'
import type { SessionWatch } from './session'
import { reason } from './steps'
import type { TrackerHost } from './tracker-host'

/** What the item host reads of the parts built after it. */
export type ItemHostWiring = {
  trackers: readonly Tracker[]
  config: ConfigSource
  facts: FactsPort
  dismiss: DismissPort
  watch: SessionWatch
  persistence: Persistence
  /** The TrackerHost does not exist yet when the item host is built: the service reads `live` from it at call time. */
  host(): TrackerHost
  ports: Ports
}

/** The item host the deps gave, else the ItemService over the trackers. */
export function itemHostOf(given: ItemsHost | undefined, w: ItemHostWiring): ItemsHost {
  return (
    given ??
    new ItemService({
      trackers: w.trackers,
      live: id => w.host().live(id),
      config: w.config,
      facts: w.facts,
      dismiss: w.dismiss,
      watch: w.watch,
      persisted: () => void w.persistence.touch(),
      state: w.ports.state,
      log: w.ports.log,
    })
  )
}

/** The calls of the manager that the router makes. */
export interface CommandOwner {
  entry(p: Ports): Promise<void>
  command(p: Ports, ev: CommandEvent): Promise<void>
  clear(p: Ports): Promise<void>
  flushNow(): Promise<void>
  refreshConfig(p: Ports): Promise<boolean>
}

/** The host of the `/track` router: the manager's calls, the declared sub-commands of the live trackers, and the pane. */
export function commandHostOf(
  m: CommandOwner,
  w: { items: ItemsHost; host: TrackerHost; bus: EventBus; config: ConfigSource },
): CommandHost {
  return {
    entry: p => m.entry(p),
    items: w.items,
    broadcast: (p, ev) => m.command(p, ev),
    declared: () => w.host.commands(),
    runDeclared: async (p, owner, ev) => {
      await m.entry(p)
      await w.bus.emit('command', ev, p, owner)
    },
    openPane: async p => {
      if (!(await p.ui.open())) p.ui.toast('Widen the terminal to see the tracking pane')
    },
    clear: p => m.clear(p),
    flushNow: () => m.flushNow(),
    refreshConfig: p => m.refreshConfig(p),
    config: w.config,
  }
}

/** The session store over the ports. A flush is an entry: a `/clear` since the last change is carried first. */
export function persistenceOf(
  ports: Ports,
  config: ConfigSource,
  watch: Pick<SessionWatch, 'check'>,
  slots: () => readonly DataSlot[],
): Persistence {
  const g = () => config.global() // read per call: a changed file shows on the next read
  return new Persistence({
    store: ports.store,
    clock: ports.clock,
    sessionId: () => ports.session.id(),
    slots,
    limits: () => ({
      flushMs: g().refresh.flushMs,
      keepSessions: g().store.keepSessions,
      maxBytes: g().store.maxBytes,
    }),
    beforeFlush: async () => {
      await watch.check()
    },
    log: ports.log,
  })
}

/** The tick over the ports: `beat` runs once per `refresh.tickMs`. */
export function schedulerOf(ports: Ports, config: ConfigSource, beat: () => Promise<void>): Scheduler {
  return new Scheduler({
    now: () => ports.clock.now(),
    every: (ms, fn) => ports.clock.every(ms, fn),
    periodMs: () => config.global().refresh.tickMs,
    beat,
    log: ports.log,
  })
}

/**
 * Checks the config file and, when it changed, re-arms the tick (a new `tickMs`) and redraws the pane (a toggle, a
 * problem). Never rejects: a failure is logged and counts as no change. The file is read when its signature moved.
 */
export function configRefresher(
  config: Pick<ConfigService, 'refresh'>,
  scheduler: Pick<Scheduler, 'ensure'>,
): (ports: Ports) => Promise<boolean> {
  return async ports => {
    try {
      const changed = await config.refresh()
      if (changed) {
        await scheduler.ensure()
        ports.ui.invalidate()
      }
      return changed
    } catch (e) {
      ports.log(`config: refresh failed: ${reason(e)}`)
      return false
    }
  }
}
