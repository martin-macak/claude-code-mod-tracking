// The rows, the section and the prompt lines of the file tracker (issue #57): the type cell and `facets.kind`, the status,
// a dim row for a file that was only read, the sort (level, written first, type, path), the band and the note, and the count
// line of the read-only files. Pure: the record and the view context are plain values.
import { expect, test } from 'claude-code/testing'
import type { Effective, Json, StoredItem } from '../core/interfaces/items'
import type { ViewContext } from '../core/interfaces/view'
import { reasonSet } from '../core/lib/reasons'
import { fileRank } from '../trackers/file/activity'
import type { FileConfig } from '../trackers/file/config'
import { fileKind, fileRecord } from '../trackers/file/kind'
import { filePrompt } from '../trackers/file/prompt'
import { fileRow } from '../trackers/file/rows'
import { sections } from '../trackers/file/sections'
import type { FileActivity, FileRecord } from '../trackers/file/types'

/** A file record as the kind makes it from one sighting; `over` changes the fields a test cares about. */
const file = (path: string, kind: FileActivity, over: Partial<FileRecord> = {}, at = 1): FileRecord => ({
  ...fileRecord({ path, label: path, kind, bySubagent: false }, { source: 'tool', at }),
  ...over,
})
const NO_LEVEL: Effective = {}
const env = { levelOf: () => NO_LEVEL, root: '/work' }
const row = (rec: FileRecord) => fileRow(rec, env)
const text = (r: ReturnType<typeof row>, id: 'name' | 'description' | 'type' | 'status') => r.cells[id]?.text

// ---------------------------------------------------------------- the row

test('the type cell holds the type word and facets.kind holds the same word', () => {
  const cases: [string, string][] = [
    ['/work/src/a.ts', 'code'],
    ['/work/package.json', 'config'],
    ['/work/README.md', 'docs'],
    ['/work/data.csv', 'data'],
    ['/work/index.html', 'markup'],
    ['/work/img.png', 'image'],
    ['/work/noext', 'other'],
  ]
  for (const [path, type] of cases) {
    const r = row(file(path, 'edited', { edits: 1 }))
    expect([path, text(r, 'type'), r.facets?.kind]).toEqual([path, type, type])
  }
})

test('a file the map does not know takes the type of its cached MIME type', () => {
  expect(text(row(file('/work/run', 'edited', { edits: 1 })), 'type')).toBe('other')
  expect(text(row(file('/work/run', 'edited', { edits: 1, mime: 'text/x-script.python' })), 'type')).toBe('code')
  expect(row(file('/work/run', 'edited', { edits: 1, mime: 'text/x-script.python' })).facets?.kind).toBe('code')
  expect(text(row(file('/work/run', 'edited', { edits: 1, mime: 'unknown' })), 'type')).toBe('other')
})

test('the status cell says deleted, created or edited N; a file that was only named or only read has none', () => {
  expect(text(row(file('/work/a.ts', 'deleted')), 'status')).toBe('deleted')
  expect(text(row(file('/work/a.ts', 'created')), 'status')).toBe('created')
  expect(text(row(file('/work/a.ts', 'edited', { edits: 3 })), 'status')).toBe('edited 3')
  expect(text(row(file('/work/a.ts', 'mentioned')), 'status')).toBe('') // the reason `mentioned` is in the reasons
  expect(text(row(file('/work/a.ts', 'viewed')), 'status')).toBe('')
  // deleted wins over created, and created over edited.
  expect(text(row(file('/work/a.ts', 'created', { deleted: true, edits: 1 })), 'status')).toBe('deleted')
  expect(text(row(file('/work/a.ts', 'created', { edits: 2, mentions: 1 })), 'status')).toBe('created')
  expect(text(row(file('/work/a.ts', 'edited', { edits: 2, mentions: 1 })), 'status')).toBe('edited 2')
})

test('the badges: edited N when the status says more, viewed N, and the mark subagent; the type cell never says created', () => {
  const made = file('/work/a.ts', 'created', { edits: 3, views: 2, bySubagent: true })
  const r = row(made)
  expect(r.extras?.map(b => b.text)).toEqual(['edited 3 viewed 2', 'subagent'])
  expect(r.extras?.at(-1)).toEqual({ text: 'subagent', dim: true })
  expect(text(r, 'type')).toBe('code')
  expect(row(file('/work/a.ts', 'edited', { edits: 3, views: 2 })).extras?.map(b => b.text)).toEqual(['viewed 2'])
  expect(row(file('/work/a.ts', 'viewed', { views: 1 })).extras?.map(b => b.text)).toEqual(['viewed 1'])
  expect(row(file('/work/a.ts', 'created')).extras).toBeUndefined()
  expect(row(file('/work/a.ts', 'deleted', { edits: 2 })).extras?.map(b => b.text)).toEqual(['edited 2'])
})

