// The generic record algebra over a kind table: merge claims, fold, cap, carry-over, refresh, migrate. Pure, one fake kind.
// Plan: L5 Task 4, K4, K5.
import { expect, test } from 'claude-code/testing'
import type { Claim, CoreReason, ItemKind, ReasonSet, StoredItem } from '../core/interfaces/items'
import { addReason, reasonSet } from '../core/lib/reasons'
import {
  applyRefresh,
  type BaseRecord,
  carryOver,
  cloneRecord,
  dropAuto,
  enforceCap,
  foldRecords,
  isAutoOnly,
  isDiscovered,
  type KindTable,
  MAX_PINNED,
  mergeClaims,
  migrateRecords,
  sighted,
  unionRecords,
} from '../core/lib/records'
import { DISCOVERED, reasonsOfSources } from './fixtures/reasons'

type TRec = BaseRecord & { category: 't'; n?: number; deep?: { list: number[] } }

const rec = (key: string, at: number, over: Partial<TRec> = {}): TRec => ({
  key,
  category: 't',
  url: key,
  label: key,
  sources: ['prompt'],
  reasons: reasonsOfSources(['prompt']),
  firstSeen: at,
  lastSeen: at,
  seenCount: 1,
  ...over,
})
const claim = (key: string, at: number, n?: number, category = 't'): Claim => ({
  category,
  key,
  source: 'prompt',
  reason: 'mentioned',
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
  row: i => ({ id: i.key, owner: 't', cells: {} }),
}
/** Moves a record of category `old` to `t`. */
const oldKind: ItemKind = {
  category: 'old',
  rank: 0,
  decode: item => (item.category === 'old' ? item : null),
  merge: cur => cur,
  row: i => ({ id: i.key, owner: 'old', cells: {} }),
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

test('mergeClaims says whether a claim changed anything: a kind that returns cur changes nothing', () => {
  const same: ItemKind<TRec> = {
    ...tKind,
    merge: (cur, seen) => (seen.fields.skip === true ? null : (cur ?? rec(seen.key, seen.at))),
  }
  const table: KindTable = c => (c === 't' ? same : undefined)
  const list = [rec('t:a', 1)]
  expect(mergeClaims(list, [claim('t:a', 2)], table, 100).changed).toBe(false)
  expect(mergeClaims(list, [claim('t:b', 2)], table, 100).changed).toBe(true)
  expect(mergeClaims(list, [claim('t:a', 2, 7)], kinds, 100).changed).toBe(true)
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

test('enforceCap evicts the smallest lastSeen, never a discovered record, never the newest 100 manual-high records', () => {
  const found = { sources: [], reasons: DISCOVERED }
  const list: StoredItem[] = [rec('t:a', 5), rec('t:b', 1), rec('t:c', 3), rec('t:auto', 0, found)]
  expect(enforceCap(list, 3)).toBe(list) // the auto-only record does not count
  expect(enforceCap(list, 2).map(x => x.key)).toEqual(['t:a', 't:c', 't:auto'])
  const manual = (i: number) => rec(`t:m${i}`, i, { priority: 'high' })
  const highs = Array.from({ length: MAX_PINNED + 3 }, (_, i) => manual(i + 10)) // lastSeen 10 to 112
  const all: StoredItem[] = [rec('t:auto2', 0, found), rec('t:old', 1), rec('t:keep', 2), ...highs]
  // 105 records count against a cap of 101: four go. Not the auto-only one, not t:keep, not the newest 100 manual-high.
  const out = enforceCap(all, MAX_PINNED + 1, new Set(['t:keep']))
  expect(out).toHaveLength(all.length - 4)
  expect(out.map(x => x.key)).toContain('t:auto2')
  expect(out.map(x => x.key)).toContain('t:keep')
  expect(out.map(x => x.key)).not.toContain('t:old')
  for (const gone of ['t:m10', 't:m11', 't:m12']) expect(out.map(x => x.key)).not.toContain(gone)
  for (const stays of highs.slice(3)) expect(out.map(x => x.key)).toContain(stays.key)
})

test('isAutoOnly and isDiscovered read the reasons, not the sources (issue #62)', () => {
  const both = addReason(reasonSet('mentioned'), 'discovered')
  // Discovery found it and nothing else did: no channel, one reason.
  expect(isAutoOnly(rec('t:a', 1, { sources: [], reasons: DISCOVERED }))).toBe(true)
  expect(isDiscovered(rec('t:a', 1, { sources: [], reasons: DISCOVERED }))).toBe(true)
  // A conversation named it too: found, but not auto-only. The channel is not what tells.
  expect(isAutoOnly(rec('t:a', 1, { sources: ['prompt'], reasons: both }))).toBe(false)
  expect(isDiscovered(rec('t:a', 1, { sources: ['prompt'], reasons: both }))).toBe(true)
  // A record with no source and no `discovered` is neither.
  expect(isAutoOnly(rec('t:a', 1, { sources: [], reasons: reasonSet('mentioned') }))).toBe(false)
  expect(isDiscovered(rec('t:a', 1))).toBe(false)
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

test('dropAuto takes `discovered` and via from the given keys; a record left with no reason goes', () => {
  const both = addReason(reasonSet('mentioned'), 'discovered')
  const list: StoredItem[] = [
    rec('t:a', 1, { sources: ['prompt'], reasons: both, via: ['k'] }),
    rec('t:b', 2, { sources: [], reasons: DISCOVERED, via: ['k'] }),
    rec('t:c', 3, { sources: ['prompt'], reasons: both }),
    rec('t:d', 4),
  ]
  const out = dropAuto(list, new Set(['t:a', 't:b', 't:d']))
  expect(out.map(x => x.key)).toEqual(['t:a', 't:c', 't:d'])
  expect(out[0]).toMatchObject({ sources: ['prompt'], reasons: reasonSet('mentioned') })
  expect('via' in out[0]!).toBe(false)
  expect(out[1]).toBe(list[2]!)
  const same = dropAuto(list, new Set(['t:d', 'none']))
  expect(same).toBe(list)
})

// ---------------------------------------------------------------- reasons (issue #62)

const why = (set: ReasonSet) => [set.first, set.all, set.strongest]

/** A kind whose merge is the generic one: a claim makes a record with its reason, a second claim is `sighted`. */
const sKind: ItemKind<TRec> = {
  ...tKind,
  merge: (cur, seen) =>
    cur === null
      ? rec(seen.key, seen.at, { sources: [seen.source], reasons: reasonSet(seen.reason) })
      : sighted(cur, seen),
}
const sTable: KindTable = category => (category === 't' ? sKind : undefined)
const withReason = (key: string, reason: CoreReason, at: number): Claim => ({ ...claim(key, at), reason })

test('reasons: a claim makes a record with its reason; a later claim adds its own and keeps `first`', () => {
  const out = mergeClaims(
    [],
    [withReason('t:a', 'mentioned', 1), withReason('t:a', 'read', 2), withReason('t:a', 'updated', 3)],
    sTable,
    100,
  )
  expect(why(out.list[0]!.reasons)).toEqual(['mentioned', ['updated', 'read', 'mentioned'], 'updated'])
  // The same reason again changes nothing in the set.
  const again = mergeClaims(out.list, [withReason('t:a', 'read', 4)], sTable, 100)
  expect(why(again.list[0]!.reasons)).toEqual(['mentioned', ['updated', 'read', 'mentioned'], 'updated'])
})

test('reasons: the order of the claims changes neither `all` nor `strongest`', () => {
  const claims = [
    withReason('t:a', 'discovered', 1),
    withReason('t:a', 'created', 2),
    withReason('t:a', 'mentioned', 3),
    withReason('t:a', 'read', 4),
  ]
  const forward = mergeClaims([], claims, sTable, 100).list[0]!.reasons
  const backward = mergeClaims([], [...claims].reverse(), sTable, 100).list[0]!.reasons
  expect(forward.all).toEqual(['created', 'read', 'discovered', 'mentioned'])
  expect(backward.all).toEqual(forward.all)
  expect(backward.strongest).toBe(forward.strongest)
  expect(forward.strongest).toBe('created')
})

test('reasons: a fold keeps the `first` of the record seen first and unions `all`, whatever the order', () => {
  const older = rec('t:a', 1, { reasons: reasonSet('read') })
  const newer = rec('t:a', 5, { reasons: addReason(reasonSet('mentioned'), 'updated') })
  const ab = foldRecords(older, newer, sTable)
  const ba = foldRecords(newer, older, sTable)
  expect(why(ab.reasons)).toEqual(['read', ['updated', 'read', 'mentioned'], 'updated'])
  expect(ba.reasons).toEqual(ab.reasons)
  expect(unionRecords([newer], [older], sTable, 100)[0]?.reasons).toEqual(ab.reasons)
})

test('reasons: a fold of two records seen at once keeps the `first` of `a`', () => {
  const a = rec('t:a', 3, { reasons: reasonSet('read') })
  const b = rec('t:a', 3, { reasons: reasonSet('created') })
  expect(why(foldRecords(a, b, sTable).reasons)).toEqual(['read', ['created', 'read'], 'created'])
  expect(why(foldRecords(b, a, sTable).reasons)).toEqual(['created', ['created', 'read'], 'created'])
})

test('reasons: dropAuto takes `discovered` away, `sources` stay as they are; a mention stays; an auto-only record goes', () => {
  const both = rec('t:a', 1, {
    sources: ['prompt'],
    reasons: addReason(reasonSet('mentioned'), 'discovered'),
  })
  const autoOnly = rec('t:b', 2, { sources: [], reasons: reasonSet('discovered') })
  const out = dropAuto([both, autoOnly], new Set(['t:a', 't:b']))
  expect(out.map(r => [r.key, r.sources, why(r.reasons)])).toEqual([
    ['t:a', ['prompt'], ['mentioned', ['mentioned'], 'mentioned']],
  ])
})

// ---------------------------------------------------------------- turns (issue #69)

test('turns: a claim made in a turn stamps firstTurn and lastTurn on a new record; a later turn moves lastTurn only', () => {
  const first = mergeClaims([], [claim('t:a', 1)], kinds, 100, 3)
  expect(first.list[0]).toMatchObject({ key: 't:a', firstTurn: 3, lastTurn: 3 })
  const later = mergeClaims(first.list, [claim('t:a', 2)], kinds, 100, 7)
  expect(later.list[0]).toMatchObject({ firstTurn: 3, lastTurn: 7 })
  // An older turn (late work of a subagent) lowers firstTurn and never raises lastTurn.
  const early = mergeClaims(later.list, [claim('t:a', 3)], kinds, 100, 1)
  expect(early.list[0]).toMatchObject({ firstTurn: 1, lastTurn: 7 })
})

test('turns: a claim with no turn stamps nothing, and leaves the stamps of a known record', () => {
  const plain = mergeClaims([], [claim('t:a', 1)], kinds, 100)
  expect('firstTurn' in plain.list[0]!).toBe(false)
  expect('lastTurn' in plain.list[0]!).toBe(false)
  const stamped = mergeClaims(plain.list, [claim('t:a', 2)], kinds, 100, 4).list
  const again = mergeClaims(stamped, [claim('t:a', 3)], kinds, 100)
  expect(again.list[0]).toMatchObject({ firstTurn: 4, lastTurn: 4 })
})

test('turns: a kind that keeps no unknown field still gets the stamps, read from the list record', () => {
  const lossy: ItemKind<TRec> = {
    ...tKind,
    merge: (cur, seen) => (cur === null ? rec(seen.key, seen.at) : rec(cur.key, seen.at)),
  }
  const table: KindTable = c => (c === 't' ? lossy : undefined)
  const one = mergeClaims([], [claim('t:a', 1)], table, 100, 2).list
  const two = mergeClaims(one, [claim('t:a', 2)], table, 100, 5)
  expect(two.list[0]).toMatchObject({ firstTurn: 2, lastTurn: 5 })
})

test('turns: mergeClaims lists the known keys a claim touched, also when the kind returned cur; an added key is not touched', () => {
  const same: ItemKind<TRec> = {
    ...tKind,
    merge: (cur, seen) => (seen.fields.skip === true ? null : (cur ?? rec(seen.key, seen.at))),
  }
  const table: KindTable = c => (c === 't' ? same : undefined)
  const list = [rec('t:a', 1), rec('t:b', 1)]
  const r = mergeClaims(list, [claim('t:a', 2), claim('t:c', 2), claim('t:c', 3), claim('t:a', 4)], table, 100)
  expect(r.added).toEqual(['t:c'])
  expect(r.touched).toEqual(['t:a']) // once, and not t:c: it was new in this call
  expect(r.changed).toBe(true)
  const none = mergeClaims(list, [claim('t:a', 2)], table, 100)
  expect(none.touched).toEqual(['t:a'])
  expect(none.changed).toBe(false) // nothing to write, and the touch is still reported
})

test('turns: a known key that the same turn stamped already is a repeat, apart from the first sighting of the turn', () => {
  const same: ItemKind<TRec> = { ...tKind, merge: (cur, seen) => cur ?? rec(seen.key, seen.at) }
  const table: KindTable = c => (c === 't' ? same : undefined)
  const first = mergeClaims([rec('t:a', 1), rec('t:b', 1)], [claim('t:a', 2)], table, 100, 3)
  expect(first.touched).toEqual(['t:a']) // turn 3 stamped t:a: a first sighting
  expect(first.repeats).toEqual([])
  const next = mergeClaims(
    first.list,
    [claim('t:a', 3), claim('t:b', 3), claim('t:b', 4), claim('t:c', 3)],
    table,
    100,
    3,
  )
  expect(next.repeats).toEqual(['t:a']) // stamped by turn 3 before this call
  expect(next.touched).toEqual(['t:b']) // not yet, and named twice: one sighting
  expect(next.added).toEqual(['t:c'])
  // The key that a call added is a repeat in the next call of the same turn, and a first sighting in a later turn.
  expect(mergeClaims(next.list, [claim('t:c', 5)], table, 100, 3).repeats).toEqual(['t:c'])
  const later = mergeClaims(next.list, [claim('t:c', 6)], table, 100, 4)
  expect([later.repeats, later.touched]).toEqual([[], ['t:c']])
  // Late work of an older turn is not a repeat: lastTurn is the larger one.
  const late = mergeClaims(next.list, [claim('t:a', 7)], table, 100, 2)
  expect([late.repeats, late.touched]).toEqual([[], ['t:a']])
  // No turn, no repeat.
  const plain = mergeClaims(next.list, [claim('t:a', 8)], table, 100)
  expect([plain.repeats, plain.touched]).toEqual([[], ['t:a']])
})

test('turns: a stamp that changes nothing is not a change', () => {
  const same: ItemKind<TRec> = { ...tKind, merge: (cur, seen) => cur ?? rec(seen.key, seen.at) }
  const table: KindTable = c => (c === 't' ? same : undefined)
  const list = mergeClaims([], [claim('t:a', 1)], table, 100, 4).list
  expect(mergeClaims(list, [claim('t:a', 2)], table, 100, 4).changed).toBe(false)
  expect(mergeClaims(list, [claim('t:a', 2)], table, 100, 5).changed).toBe(true)
})

test('turns: a record the kind cannot decode is neither touched nor stamped', () => {
  const odd = { ...rec('t:a', 1), category: 'u' } as unknown as StoredItem
  const table: KindTable = c => (c === 'u' || c === 't' ? tKind : undefined)
  const bad: ItemKind<TRec> = { ...tKind, decode: () => null }
  const r = mergeClaims([odd], [claim('t:a', 2, undefined, 'u')], c => (c === 'u' ? bad : table(c)), 100, 6)
  expect(r.touched).toEqual([])
  expect('lastTurn' in r.list[0]!).toBe(false)
})

test('turns: foldRecords keeps the smallest firstTurn and the largest lastTurn, and a record with none leaves the other', () => {
  const a = rec('t:a', 1, { firstTurn: 3, lastTurn: 5 })
  const b = rec('t:a', 2, { firstTurn: 1, lastTurn: 4 })
  expect(foldRecords(a, b, kinds)).toMatchObject({ firstTurn: 1, lastTurn: 5 })
  const bare = rec('t:a', 2)
  expect(foldRecords(a, bare, kinds)).toMatchObject({ firstTurn: 3, lastTurn: 5 })
  expect(foldRecords(bare, a, kinds)).toMatchObject({ firstTurn: 3, lastTurn: 5 })
  const none = foldRecords(rec('t:a', 1), bare, kinds)
  expect('firstTurn' in none).toBe(false)
  expect('lastTurn' in none).toBe(false)
})

test('turns: applyRefresh stamps nothing and keeps the turns of the record', () => {
  const cur = rec('t:a', 1, { firstTurn: 2, lastTurn: 3 })
  const fresh = rec('t:a', 9, { refreshedAt: 50, firstTurn: 9, lastTurn: 9 })
  const out = applyRefresh([cur], [fresh], kinds)
  expect(out[0]).toMatchObject({ refreshedAt: 50, firstTurn: 2, lastTurn: 3 })
})
