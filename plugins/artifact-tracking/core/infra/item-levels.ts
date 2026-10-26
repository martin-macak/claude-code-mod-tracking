// ItemLevels: the priority of the items. The person's mark on a row, the row a typed ref names, and the level of every
// item (the marks, then the rules of the kinds). The pure parts are in `priority.ts`; this joins them to the list.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.9. Plan: L5 Task 6 and Task 8.

import type { Effective, Level, StoredItem } from '../interfaces/items'
import type { FactsPort } from '../interfaces/tracker'
import type { ItemStore } from './item-store'
import type { Kinds } from './kinds'
import { effectiveLevels, rowIdOf, setLevel } from './priority'

export class ItemLevels {
  constructor(
    private readonly d: {
      store: ItemStore
      kinds: Kinds
      facts: FactsPort
      /** The kinds find what a lookup needs first (the session repo). */
      prepare(): Promise<void>
    },
  ) {}

  /** The person's mark on a row. `undefined` removes it. `top` comes from a rule only: it does nothing. True when the list changed. */
  async setPriority(rowId: string, level: Level | undefined): Promise<boolean> {
    return this.setPriorities([rowId], level)
  }

  /**
   * The person's mark on many rows (the digits on the marked rows of the pane, issue #138): one write for all of them, so the
   * list is stored and the prompt rebuilt once. A row that holds the level already, an id no item holds and `top` change
   * nothing. True when the list changed.
   */
  async setPriorities(rowIds: readonly string[], level: Level | undefined): Promise<boolean> {
    if (level === 'top' || rowIds.length === 0) return false
    return this.d.store.rawUpdate(list =>
      [...new Set(rowIds)].reduce((marked, id) => setLevel(marked, id, level, this.d.kinds.table), list),
    )
  }

  /** The row of a typed ref (`/track prio`). It waits for the session repo first, so `#N` keys are right. */
  async rowIdOf(ref: string): Promise<string | undefined> {
    await this.d.prepare()
    const ctx = this.d.kinds.plain({ source: 'lookup', mode: 'full', purpose: 'lookup' })
    return rowIdOf(await this.d.store.list(), ref, this.d.kinds.all, ctx, category => this.d.kinds.isLive(category))
  }

  /** The levels of `list`, or of the store's list. The pane passes the list it read, so both agree. */
  async levels(list?: readonly StoredItem[]): Promise<ReadonlyMap<string, Effective>> {
    return effectiveLevels(list ?? (await this.d.store.list()), this.d.kinds.table, this.d.facts)
  }
}
