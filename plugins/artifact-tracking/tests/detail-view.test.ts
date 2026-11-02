// The detail view (issue #277, L2 of #275): the preview body with the core mode `detail`. The first line names the row and the mode, the
// second holds the keys (`↩ back`, the modes of a file row, `r`), the third the other keys as dim Buttons, and the fields follow in a
// label column with wrapped text. A tall view scrolls by the engine; a plan of 100,000 characters keeps every key. Pure.
// Design of issue #275, "The detail view" (B1, B3, B6, B11).
import { expect, test } from 'claude-code/testing'
import { KeyRegistry, previewKeys } from '../core/infra/keys'
import { BACK_BUTTON, previewBody } from '../core/infra/preview-body'
import type { PreviewBlock } from '../core/interfaces/preview'
import type { TreeRow } from '../core/interfaces/view'
import { DETAIL_NOTICE_CUT, detailContent, GONE } from '../core/lib/detail'
import { PREVIEW_LIMITS } from '../core/lib/preview'
import { callRow } from '../trackers/questions/rows'
import type { QuestionCall } from '../trackers/questions/types'
import { BUDGET, fits, measure } from '../ux/tree-data-table/budget'
import { BACK_HINT, PREVIEW_TOO_LARGE, type PreviewView, renderPreview } from '../ux/tree-data-table/preview'
import { buttonOf, isNode, leaves, type Node, nodes, press, recorder } from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { row } from './fixtures/sections'

const NOW = Date.UTC(2026, 9, 27, 12, 0)
const PULL = 'https://github.com/martin-macak/claude-code-mod-tracking/pull/262'

const pr = (extra: Partial<TreeRow> = {}): TreeRow =>
  row(
    'pr',
    {
      control: '●',
      name: { text: '#262', href: PULL },
      description: 'feat(track): Track every file Claude reads or writes, with its type',
      type: 'feat/track-all-files',
      status: 'open',
    },
    {
      owner: 'github',
      extras: [{ text: '✓ checks' }, { text: 'mergeable' }],
      reasons: { first: 'created', all: ['created', 'updated', 'discovered'], strongest: 'created' },
      turns: { first: 3, last: 9 },
      facets: { level: { auto: true, level: 'normal' }, firstSeen: NOW - 2 * 3_600_000, kind: 'pr' },
      ...extra,
    },
  )

const reg = new KeyRegistry()
reg.add('github', [
  { id: 'resolve', key: 'c', label: 'resolve', scope: 'row' },
  { id: 'files', key: 'f', label: 'files', scope: 'row' },
])

/** The view of the detail of `r` as the pane builds it: the content, the key line and the dim keys. */
function view(
  r: TreeRow,
  over: Partial<PreviewView> = {},
  modes = [] as { id: string; enabled: boolean }[],
): PreviewView {
  const content = detailContent(r, { group: 'Pull requests', now: NOW })
  const body = previewBody(reg, modes, 'detail', r.owner)
  return {
    title: content.title,
    subtitle: content.subtitle,
    keys: body.keys,
    back: BACK_BUTTON,
    dim: body.dim,
    blocks: content.blocks,
    columns: 96,
    ...over,
  }
}

const draw = (
  r: TreeRow,
  over: Partial<PreviewView> = {},
  rec = recorder(),
  modes = [] as { id: string; enabled: boolean }[],
) => renderPreview(EL, view(r, over, modes), rec.actions)

/** The children of the root, as nodes. */
const parts = (tree: unknown): Node[] => (isNode(tree) ? tree.children.filter(isNode) : [])

// ---- B1: the first line, the key line, the fields -----------------------------------------------------------------------------

test('the detail view is the header, the key line, the dim keys, then the fields: the row and the mode on the first line (B1)', () => {
  const tree = draw(pr())
  const [header, keys, dim, block, ...rest] = parts(tree)
  expect(rest).toEqual([])
  expect(leaves(header)).toEqual(['#262', ' · Pull requests · open · detail'])
  expect(nodes(header, 'Text')[0]?.props.weight).toBe('bold')
  expect(nodes(keys as Node, 'Button').map(b => [b.props.key, b.props.hotkey, b.props.label])).toEqual([
    ['back', undefined, '↩ back'],
    ['refresh', 'r', 'refresh'],
  ])
  expect(leaves(keys).at(-1)).toBe(BACK_HINT)
  expect(nodes(dim as Node, 'Button').length).toBeGreaterThan(10)
  expect(parts(block as Node).length).toBeGreaterThan(8) // one row for each field
})

test('the fields are a label column and a text that wraps: every label dim and as wide as the longest, the text beside it', () => {
  const tree = draw(pr())
  const fields = parts(parts(tree)[3] as Node)
  const labels = fields.map(f => leaves(f)[0])
  expect(labels.slice(0, 4)).toEqual(['Name', 'Description', 'Type', 'Status'])
  for (const f of fields) {
    const [label, value] = nodes(f, 'Text')
    expect(label?.props.dimColor).toBe(true)
    expect(value?.props.wrap).toBe('wrap')
  }
  // One label width for every row, so the texts stand under each other.
  const widths = fields.map(f => nodes(f, 'Box').find(b => b.props.width !== undefined)?.props.width)
  expect(new Set(widths).size).toBe(1)
  expect(Number(widths[0])).toBeGreaterThanOrEqual('First seen'.length)
  // The text of the description is whole: the engine wraps it, the model does not cut it.
  expect(leaves(fields[1])).toContain('feat(track): Track every file Claude reads or writes, with its type')
})

