// The record algebra: the fields every item record shares, and the generic merge, fold, cap, carry-over, refresh and
// migration over a table of item kinds. No function here knows a category: a kind brings its own part (`merge`,
// `fold`, `keepMarks`, `refresh.fields`, `refresh.apply`, `migrate`). Pure: no input list or record is mutated.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.9. Plan: L5 Task 1 and Task 4, K4, K5.

import type { Claim, ItemKind, Json, Priority, StoredItem } from '../interfaces/items'
import { mergePriority, withPriority } from './levels'

/** `not-found`: the tool says the item does not exist (or no permission). `failed`: the last refresh failed. */
export type ItemError = { kind: 'not-found' | 'failed'; message: string; at: number }

/**
 * What every item record shares, over the contract's `StoredItem`. A kind adds its own flat fields.
 * `key`, `firstSeen` and `lastSeen` are writable here: the merge folds records in place on a copy.
 */
export type BaseRecord = StoredItem & {
  key: string
  firstSeen: number
  lastSeen: number
  /** The person's manual mark. A rule's level never lands in a record. */
  priority?: Priority
  url: string
  /** Display text: Markdown label, title, or host + path. */
  label: string
  sources: string[]
  seenCount: number
  refreshedAt?: number
  error?: ItemError
  /** Keys of discovered items whose body names this one. Absent when none. */
  via?: string[]
}

/** Sources that discovery adds. The transcript backfill and the capture hooks never write them. */
export const AUTO_SOURCES: ReadonlySet<string> = new Set<string>(['auto', 'pr-body'])

/**
 * R12: the newest manual-high records the cap never drops. A code constant, not a config key: it must stay below
 * `store.maxItems` (min 200), so the cap can always be met (plan decision C2).
 */
export const MAX_PINNED = 100

/** The kind of a category, or undefined. The store builds it from the kinds of the live trackers. */
export type KindTable = (category: string) => ItemKind | undefined

type Writable<T> = { -readonly [K in keyof T]: T[K] }
type Row = Writable<StoredItem>

const hasAutoSource = (rec: Pick<StoredItem, 'sources'>): boolean => rec.sources.some(s => AUTO_SOURCES.has(s))

/** Every source is an auto source: no conversation mention backs the item. */
export function isAutoOnly(rec: Pick<StoredItem, 'sources'>): boolean {
  return rec.sources.length > 0 && rec.sources.every(s => AUTO_SOURCES.has(s))
}

/** A deep copy of a JSON value. A key whose value is undefined is left out, so an absent key stays absent. */
function copy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copy) as T
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value)) if (v !== undefined) out[key] = copy(v)
  return out as T
}

/** A copy that shares no array or object with `rec`, whatever the kind keeps in it (sources, error, via, a child tree). */
export function cloneRecord<R extends StoredItem>(rec: R): R {
  return copy(rec)
}

const numberOf = (v: Json | undefined): number | undefined => (typeof v === 'number' ? v : undefined)
const stringsOf = (v: Json | undefined): readonly string[] => (Array.isArray(v) ? (v as readonly string[]) : [])
const levelOf = (v: Json | undefined): Priority | undefined => v as Priority | undefined
const errorOf = (rec: StoredItem): ItemError | undefined => rec.error as ItemError | undefined

/** One more sighting of a known record: the claim's source once, `seenCount` + 1 and the claim's time as `lastSeen`. */
export function sighted<R extends BaseRecord>(cur: R, seen: Claim): R {
  return {
    ...cur,
    sources: cur.sources.includes(seen.source) ? [...cur.sources] : [...cur.sources, seen.source],
    seenCount: cur.seenCount + 1,
    lastSeen: seen.at,
  }
}

// ---------------------------------------------------------------- cap

/** R12: the keys of the newest manual-high records, at most `MAX_PINNED`. The cap never drops them. */
function pinnedKeys(list: readonly StoredItem[]): Set<string> {
  return new Set(
    list
      .filter(rec => rec.priority === 'high' && !hasAutoSource(rec))
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, MAX_PINNED)
      .map(rec => rec.key),
  )
}

