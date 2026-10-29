// The preview body the pane draws in place of the table (issue #57, L2): a header, the key line, the notices, then the blocks. Keys
// first, notices next, content last, so a cut of the content never takes a key or a notice. Every string is made safe for the
// engine, which refuses a whole tree for one control character. Pure. Design study R10:
// https://github.com/martin-macak/claude-code-mod-tracking/issues/57#issuecomment-6414682787
import { expect, test } from 'claude-code/testing'
import { KeyRegistry, previewKeys } from '../core/infra/keys'
import type { PreviewBlock } from '../core/interfaces/preview'
import { cellWidth } from '../ux/text/cell-width'
import { BUDGET, type Cost, fits, measure } from '../ux/tree-data-table/budget'
import { fillRows, keyWidth } from '../ux/tree-data-table/footer'
import { BACK_HINT, LOADING, PREVIEW_TOO_LARGE, type PreviewView, renderPreview } from '../ux/tree-data-table/preview'
import { buttonOf, isNode, leaves, type Node, nodes, press, recorder } from './fixtures/drawn'
import { EL } from './fixtures/elements'

const KEYS = previewKeys(new KeyRegistry(), [
  { id: 'view', enabled: true },
  { id: 'diff', enabled: false },
])

const CODE: PreviewBlock = { kind: 'code', source: 'one\ntwo\n', path: 'src/a.ts', startLine: 1 }

const draw = (over: Partial<PreviewView> = {}, rec = recorder()) =>
  renderPreview(
    EL,
    { title: 'src/a.ts', subtitle: 'code · 2 lines', keys: KEYS, blocks: [CODE], columns: 96, ...over },
    rec.actions,
  )

/** The children of the root, as nodes. */
const parts = (tree: unknown): Node[] => (isNode(tree) ? tree.children.filter(isNode) : [])

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

test('the body is the header, the key line, then the content, in that order, in one column', () => {
  const tree = draw()
  expect(isNode(tree) && tree.type).toBe('Box')
  expect(isNode(tree) && tree.props.flexDirection).toBe('column')
  const [header, keys, content] = parts(tree)
  expect(parts(tree)).toHaveLength(3)
  expect(leaves(header)).toEqual(['src/a.ts', ' · code · 2 lines'])
  expect(nodes(header, 'Text')[0]?.props.weight).toBe('bold')
  expect(nodes(header, 'Text')[1]?.props.dimColor).toBe(true)
  expect(nodes(keys as Node, 'Button').map(b => [b.props.key, b.props.hotkey, b.props.label])).toEqual([
    ['preview', 'v', 'view'],
    ['diff', 'd', 'diff'],
    ['refresh', 'r', 'reload'],
  ])
  expect(leaves(keys).at(-1)).toBe(BACK_HINT)
  expect(content?.type).toBe('Code')
})

test('a Code block draws its source with a line gutter, the path for the language, and no prop that holds undefined', () => {
  const content = parts(draw())[2] as Node
  expect(content.props).toEqual({ source: 'one\ntwo\n', path: 'src/a.ts', startLine: 1, wrap: 'truncate-end' })
  const bare = parts(draw({ blocks: [{ kind: 'code', source: 'x' }] }))[2] as Node
  expect(bare.props).toEqual({ source: 'x', wrap: 'truncate-end' }) // no gutter, no language: the engine draws it plain
  const typed = parts(draw({ blocks: [{ kind: 'code', source: 'x', language: 'py', startLine: 5 }] }))[2] as Node
  expect(typed.props).toEqual({ source: 'x', language: 'py', startLine: 5, wrap: 'truncate-end' })
})

test('a diff block draws as Code with format diff, a markdown block as Markdown', () => {
  const [, , diff, md] = parts(
    draw({
      blocks: [
        { kind: 'diff', source: '@@ -1 +1 @@\n-a\n+b\n', path: 'a.ts' },
        { kind: 'markdown', text: '# Title' },
      ],
    }),
  )
  expect(diff).toMatchObject({
    type: 'Code',
    props: { source: '@@ -1 +1 @@\n-a\n+b\n', format: 'diff', path: 'a.ts', wrap: 'truncate-end' },
  })
  expect(md).toMatchObject({ type: 'Markdown', props: { text: '# Title' } })
})

test('notices come before the content whatever their place in the blocks, in order, so a cut of the content never takes one', () => {
  const tree = draw({
    blocks: [
      CODE,
      { kind: 'notice', text: 'Truncated: the first 2000 lines.', tone: 'warning' },
      { kind: 'notice', text: 'Binary file.' },
    ],
  })
  const [, , first, second, content] = parts(tree)
  expect(leaves(first)).toEqual(['Truncated: the first 2000 lines.'])
  expect(first?.props.color).toBe('warning')
  expect(first?.props.dimColor).toBeUndefined()
  expect(leaves(second)).toEqual(['Binary file.'])
  expect(second?.props.dimColor).toBe(true)
  expect(second?.props.color).toBeUndefined()
  expect(content?.type).toBe('Code')
})

test('while the content loads the body says Loading and still draws the header and the keys', () => {
  const tree = draw({ blocks: undefined, subtitle: undefined, title: 'Preview' })
  expect(leaves(parts(tree)[0])).toEqual(['Preview'])
  expect(leaves(tree)).toContain(LOADING)
  expect(nodes(tree, 'Button')).toHaveLength(3)
  expect(nodes(tree, 'Code')).toEqual([])
})

