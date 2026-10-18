// The priority of a tracked item, from the kinds. The levels of the whole list (the person's marks, then the rules of the
// kinds in stages), the mark of a row, and the row a ref names. Pure: no `$`, no I/O, no kind named.
// A record's `priority` is the person's manual mark only. A rule gives a level that is not stored (`auto`).
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.9. Plan: L5 Task 6, K6.

import type { Effective, ItemKind, KindContext, Priority, RuleEnv, StoredItem } from '../interfaces/items'
import type { FactsPort } from '../interfaces/tracker'
import { withPriority } from '../lib/levels'
import type { KindTable } from '../lib/records'
import { scanClaims } from './capture'

/** The item with the mark set, or without the key when `level` is undefined. */
const marked = (item: StoredItem, level: Priority | undefined): StoredItem =>
  withPriority(item as StoredItem & { priority?: Priority }, level)

/**
 * The level of every item, by key. A manual mark wins. Else the rules of the item's kind run stage by stage, lowest
 * first, and the first rule that answers gives an auto level. A rule of stage N reads the levels of stages below N
 * (and every manual mark) through `env.levelOf`, so an issue can take the level of the PR that closes it. An item no
 * rule answers for has `{}`. A list is read once per stage, and the work stays linear in its size.
 */
export function effectiveLevels(
  items: readonly StoredItem[],
  kinds: KindTable,
  facts: Pick<FactsPort, 'read'>,
): Map<string, Effective> {
  const out = new Map<string, Effective>()
  const stages = new Set<number>()
  for (const item of items) {
    if (item.priority !== undefined) out.set(item.key, { level: item.priority })
    else for (const rule of kinds(item.category)?.rules ?? []) stages.add(rule.stage)
  }
  const env: RuleEnv = { facts, items, levelOf: key => out.get(key)?.level }
  for (const stage of [...stages].sort((a, b) => a - b)) {
    for (const item of items) {
      if (out.has(item.key)) continue
      for (const rule of kinds(item.category)?.rules ?? []) {
        if (rule.stage !== stage) continue
        const level = rule.level(item, env)
        if (level === undefined) continue
        out.set(item.key, { level, auto: true })
        break
      }
    }
  }
  for (const item of items) if (!out.has(item.key)) out.set(item.key, {})
  return out
}

/**
 * The list with the mark on row `rowId` set to `level`, or removed when `level` is undefined. `rowId` is an item key,
 * or a row inside an item that its kind knows (`setLevel` of the kind). An item with that very key wins over an item
 * whose key prefixes it. An unknown id, or a mark that does not change, gives the input list.
 */
export function setLevel(
  list: readonly StoredItem[],
  rowId: string,
  level: Priority | undefined,
  kinds: KindTable,
): StoredItem[] {
  const same = list as StoredItem[]
  const swap = (i: number, next: StoredItem): StoredItem[] => list.map((r, j) => (j === i ? next : r))
  const own = list.findIndex(r => r.key === rowId)
  if (own >= 0) {
    const item = list[own]!
    return item.priority === level ? same : swap(own, marked(item, level))
  }
  const i = list.findIndex(r => rowId.startsWith(`${r.key}/`) && kinds(r.category)?.setLevel !== undefined)
  if (i < 0) return same
  const kind = kinds(list[i]!.category)!
  const typed = kind.decode(list[i]!)
  const next = typed && kind.setLevel?.(typed, rowId, level)
  return next && next !== typed ? swap(i, next) : same
}

/**
 * The row id a ref names, or undefined when it names no tracked row. A kind may name a row inside one of its items
 * (`findRow`). Else the ref is read as the capture reads a lookup text, and the first claim names the row when the
 * list holds its key.
 */
export function rowIdOf(
  list: readonly StoredItem[],
  ref: string,
  kinds: readonly ItemKind[],
  ctx: KindContext,
): string | undefined {
  const byCategory = new Map(kinds.map(kind => [kind.category, kind]))
  for (const item of list) {
    const kind = byCategory.get(item.category)
    const typed = kind?.decode(item)
    const row = typed ? kind?.findRow?.(typed, ref) : undefined
    if (row !== undefined) return row
  }
  const [first] = scanClaims(ref, 'full', kinds, { ...ctx, purpose: 'lookup' })
  return first && list.some(item => item.key === first.key) ? first.key : undefined
}
