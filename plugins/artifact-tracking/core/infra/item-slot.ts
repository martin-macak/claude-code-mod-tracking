// The `items` slot: how Persistence stores the list and a session switch carries it. `settle` puts the stored copy under
// the live list, `restore('carry')` joins the list of the leaving session, `restore('load')` takes a stored copy back
// through the filters of the kinds, `clear` empties it. The merges are the generic ones of `core/lib/records.ts`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.6 and 5.9. Plan: L5 Task 8, L3 D6, D9.

import type { Json, StoredItem } from '../interfaces/items'
import type { DataSlot } from '../interfaces/slots'
import type { DismissPort } from '../interfaces/tracker'
import { AUTO_SOURCES, carryOver, dropAuto, migrateRecords, unionRecords } from '../lib/records'
import type { ItemStore } from './item-store'
import type { Kinds } from './kinds'

export type SlotDeps = {
  kinds: Kinds
  dismiss: DismissPort
  /** `global.store.maxItems`. */
  cap(): number
  /** A load of a stored copy begins: let the lookups of the kinds start now, so they are ready when the load ends. */
  loading(): void
  /** A load put items in the list: finish what needs the session, then refresh. */
  loaded(): void
}

/** A stored record comes back due: its status stays for display, its refresh time goes. */
function due(rec: StoredItem): StoredItem {
  const out = { ...rec }
  delete out.refreshedAt
  return out
}

/** A stored copy comes back without auto sources: a new process has no proofs, so the first complete PR step adds back what is still tracked. */
function withoutAuto(list: StoredItem[]): StoredItem[] {
  const keys = new Set(
    list.filter(r => r.via !== undefined || r.sources.some(s => AUTO_SOURCES.has(s))).map(r => r.key),
  )
  return dropAuto(list, keys)
}

export function itemSlot(store: ItemStore, d: SlotDeps): DataSlot {
  const { kinds } = d

  /** The stored copy under the live list, less the dismissed keys, and old web rows of artifact URLs moved (R13). */
  async function settle(live: StoredItem[] | undefined, stored: StoredItem[] | undefined): Promise<Json> {
    // The stored copy can predate the last presses: an item the person dismissed since, or a mark they changed (D6).
    const dismissed = await d.dismiss.list()
    const kept = (stored ?? []).filter(rec => !dismissed.has(rec.key))
    return migrateRecords(carryOver(live ?? [], kept, kinds.table, d.cap()), kinds.all) as unknown as Json
  }

  /** `carry`: the list of the leaving session joins the live one. Records of a kind that is off stay out. */
  async function carry(value: StoredItem[]): Promise<void> {
    const kept = kinds.onlyOn(value)
    if (kept.length > 0) await store.set(cur => unionRecords(kept, cur, kinds.table, d.cap()))
  }

  /**
   * `load`: the stored copy of a `--resume` load or a /resume switch. Artifact rows are re-keyed, auto sources dropped,
   * each live kind filters its own records (`restore`: tool-only sightings off the site its tool acts on), and not-found items and dismissed
   * keys stay out. Every record comes back due. The transcript is not read here: Replay hands it over after the load.
   */
  async function load(stored: StoredItem[]): Promise<void> {
    d.loading()
    const dismissed = await d.dismiss.list()
    let list = kinds.onlyOn(withoutAuto(migrateRecords(stored, kinds.all)))
    // Every live kind with a `restore` is asked, also with no record of its own: it may learn what it needs first.
    for (const kind of kinds.liveKinds()) {
      if (!kind.restore) continue
      const own = list.flatMap(rec => kind.decode(rec) ?? [])
      const ctx = kinds.context(kind, { source: 'load', mode: 'full', purpose: 'capture' })
      const kept = new Set(await kind.restore(own, ctx))
      list = list.filter(
        rec => rec.category !== kind.category || kind.decode(rec) === null || kept.has(kind.decode(rec)!),
      )
    }
    list = list
      .filter(rec => (rec.error as { kind?: string } | undefined)?.kind !== 'not-found' && !dismissed.has(rec.key))
      .map(due)
    if (list.length === 0) return
    await store.set(cur => unionRecords(cur, list, kinds.table, d.cap()))
    d.loaded()
  }

  return {
    id: 'items',
    persist: true,
    read: async () => (await store.list()) as unknown as Json,
    empty: v => !Array.isArray(v) || v.length === 0,
    settle: (live, stored) => settle(live as unknown as StoredItem[], stored as unknown as StoredItem[]),
    restore: (value, how) =>
      how === 'load' ? load(value as unknown as StoredItem[]) : carry(value as unknown as StoredItem[]),
    clear: () => store.set(() => []),
  }
}
