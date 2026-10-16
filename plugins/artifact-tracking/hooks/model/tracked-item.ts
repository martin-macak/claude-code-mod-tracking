// Base class of a tracked item (spec section 5). Plain TypeScript: no `$`.
// An item is rebuilt from an ItemRecord for each operation and turned back into a record afterwards.

import type { Category, ItemError, ItemRecord, ItemRecordBase, Priority, Refreshable, Source } from '../contracts'
import { LIMITS } from '../contracts'

/** A copy of `obj` without the keys whose value is undefined. */
export function omitUndefined<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v
  return out as T
}

export abstract class TrackedItem implements Refreshable {
  readonly key: string
  abstract readonly category: Category
  url: string
  label: string
  /** The person's manual mark. Absent: no mark. */
  priority?: Priority
  sources: Source[]
  firstSeen: number
  lastSeen: number
  seenCount: number
  refreshedAt?: number
  error?: ItemError

  protected constructor(rec: ItemRecordBase) {
    this.key = rec.key
    this.url = rec.url
    this.label = rec.label
    if (rec.priority !== undefined) this.priority = rec.priority
    this.sources = [...rec.sources]
    this.firstSeen = rec.firstSeen
    this.lastSeen = rec.lastSeen
    this.seenCount = rec.seenCount
    if (rec.refreshedAt !== undefined) this.refreshedAt = rec.refreshedAt
    if (rec.error !== undefined) this.error = { ...rec.error }
  }

  abstract canRefresh(now: number): boolean
  abstract refresh(): Promise<void>
  abstract toRecord(): ItemRecord

  /** False when the tool said not-found. True when never refreshed. Else true once the item is stale. */
  isDue(now: number): boolean {
    if (this.error?.kind === 'not-found') return false
    if (this.refreshedAt === undefined) return true
    return now - this.refreshedAt >= this.staleAfter()
  }

  protected staleAfter(): number {
    return LIMITS.staleMs
  }

  /** The shared record fields. Optional fields appear only when set. */
  protected baseRecord(): ItemRecordBase {
    return omitUndefined({
      key: this.key,
      url: this.url,
      label: this.label,
      priority: this.priority,
      sources: [...this.sources],
      firstSeen: this.firstSeen,
      lastSeen: this.lastSeen,
      seenCount: this.seenCount,
      refreshedAt: this.refreshedAt,
      error: this.error === undefined ? undefined : { ...this.error },
    })
  }
}

/** An item with no status to fetch: a web link, an artifact or a Markdown file. It never refreshes. */
export abstract class StaticItem extends TrackedItem {
  canRefresh(_now: number): boolean {
    return false
  }

  async refresh(): Promise<void> {}

  override isDue(_now: number): boolean {
    return false
  }
}
