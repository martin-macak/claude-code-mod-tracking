// The generic record algebra over a kind table: merge claims, fold, cap, carry-over, refresh, migrate. Pure, one fake kind.
// Plan: L5 Task 4, K4, K5.
import { expect, test } from 'claude-code/testing'
import type { Claim, ItemKind, StoredItem } from '../core/interfaces/items'
import {
  AUTO_SOURCES,
  applyRefresh,
  type BaseRecord,
  carryOver,
  cloneRecord,
  dropAuto,
  enforceCap,
  foldRecords,
  isAutoOnly,
  type KindTable,
  MAX_PINNED,
  mergeClaims,
  migrateRecords,
  unionRecords,
} from '../core/lib/records'

type TRec = BaseRecord & { category: 't'; n?: number; deep?: { list: number[] } }

const rec = (key: string, at: number, over: Partial<TRec> = {}): TRec => ({
  key,
  category: 't',
  url: key,
  label: key,
  sources: ['prompt'],
  firstSeen: at,
  lastSeen: at,
  seenCount: 1,
  ...over,
})
const claim = (key: string, at: number, n?: number, category = 't'): Claim => ({
  category,
  key,
  source: 'prompt',
  at,
  fields: n === undefined ? {} : { n },
})

const folds: string[] = []
/** The fake kind: `merge` sets `n` from the claim, a claim with `skip` adds nothing, `fold` records what it saw. */
const tKind: ItemKind<TRec> = {
  category: 't',
  rank: 1,
  decode: item => (item.category === 't' ? (item as TRec) : null),
  merge(cur, seen) {
    if (seen.fields.skip === true) return null
    const n = typeof seen.fields.n === 'number' ? seen.fields.n : undefined
    if (cur === null) return rec(seen.key, seen.at, n === undefined ? {} : { n })
    return { ...cur, seenCount: cur.seenCount + 1, lastSeen: seen.at, ...(n === undefined ? {} : { n }) }
  },
  fold(winner, loser, out) {
    folds.push(`${winner.key}:${out.seenCount}:${winner.n ?? '-'}:${loser.n ?? '-'}`)
    return out
  },
  refresh: {
    tool: 'x',
    fields: ['title', 'deep'],
    hydrate: () => {
      throw new Error('not used')
    },
    refreshItems: async () => {},
    apply: (out, fresh) => ({ ...out, n: fresh.n ?? out.n }),
  },
  keepMarks: (merged, live) => ({ ...merged, n: live.n }),
}
/** Moves a record of category `old` to `t`. */
const oldKind: ItemKind = {
  category: 'old',
  rank: 0,
  decode: item => (item.category === 'old' ? item : null),
  merge: cur => cur,
}
const mover: ItemKind = {
  ...tKind,
  migrate: item =>
    item.category === 'old' ? { ...rec(String(item.key).replace('old:', 't:'), item.firstSeen), url: 'moved' } : null,
}
const kinds: KindTable = c => (c === 't' ? tKind : undefined)

test('mergeClaims adds a new key once and reports it in added; the input list is not mutated', () => {
  const list = [rec('t:a', 1)]
  const copy = JSON.parse(JSON.stringify(list)) as StoredItem[]
  const r = mergeClaims(list, [claim('t:b', 2, 7), claim('t:b', 3, 8), claim('t:a', 4)], kinds, 100)
  expect(r.added).toEqual(['t:b'])
  expect(r.list.map(x => x.key)).toEqual(['t:a', 't:b'])
  expect(r.list[1]).toMatchObject({ n: 8, seenCount: 2, lastSeen: 3 })
  expect(r.list[0]).toMatchObject({ seenCount: 2, lastSeen: 4 })
  expect(list).toEqual(copy)
  expect(r.list[0]).not.toBe(list[0])
})

test('a merge that returns null adds nothing', () => {
  const list = [rec('t:a', 1)]
  const r = mergeClaims(list, [{ ...claim('t:x', 2), fields: { skip: true } }], kinds, 100)
  expect(r.added).toEqual([])
  expect(r.list).toEqual(list)
})

test('mergeClaims skips a claim of a category no kind owns, and copies every record even with no claim', () => {
  const list = [rec('t:a', 1, { deep: { list: [1] } })]
  const r = mergeClaims(list, [claim('z:1', 2, undefined, 'z')], kinds, 100)
  expect(r.added).toEqual([])
  expect(r.list).toEqual(list)
  expect(r.list[0]).not.toBe(list[0])
  expect((r.list[0] as TRec).deep).not.toBe(list[0]!.deep)
  expect((r.list[0] as TRec).deep?.list).not.toBe(list[0]!.deep?.list)
})

