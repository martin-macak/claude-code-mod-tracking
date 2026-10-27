// Pure functions over lists of ItemRecord: conversion, merge, dedupe, caps, re-key (spec 6.2, 10).
// A test binding over the item kinds and the record algebra (plan L5, Tasks 4 and 15): each function keeps its old
// signature and forwards to `core/lib/records.ts` with the table of the five shipped kinds. Production code does not
// import it. No input list or record is mutated.

import type { Claim, JsonObject, StoredItem } from '../../core/interfaces/items'
import { GLOBAL_DEFAULTS } from '../../core/lib/global-config'
import {
  applyRefresh,
  carryOver as carryRecords,
  cloneRecord,
  enforceCap,
  foldRecords,
  type KindTable,
  MAX_PINNED,
  mergeClaims,
  migrateRecords,
  unionRecords as unionKinds,
} from '../../core/lib/records'
import { KINDS } from '../../trackers'
import { markArtifactDeleted } from '../../trackers/artifact/records'
import { fileRecord } from '../../trackers/file/kind'
import { resolveBareRefs as resolveBare } from '../../trackers/github/bare'
import { GitHubItem } from '../../trackers/github/github-item'
import { JiraItem } from '../../trackers/jira/jira-item'
import type { FileActivity, FileRecord, HydratedItem, ItemRecord, Ref, RepoRef, Sighting, Tools } from './contracts'
import { keyOf } from './keys'
import { reasonFor } from './reasons'

export { enforceCap, KINDS, MAX_PINNED, markArtifactDeleted }

const byCategory = new Map(KINDS.map(k => [k.category, k]))
const table: KindTable = category => byCategory.get(category)

/** The cap of the store, as a function of a list (`ItemStorePort.cap`): `max` records, no limit of a kind, every record ranks alike. */
export const capTo =
  (max: number) =>
  (list: StoredItem[]): StoredItem[] =>
    enforceCap(list, max, new Set(), () => undefined)

/** A ref as the kinds see it: the category, the key, where and when it was seen, and the ref fields. */
function claimOf(ref: Ref, s: Sighting): Claim {
  const { category, ...fields } = ref
  return {
    category,
    key: keyOf(ref),
    source: s.source,
    reason: s.reason ?? reasonFor(s.source),
    at: s.at,
    fields: fields as unknown as JsonObject,
  }
}

const typed = (list: readonly StoredItem[]): ItemRecord[] => list as unknown as ItemRecord[]

// ---------------------------------------------------------------- record from ref

export function recordFromRef(ref: Ref, s: Sighting): ItemRecord {
  return table(ref.category)!.merge(null, claimOf(ref, s)) as unknown as ItemRecord
}

/** One sighting of a Markdown file: `path` is where it landed, `label` the absolute path as spelled (issue #28). */
export function recordFromFile(
  hit: { path: string; label: string; kind: FileActivity; bySubagent: boolean },
  s: Sighting,
): FileRecord {
  return fileRecord(hit, s)
}

/** The record a claim makes, or null when its kind makes none (`ItemStorePort.build` over the shipped kinds). */
export function buildRecord(claim: Claim): StoredItem | null {
  return table(claim.category)?.merge(null, claim) ?? null
}

// ---------------------------------------------------------------- merge

export function mergeRefs(
  list: readonly ItemRecord[],
  refs: readonly Ref[],
  s: Sighting,
  cap: number = GLOBAL_DEFAULTS.store.maxItems,
): { list: ItemRecord[]; added: string[] } {
  const merged = mergeClaims(
    list,
    refs.map(ref => claimOf(ref, s)),
    table,
    cap,
  )
  return { list: typed(merged.list), added: merged.added }
}

/**
 * Adds file rows, or folds each into the row with the same key. The cap drops the smallest lastSeen, never a row
 * this call added. No rows: the list itself comes back (A22).
 */
export function mergeFiles(
  list: readonly ItemRecord[],
  recs: readonly FileRecord[],
  cap: number = GLOBAL_DEFAULTS.store.maxItems,
): ItemRecord[] {
  if (recs.length === 0) return list as ItemRecord[]
  const out: ItemRecord[] = list.map(cloneRecord)
  const index = new Map<string, number>(out.map((r, i) => [r.key, i]))
  const added = new Set<string>()
  for (const rec of recs) {
    const at = index.get(rec.key)
    if (at === undefined) {
      index.set(rec.key, out.length)
      out.push(cloneRecord(rec))
      added.add(rec.key)
      continue
    }
    const old = out[at]!
    if (old.category === 'file') out[at] = foldRecords(old, rec, table) as unknown as ItemRecord
  }
  return enforceCap(out, cap, added, table)
}

export function mergeResults(list: readonly ItemRecord[], refreshed: readonly ItemRecord[]): ItemRecord[] {
  return typed(applyRefresh(list, refreshed, table))
}

// ---------------------------------------------------------------- bare #N

export function resolveBareRefs(list: readonly ItemRecord[], repo: RepoRef): ItemRecord[] {
  return typed(resolveBare(list, repo))
}

// ---------------------------------------------------------------- re-key and carry-over

/**
 * Rows that an older version stored as web links move to Artifacts (R13), folded into a twin with the same key.
 * The input list comes back when no row moves.
 */
export function rekeyArtifacts(list: ItemRecord[]): ItemRecord[] {
  return typed(migrateRecords(list, KINDS))
}

/** Merge for `/clear` carry-over: fold records with the same key, then cap. */
export function unionRecords(
  a: readonly ItemRecord[],
  b: readonly ItemRecord[],
  cap: number = GLOBAL_DEFAULTS.store.maxItems,
): ItemRecord[] {
  return typed(unionKinds(a, b, table, cap))
}

/**
 * Merge for `/clear` carry-over. `held` is the live list; `stored`, the copy in the plugin store, can be up to `flushMs` older.
 * Records fold as in `unionRecords`, but a key that `held` has keeps its live marks, on the root and on each Jira
 * child: a reset or a lowered level must not lose to the higher mark of the older copy.
 */
export function carryOver(
  held: readonly ItemRecord[],
  stored: readonly ItemRecord[],
  cap: number = GLOBAL_DEFAULTS.store.maxItems,
): ItemRecord[] {
  return typed(carryRecords(held, stored, table, cap))
}

// ---------------------------------------------------------------- classes

/** How long a refreshed item stays current: all items, and a GitHub PR whose checks are still pending. */
export type Ttl = { staleMs: number; pendingStaleMs: number }

/** An item no tool refreshes: never due, never refreshed. Only the `hydrate` binding below builds it. */
function plainItem(rec: ItemRecord): HydratedItem {
  return {
    key: rec.key,
    category: rec.category,
    canRefresh: () => false,
    isDue: () => false,
    refresh: async () => {},
    toRecord: () => rec,
  } as HydratedItem
}

/**
 * `ttl` is how long an item stays current. It is read at each check; the default is today's. The item classes of the
 * two kinds that refresh take their tool from `tools`. No production code calls it since plan L5, Task 7: the coordinator's
 * lanes build items through `ItemKind.refresh.hydrate`. The registry, global-values and kinds tests still do.
 */
export function hydrate(rec: ItemRecord, tools: Tools, ttl?: () => Ttl): HydratedItem {
  const staleMs = ttl && (() => ttl().staleMs)
  switch (rec.category) {
    case 'github':
      return new GitHubItem(rec, tools.gh, staleMs, ttl && (() => ttl().pendingStaleMs))
    case 'jira':
      return new JiraItem(rec, tools.acli, staleMs)
    default:
      return plainItem(rec)
  }
}
