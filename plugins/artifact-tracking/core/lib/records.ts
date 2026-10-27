// The record algebra: the fields every item record shares, and the generic merge, fold, cap, carry-over, refresh and
// migration over a table of item kinds. No function here knows a category: a kind brings its own part (`merge`,
// `fold`, `keepMarks`, `refresh.fields`, `refresh.apply`, `migrate`). Pure: no input list or record is mutated.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.9. Plan: L5 Task 1 and Task 4, K4, K5.

import type { Claim, ItemKind, Json, Priority, StoredItem } from '../interfaces/items'
import { mergePriority, withPriority } from './levels'
import { addReason, dropReason, joinReasons } from './reasons'
import { turnSpan } from './turn-span'

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

/**
 * R12: the newest manual-high records the cap never drops. A code constant, not a config key: it must stay below
 * `store.maxItems` (min 200), so the cap can always be met (plan decision C2).
 */
export const MAX_PINNED = 100

/** The kind of a category, or undefined. The store builds it from the kinds of the live trackers. */
export type KindTable = (category: string) => ItemKind | undefined

type Writable<T> = { -readonly [K in keyof T]: T[K] }
type Row = Writable<StoredItem>

/**
 * Discovery found the item: the PR lane found the PR, or the body of a PR names the item. Only discovery adds the reason
 * `discovered`, and the capture hooks never do. `sources` holds channels only (`prompt`, `response`, `tool`), so a
 * record that only discovery found has no source at all.
 */
export const isDiscovered = (rec: Pick<StoredItem, 'reasons'>): boolean => rec.reasons.all.includes('discovered')

/** The only reason is `discovered`: no conversation or tool call backs the item. */
export function isAutoOnly(rec: Pick<StoredItem, 'reasons'>): boolean {
  return rec.reasons.all.length > 0 && rec.reasons.all.every(r => r === 'discovered')
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

/**
 * One more sighting of a known record: the claim's source once, the claim's reason, `seenCount` + 1 and the claim's time
 * as `lastSeen`.
 */
export function sighted<R extends BaseRecord>(cur: R, seen: Claim): R {
  return {
    ...cur,
    sources: cur.sources.includes(seen.source) ? [...cur.sources] : [...cur.sources, seen.source],
    reasons: addReason(cur.reasons, seen.reason),
    seenCount: cur.seenCount + 1,
    lastSeen: seen.at,
  }
}

// ---------------------------------------------------------------- cap

/** R12: the keys of the newest manual-high records, at most `MAX_PINNED`. The cap never drops them. */
function pinnedKeys(list: readonly StoredItem[]): Set<string> {
  return new Set(
    list
      .filter(rec => rec.priority === 'high' && !isDiscovered(rec))
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, MAX_PINNED)
      .map(rec => rec.key),
  )
}

/**
 * What the cap keeps. A number is the shared cap alone (`global.store.maxItems`). An object adds a limit for each kind that
 * has one (issue #57: `file.maxFiles`): `of` answers for a category, or undefined when the kind has none. The limit never
 * lifts the shared cap: the lower of the two applies to the kind.
 */
export type Cap = number | { readonly total: number; readonly of?: (category: string) => number | undefined }

/** The rank of a record that its kind ranks not: the highest, so a kind with no `capRank` loses a record only by its age. */
const DEFAULT_RANK = 2

/**
 * Drops records until `cap` is met: first the records of a kind over its own limit, then the whole list over the shared cap.
 * Each pass drops the lowest `ItemKind.capRank` first, then the smallest lastSeen. A kind with no `capRank` ranks 2. `kinds`
 * is required: a caller that forgets it would cap by age alone and ignore the rank (pass `() => undefined` to say that on
 * purpose). Keys in `keep` never go, so the record a call has just added stays even when it ranks lowest: a full kind of
 * written records then loses its oldest one to a new read-only record. Nor do the newest manual-high records go (R12). Only
 * records that discovery did not find count against `cap`, and only they are evicted (spec A11): auto-only items have their
 * own cap, `maxAutoItems`, enforced at the source. The input list comes back when it fits.
 */
