// The default model of the detail view (issue #277, L2 of #275, criterion B2): core builds the fields of every row from the `TreeRow`
// alone, with no tracker code and no load. Every cell whole, every badge and link, the priority, the reasons, the turns, the first
// sighting, the kind, the source and the count of the children, then the `detail()` lines of the row. It is never empty. Pure.
import { expect, test } from 'claude-code/testing'
import { NO_VIEW } from '../core/infra/views'
import type { TreeRow } from '../core/interfaces/view'
import { canOpen } from '../core/interfaces/view'
import { type DetailField, detailFields, fitFields } from '../core/lib/detail'
import { listGroups } from '../core/lib/grouping'
import { callRow } from '../trackers/questions/rows'
import type { QuestionCall } from '../trackers/questions/types'
import { paneWorld } from './fixtures/pane-world'
import { row } from './fixtures/sections'

const NOW = Date.UTC(2026, 9, 27, 12, 0)
const GROUP = 'Pull requests'
const SOURCE = 'Pull requests · github'
const PULL = 'https://github.com/martin-macak/claude-code-mod-tracking/pull/262'
const TITLE = 'feat(track): Track every file Claude reads or writes, with its type'

/** The clock time of an epoch as the model writes it (local time, so the test computes it the same way). */
const clock = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const pr = (extra: Partial<TreeRow> = {}): TreeRow =>
  row(
    'pr',
    {
      control: '●',
      name: { text: '#262', href: PULL },
      description: { text: TITLE, clip: 'end' },
      type: 'feat/track-all-files',
      status: { text: 'open', fg: 'success' },
    },
    {
      owner: 'github',
      extras: [{ text: '✓ checks', fg: 'success' }, { text: 'mergeable' }],
      reasons: { first: 'created', all: ['created', 'updated', 'discovered'], strongest: 'created' },
      turns: { first: 3, last: 9 },
      facets: { level: { auto: true, level: 'normal' }, firstSeen: NOW - 2 * 3_600_000, kind: 'pr' },
      ...extra,
    },
  )

const model = (r: TreeRow, group = GROUP): DetailField[] => [...detailFields(r, { group, now: NOW })]
const shape = (fields: readonly DetailField[]): string[] => fields.map(f => `${f.label}: ${f.text}`)

test('a PR: every cell whole, the badges, the link, the priority, the reasons, the turns, the first sighting, the kind and the source, in that order', () => {
  expect(shape(model(pr()))).toEqual([
    'Name: #262',
    `Description: ${TITLE}`,
    'Type: feat/track-all-files',
    'Status: open',
    'Badges: ✓ checks · mergeable',
    `Link: ${PULL}`,
    'Priority: normal (rule)',
    'Reasons: created, updated, discovered',
    'Turns: first 3 · last 9',
    `First seen: ${clock(NOW - 2 * 3_600_000)} (2h ago)`,
    'Kind: pr',
    `Source: ${SOURCE}`,
  ])
})

test('a cell is whole: a long text and a `clip` of the cell cut nothing, and the control cell (the level marker) is no field', () => {
  const long = 'word '.repeat(400).trim()
  const fields = model(
    pr({ cells: { control: { text: '●' }, name: { text: 'n' }, description: { text: long, clip: 'middle' } } }),
  )
  expect(fields.find(f => f.label === 'Description')?.text).toBe(long)
  expect(fields.some(f => f.text === '●')).toBe(false)
})

test('a link is a field for each distinct address of the cells, once', () => {
  const other = 'https://example.test/other'
  const fields = model(
    pr({
      cells: {
        name: { text: '#262', href: PULL },
        description: { text: 'd', href: PULL },
        status: { text: 'open', href: other },
      },
    }),
  )
  expect(fields.filter(f => f.label === 'Link').map(f => f.text)).toEqual([PULL, other])
})

test('the priority says who set it: a rule, or your mark; a row with no level has none (the slot trackers)', () => {
  const level = (facets: TreeRow['facets']) => model(pr({ facets })).find(f => f.label === 'Priority')?.text
  expect(level({ level: { level: 'high' } })).toBe('high (your mark)')
  expect(level({ level: { level: 'low', auto: true } })).toBe('low (rule)')
  expect(level({ level: {} })).toBeUndefined()
  expect(level({})).toBeUndefined()
  expect(level(undefined)).toBeUndefined()
})