test('the key line holds the Buttons of the modes of a file row between `↩ back` and `r`; a mode that is off draws dim and still presses', () => {
  const modes = [
    { id: 'view', enabled: true },
    { id: 'diff', enabled: false },
  ]
  const rec = recorder()
  const tree = draw(pr(), { keys: previewKeys(reg, modes, 'detail') }, rec, modes)
  const keys = parts(tree)[1] as Node
  expect(nodes(keys, 'Button').map(b => [b.props.key, b.props.hotkey, b.props.label, b.props.dimColor])).toEqual([
    ['back', undefined, '↩ back', undefined],
    ['preview', 'v', 'view', undefined],
    ['diff', 'd', 'diff', true],
    ['refresh', 'r', 'refresh', undefined],
  ])
  press(buttonOf(keys, 'diff')) // an off mode still goes to the pane, which says why in a toast
  expect(rec.calls).toEqual(['press:diff'])
})

test('a press of `↩ back` calls back and no key; it has no hotkey, so no letter is taken', () => {
  const rec = recorder()
  const back = buttonOf(draw(pr(), {}, rec), BACK_BUTTON)
  expect(back.props.hotkey).toBeUndefined()
  press(back)
  expect(rec.calls).toEqual(['back'])
})

// ---- B6: every other key is a dim Button ---------------------------------------------------------------------------------------

test('every other key is a dim Button with its hotkey, so no letter reaches the prompt; a press only gives the pane the keys (B6)', () => {
  const rec = recorder()
  const tree = draw(pr(), {}, rec)
  const dim = parts(tree)[2] as Node
  const buttons = nodes(dim, 'Button')
  expect(buttons.map(b => b.props.hotkey)).toEqual([
    'h',
    'g',
    'a',
    't',
    'p',
    'm',
    'e',
    'x',
    '1',
    '2',
    '3',
    '0',
    'o',
    'v',
    'd',
    'c',
    'f',
  ])
  for (const b of buttons) expect(b.props.dimColor, String(b.props.hotkey)).toBe(true)
  for (const b of buttons) press(b)
  expect(rec.calls).toEqual([]) // no work
  expect(rec.asks.count).toBe(buttons.length) // each one gives the keys
})

test('the hotkeys of the whole body are one each: the key line and the dim keys never share a letter', () => {
  const hotkeys = nodes(draw(pr()), 'Button')
    .map(b => b.props.hotkey)
    .filter(h => h !== undefined)
  expect(hotkeys).toEqual([...new Set(hotkeys)])
  expect(hotkeys).toContain('r')
  expect(hotkeys).toContain('v') // a non-file row has no mode: `v` is a dim Button (M1 of PR 302)
})

test('the Button keys of the body are the ones the refocus compares: back first, then the key line, then the dim keys', () => {
  expect(previewBody(reg, [], 'detail', 'github').buttons).toEqual(
    nodes(draw(pr()), 'Button').map(b => String(b.props.key)),
  )
})

// ---- B3: a plan of 100,000 characters keeps the keys ----------------------------------------------------------------------------

test('a plan of 100,000 characters is cut to the budget of the preview and keeps every Button of the view (B3)', () => {
  const plan = row(
    'q',
    { name: 'Q1', description: 'plan' },
    {
      owner: 'questions',
      detail: () => [{ label: 'plan', cell: { text: `word ${'x'.repeat(99)}\n`.repeat(1000) } }],
    },
  )
  expect(plan.detail?.()[0]?.cell.text.length).toBeGreaterThan(100_000)
  const content = detailContent(plan, { group: 'Questions', now: NOW })
  const tree = renderPreview(EL, view(plan, { blocks: content.blocks }), recorder().actions)
  // It fits the guard with its keys, and the content is not the notice that says the view is too large.
  expect(fits(measure(tree), BUDGET)).toBe(true)
  expect(leaves(tree)).not.toContain(PREVIEW_TOO_LARGE)
  expect(nodes(tree, 'Button').length).toBe(previewBody(reg, [], 'detail', plan.owner).buttons.length)
  // The text is cut, and the view says so before the fields, so a cut never takes the notice.
  const fields = content.blocks.find(b => b.kind === 'fields')
  const total = (fields?.kind === 'fields' ? fields.fields : []).reduce((n, f) => n + f.label.length + f.text.length, 0)
  expect(total).toBeLessThanOrEqual(PREVIEW_LIMITS.maxChars)
  expect(content.blocks[0]).toEqual({ kind: 'notice', text: DETAIL_NOTICE_CUT, tone: 'info' })
})