test('a row is dim unless the file was written; the row sets no quiet mark: the section names the rows the text leaves out', () => {
  const read = row(file('/work/a.ts', 'viewed', { views: 1 }))
  expect([read.dim, read.quiet]).toEqual([true, undefined])
  const named = row(file('/work/a.ts', 'mentioned'))
  expect([named.dim, named.quiet]).toEqual([true, undefined])
  for (const written of [
    file('/work/a.ts', 'created'),
    file('/work/a.ts', 'edited', { edits: 1 }),
    file('/work/a.ts', 'deleted'),
    file('/work/a.ts', 'viewed', { views: 3, edits: 1 }),
  ]) {
    const r = row(written)
    expect([written.key, r.dim, r.quiet]).toEqual([written.key, undefined, undefined])
  }
})

test('the name, the folder below the session root, the mark and the dismiss key are as before', () => {
  const r = row(file('/work/docs/plan.md', 'created'))
  expect(r.cells.name).toEqual({ text: 'plan.md', clip: 'middle' })
  expect(text(r, 'description')).toBe('docs')
  expect(r.cells.description?.clip).toBe('middle')
  expect(r.id).toBe('file:/work/docs/plan.md')
  expect(r.owner).toBe('file')
  expect(r.can).toEqual({ dismiss: true, priority: true })
  expect(r.reasons).toEqual(reasonSet('created'))
  expect(text(fileRow(file('/home/u/x.ts', 'created'), { levelOf: () => NO_LEVEL, root: undefined }), 'name')).toBe(
    'x.ts',
  )
})

// ---------------------------------------------------------------- the section

function ctxOf(recs: readonly FileRecord[], levels: Record<string, Effective> = {}): ViewContext<FileConfig, Json> {
  return {
    items: recs as unknown as readonly StoredItem[],
    levelOf: (key: string) => levels[key] ?? NO_LEVEL,
    root: '/work',
  } as unknown as ViewContext<FileConfig, Json>
}
const sec = (recs: readonly FileRecord[], levels?: Record<string, Effective>) => sections(ctxOf(recs, levels))[0]!
const names = (recs: readonly FileRecord[], levels?: Record<string, Effective>) =>
  sec(recs, levels).rows.map(r => r.cells.name?.text)

test('no file record gives no section', () => {
  expect(sections(ctxOf([]))).toEqual([])
  expect(sections(ctxOf([{ key: 'web:x', category: 'web' } as unknown as FileRecord]))).toEqual([])
})

test('the sort: level, then written before named before read, then type, then path', () => {
  const recs = [
    file('/work/z-read.ts', 'viewed', { views: 1 }),
    file('/work/b.png', 'edited', { edits: 1 }),
    file('/work/a-note.md', 'mentioned'),
    file('/work/b.ts', 'edited', { edits: 1 }),
    file('/work/a.ts', 'created'),
    file('/work/c.md', 'edited', { edits: 1 }),
    file('/work/a-read.md', 'viewed', { views: 1 }),
    file('/work/gone.json', 'deleted'),
  ]
  // Written: code (a.ts, b.ts), docs (c.md), data (gone.json), image (b.png). Named: a-note.md. Read: code, then docs.
  expect(names(recs)).toEqual(['a.ts', 'b.ts', 'c.md', 'gone.json', 'b.png', 'a-note.md', 'z-read.ts', 'a-read.md'])
  // A level beats the rest: a read-only file that the person marked high comes first.
  expect(names(recs, { 'file:/work/z-read.ts': { level: 'high' } })[0]).toBe('z-read.ts')
  // The first sighting does not decide: a file seen last sorts by its type and path.
  const late = file('/work/a.ts', 'edited', { edits: 1 }, 99)
  const early = file('/work/b.ts', 'edited', { edits: 1 }, 1)
  expect(names([early, late])).toEqual(['a.ts', 'b.ts'])
})

test('the band counts the written, deleted and named files; the note adds the count of the read ones', () => {
  const written = [file('/work/a.ts', 'created'), file('/work/b.ts', 'deleted'), file('/work/c.ts', 'mentioned')]
  const only = sec(written)
  expect(only.title).toBe('Files')
  expect(only.note).toEqual({ text: '3 files' })
  expect(only.band).toEqual({ label: 'Files', count: 3, failing: 0, rank: 5 })
  expect(only.textMore).toBeUndefined()
  const mixed = sec([
    ...written,
    file('/work/r1.ts', 'viewed', { views: 1 }),
    file('/work/r2.ts', 'viewed', { views: 4 }),
  ])
  expect(mixed.note).toEqual({ text: '3 files · 2 read' })
  expect(mixed.band?.count).toBe(3)
  expect(mixed.rows).toHaveLength(5) // the pane shows every row
  expect(mixed.textMore).toEqual({ line: '2 more files read only', rows: ['file:/work/r1.ts', 'file:/work/r2.ts'] })
  // Only read files: the band leaves the part out (a zero count), the note still counts them.
  const reads = sec([file('/work/r1.ts', 'viewed', { views: 1 })])
  expect(reads.note).toEqual({ text: '0 files · 1 read' })
  expect(reads.band?.count).toBe(0)
  expect(reads.textMore).toEqual({ line: '1 more file read only', rows: ['file:/work/r1.ts'] })
})

