// The item list in the plugin state: every write goes through the raw writer `set`, which also tells Persistence. `update` and
// `track` run the session check first; the switch and the load use `set` alone, because the check is single flight and
// would wait for the switch they sit in (Review Focus 2). Also the filters a stored copy passes at a load.
// Transitional (plan Task 11): layer L5 splits this into ItemStore and the kinds' `restore`.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.9 and 5.13. Plan: L3 Task 11, D6, D8.

import type { Claim, HostContext, ItemStorePort, StoredItem } from '../../core/interfaces/items'
import type { AtomPort } from '../../core/interfaces/ports'
import { dropAuto } from '../../trackers/github/discovered'
import type { ItemRecord, Ref, Source } from '../contracts'
import { AUTO_SOURCES } from '../contracts'
import { keyOf } from '../model/keys'
import { mergeRefs, rekeyArtifacts } from '../model/registry'

export type StoreDeps = {
  /** The `items` atom. */
  atom: AtomPort<StoredItem[]>
  /** The context of the load; absent before the item runtime started. */
  host(): HostContext | undefined
  /** Keys to refresh after the capture debounce. No keys: every item. */
  kick(keys?: readonly string[]): void
}

const asRecords = (list: StoredItem[]): ItemRecord[] => list as unknown as ItemRecord[]
const asStored = (list: ItemRecord[]): StoredItem[] => list as unknown as StoredItem[]

export class ItemStore implements ItemStorePort {
  constructor(private readonly d: StoreDeps) {}

  /** The records as they are now. */
  async records(): Promise<ItemRecord[]> {
    return asRecords(await this.d.atom.get())
  }

  /**
   * Changes the list. The raw writer: no session check. Every write to `items` goes through here, so each one tells
   * Persistence to flush soon. Before the runtime started there is nobody to tell.
   */
  async set(change: (list: ItemRecord[]) => ItemRecord[]): Promise<void> {
    await this.d.atom.update(list => asStored(change(asRecords(list ?? []))))
    this.d.host()?.persisted()
  }

  async list(): Promise<readonly StoredItem[]> {
    return this.d.atom.get()
  }

  /**
   * The session check, then read first, call `change` at least once and write the result. `change` gets the dismissed
   * set of this run, read again before the write: an x press while the first call ran must win (A20). A `since` older
   * than the generation drops the write. Resolves to whether it wrote.
   */
  async update(
    change: (list: StoredItem[], dismissed: ReadonlySet<string>) => StoredItem[],
    opts?: { since?: number },
  ): Promise<boolean> {
    const host = this.need()
    const generation = await host.current()
    if (opts?.since !== undefined && opts.since !== generation) return false
    const cur = await this.d.atom.get()
    if (change(cur, await host.dismiss.list()) === cur) return false
    const dismissed = await host.dismiss.list()
    await this.set(list => asRecords(change(asStored(list), dismissed)))
    return true
  }

  /**
   * The `ItemStorePort` form. In L3 a `Claim` is today's `Ref` (the interface says so); layer L5 turns it into the
   * real claim.
   */
  track(claims: readonly Claim[], source: string): Promise<void> {
    return this.trackRefs(claims as unknown as readonly Ref[], source as Source)
  }

  /** Merges refs into the list, less the dismissed keys. The common tail of every capture. */
  async trackRefs(refs: readonly Ref[], source: Source): Promise<void> {
    const host = this.need()
    await host.current()
    const dismissed = await host.dismiss.list()
    const keep = refs.filter(ref => !dismissed.has(keyOf(ref)))
    if (keep.length === 0) return
    let added: string[] = []
    await this.set(list => {
      const merged = mergeRefs(list, keep, { source, at: host.clock.wall() })
      added = merged.added
      return merged.list
    })
    if (added.length > 0) this.d.kick(added)
  }

  /** Marks the keys due and kicks the refresh. Fire and forget. */
  refresh(keys?: readonly string[]): void {
    this.d.kick(keys)
  }

  private need(): HostContext {
    const host = this.d.host()
    if (!host) throw new Error('items: not started')
    return host
  }
}

// ---------------------------------------------------------------- what a load keeps of a stored copy

/** A stored record comes back due: its status stays for display, its refresh time goes. */
function due(rec: ItemRecord): ItemRecord {
  const out = { ...rec }
  delete out.refreshedAt
  return out
}

/** A stored copy comes back without auto sources: a new process has no proofs, so the first complete PR step adds back what is still tracked. */
function withoutAuto(list: ItemRecord[]): ItemRecord[] {
  const keys = new Set(
    list.filter(r => r.via !== undefined || r.sources.some(s => AUTO_SOURCES.has(s))).map(r => r.key),
  )
  return dropAuto(list, keys)
}

/** A Jira item that only a tool sighting knew stays only on the Jira site that is active now. */
function keepStored(rec: ItemRecord, activeSite: string | null | undefined): boolean {
  if (rec.category !== 'jira') return true
  if (activeSite === undefined) return true
  if (rec.sources.length !== 1 || rec.sources[0] !== 'tool') return true
  return activeSite !== null && rec.site.toLowerCase() === activeSite.toLowerCase()
}

/**
 * The items of a stored copy that a `--resume` load or a /resume switch takes back: artifact rows re-keyed, auto
 * sources dropped, foreign tool-only Jira items, not-found items and dismissed keys left out, every record due.
 */
export function storedForLoad(
  stored: ItemRecord[],
  activeSite: string | null | undefined,
  dismissed: ReadonlySet<string>,
): ItemRecord[] {
  return withoutAuto(rekeyArtifacts(stored))
    .filter(rec => keepStored(rec, activeSite))
    .filter(rec => rec.error?.kind !== 'not-found')
    .filter(rec => !dismissed.has(rec.key))
    .map(due)
}