test('a plan of many short lines, as the questions builder splits it, shows a prefix of the fields and not the notice that says the view is too large (P2 of PR 302)', () => {
  const plan: QuestionCall = {
    id: 'c1',
    n: 1,
    kind: 'plan',
    state: 'answered',
    at: Date.UTC(2026, 9, 27, 10, 30),
    turn: 7,
    items: [],
    plan: 'step\n'.repeat(4000),
  }
  const r = { ...callRow(plan, s => s), turns: { first: 7, last: 7 } }
  expect(r.detail?.().length).toBeGreaterThan(4000)
  const content = detailContent(r, { group: 'Questions', now: NOW })
  const tree = renderPreview(EL, view(r, { blocks: content.blocks }), recorder().actions)
  expect(leaves(tree)).not.toContain(PREVIEW_TOO_LARGE)
  expect(fits(measure(tree), BUDGET)).toBe(true)
  expect(content.blocks[0]).toEqual({ kind: 'notice', text: DETAIL_NOTICE_CUT, tone: 'info' })
  expect(nodes(tree, 'Button').length).toBe(previewBody(reg, [], 'detail', r.owner).buttons.length)
})

test('a plan whose lines hold tabs, as the questions builder splits it, shows a prefix and not the notice that says the view is too large (P2 of PR 302)', () => {
  const plan: QuestionCall = {
    id: 'c1',
    n: 1,
    kind: 'plan',
    state: 'answered',
    at: Date.UTC(2026, 9, 27, 10, 30),
    turn: 7,
    items: [],
    plan: `Plan\n${'step\t'.repeat(20_000)}`,
  }
  const r = { ...callRow(plan, s => s), turns: { first: 7, last: 7 } }
  const content = detailContent(r, { group: 'Questions', now: NOW })
  const tree = renderPreview(EL, view(r, { blocks: content.blocks }), recorder().actions)
  expect(leaves(tree)).not.toContain(PREVIEW_TOO_LARGE)
  expect(fits(measure(tree), BUDGET)).toBe(true)
  expect(content.blocks[0]).toEqual({ kind: 'notice', text: DETAIL_NOTICE_CUT, tone: 'info' })
})

test('a view that is too large for the guard still keeps the keys: the Buttons stay and the body says so', () => {
  const huge: PreviewBlock = { kind: 'fields', fields: [{ label: 'Plan', text: 'x'.repeat(150_000) }] }
  const tree = renderPreview(EL, view(pr(), { blocks: [huge] }), recorder().actions)
  expect(leaves(tree)).toContain(PREVIEW_TOO_LARGE)
  expect(nodes(tree, 'Button').length).toBe(previewBody(reg, [], 'detail', 'github').buttons.length)
})

test('a view that fits whole has no cut notice', () => {
  expect(detailContent(pr(), { group: 'Pull requests', now: NOW }).blocks.map(b => b.kind)).toEqual(['fields'])
})

// ---- the safe strings -----------------------------------------------------------------------------------------------------------

/** Every string a tree holds: text children and string props, so a control character cannot hide in a prop. */
function strings(tree: unknown): string[] {
  if (typeof tree === 'string') return [tree]
  if (!isNode(tree)) return []
  return [
    ...Object.values(tree.props).filter((v): v is string => typeof v === 'string'),
    ...tree.children.flatMap(strings),
  ]
}

/** The characters that make the engine refuse a tree: the C0 controls but tab and newline, DEL and the C1 controls. */
const REFUSED = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/

test('every string of the detail is made safe: a control character in a name, a cell or a detail() line draws as U+FFFD, a tab as spaces', () => {
  const r = pr({
    cells: {
      name: { text: 'a\u001b[31mb\u0000' },
      description: { text: 'one\ttwo\u0007' },
    },
    detail: () => [{ label: 'x\u0000y', cell: { text: 'line one\nline\ttwo\u0085' } }],
  })
  const tree = draw(r)
  for (const s of strings(tree)) expect(REFUSED.test(s), JSON.stringify(s)).toBe(false)
  const text = leaves(tree).join('|')
  expect(text).toContain('a�[31mb�')
  expect(text).toContain('one two�') // a cell is one line
  expect(text).toContain('line one\nline  two�') // a newline stays: the text wraps in the pane
})

// ---- B11: a row that is gone ----------------------------------------------------------------------------------------------------

test('a row that left the pane: the view says This row is gone and keeps `↩ back` and the key line', () => {
  const content = GONE
  expect(content.blocks).toEqual([{ kind: 'notice', text: 'This row is gone', tone: 'info' }])
  const tree = renderPreview(
    EL,
    {
      title: content.title,
      subtitle: content.subtitle,
      keys: previewKeys(reg, [], 'detail'),
      back: BACK_BUTTON,
      blocks: content.blocks,
      columns: 96,
    },
    recorder().actions,
  )
  expect(leaves(tree)).toContain('This row is gone')
  expect(nodes(tree, 'Button').map(b => b.props.key)).toEqual(['back', 'refresh'])
})