test('mergeClaims keeps a record the kind cannot decode as it is', () => {
  const odd = { ...rec('t:a', 1), category: 'u' } as unknown as StoredItem
  const table: KindTable = c => (c === 'u' || c === 't' ? tKind : undefined)
  const r = mergeClaims([odd], [claim('t:a', 2, undefined, 'u')], table, 100)
  expect(r.list).toEqual([odd])
})

test('foldRecords takes status from the newer refreshedAt and runs the kind fold last', () => {
  folds.length = 0
  const a = rec('t:a', 1, { n: 1, sources: ['prompt'], refreshedAt: 5, via: ['v1'], priority: 'low' })
  const b = rec('t:a', 4, { n: 2, sources: ['tool', 'prompt'], refreshedAt: 9, via: ['v2', 'v1'], priority: 'high' })
  const out = foldRecords(a, b, kinds) as TRec
  expect(out).toMatchObject({
    n: 2,
    refreshedAt: 9,
    sources: ['prompt', 'tool'],
    via: ['v1', 'v2'],
    seenCount: 2,
    firstSeen: 1,
    lastSeen: 4,
    priority: 'high',
  })
  const three = foldRecords(rec('t:a', 1, { seenCount: 1 }), rec('t:a', 2, { seenCount: 2 }), kinds)
  expect(three.seenCount).toBe(3)
  expect(folds).toEqual(['t:a:2:2:1', 't:a:3:-:-'])
  // A tie keeps `a`, and no via on either side leaves none.
  const tie = foldRecords(rec('t:a', 1, { n: 1 }), rec('t:a', 1, { n: 2 }), kinds) as TRec
  expect(tie.n).toBe(1)
  expect('via' in tie).toBe(false)
  expect('priority' in tie).toBe(false)
})

test('foldRecords with no kind for the category gives the generic fold', () => {
  const out = foldRecords(rec('t:a', 1), rec('t:a', 2), () => undefined)
  expect(out).toMatchObject({ seenCount: 2, sources: ['prompt'], lastSeen: 2 })
})

test('enforceCap evicts the smallest lastSeen, never an auto source, never the newest 100 manual-high records', () => {
  const list: StoredItem[] = [rec('t:a', 5), rec('t:b', 1), rec('t:c', 3), rec('t:auto', 0, { sources: ['auto'] })]
  expect(enforceCap(list, 3)).toBe(list) // the auto-only record does not count
  expect(enforceCap(list, 2).map(x => x.key)).toEqual(['t:a', 't:c', 't:auto'])
  const manual = (i: number) => rec(`t:m${i}`, i, { priority: 'high' })
  const highs = Array.from({ length: MAX_PINNED + 3 }, (_, i) => manual(i + 10)) // lastSeen 10 to 112
  const all: StoredItem[] = [rec('t:auto2', 0, { sources: ['pr-body'] }), rec('t:old', 1), rec('t:keep', 2), ...highs]
  // 105 records count against a cap of 101: four go. Not the auto-only one, not t:keep, not the newest 100 manual-high.
  const out = enforceCap(all, MAX_PINNED + 1, new Set(['t:keep']))
  expect(out).toHaveLength(all.length - 4)
  expect(out.map(x => x.key)).toContain('t:auto2')
  expect(out.map(x => x.key)).toContain('t:keep')
  expect(out.map(x => x.key)).not.toContain('t:old')
  for (const gone of ['t:m10', 't:m11', 't:m12']) expect(out.map(x => x.key)).not.toContain(gone)
  for (const stays of highs.slice(3)) expect(out.map(x => x.key)).toContain(stays.key)
})

test('isAutoOnly and AUTO_SOURCES', () => {
  expect([...AUTO_SOURCES].sort()).toEqual(['auto', 'pr-body'])
  expect(isAutoOnly(rec('t:a', 1, { sources: ['auto', 'pr-body'] }))).toBe(true)
  expect(isAutoOnly(rec('t:a', 1, { sources: ['auto', 'prompt'] }))).toBe(false)
  expect(isAutoOnly(rec('t:a', 1, { sources: [] }))).toBe(false)
})

test('cloneRecord copies nested arrays and objects and leaves out undefined keys', () => {
  const r = rec('t:a', 1, { deep: { list: [1, 2] }, error: { kind: 'failed', message: 'm', at: 1 }, via: ['v'] })
  ;(r as Record<string, unknown>).gone = undefined
  const c = cloneRecord(r)
  expect(c).toEqual(r)
  expect(c.sources).not.toBe(r.sources)
  expect(c.deep).not.toBe(r.deep)
  expect(c.error).not.toBe(r.error)
  expect('gone' in c).toBe(false)
})

test('unionRecords folds records of one key, a first, then caps', () => {
  const out = unionRecords([rec('t:a', 1), rec('t:b', 5)], [rec('t:a', 3), rec('t:c', 9)], kinds, 2)
  expect(out.map(x => x.key)).toEqual(['t:b', 't:c'])
  const all = unionRecords([rec('t:a', 1)], [rec('t:a', 3)], kinds, 10)
  expect(all[0]).toMatchObject({ seenCount: 2, lastSeen: 3 })
})