/**
 * Drops the records with the smallest lastSeen until `cap` is met. Keys in `keep` never go, nor the newest manual-high
 * records (R12). Only records without an auto source count against `cap`, and only they are evicted (spec A11):
 * auto-only items have their own cap, `maxAutoItems`, enforced at the source. The input list comes back when it fits.
 */
export function enforceCap<R extends StoredItem>(list: R[], cap: number, keep: ReadonlySet<string> = new Set()): R[] {
  const excess = list.filter(rec => !hasAutoSource(rec)).length - cap
  if (excess <= 0) return list
  const pinned = pinnedKeys(list)
  const victims = list
    .map((rec, i) => ({ rec, i }))
    .filter(({ rec }) => !hasAutoSource(rec) && !keep.has(rec.key) && !pinned.has(rec.key))
    .sort((x, y) => x.rec.lastSeen - y.rec.lastSeen || x.i - y.i)
    .slice(0, excess)
    .map(({ i }) => i)
  const drop = new Set(victims)
  return list.filter((_, i) => !drop.has(i))
}

// ---------------------------------------------------------------- fold

/**
 * Folds sightings of `b` into `a`: status fields come from the record with the newer `refreshedAt` (a tie keeps `a`),
 * the union of sources (a first) and of `via`, the sum of seenCount, the min firstSeen, the max lastSeen, the merge of
 * the manual marks. The kind adds its own part last (`ItemKind.fold`).
 */
export function foldRecords(a: StoredItem, b: StoredItem, kinds: KindTable): StoredItem {
  const winner = (numberOf(b.refreshedAt) ?? -Infinity) > (numberOf(a.refreshedAt) ?? -Infinity) ? b : a
  const loser = winner === a ? b : a
  const out = cloneRecord(winner) as Row
  out.sources = [...new Set([...a.sources, ...b.sources])]
  const via = [...new Set([...stringsOf(a.via), ...stringsOf(b.via)])]
  if (via.length > 0) out.via = via
  else delete out.via
  out.seenCount = (numberOf(a.seenCount) ?? 0) + (numberOf(b.seenCount) ?? 0)
  out.firstSeen = Math.min(a.firstSeen, b.firstSeen)
  out.lastSeen = Math.max(a.lastSeen, b.lastSeen)
  const priority = mergePriority(levelOf(a.priority), levelOf(b.priority))
  if (priority === undefined) delete out.priority
  else out.priority = priority
  const kind = kinds(winner.category)
  return kind?.fold && loser.category === winner.category ? kind.fold(winner, loser, out) : out
}

// ---------------------------------------------------------------- merge

/**
 * Offers each claim to the kind of its category. A new key gets `kind.merge(null, claim)` (null adds nothing). A known
 * key gets `kind.merge(cur, claim)`. The cap drops the smallest lastSeen, never a record this call added. Every record
 * of the input is copied, so the output shares nothing with it.
 */
export function mergeClaims(
  list: readonly StoredItem[],
  claims: readonly Claim[],
  kinds: KindTable,
  cap: number,
): { list: StoredItem[]; added: string[] } {
  const out: StoredItem[] = list.map(cloneRecord)
  const index = new Map<string, number>(out.map((r, i) => [r.key, i]))
  const added: string[] = []
  for (const claim of claims) {
    const kind = kinds(claim.category)
    if (!kind) continue
    const at = index.get(claim.key)
    if (at === undefined) {
      const rec = kind.merge(null, claim)
      if (rec === null) continue
      index.set(claim.key, out.length)
      out.push(rec)
      added.push(claim.key)
      continue
    }
    const cur = kind.decode(out[at]!)
    const next = cur === null ? null : kind.merge(cur, claim)
    if (next) out[at] = next
  }
  return { list: enforceCap(out, cap, new Set(added)), added }
}

/** Fold records with the same key (`a` first), then cap. The input records are copied. */
export function unionRecords(
  a: readonly StoredItem[],
  b: readonly StoredItem[],
  kinds: KindTable,
  cap: number,
): StoredItem[] {
  const out: StoredItem[] = []
  const index = new Map<string, number>()
  for (const rec of [...a, ...b]) {
    const at = index.get(rec.key)
    if (at === undefined) {
      index.set(rec.key, out.length)
      out.push(cloneRecord(rec))
    } else out[at] = foldRecords(out[at]!, rec, kinds)
  }
  return enforceCap(out, cap)
}