test('a file that was read and named is listed, counted in the band and not in the read-only line', () => {
  const both = file('/work/n.ts', 'viewed', { views: 2, mentions: 1 })
  const only = file('/work/r.ts', 'viewed', { views: 1 })
  const s = sec([both, only])
  expect(s.band?.count).toBe(1)
  expect(s.note).toEqual({ text: '1 files · 1 read' })
  expect(s.textMore).toEqual({ line: '1 more file read only', rows: ['file:/work/r.ts'] })
  expect(names([only, both])).toEqual(['n.ts', 'r.ts'])
  const lines = filePrompt({ items: [both, only] as never, isDismissed: () => false, root: '/work' })
  expect(lines).toHaveLength(2)
  expect(lines[0]).toBe('file: 1 more file read only')
  expect(lines[1]).toContain('"n.ts"')
})

test('a file that was only read and that the person marked high is listed, counted in the band and not in the read-only line', () => {
  const marked = file('/work/p.ts', 'viewed', { views: 1, priority: 'high' })
  const only = file('/work/r.ts', 'viewed', { views: 1 })
  const s = sec([marked, only], { 'file:/work/p.ts': { level: 'high' } })
  expect(s.band?.count).toBe(1)
  expect(s.note).toEqual({ text: '1 files · 1 read' })
  expect(s.textMore).toEqual({ line: '1 more file read only', rows: ['file:/work/r.ts'] })
  // A mark of `low` or `normal` is no pin: the file stays a file that was only read.
  for (const priority of ['low', 'normal'] as const)
    expect(sec([file('/work/q.ts', 'viewed', { views: 1, priority })]).textMore?.rows).toEqual(['file:/work/q.ts'])
})

test('the mark of the record is the whole level of a file: the file kind has no rule that sets a level', () => {
  // `isOnlyRead` reads `priority` of the record, so the section, the cap and the prompt agree. A rule would give a level to a
  // record with no mark: then the predicate must read `levelOf` (and the prompt would need it too).
  expect(fileKind.rules).toBeUndefined()
})

test('the rank: a written file 2, a named file 1, a file that was only read 0; the cap reads the same rule', () => {
  const rank = (rec: FileRecord) => fileRank(rec)
  expect([
    rank(file('/work/a', 'created')),
    rank(file('/work/a', 'edited', { edits: 1 })),
    rank(file('/work/a', 'deleted')),
    rank(file('/work/a', 'viewed', { views: 2, edits: 1 })),
    rank(file('/work/a', 'mentioned')),
    rank(file('/work/a', 'viewed', { views: 2, mentions: 1 })),
    rank(file('/work/a', 'viewed', { views: 1 })),
  ]).toEqual([2, 2, 2, 2, 1, 1, 0])
  for (const rec of [file('/work/a', 'created'), file('/work/a', 'mentioned'), file('/work/a', 'viewed', { views: 1 })])
    expect(fileKind.capRank?.(rec)).toBe(rank(rec))
})

// ---------------------------------------------------------------- the prompt lines

const promptCtx = (recs: readonly FileRecord[], dismissed: readonly string[] = []) =>
  ({
    items: recs as unknown as readonly StoredItem[],
    isDismissed: (id: string) => dismissed.includes(id),
    root: '/work',
  }) as unknown as Pick<ViewContext, 'items' | 'isDismissed' | 'root'>

test('the prompt starts with one line that counts the read ones, then lists the written and the named files', () => {
  const lines = filePrompt(
    promptCtx([
      file('/work/r1.ts', 'viewed', { views: 1 }),
      file('/work/a.ts', 'edited', { edits: 2, views: 1 }, 2),
      file('/work/n.md', 'mentioned', {}, 3),
      file('/work/r2.ts', 'viewed', { views: 1 }),
      file('/work/gone.ts', 'deleted', {}, 4),
    ]),
  )
  expect(lines).toEqual([
    'file: 2 more files read only',
    'file: "a.ts" (updated, edited 2, viewed 1)',
    'file: "n.md" (mentioned)',
    'file: "gone.ts" (deleted)',
  ])
})

test('the prompt has no count line without a read-only file, and a dismissed file is in neither', () => {
  expect(filePrompt(promptCtx([file('/work/a.ts', 'created')]))).toEqual(['file: "a.ts" (created)'])
  const recs = [file('/work/a.ts', 'created'), file('/work/r.ts', 'viewed', { views: 1 })]
  expect(filePrompt(promptCtx(recs, ['file:/work/r.ts']))).toEqual(['file: "a.ts" (created)'])
  expect(filePrompt(promptCtx([]))).toEqual([])
})

test('the kind row is the file row', () => {
  const rec = file('/work/a.ts', 'created')
  expect(fileKind.row(rec, ctxOf([rec]) as unknown as ViewContext)).toEqual(row(rec))
})
