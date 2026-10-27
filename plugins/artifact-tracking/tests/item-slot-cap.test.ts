// The cap of a kind and its rank where a stored, carried or replayed list meets the live one (issue #57, R5): a /resume load, a
// /clear carry-over, a settle of the stored copy and the replay of a transcript. Each of them hands `d.cap()` and the kind
// table to the merge; a slip to the shared number alone, or a missing kind table, still type-checks and would keep more than
// `maxFiles` rows, or drop a written file before an older read. Pure: the store is a plain atom.
import { expect, test } from 'claude-code/testing'
import { itemSlot, type SlotDeps } from '../core/infra/item-slot'
import { ItemStore } from '../core/infra/item-store'
import type { Kinds } from '../core/infra/kinds'
import type { Claim, StoredItem } from '../core/interfaces/items'
import type { AtomPort } from '../core/interfaces/ports'
import type { Cap } from '../core/lib/records'
import { fileKey, fileKind, fileReason, fileRecord } from '../trackers/file/kind'
import type { FileActivity } from '../trackers/file/types'

/** The file cap of the test: far below the shared cap of 500. */
const MAX_FILES = 50
const cap = (): Cap => ({ total: 500, of: category => (category === 'file' ? MAX_FILES : undefined) })

const rec = (path: string, kind: 'viewed' | 'created', at: number): StoredItem =>
  fileRecord({ path, label: path, kind, bySubagent: false }, { source: 'tool', at }) as unknown as StoredItem
const claim = (path: string, activity: FileActivity, at: number): Claim => ({
  category: 'file',
  key: fileKey(path),
  source: 'tool',
  reason: fileReason(activity),
  at,
  fields: { path, label: path, activity },
})

/** One written file, the oldest, then 70 read files: more than maxFiles. */
const stored = (): StoredItem[] => [
  rec('/work/keep.ts', 'created', 1),
  ...Array.from({ length: 70 }, (_, i) => rec(`/work/r${i}.txt`, 'viewed', 10 + i)),
]
const claims = (): Claim[] => [
  claim('/work/keep.ts', 'created', 1),
  ...Array.from({ length: 70 }, (_, i) => claim(`/work/r${i}.txt`, 'viewed', 10 + i)),
]

const kinds = {
  table: (category: string) => (category === 'file' ? fileKind : undefined),
  all: [fileKind],
  onlyOn: (list: StoredItem[]) => list,
  liveKinds: () => [],
  isLive: (category: string) => category === 'file',
} as unknown as Kinds
const dismiss = { list: async () => new Set<string>(), add: async () => {} }

/** The store over a plain atom, and the slot over the store. */
function world() {
  let list: StoredItem[] = []
  const atom: AtomPort<StoredItem[]> = {
    get: async () => list,
    update: async fn => (list = fn(list)),
  }
  const store = new ItemStore({
    atom,
    kinds,
    dismiss,
    current: async () => 1,
    cap,
    persisted: () => {},
    kick: () => {},
    started: () => true,
  })
  const deps = { kinds, dismiss, cap, loading: () => {}, loaded: () => {} } as unknown as SlotDeps
  return { store, slot: itemSlot(store, deps), held: () => list }
}

/** How many rows are left, and whether the written file is one of them. */
const survivors = (list: readonly StoredItem[]) => [list.length, list.some(r => r.key === 'file:/work/keep.ts')]

test('a /resume load keeps the file cap, and the written file outlives the older reads', async () => {
  const t = world()
  await t.slot.restore(stored() as never, 'load')
  expect(survivors(t.held())).toEqual([MAX_FILES, true])
})

test('a /clear carry-over keeps the file cap and the rank', async () => {
  const t = world()
  await t.slot.restore(stored() as never, 'carry')
  expect(survivors(t.held())).toEqual([MAX_FILES, true])
})

test('a settle of the live list and the stored copy keeps the file cap and the rank', async () => {
  const t = world()
  const out = (await t.slot.settle!(
    stored().slice(0, 36) as never,
    stored().slice(36) as never,
  )) as unknown as StoredItem[]
  expect(survivors(out)).toEqual([MAX_FILES, true])
})

test('the replay of a transcript keeps the file cap and the rank when it meets the live list', async () => {
  const t = world()
  expect(await t.store.replayed(claims())).toBe(true)
  expect(survivors(t.held())).toEqual([MAX_FILES, true])
})

test('a list under the file cap is not touched by any of them', async () => {
  const few = stored().slice(0, 20)
  const t = world()
  await t.slot.restore(few as never, 'load')
  expect(t.held()).toHaveLength(20)
})