export function enforceCap<R extends StoredItem>(
  list: R[],
  cap: Cap,
  keep: ReadonlySet<string>,
  kinds: KindTable,
): R[] {
  const { total, of } = typeof cap === 'number' ? { total: cap, of: undefined } : cap
  const counted = list.filter(rec => !isDiscovered(rec))
  const own = of ? limitedKinds(counted, of, total) : []
  if (counted.length <= total && own.length === 0) return list
  const pinned = pinnedKeys(list)
  const rankOf = (rec: StoredItem): number => kinds(rec.category)?.capRank?.(rec) ?? DEFAULT_RANK
  const drop = new Set<StoredItem>()
  /** Marks the `excess` records of `pool` that go: lowest rank, then smallest lastSeen, then the earlier place. */
  const evict = (pool: readonly StoredItem[], excess: number): void => {
    if (excess <= 0) return
    const order = new Map<StoredItem, number>(list.map((rec, i) => [rec, i]))
    pool
      .filter(rec => !drop.has(rec) && !keep.has(rec.key) && !pinned.has(rec.key))
      .sort((x, y) => rankOf(x) - rankOf(y) || x.lastSeen - y.lastSeen || order.get(x)! - order.get(y)!)
      .slice(0, excess)
      .forEach(rec => void drop.add(rec))
  }
  for (const { category, limit } of own) {
    const pool = counted.filter(rec => rec.category === category)
    evict(pool, pool.length - limit)
  }
  evict(counted, counted.length - drop.size - total)
  return drop.size === 0 ? list : list.filter(rec => !drop.has(rec))
}

/** The kinds that hold more records than their limit, with the limit that applies (the lower of the kind's and `total`). */
function limitedKinds(
  counted: readonly StoredItem[],
  of: (category: string) => number | undefined,
  total: number,
): { category: string; limit: number }[] {
  const sizes = new Map<string, number>()
  for (const rec of counted) sizes.set(rec.category, (sizes.get(rec.category) ?? 0) + 1)
  const out: { category: string; limit: number }[] = []
  for (const [category, size] of sizes) {
    const own = of(category)
    if (own !== undefined && size > Math.min(own, total)) out.push({ category, limit: Math.min(own, total) })
  }
  return out
}

// ---------------------------------------------------------------- fold

/**
 * Folds sightings of `b` into `a`: status fields come from the record with the newer `refreshedAt` (a tie keeps `a`),
 * the union of sources (a first), of `via` and of the reasons (`first` from the record seen first, a tie keeps `a`), the
 * sum of seenCount, the min firstSeen, the max lastSeen, the min firstTurn and the max lastTurn (a record with none
 * leaves the other's), the merge of the manual marks. The kind adds its own part last (`ItemKind.fold`).
 */
export function foldRecords(a: StoredItem, b: StoredItem, kinds: KindTable): StoredItem {
  const winner = (numberOf(b.refreshedAt) ?? -Infinity) > (numberOf(a.refreshedAt) ?? -Infinity) ? b : a
  const loser = winner === a ? b : a
  const out = cloneRecord(winner) as Row
  out.sources = [...new Set([...a.sources, ...b.sources])]
  out.reasons = joinReasons(a.reasons, b.reasons, a.firstSeen <= b.firstSeen ? 'a' : 'b')
  const via = [...new Set([...stringsOf(a.via), ...stringsOf(b.via)])]
  if (via.length > 0) out.via = via
  else delete out.via
  out.seenCount = (numberOf(a.seenCount) ?? 0) + (numberOf(b.seenCount) ?? 0)
  out.firstSeen = Math.min(a.firstSeen, b.firstSeen)
  out.lastSeen = Math.max(a.lastSeen, b.lastSeen)
  const turns = turnSpan(a, b)
  if (turns === undefined) {
    delete out.firstTurn
    delete out.lastTurn
  } else {
    out.firstTurn = turns.first
    out.lastTurn = turns.last
  }
  const priority = mergePriority(levelOf(a.priority), levelOf(b.priority))
  if (priority === undefined) delete out.priority
  else out.priority = priority
  const kind = kinds(winner.category)
  return kind?.fold && loser.category === winner.category ? kind.fold(winner, loser, out) : out
}

// ---------------------------------------------------------------- merge

/**
 * The record as a claim of `turn` leaves it: `firstTurn` the smallest and `lastTurn` the largest of the turns the record
 * had (`prior`: the record in the list before the claim, since a kind's merge may keep no field it does not know) and
 * `turn`. The same record comes back when the stamps are right already.
 */