test('the first sighting is the clock time and the age; a day old or more it names the date too; a future time says just now', () => {
  const seen = (ms: number) => model(pr({ facets: { firstSeen: ms } })).find(f => f.label === 'First seen')?.text
  expect(seen(NOW - 30 * 60_000)).toBe(`${clock(NOW - 30 * 60_000)} (30m ago)`)
  const day = NOW - 3 * 86_400_000
  const d = new Date(day)
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  expect(seen(day)).toBe(`${date} ${clock(day)} (3d ago)`)
  expect(seen(NOW + 5_000)).toBe(`${clock(NOW + 5_000)} (just now)`)
  expect(seen(NOW - 500)).toBe(`${clock(NOW - 500)} (just now)`)
})

test('a row with children has a Children field with the count, and a leaf has none', () => {
  const kid = row('k', { name: 'k' })
  expect(model(pr({ children: [kid, kid, kid] })).find(f => f.label === 'Children')?.text).toBe('3')
  expect(model(pr({ children: [] })).some(f => f.label === 'Children')).toBe(false)
  expect(model(pr()).some(f => f.label === 'Children')).toBe(false)
})

test('a field is left out when the row lacks what it shows: a bare row has its source alone, so a detail is never empty', () => {
  const bare = row('b', {}, { owner: 'processes' })
  expect(shape(model(bare, 'Processes'))).toEqual(['Source: Processes · processes'])
  const named = row('n', { name: 'node', description: '  ', type: '' }, { owner: 'processes' })
  expect(shape(model(named, 'Processes'))).toEqual(['Name: node', 'Source: Processes · processes'])
})

test('the detail() lines of the row come last, with their labels in sentence case; a line with no label has an empty label; a blank line is none', () => {
  const lines = [
    { label: 'question', cell: { text: 'Which layout do you want?' } },
    { cell: { text: 'a line with no label' } },
    { cell: { text: '' } },
    { label: 'asked', cell: { text: '  ' } },
  ]
  const fields = model(pr({ detail: () => lines }))
  expect(shape(fields.slice(-3))).toEqual([
    `Source: ${SOURCE}`,
    'Question: Which layout do you want?',
    ': a line with no label',
  ])
  expect(fields.at(-1)).toEqual({ label: '', text: 'a line with no label' })
})

test('the detail() of a row is called once per model, and a text with newlines keeps them', () => {
  const calls: string[] = []
  const fields = model(
    pr({
      detail: () => {
        calls.push('detail')
        return [{ label: 'plan', cell: { text: '# Plan\n\nStep one' } }]
      },
    }),
  )
  expect(calls).toEqual(['detail'])
  expect(fields.at(-1)).toEqual({ label: 'Plan', text: '# Plan\n\nStep one' })
})

test('a call of the questions tracker: the model has its detail() lines after the source, and its turns and children count', () => {
  const ask: QuestionCall = {
    id: 'c1',
    n: 1,
    kind: 'ask',
    state: 'answered',
    at: Date.UTC(2026, 9, 27, 10, 30),
    turn: 7,
    items: [
      {
        question: 'Where should the choice of e live?',
        header: 'Storage',
        multiSelect: false,
        options: [{ label: 'State only' }, { label: 'Config file' }],
        answer: 'State only',
      },
    ],
  }
  const call: TreeRow = { ...callRow(ask, s => s), turns: { first: 7, last: 7 } }
  const fields = model(call, 'Questions')
  const labels = fields.map(f => f.label)
  expect(labels.indexOf('Source')).toBeLessThan(labels.indexOf('Asked'))
  expect(shape(fields)).toContain('Turns: first 7 · last 7')
  expect(shape(fields)).toContain('Asked: 2026-10-27 10:30 UTC')
  expect(shape(fields)).toContain('Call: c1')
  expect(shape(fields)).toContain('Children: 1')
})