test('carryOver: a key the live list holds keeps its live mark and the kind marks', () => {
  const held = [rec('t:a', 1, { n: 4 })]
  const stored = [rec('t:a', 2, { priority: 'high', n: 9 }), rec('t:b', 3, { priority: 'low' })]
  const out = carryOver(held, stored, kinds, 10)
  expect('priority' in out[0]!).toBe(false) // the live copy has no mark, the older stored one must not bring it back
  expect(out[0]).toMatchObject({ n: 4 })
  expect(out[1]).toMatchObject({ key: 't:b', priority: 'low' })
  expect(unionRecords(held, stored, kinds, 10)[0]?.priority).toBe('high')
  const noMarks = carryOver([rec('t:a', 1, { priority: 'low' })], [], () => undefined, 10)
  expect(noMarks[0]?.priority).toBe('low')
})

test("applyRefresh writes only the kind's status fields and drops a not-found key", () => {
  const cur = rec('t:a', 1, { n: 1, error: { kind: 'failed', message: 'x', at: 1 }, seenCount: 4 })
  const fresh = rec('t:a', 9, { n: 2, refreshedAt: 50, deep: { list: [3] } })
  Object.assign(fresh, { title: 'T', url: 'WRONG', seenCount: 1 })
  const gone = rec('t:g', 1)
  const goneFresh = rec('t:g', 1, { error: { kind: 'not-found', message: 'gone', at: 5 } })
  const other = rec('t:o', 1)
  const out = applyRefresh([cur, gone, other], [fresh, goneFresh], kinds)
  expect(out.map(x => x.key)).toEqual(['t:a', 't:o'])
  const a = out[0] as TRec & { title?: string }
  expect(a).toMatchObject({ title: 'T', refreshedAt: 50, seenCount: 4, url: 't:a', n: 2 })
  expect(a.deep).toEqual({ list: [3] })
  expect(a.deep).not.toBe(fresh.deep)
  expect('error' in a).toBe(false)
  expect(out[1]).toEqual(other)
  expect(out[1]).not.toBe(other)
})

test('applyRefresh keeps a failed error, and a kind with no refresh spec takes nothing but time and error', () => {
  const cur = rec('t:a', 1)
  const fresh = rec('t:a', 1, { refreshedAt: 7, error: { kind: 'failed', message: 'boom', at: 7 } })
  const out = applyRefresh([cur], [fresh], () => undefined)
  expect(out[0]).toMatchObject({ refreshedAt: 7, error: { kind: 'failed', message: 'boom' } })
  expect(out[0]!.error).not.toBe(fresh.error)
  // A record the refresh did not return is copied as it is.
  expect(applyRefresh([cur], [], kinds)[0]).toEqual(cur)
})

test('migrateRecords moves a record to the kind that claims it and folds it into its twin; no move gives the same list', () => {
  const table = [oldKind, mover]
  const plain = [rec('t:a', 1), rec('t:b', 2)]
  expect(migrateRecords(plain, table)).toBe(plain)
  const moving: StoredItem[] = [
    { ...rec('old:a', 1), category: 'old' },
    rec('t:x', 2),
    rec('t:a', 3, { sources: ['tool'] }),
    { ...rec('old:b', 4), category: 'old' },
  ]
  const input = JSON.parse(JSON.stringify(moving)) as StoredItem[]
  const out = migrateRecords(moving, table)
  expect(out.map(x => x.key)).toEqual(['t:a', 't:x', 't:b'])
  expect(out[0]).toMatchObject({ category: 't', seenCount: 2, sources: ['prompt', 'tool'], firstSeen: 1, lastSeen: 3 })
  expect(out[2]).toMatchObject({ category: 't', url: 'moved' })
  expect(moving).toEqual(input)
})

test('dropAuto removes auto sources and via from the given keys; a record left with no source goes', () => {
  const list: StoredItem[] = [
    rec('t:a', 1, { sources: ['prompt', 'auto'], via: ['k'] }),
    rec('t:b', 2, { sources: ['pr-body'], via: ['k'] }),
    rec('t:c', 3, { sources: ['prompt', 'auto'] }),
    rec('t:d', 4),
  ]
  const out = dropAuto(list, new Set(['t:a', 't:b', 't:d']))
  expect(out.map(x => x.key)).toEqual(['t:a', 't:c', 't:d'])
  expect(out[0]).toMatchObject({ sources: ['prompt'] })
  expect('via' in out[0]!).toBe(false)
  expect(out[1]).toBe(list[2]!)
  const same = dropAuto(list, new Set(['t:d', 'none']))
  expect(same).toBe(list)
})