function stamped<R extends StoredItem>(rec: R, turn: number, prior: StoredItem): R {
  const { first, last } = turnSpan(prior, { firstTurn: turn, lastTurn: turn } as unknown as StoredItem) as {
    first: number
    last: number
  }
  if (rec.firstTurn === first && rec.lastTurn === last) return rec
  return { ...rec, firstTurn: first, lastTurn: last }
}

/**
 * Offers each claim to the kind of its category. A new key gets `kind.merge(null, claim)` (null adds nothing). A known
 * key gets `kind.merge(cur, claim)`; the kind returns `cur` itself when the claim changes nothing. The cap drops the
 * smallest lastSeen, never a record this call added. Every record of the output is a copy, so it shares nothing with
 * the input. `changed` is false when no claim changed anything (a delete of a page that is gone): the caller skips the write.
 *
 * `turn` (issue #69) is the ordinal of the main-loop turn that made the claims. It stamps `firstTurn` and `lastTurn` on
 * each record a claim reaches, after the kind's merge. `touched` lists the keys that were in the list before the call and
 * that a claim named: the known items the turn saw again, also where the kind returned `cur`. `repeats` lists those among
 * them that the same turn had stamped before this call (`lastTurn` is `turn` already): the turn added or saw them earlier,
 * so a call of it names them again. A key is in one of `added`, `touched` and `repeats`, once.
 */
export function mergeClaims(
  list: readonly StoredItem[],
  claims: readonly Claim[],
  kinds: KindTable,
  cap: Cap,
  turn?: number,
): { list: StoredItem[]; added: string[]; touched: string[]; repeats: string[]; changed: boolean } {
  const out: StoredItem[] = list.map(cloneRecord)
  const index = new Map<string, number>(out.map((r, i) => [r.key, i]))
  const known = new Set(index.keys())
  const added: string[] = []
  const touched = new Set<string>()
  const repeats = new Set<string>()
  let changed = false
  for (const claim of claims) {
    const kind = kinds(claim.category)
    if (!kind) continue
    const at = index.get(claim.key)
    if (at === undefined) {
      const rec = kind.merge(null, claim)
      if (rec === null) continue
      index.set(claim.key, out.length)
      out.push(turn === undefined ? rec : stamped(rec, turn, rec))
      added.push(claim.key)
      changed = true
      continue
    }
    const held = out[at]!
    const cur = kind.decode(held)
    if (cur === null) continue
    if (known.has(claim.key) && !touched.has(claim.key) && !repeats.has(claim.key))
      (turn !== undefined && held.lastTurn === turn ? repeats : touched).add(claim.key)
    const merged = kind.merge(cur, claim)
    let next: StoredItem | undefined = merged && merged !== cur ? merged : undefined
    if (turn !== undefined) {
      const base = next ?? held
      const marked = stamped(base, turn, held)
      if (marked !== base) next = marked
    }
    if (next) {
      out[at] = next
      changed = true
    }
  }
  return {
    list: enforceCap(out, cap, new Set(added), kinds),
    added,
    touched: [...touched],
    repeats: [...repeats],
    changed,
  }
}

/** Fold records with the same key (`a` first), then cap. The input records are copied. */
export function unionRecords(
  a: readonly StoredItem[],
  b: readonly StoredItem[],
  kinds: KindTable,
  cap: Cap,
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
  return enforceCap(out, cap, new Set(), kinds)
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
  cap: Cap,
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

// ---------------------------------------------------------------- migration and discovery

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

/**
 * Takes the reason `discovered` and `via` away from the given keys. A record left with no reason goes. A mark that a kind
 * keeps for itself (the `lane` marker of a PR the lane found) stays: core does not know it, and the kind reads it only
 * beside the reason `discovered`, so a mark left behind does nothing until the lane finds the item again.
 */
export function dropAuto<R extends StoredItem>(list: readonly R[], keys: ReadonlySet<string>): R[] {
  let changed = false
  const out: R[] = []
  for (const rec of list) {
    if (!keys.has(rec.key) || (!isDiscovered(rec) && rec.via === undefined)) {
      out.push(rec)
      continue
    }
    changed = true
    const reasons = dropReason(rec.reasons, 'discovered')
    if (reasons === undefined) continue
    const next = { ...rec, reasons } as Row
    delete next.via
    out.push(next as R)
  }
  return changed ? out : (list as R[])
}