test('every string of the body is made safe: a path, a notice and a source with control characters draw none the engine refuses', () => {
  const tree = draw({
    title: 'src/\u001b[31ma\u0000.ts\n',
    subtitle: 'code\u0007',
    blocks: [
      { kind: 'notice', text: 'hidden\r\nline\u0085' },
      { kind: 'code', source: 'a\r\nb\u0000\rc\u001b[0m\td\n', path: 'x\u0000.ts', language: 'p\u0000y' },
      { kind: 'diff', source: '-a\u0000\n', path: 'y\u0007.ts' },
      { kind: 'markdown', text: '# t\u000c\r\n' },
    ],
  })
  expect(strings(tree).filter(s => REFUSED.test(s))).toEqual([])
  const [, , notice, code, diff, md] = parts(tree)
  // One rule for every string (G9): a control character shows as U+FFFD, and a line of words puts a tab or a newline on one line.
  expect(leaves(notice)).toEqual(['hidden line�'])
  expect(code?.props.source).toBe('a\nb��c�[0m\td\n') // CRLF is one newline, a lone CR is not
  expect(code?.props.path).toBe('x�.ts')
  expect(code?.props.language).toBe('p�y')
  expect(diff?.props).toMatchObject({ source: '-a�\n', path: 'y�.ts' })
  expect(md?.props.text).toBe('# t�\n')
  expect(leaves(parts(tree)[0])).toEqual(['src/�[31ma�.ts ', ' · code�'])
})

test('a long title is cut in the middle to leave the subtitle whole, and the header takes one row', () => {
  const title = `${'very/long/folder/'.repeat(8)}file.ts`
  const header = parts(draw({ title, columns: 60 }))[0] as Node
  const [name, sub] = leaves(header)
  expect(sub).toBe(' · code · 2 lines')
  expect((name as string).length + (sub as string).length).toBeLessThanOrEqual(60)
  expect(name).toContain('…')
  expect((name as string).endsWith('file.ts')).toBe(true) // the end of a path is the part that names the file
  expect((name as string).startsWith('very/')).toBe(true)
})

test('a Button of the key line presses the core key by its Button key; a dim one presses too, so the pane can say why the mode is off', () => {
  const rec = recorder()
  const tree = draw({}, rec)
  press(buttonOf(tree, 'preview'), 'terminal')
  press(buttonOf(tree, 'refresh'))
  expect(rec.calls).toEqual(['press:preview', 'press:refresh'])
  expect(rec.surfaces).toEqual(['terminal', undefined])
  expect(buttonOf(tree, 'diff').props.dimColor).toBe(true) // the mode is off: dim
  expect(buttonOf(tree, 'preview').props.dimColor).toBeUndefined()
  press(buttonOf(tree, 'diff'))
  expect(rec.calls).toEqual(['press:preview', 'press:refresh', 'press:diff']) // the pane toasts its reason
  expect(rec.asks.count).toBe(0)
})

test('a source over the budget falls back to the notices and one line, and the header and the key line stay', () => {
  const big: PreviewBlock = { kind: 'code', source: 'x'.repeat(120_000), startLine: 1 }
  const tree = draw({ blocks: [{ kind: 'notice', text: 'Truncated.', tone: 'warning' }, big] })
  expect(nodes(tree, 'Code')).toEqual([])
  expect(leaves(tree)).toContain(PREVIEW_TOO_LARGE)
  expect(leaves(tree)).toContain('Truncated.')
  expect(nodes(tree, 'Button').map(b => b.props.key)).toEqual(['preview', 'diff', 'refresh'])
  expect(fits(measure(tree), BUDGET)).toBe(true)
  // The same source under the limit is drawn whole.
  const ok = draw({ blocks: [{ ...big, source: 'x'.repeat(70_000) }] })
  expect(nodes(ok, 'Code')).toHaveLength(1)
  expect(fits(measure(ok), BUDGET)).toBe(true)
})

test('the budget is the one the engine keeps: the header and the keys are counted first, and a small budget cuts the content, not the keys', () => {
  // The edge is the cost of the header and the key line: the content fits only when the room is that cost and its own, no less.
  const [header, keys] = parts(draw())
  const reserved = measure([header, keys])
  const n = 40
  const block: PreviewBlock = { kind: 'code', source: 'x'.repeat(n) }
  const at = (budget: Cost) => draw({ blocks: [block], budget })
  const roomy = { values: 1000, chars: 100_000 }
  expect(nodes(at({ ...roomy, chars: reserved.chars + n }), 'Code')).toHaveLength(1)
  const cut = at({ ...roomy, chars: reserved.chars + n - 1 })
  expect(nodes(cut, 'Code')).toEqual([])
  expect(nodes(cut, 'Button')).toHaveLength(3) // the keys stay
  expect(leaves(cut)).toContain(PREVIEW_TOO_LARGE)
  // The same for the values (the engine counts a node and a string child as one each): a Code is one value, its source is none.
  expect(nodes(at({ ...roomy, values: reserved.values + 1 }), 'Code')).toHaveLength(1)
  expect(nodes(at({ ...roomy, values: reserved.values }), 'Code')).toEqual([])
})

test('the key line takes one row at 96 cells with the three keys and the hint', () => {
  // The layout of the footer: the Buttons and the hint, wrapped greedily in 96 cells.
  expect(fillRows([...KEYS.map(keyWidth), cellWidth(BACK_HINT)], 96)).toBe(1)
  // The layout can say no: the same keys three times over do not fit 40 cells.
  const crowd = [...KEYS, ...KEYS, ...KEYS].map(keyWidth)
  expect(fillRows([...crowd, cellWidth(BACK_HINT)], 40)).toBeGreaterThan(1)
})
