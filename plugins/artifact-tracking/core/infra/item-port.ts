// The ItemStorePort a tracker sees (`ctx.items`): the list, the checked write, the claims, and the scan and build of the
// kinds. A thin join of the store and Capture; the ItemService hands it out for every owner.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.9 (the store port). Plan: L5 Task 8, K3.

import type { ItemStorePort } from '../interfaces/items'
import type { Capture } from './capture-runtime'
import type { ItemStore } from './item-store'

export function storePort(d: { store: ItemStore; capture: Capture }): ItemStorePort {
  return {
    list: () => d.store.list(),
    update: (change, opts) => d.store.update(change, opts),
    // A tracker's own claims make no sighting for a turn (issue #69): the answer of the store is dropped.
    track: async claims => void (await d.store.track(claims)),
    refresh: keys => d.store.refresh(keys),
    scan: (text, o) => d.capture.scan(text, o),
    build: claim => d.store.build(claim),
    cap: (list, keep) => d.store.capped(list, keep),
  }
}
