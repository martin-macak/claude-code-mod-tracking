// The members of an item host that a test double of `ItemsHost` rarely needs: they do nothing and answer nothing.
// A stub spreads it first and lists the members it cares about after it. `port` hands back the host itself.
import type { ItemStorePort, ItemsHost } from '../../core/interfaces/items'
import { NO_SIGHTINGS } from '../../core/lib/turn-entries'

export const IDLE_ITEMS: Pick<
  ItemsHost,
  | 'ready'
  | 'capture'
  | 'toolCall'
  | 'wants'
  | 'problems'
  | 'prepare'
  | 'settle'
  | 'kick'
  | 'refreshAll'
  | 'setPriority'
  | 'setPriorities'
  | 'rowIdOf'
  | 'levels'
  | 'port'
  | 'tools'
  | 'scan'
  | 'build'
> = {
  ready: true,
  capture: async () => NO_SIGHTINGS,
  toolCall: async () => NO_SIGHTINGS,
  wants: () => false,
  problems: () => [],
  prepare: async () => {},
  settle: async () => {},
  kick: () => {},
  refreshAll: async () => {},
  setPriority: async () => false,
  setPriorities: async () => false,
  rowIdOf: async () => undefined,
  levels: async () => new Map(),
  port(this: ItemStorePort) {
    return this
  },
  tools: () => undefined,
  scan: () => [],
  build: () => null,
}
