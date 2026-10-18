// A TrackerHost over fakePorts for the tests of the host and of the tracker list. No engine, no `$`.
// The watch is a plain counter: `gen` is the generation, `checks` counts the session checks that ran.
import { EventBus } from '../../core/infra/bus'
import { Facts } from '../../core/infra/facts'
import { GLOBAL_DEFAULTS } from '../../core/infra/global-defaults'
import { TrackerHost } from '../../core/infra/tracker-host'
import type { ItemStorePort, Json } from '../../core/interfaces/items'
import type { Tracker } from '../../core/interfaces/tracker'
import { fakePorts } from './ports'

export type Cfg = { enabled: boolean }

/** A tracker with the least a tracker needs. `extra` adds events, data and the rest. */
export function fake(id: string, order: number, extra: Partial<Tracker<Cfg, Json>> = {}): Tracker<Cfg, Json> {
  return {
    id,
    order,
    config: { defaults: { enabled: true }, normalise: (_raw, defaults) => defaults },
    init: () => {},
    store: ctx => ctx.config.slice(),
    ...extra,
  }
}

export function hostWorld(trackers: readonly Tracker<Cfg, Json>[] | readonly Tracker[], o: { due?: boolean } = {}) {
  const w = fakePorts()
  const facts = new Facts()
  const persisted: string[] = []
  const watch = {
    gen: 0,
    checks: 0,
    get generation() {
      return this.gen
    },
    async check() {
      this.checks++
      return false
    },
    async current() {
      await this.check()
      return this.gen
    },
  }
  const dismissed = new Set<string>()
  const items: ItemStorePort = {
    list: async () => [],
    update: async () => false,
    track: async () => {},
    refresh: () => {},
  }
  const dues: string[] = []
  const host = new TrackerHost({
    trackers,
    ports: w.ports,
    global: GLOBAL_DEFAULTS,
    facts,
    dismiss: { list: async () => dismissed, add: async () => {} },
    items,
    watch,
    due: (owner, everyMs) => {
      dues.push(`${owner}:${everyMs}`)
      return o.due ?? true
    },
    persisted: owner => void persisted.push(owner),
    log: w.ports.log,
  })
  const bus = new EventBus({ log: w.ports.log })
  return { w, host, bus, facts, watch, persisted, items, dues }
}