// One row of each kind that the trackers make, built by the real builders over the pane world: whatever the kind, the model shows every
// cell whole, every badge, every link, the reasons and the turns, and ends with the source. No tracker adds a line of its own to it.
test('a row of every kind of tracker, as its real builder makes it: nothing the row holds is left out', async () => {
  const t = await paneWorld()
  const groups = listGroups(await t.m.paneData(t.w.ports, NO_VIEW))
  const every = (rows: readonly TreeRow[]): TreeRow[] => rows.flatMap(r => [r, ...every(r.children ?? [])])
  let checked = 0
  for (const g of groups) {
    for (const r of every(g.rows)) {
      const fields = model(r, g.title)
      const texts = fields.map(f => f.text)
      expect(fields.length, r.id).toBeGreaterThan(0)
      // The source is followed by the Children field, when the row has children, then by the labels of its detail() lines, in order.
      const labels = fields.map(f => f.label)
      const lines = (r.detail?.() ?? []).filter(l => l.cell.text.trim() !== '').map(l => (l.label ?? '').toLowerCase())
      const kids = (r.children?.length ?? 0) > 0 ? ['children'] : []
      expect(
        labels.slice(labels.indexOf('Source') + 1).map(l => l.toLowerCase()),
        r.id,
      ).toEqual([...kids, ...lines])
      for (const column of ['name', 'description', 'type', 'status'] as const) {
        const text = r.cells[column]?.text.trim() ?? ''
        if (text !== '')
          expect(texts, `${r.id} ${column}`).toContain(r.cells[column]?.text.replace(/\s+/g, ' ').trim() ?? '')
      }
      for (const badge of r.extras ?? []) {
        if (badge.text.trim() !== '')
          expect(fields.find(f => f.label === 'Badges')?.text, r.id).toContain(badge.text.trim())
      }
      for (const href of [...Object.values(r.cells), ...(r.extras ?? [])].map(c => c.href)) {
        if (href !== undefined && href !== '') expect(texts, `${r.id} link`).toContain(href)
      }
      if (r.reasons !== undefined) expect(texts, r.id).toContain(r.reasons.all.join(', '))
      if (r.turns !== undefined) expect(texts, r.id).toContain(`first ${r.turns.first} · last ${r.turns.last}`)
      checked++
    }
  }
  expect(checked).toBeGreaterThan(30) // the world holds a row of every kind, children included
})

// ---- the size ---------------------------------------------------------------------------------------------------------------

test('fitFields keeps the fields whole while they fit the characters, and says nothing was cut', () => {
  const fields = [
    { label: 'Name', text: 'a' },
    { label: 'Plan', text: 'b'.repeat(10) },
  ]
  expect(fitFields(fields, 100)).toEqual({ fields, cut: false })
})

test('fitFields cuts the first field that does not fit at the characters left and drops the fields after it: the last fields (the detail() lines) go first', () => {
  const fields = [
    { label: 'Name', text: 'abcd' },
    { label: 'Plan', text: 'x'.repeat(100_000) },
    { label: 'After', text: 'never drawn' },
  ]
  const fitted = fitFields(fields, 1_000)
  expect(fitted.cut).toBe(true)
  expect(fitted.fields.map(f => f.label)).toEqual(['Name', 'Plan'])
  expect(fitted.fields[0]?.text).toBe('abcd')
  const plan = fitted.fields[1]?.text ?? ''
  expect(plan.length).toBeLessThanOrEqual(1_000)
  expect(plan.endsWith('…')).toBe(true)
  expect(fitted.fields.reduce((n, f) => n + f.label.length + f.text.length, 0)).toBeLessThanOrEqual(1_000)
})

test('fitFields never cuts an astral character in two: no lone surrogate stands before the mark (m1 of PR 302)', () => {
  // The label takes 4 and the mark 1: room is 5 units, which falls between the two halves of the third emoji.
  const fitted = fitFields([{ label: 'Plan', text: '😀'.repeat(10) }], 10)
  const text = fitted.fields[0]?.text ?? ''
  expect(fitted.cut).toBe(true)
  expect(text).toBe('😀😀…')
  expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)).toBe(false)
})

test('fitFields keeps at most maxFields fields and says the rest was cut (P2 of PR 302)', () => {
  const fields = Array.from({ length: 5 }, (_, i) => ({ label: `L${i}`, text: 'x' }))
  expect(fitFields(fields, 1_000, 3)).toEqual({ fields: fields.slice(0, 3), cut: true })
  expect(fitFields(fields, 1_000, 5)).toEqual({ fields, cut: false })
})

test('fitFields counts the label too, and a budget that is gone before a field drops that field', () => {
  const fitted = fitFields(
    [
      { label: 'L'.repeat(10), text: 'x'.repeat(10) },
      { label: 'B', text: 'y' },
    ],
    15,
  )
  expect(fitted.cut).toBe(true)
  expect(fitted.fields).toHaveLength(1)
})

test('canOpen is true for a row with children and false for a leaf (n6, one rule for the fold)', () => {
  const leaf = row('a', {})
  expect(canOpen(leaf)).toBe(false)
  expect(canOpen({ ...leaf, children: [] })).toBe(false)
  expect(canOpen({ ...leaf, children: [row('b', {})] })).toBe(true)
})
