// ItemStore: the item list in the plugin state. Every write goes through the raw
// writer `set`, which also tells Persistence. `update` and `track` run the session check first; the switch, the load and
// a `prepare` use the raw paths, because the check is single flight and would wait for the switch they sit in
// (Review Focus 2). The merges are the generic ones of `core/lib/records.ts`; a kind brings its own part.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.9 and 5.13. Plan: L5 Task 8, L3 D6, D8.

import type { Claim, StoredItem } from '../interfaces/items'
import type { AtomPort } from '../interfaces/ports'
import type { DismissPort } from '../interfaces/tracker'
import type { Sightings } from '../interfaces/turns'
import { withReasons } from '../lib/reasons'
import { type Cap, enforceCap, mergeClaims, migrateRecords, unionRecords } from '../lib/records'
import { NO_SIGHTINGS, sightingsOf } from '../lib/turn-entries'
import type { Kinds } from './kinds'

export type StoreDeps = {
  /** The `items` atom. */
  atom: AtomPort<StoredItem[]>
  kinds: Kinds
  dismiss: DismissPort
  /** The session check. */
  current(): Promise<number>
  /** `global.store.maxItems`, and the limit of each kind that has one: the cap of every merge into the list. */
  cap(): Cap
  /** The list changed: Persistence writes the session copy soon. Nobody to tell before the start. */
  persisted(): void
  /** Keys to refresh after the capture debounce. No keys: every item. */
  kick(keys?: readonly string[]): void
  /** True once the item host started. */
  started(): boolean
}

export class ItemStore {
  constructor(private readonly d: StoreDeps) {}

  async list(): Promise<readonly StoredItem[]> {
    return this.d.atom.get()
  }

  /** Changes the list. The raw writer: no session check. Every write to `items` goes through here. */
  async set(change: (list: StoredItem[]) => StoredItem[]): Promise<void> {
    await this.d.atom.update(list => change(list ?? []))
    if (this.d.started()) this.d.persisted()
  }

  /**
   * The session check, then read first, call `change` at least once and write the result. `change` gets the dismissed
   * set of this run, read again before the write: an x press while the first call ran must win (A20). A `since` older
   * than the generation drops the write. Resolves to whether it wrote. Before the item host started it rejects with
   * `items: not started` (so does `track`): a checked write needs the context of the load.
   */
  async update(
    change: (list: StoredItem[], dismissed: ReadonlySet<string>) => StoredItem[],
    opts?: { since?: number },
  ): Promise<boolean> {
    if (!this.d.started()) throw new Error('items: not started')
    const generation = await this.d.current()
    if (opts?.since !== undefined && opts.since !== generation) return false
    const cur = await this.d.atom.get()
    if (change(cur, await this.d.dismiss.list()) === cur) return false
    const dismissed = await this.d.dismiss.list()
    await this.set(list => change(list, dismissed))
    return true
  }

  /** Like `update`, but with no session check and no dismissed set: for a hook that runs inside a switch. */
  async rawUpdate(change: (list: StoredItem[]) => StoredItem[]): Promise<boolean> {
    const cur = await this.d.atom.get()
    if (change(cur) === cur) return false
    await this.set(change)
    return true
  }

  /**
   * Merges claims into the list, less the dismissed keys and the claims of a kind that is off. A kind that is off has
   * claimed its spans already, so a URL that a kind of a higher rank claimed never falls to a lower kind (spec 5.7, toggles). The new keys queue for refresh.
   *
   * `turn` (issue #69) is the ordinal of the main-loop turn that made the claims: the records they reach get its stamps. The
   * answer says what the claims did: the items they added, the known items they named, and the items the same turn had
   * named before (repeats). Only the capture funnel passes a turn, so a tracker's own `items.track` (the PR lane) stamps
   * nothing and makes no sighting that a turn keeps.
   */
  async track(claims: readonly Claim[], turn?: number): Promise<Sightings> {
    let added: string[] = []
    let touched: string[] = []
    let repeats: string[] = []
    let taken: readonly Claim[] = []
    await this.update((list, dismissed) => {
      const keep = claims.filter(c => !dismissed.has(c.key) && this.d.kinds.isLive(c.category))
      if (keep.length === 0) return list
      const merged = mergeClaims(list, keep, this.d.kinds.table, this.d.cap(), turn)
      added = merged.added
      touched = merged.touched
      repeats = merged.repeats
      taken = keep
      return merged.changed ? merged.list : list
    })
    if (added.length > 0) this.d.kick(added)
    return added.length + touched.length + repeats.length === 0
      ? NO_SIGHTINGS
      : sightingsOf(taken, added, touched, repeats)
  }

  /** Marks the keys due and kicks the refresh. Fire and forget. */
  refresh(keys?: readonly string[]): void {
    this.d.kick(keys)
  }

  /** The record a claim makes, from its kind. null: no such kind, or a claim that adds no item. */
  build(claim: Claim): StoredItem | null {
    return this.d.kinds.table(claim.category)?.merge(null, claim) ?? null
  }

  /** `list` under the cap of the store: the shared cap, the limit of each kind and the rank of a record. */
  capped(list: StoredItem[], keep: ReadonlySet<string> = new Set()): StoredItem[] {
    return enforceCap(list, this.d.cap(), keep, this.d.kinds.table)
  }

  /**
   * At the start of a load: drop the records with no valid reasons (a hot reload kept the list of a build before #62,
   * and no merge below may read a record that has none), re-key what moved (R13) and drop the records of a kind that is
   * off, in one write. The check comes first, so a re-key never reads the reasons of a record that has none.
   */
  async warm(): Promise<void> {
    const tidy = (list: StoredItem[]) => this.d.kinds.onlyOn(migrateRecords(withReasons(list), this.d.kinds.all))
    const live = await this.d.atom.get()
    if (tidy(live) !== live) await this.set(tidy)
  }

  /** Merges a replayed transcript: a stored key wins, except where the kind says the transcript knows more. */
  async replayed(claims: readonly Claim[]): Promise<boolean> {
    const dismissed = await this.d.dismiss.list()
    const have = new Map((await this.list()).map(r => [r.key, r]))
    const { kinds } = this.d
    const live = claims.filter(c => kinds.isLive(c.category))
    const fresh = mergeClaims([], live, kinds.table, this.d.cap()).list.filter(rec => {
      if (dismissed.has(rec.key)) return false
      const stored = have.get(rec.key)
      if (!stored) return true
      const kind = kinds.table(rec.category)
      const [a, b] = [kind?.decode(rec), kind?.decode(stored)]
      return !!a && !!b && kind?.replayWins?.(a, b) === true
    })
    if (fresh.length === 0) return false
    await this.set(list => unionRecords(list, fresh, kinds.table, this.d.cap()))
    return true
  }
}