/**
 * Merge for `/clear` carry-over. `held` is the live list; `stored`, the copy in the plugin store, can be up to `flushMs`
 * older. Records fold as in `unionRecords`, but a key that `held` has keeps its live marks, on the root and (through
 * `ItemKind.keepMarks`) inside the item: a reset or a lowered level must not lose to the higher mark of the older copy.
 */
export function carryOver(
  held: readonly StoredItem[],
  stored: readonly StoredItem[],
  kinds: KindTable,
  cap: number,
): StoredItem[] {
  const live = new Map(held.map(r => [r.key, r]))
  return unionRecords(held, stored, kinds, cap).map(rec => {
    const h = live.get(rec.key)
    if (!h) return rec
    const out = withPriority(rec as BaseRecord, levelOf(h.priority))
    return kinds(rec.category)?.keepMarks?.(out, h) ?? out
  })
}

// ---------------------------------------------------------------- refresh

/**
 * Writes the result of a refresh into the list. Each record takes the status fields its kind names
 * (`refresh.fields`), the kind's own part (`refresh.apply`), the refresh time and the error, and keeps the rest.
 * A record refreshed as not-found goes. A record the refresh did not return is copied as it is.
 */
export function applyRefresh(
  list: readonly StoredItem[],
  refreshed: readonly StoredItem[],
  kinds: KindTable,
): StoredItem[] {
  const byKey = new Map(refreshed.map(r => [r.key, r]))
  const removed = new Set(refreshed.filter(r => errorOf(r)?.kind === 'not-found').map(r => r.key))
  return list.flatMap(rec => {
    if (removed.has(rec.key)) return []
    const fresh = byKey.get(rec.key)
    const copied = cloneRecord(rec) as Row
    if (!fresh) return [copied]
    const spec = kinds(copied.category)?.refresh
    for (const field of spec?.fields ?? []) if (fresh[field] !== undefined) copied[field] = copy(fresh[field])
    const out = (spec?.apply?.(copied, fresh) ?? copied) as Row
    if (fresh.refreshedAt !== undefined) out.refreshedAt = fresh.refreshedAt
    if (fresh.error) out.error = copy(fresh.error)
    else delete out.error
    return [out]
  })
}

// ---------------------------------------------------------------- migration and auto sources

/**
 * R13: offers each record to the `migrate` of every kind, in rank order. A record that a kind claims moves there and
 * folds into a twin with the same key. The input list comes back when nothing moves.
 */
export function migrateRecords(list: StoredItem[], kinds: readonly ItemKind[]): StoredItem[] {
  const ordered = [...kinds].sort((a, b) => a.rank - b.rank)
  const moved = list.map(rec => {
    for (const kind of ordered) {
      const next = kind.migrate?.(rec)
      if (next) return next
    }
    return null
  })
  if (moved.every(m => m === null)) return list
  const table: KindTable = category => kinds.find(k => k.category === category)
  const out: StoredItem[] = []
  const index = new Map<string, number>()
  list.forEach((rec, i) => {
    const next = moved[i] ?? cloneRecord(rec)
    const at = index.get(next.key)
    if (at === undefined) {
      index.set(next.key, out.length)
      out.push(next)
    } else out[at] = foldRecords(out[at]!, next, table)
  })
  return out
}

/** Removes `auto`, `pr-body` and `via` from the given keys. A record left with no source goes. */
export function dropAuto<R extends StoredItem>(list: readonly R[], keys: ReadonlySet<string>): R[] {
  let changed = false
  const out: R[] = []
  for (const rec of list) {
    if (!keys.has(rec.key) || (!hasAutoSource(rec) && rec.via === undefined)) {
      out.push(rec)
      continue
    }
    changed = true
    const sources = rec.sources.filter(s => !AUTO_SOURCES.has(s))
    if (sources.length === 0) continue
    const next = { ...rec, sources } as Row
    delete next.via
    out.push(next as R)
  }
  return changed ? out : (list as R[])
}
