// ItemLevels: the priority of the items. The person's mark on a row, the row a typed ref names, and the level of every
// item (the marks, then the rules of the kinds). The pure parts are in `priority.ts`; this joins them to the list.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.9. Plan: L5 Task 6 and Task 8.

import type { Effective, Level } from '../interfaces/items'
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
    if (level === 'top') return false
    return this.d.store.rawUpdate(list => setLevel(list, rowId, level, this.d.kinds.table))
  }

  /** The row of a typed ref (`/track prio`). It waits for the session repo first, so `#N` keys are right. */
  async rowIdOf(ref: string): Promise<string | undefined> {
    await this.d.prepare()
    const ctx = this.d.kinds.plain({ source: 'lookup', mode: 'full', purpose: 'lookup' })
    return rowIdOf(await this.d.store.list(), ref, this.d.kinds.all, ctx, category => this.d.kinds.isLive(category))
  }

  async levels(): Promise<ReadonlyMap<string, Effective>> {
    return effectiveLevels(await this.d.store.list(), this.d.kinds.table, this.d.facts)
  }
}
