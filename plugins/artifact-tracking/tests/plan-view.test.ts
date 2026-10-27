// The plan view (issue #199): `fitPlan` cuts the lines of the `/track clean` plan to the rows of the pane body, `renderPlan` draws them,
// and the table draws them in the slot of the help view. Pure.
// The plan is the list of typed lines of `planLines`; the reply of `/track clean` prints the same lines (`planLinesText`), so a tall
// body shows what the command prints and a short body shows a cut of it.
import { expect, test } from 'claude-code/testing'
import { KeyRegistry, planFooter } from '../core/infra/keys'
import type { CleanStep } from '../core/interfaces/clean'
import { type Line, type PlanLine, planLines, planLinesText, planText } from '../core/lib/clean-text'
import { resetWidths } from '../ux/tree-data-table/columns'
import { footerRows, moveHintFits } from '../ux/tree-data-table/footer'
import { fitPlan, MORE_SUFFIX, planRows, renderPlan } from '../ux/tree-data-table/plan'
import { ROW_GAP } from '../ux/tree-data-table/shape'
import { TreeDataTable } from '../ux/tree-data-table/table'
import { type Node, nodes, recorder, texts, view } from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { heightOf } from './fixtures/height'

const ROOT = '/Users/martinmacak/projects/claude-code-mod-tracking/.claude/worktrees'
const task = (n: number, label = `job ${n}`): CleanStep => ({ kind: 'tasks', id: `task:${n}`, label, action: 'stop' })
// A worktree line is long: the path and the words wrap to two rows at 96 cells.
const tree = (n: number): CleanStep => ({
  kind: 'worktrees',
  id: `wt:${n}`,
  label: `${ROOT}/wf_82cd3937-b16-${n}`,
  action: 'remove-worktree',
})
const lines = (...steps: CleanStep[]): Line[] => steps.map(step => ({ step }))
const range = <T>(n: number, make: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => make(i + 1))
const plan = (steps: CleanStep[], failed: string[] = []): readonly PlanLine[] => planLines(lines(...steps), failed)

const words = (ls: readonly PlanLine[]): string[] => ls.map(l => l.text)
const heads = (ls: readonly PlanLine[]): string[] => ls.filter(l => l.role === 'head').map(l => l.text)
const TASKS_HEAD = 'Tasks (apply with /track clean --yes tasks)'
const TREES_HEAD = 'Worktrees (apply with /track clean --yes worktrees)'
const WT_WORDS = 'remove worktree (if clean and merged; deletes ignored files)'

/** The plans of the study (S1): empty, 2 tasks, 2 tasks and 3 worktrees, and a plan of 12 tasks and 14 worktrees that failed in one tracker. */
const PLANS: Record<string, readonly PlanLine[]> = {
  empty: plan([]),
  tasks: plan([task(1), task(2)]),
  mixed: plan([task(1), task(2), tree(1), tree(2), tree(3)]),
  tall: plan([...range(12, i => task(i)), ...range(14, tree)], ['auto: plan failed: boom']),
  failedOnly: plan([], ['processes: plan failed: boom']),
}

// ---------------------------------------------------------------- planRows

test('planRows counts the rows of each line as the engine wraps it, a blank line as one row', () => {
  const ls = PLANS.mixed as readonly PlanLine[]
  // title 1, blank 1, Tasks head 1, 2 tasks, Worktrees head 1, 3 worktrees of 2 rows, blank 1, 2 hints: 15 rows at 96 cells (S1).
  expect(planRows(ls, 96)).toBe(15)
  expect(planRows([], 96)).toBe(0)
  expect(planRows(PLANS.empty as readonly PlanLine[], 96)).toBe(6)
})

test('planRows counts the indent of a line as cells: a step that fills the row to the last cell takes one row, one cell more takes two', () => {
  const step = (n: number): PlanLine => ({ role: 'step', text: `  ${'x'.repeat(n)}` })
  expect(planRows([step(94)], 96)).toBe(1)
  expect(planRows([step(95)], 96)).toBe(2)
})

// ---------------------------------------------------------------- the whole plan (AC3)

test('fitPlan on a body that holds the plan gives every line, and their text is the text of /track clean', () => {
  const steps = {
    empty: [],
    tasks: [task(1), task(2)],
    mixed: [task(1), task(2), tree(1), tree(2), tree(3)],
    tall: [...range(12, i => task(i)), ...range(14, tree)],
  }
  for (const [name, ls] of Object.entries(PLANS)) {
    const all = fitPlan(ls, 200, 96)
    expect(all, name).toEqual(ls)
    expect(planRows(all, 96), name).toBeLessThanOrEqual(200)
  }
  for (const [name, list] of Object.entries(steps)) {
    const failed = name === 'tall' ? ['auto: plan failed: boom'] : []
    expect(planLinesText(fitPlan(plan(list, failed), 200, 96)), name).toBe(planText(lines(...list), failed))
  }
})

test('fitPlan keeps every line while the plan fits the rows exactly, and drops blank lines and hints first when it does not', () => {
  const ls = PLANS.mixed as readonly PlanLine[]
  expect(fitPlan(ls, 15, 96)).toEqual(ls)
  const trimmed = fitPlan(ls, 14, 96)
  expect(trimmed.filter(l => l.role === 'blank' || l.role === 'hint')).toEqual([])
  expect(trimmed).toEqual(ls.filter(l => l.role !== 'blank' && l.role !== 'hint')) // every step is still there
  expect(planRows(trimmed, 96)).toBe(11) // 15 less 2 hints, 2 blank lines
  expect(fitPlan(ls, 11, 96)).toEqual(trimmed)
})

// ---------------------------------------------------------------- the cut

test('the cut at 96 cells and 9 rows keeps the title, both heads, the tasks, the first worktree and a count', () => {
  const cut = fitPlan(PLANS.mixed as readonly PlanLine[], 9, 96)
  expect(words(cut)).toEqual([
    'Clean plan. Nothing changed.',
    TASKS_HEAD,
    '  job 1: stop',
    '  job 2: stop',
    TREES_HEAD,
    `  ${ROOT}/wf_82cd3937-b16-1: ${WT_WORDS}`,
    `  and 2 more${MORE_SUFFIX}`,
  ])
  expect(planRows(cut, 96)).toBe(8) // a second worktree (2 rows) would make 10
  expect(cut.at(-1)).toMatchObject({ role: 'more', count: 2 })
})

test('the cut gives the room that is left to the steps in the order of the plan, each kind in a prefix', () => {
  const ls = plan([...range(6, i => task(i)), ...range(6, tree)])
  const shown = (rows: number) => fitPlan(ls, rows, 96).filter(l => l.role === 'step').length
  const counts = Array.from({ length: 40 }, (_, i) => shown(i + 1))
  // Never fewer steps with more rows, and the prefix of each kind grows from the first kind.
  for (let i = 1; i < counts.length; i++)
    expect(counts[i], `rows ${i + 1}`).toBeGreaterThanOrEqual(counts[i - 1] as number)
  const at = fitPlan(ls, 12, 96)
  const tasks = at.filter(l => l.role === 'step' && l.text.startsWith('  job'))
  expect(tasks.map(l => l.text)).toEqual(range(tasks.length, i => task(i)).map(s => `  ${s.label}: stop`))
})

test('the count line says how many steps of the kind the cut left out, and where the full list is', () => {
  const cut = fitPlan(plan(range(30, i => task(i))), 8, 96)
  const more = cut.filter(l => l.role === 'more')
  expect(more).toHaveLength(1)
  expect(more[0]?.text).toBe(`  and ${(more[0] as PlanLine).count} more${MORE_SUFFIX}`)
  const shown = cut.filter(l => l.role === 'step').length
  // 30 steps, 10 of them in the plan and 20 left out by the plan itself: the cut adds its own, and the count is all of them.
  expect(shown + ((more[0] as PlanLine).count as number)).toBe(30)
  expect(MORE_SUFFIX).toContain('/track clean')
})

test('a kind that the plan closed with a count: a cut adds what it leaves out, a view that holds the 10 steps keeps the count of the plan', () => {
  const ls = plan(range(13, i => task(i)))
  const whole = fitPlan(ls, 14, 96) // title, head, 10 steps, the count of the plan: 13 rows, 14 with the blank line
  expect(whole.filter(l => l.role === 'step')).toHaveLength(10)
  expect(whole.find(l => l.role === 'more')).toEqual({ role: 'more', text: '  and 3 more.', count: 3 })
  const cut = fitPlan(ls, 5, 96)
  expect(cut.filter(l => l.role === 'step')).toHaveLength(2) // title, head, 2 steps, the count line
  expect(cut.find(l => l.role === 'more')).toEqual({
    role: 'more',
    text: `  and 11 more${MORE_SUFFIX}`,
    count: 11,
  })
})

test('a step whose label holds a newline is one step: the cut keeps all its rows and counts it once', () => {
  const ls = plan([task(1, 'echo one\necho two\necho three'), task(2), task(3)])
  const cut = fitPlan(ls, 6, 96) // title, head, the 3 rows of the first step, a count line
  expect(words(cut)).toEqual([
    'Clean plan. Nothing changed.',
    TASKS_HEAD,
    '  echo one',
    'echo two',
    'echo three: stop',
    `  and 2 more${MORE_SUFFIX}`,
  ])
})

test('a plan with a problem keeps the Problems head and its lines in every cut, and an empty plan keeps its one sentence', () => {
  const tall = PLANS.tall as readonly PlanLine[]
  for (const rows of [3, 6, 9, 20, 200]) {
    const cut = fitPlan(tall, rows, 96)
    expect(heads(cut), `rows ${rows}`).toContain('Problems:')
    expect(
      cut.filter(l => l.role === 'problem').map(l => l.text),
      `rows ${rows}`,
    ).toEqual(['  auto: plan failed: boom'])
  }
  const failed = PLANS.failedOnly as readonly PlanLine[]
  expect(heads(fitPlan(failed, 3, 96))).toEqual(['Nothing to stop or remove.', 'Problems:'])
  expect(heads(fitPlan(PLANS.empty as readonly PlanLine[], 3, 96))).toEqual(['Nothing to stop or remove.'])
})

test('a kind that this module does not know goes through the cut as it is: a head, its steps, a count', () => {
  const head = 'Containers (apply with /track clean --yes containers)'
  const ls: readonly PlanLine[] = [
    { role: 'title', text: 'Clean plan. Nothing changed.' },
    { role: 'blank', text: '' },
    { role: 'head', text: head },
    ...range(5, i => ({ role: 'step' as const, text: `  box ${i}: remove` })),
    { role: 'blank', text: '' },
    { role: 'hint', text: 'Log: /track clean --log' },
  ]
  expect(words(fitPlan(ls, 5, 96))).toEqual([
    'Clean plan. Nothing changed.',
    head,
    '  box 1: remove',
    '  box 2: remove',
    `  and 3 more${MORE_SUFFIX}`,
  ])
})

// ---------------------------------------------------------------- the properties of the cut, over every body

/** The steps of each head: the lines that start a step and the steps that a count line stands for. A cut moves steps into a count line, it loses none. */
function tally(ls: readonly PlanLine[]): Record<string, number> {
  const out: Record<string, number> = {}
  let head = ''
  for (const l of ls) {
    if (l.role === 'head') head = l.text
    else if (l.role === 'step' && l.cont !== true) out[head] = (out[head] ?? 0) + 1
    else if (l.role === 'more') out[head] = (out[head] ?? 0) + (l.count ?? 0)
  }
  return out
}

test('at every body height and width the cut keeps the title, every head and every problem, loses no step, and fits when it can', () => {
  for (const [name, ls] of Object.entries(PLANS)) {
    for (const columns of [96, 58, 49, 40]) {
      const floor = planRows(fitPlan(ls, 0, columns), columns) // the least the cut draws: what no body can make smaller
      let before = 0
      for (let rows = 1; rows <= 60; rows++) {
        const at = `${name} ${columns}x${rows}`
        const cut = fitPlan(ls, rows, columns)
        expect(cut[0]?.role, at).toBe('title')
        expect(heads(cut), at).toEqual(heads(ls))
        expect(
          cut.filter(l => l.role === 'problem'),
          at,
        ).toEqual(ls.filter(l => l.role === 'problem'))
        expect(tally(cut), at).toEqual(tally(ls)) // what the cut hides, a count line counts
        expect(planRows(cut, columns), at).toBeLessThanOrEqual(Math.max(rows, floor))
        // Every line of the cut is a line of the plan, or the count line of a kind.
        for (const l of cut)
          expect(ls.includes(l) || (l.role === 'more' && l.text.endsWith(MORE_SUFFIX)), at).toBe(true)
        // Lines keep the order of the plan.
        const kept = cut.filter(l => ls.includes(l))
        expect(kept, at).toEqual(ls.filter(l => kept.includes(l)))
        // More rows never leave a kind without a step that a body with fewer rows showed. The first step of each kind comes before more
        // steps of an earlier kind, so the count of steps itself can fall when the first step of the next kind fits.
        const kinds = cut.filter((l, i) => l.role === 'step' && cut[i - 1]?.role !== 'step' && l.cont !== true).length
        expect(kinds, at).toBeGreaterThanOrEqual(before)
        before = kinds
      }
    }
  }
})

test('a body that holds the first step of each kind shows it: the cut gives up a first step only when the heads and counts leave no room', () => {
  const three = plan([task(1), task(2), task(3), tree(1), tree(2), tree(3)])
  const firsts = fitPlan(three, 8, 96) // title, 2 heads, the first step of each kind (1 and 2 rows), 2 count lines
  expect(firsts.filter(l => l.role === 'step').map(l => l.text)).toEqual([
    '  job 1: stop',
    `  ${ROOT}/wf_82cd3937-b16-1: ${WT_WORDS}`,
  ])
  expect(planRows(firsts, 96)).toBe(8)
  // 7 rows do not hold the first worktree (2 rows) with its count: the last kind gives its first step up, and its count line says all.
  // The room that this frees goes to the tasks, which are the first kind.
  expect(words(fitPlan(three, 7, 96))).toEqual([
    'Clean plan. Nothing changed.',
    TASKS_HEAD,
    '  job 1: stop',
    '  job 2: stop',
    '  job 3: stop',
    TREES_HEAD,
    `  3 steps${MORE_SUFFIX}`,
  ])
  expect(words(fitPlan(three, 6, 96))).toEqual([
    'Clean plan. Nothing changed.',
    TASKS_HEAD,
    '  job 1: stop',
    `  and 2 more${MORE_SUFFIX}`,
    TREES_HEAD,
    `  3 steps${MORE_SUFFIX}`,
  ])
})

test('the plan of the study with a problem, at 96 cells and 9 rows: the first worktree gives way to the problem, and the counts say it', () => {
  const cut = fitPlan(PLANS.tall as readonly PlanLine[], 9, 96)
  expect(words(cut)).toEqual([
    'Clean plan. Nothing changed.',
    TASKS_HEAD,
    '  job 1: stop',
    '  job 2: stop',
    `  and 10 more${MORE_SUFFIX}`, // 12 tasks: the plan shows 10 and counts 2, the cut shows 2 and counts the other 10
    TREES_HEAD,
    `  14 steps${MORE_SUFFIX}`, // the plan shows 10 worktrees and counts 4
    'Problems:',
    '  auto: plan failed: boom',
  ])
  expect(planRows(cut, 96)).toBeLessThanOrEqual(9)
})

test('the least body: a body of one row draws the title, every head, every problem and a count for each kind, and the plan is not changed', () => {
  const ls = PLANS.mixed as readonly PlanLine[]
  const before = JSON.stringify(ls)
  const cut = fitPlan(ls, 1, 96)
  expect(words(cut)).toEqual([
    'Clean plan. Nothing changed.',
    TASKS_HEAD,
    `  2 steps${MORE_SUFFIX}`,
    TREES_HEAD,
    `  3 steps${MORE_SUFFIX}`,
  ])
  expect(JSON.stringify(ls)).toBe(before)
  expect(fitPlan(plan([task(1)]), 1, 96).at(-1)?.text).toBe(`  1 step${MORE_SUFFIX}`)
})

// ---------------------------------------------------------------- the drawing

test('renderPlan draws one wrapped Text for each line, a bold title and head, a dim hint, and a one-row Box for a blank line', () => {
  const drawn = renderPlan(EL, PLANS.mixed as readonly PlanLine[]) as unknown as Node[]
  expect(drawn).toHaveLength((PLANS.mixed as readonly PlanLine[]).length)
  expect(drawn[0]).toEqual({
    type: 'Text',
    props: { weight: 'bold', wrap: 'wrap' },
    children: ['Clean plan. Nothing changed.'],
  })
  expect(drawn[1]).toEqual({ type: 'Box', props: { height: 1 }, children: [] })
  expect(drawn[2]).toEqual({ type: 'Text', props: { weight: 'bold', wrap: 'wrap' }, children: [TASKS_HEAD] })
  expect(drawn[3]).toEqual({ type: 'Text', props: { wrap: 'wrap' }, children: ['  job 1: stop'] })
  expect(drawn.at(-1)).toEqual({
    type: 'Text',
    props: { dimColor: true, wrap: 'wrap' },
    children: ['Log: /track clean --log'],
  })
})

// ---------------------------------------------------------------- the table

const FOOTER = planFooter(new KeyRegistry())
const INLINE = { bodyColumns: 96, bodyRows: 11, placement: 'inline' } as const
const drawPlan = (ls: readonly PlanLine[], over: Parameters<typeof view>[0] = {}) => {
  resetWidths()
  const r = recorder()
  const drawn = TreeDataTable.render([], view({ ...INLINE, footer: FOOTER, plan: ls, ...over }), EL, r.actions)
  return { ...r, drawn }
}
const root = (tree: unknown): Node => tree as Node
/** The lines of the body of a drawing, as the engine would wrap them: a Box is a blank row, a Text its words. */
const drawnLines = (tree: unknown): PlanLine[] =>
  ((root(tree).children[0] as Node).children as Node[]).map(n =>
    n.type === 'Box' ? { role: 'blank', text: '' } : { role: 'step', text: String(n.children[0]) },
  )
/** The rows a drawing takes: the lines of the body, the gap row and the footer. */
const drawnRows = (tree: unknown, columns: number): number =>
  planRows(drawnLines(tree), columns) +
  Number(root(tree).props.rowGap ?? 0) +
  footerRows(FOOTER, columns, moveHintFits(FOOTER, columns))

test('the table draws the plan in the slot of the help view: no rows, no view line, no status area, and the footer under it', () => {
  const { drawn } = drawPlan(PLANS.tasks as readonly PlanLine[])
  expect(drawn.rows).toEqual([])
  expect(drawn.handles.size).toBe(0)
  expect(drawn.stops).toEqual([])
  expect(texts(drawn.tree).map(([, s]) => s)).toContain(TASKS_HEAD)
  expect(texts(drawn.tree).some(([, s]) => s.startsWith('View:'))).toBe(false)
  const buttons = nodes(drawn.tree, 'Button').map(b => b.props.key)
  expect(buttons).toEqual(FOOTER.map(k => k.buttonKey)) // every core key is a Button, and none is a Button of a view line
})

test('a view line and a status area given with a plan are not drawn: the plan view is a text view', () => {
  const line = { text: 'View: list', keys: FOOTER }
  const status = { selected: { label: 'Selected:', cells: [] }, health: { label: 'Health:', cells: [] } }
  const { drawn } = drawPlan(PLANS.tasks as readonly PlanLine[], { viewLine: line, status })
  expect(texts(drawn.tree).some(([, s]) => s.startsWith('View:') || s === 'Selected:' || s === 'Health:')).toBe(false)
})

test('a plan that fits the body keeps the gap above the footer, and a cut plan draws none, as the compact help form does', () => {
  const whole = drawPlan(PLANS.tasks as readonly PlanLine[], { bodyRows: 30 })
  expect(root(whole.drawn.tree).props.rowGap).toBe(ROW_GAP)
  expect(texts(whole.drawn.tree).map(([, s]) => s)).toContain('Log: /track clean --log') // the hints are there
  const cut = drawPlan(PLANS.mixed as readonly PlanLine[])
  expect(root(cut.drawn.tree).props.rowGap).toBe(0)
  expect(texts(cut.drawn.tree).map(([, s]) => s)).not.toContain('Log: /track clean --log')
})

test('inline 100x40: the plan of 2 tasks fits whole, and a plan with worktrees is cut to the 11 rows with the footer in the body', () => {
  const tasks = drawPlan(PLANS.tasks as readonly PlanLine[])
  expect(words(drawnLines(tasks.drawn.tree))).toEqual(words(PLANS.tasks as readonly PlanLine[])) // whole, blank lines included: the command prints the same lines
  expect(drawnRows(tasks.drawn.tree, INLINE.bodyColumns)).toBeLessThanOrEqual(INLINE.bodyRows)
  for (const name of ['mixed', 'tall', 'failedOnly', 'empty']) {
    const { drawn } = drawPlan(PLANS[name] as readonly PlanLine[])
    expect(drawnRows(drawn.tree, INLINE.bodyColumns), name).toBeLessThanOrEqual(INLINE.bodyRows)
    const shown = texts(drawn.tree).map(([, s]) => s)
    for (const head of heads(PLANS[name] as readonly PlanLine[])) expect(shown, name).toContain(head)
  }
})

// The row counters of the module decide the cut, so a test that counts the drawing with them proves the cut against itself. `heightOf`
// is the oracle of the other tests of the pane: it counts the Boxes, the gaps and the footer on its own. It reads the raw text of a
// Text with `wrapRows`, so the indent of a step is not in its count: the indent rule is pinned by `planRows` (above) and `wrapRowsIndented`.
test('every plan drawn inline fits the 11 rows at 96, 58, 49 and 40 cells, as the oracle of the pane counts them', () => {
  for (const [name, ls] of Object.entries(PLANS))
    for (const columns of [96, 58, 49, 40]) {
      const { drawn } = drawPlan(ls, { bodyColumns: columns, bodyRows: 11 })
      // A footer of 4 rows at 40 cells and the title and heads that never go can leave a body taller than 11: that floor is the limit.
      const floor = heightOf(drawPlan(ls, { bodyColumns: columns, bodyRows: 0 }).drawn.tree, columns)
      expect(heightOf(drawn.tree, columns), `${name} at ${columns}`).toBeLessThanOrEqual(Math.max(11, floor))
    }
})

test('the plan footer takes 2 rows at 96 and 80 cells, 3 at 58 and 49, and 4 at 40', () => {
  const rows = (columns: number) => footerRows(FOOTER, columns, moveHintFits(FOOTER, columns))
  expect([96, 80, 58, 49, 40].map(rows)).toEqual([2, 2, 3, 3, 4])
})

// The text of a step and of a problem comes from outside. A tab counts as no cell in `cellWidth`, and an escape byte moves the cursor.
test('a control character in a step or a problem is a space in the count and in the drawing: planRows and the Text read the same string', () => {
  const dirty = `  ${'a'.repeat(10)}\t${'b'.repeat(10)}`
  const spaced = `  ${'a'.repeat(10)} ${'b'.repeat(10)}`
  const ls: readonly PlanLine[] = [
    { role: 'step', text: dirty },
    { role: 'problem', text: '  auto: \u001b[31mplan failed\u001b[0m: boom\rtail' },
  ]
  // At 22 cells the raw text is one word of 22 cells (a tab counts 0), the same string with a space is two words: 12 and 10 cells.
  expect(planRows([{ role: 'step', text: dirty }], 22)).toBe(planRows([{ role: 'step', text: spaced }], 22))
  expect(planRows([{ role: 'step', text: spaced }], 22)).toBe(2)
  const drawn = renderPlan(EL, ls) as unknown as Node[]
  expect(drawn.map(n => String(n.children[0]))).toEqual([spaced, '  auto:  plan failed : boom tail'])
  expect(drawn.every(n => !/\p{Cc}/u.test(String(n.children[0])))).toBe(true) // no C0, DEL or C1 control character
})

test('a docked pane with a tall body shows more of the same plan than the inline pane does', () => {
  const ls = PLANS.mixed as readonly PlanLine[]
  const stepsOf = (over: Parameters<typeof view>[0]) =>
    texts(drawPlan(ls, over).drawn.tree).filter(([, s]) => s.includes('remove worktree')).length
  expect(stepsOf({ bodyRows: 11 })).toBe(1)
  expect(stepsOf({ bodyRows: 31, placement: 'dock' })).toBe(3)
})

test('with no body height every line shows, as in the help view', () => {
  const ls = PLANS.tall as readonly PlanLine[]
  const { drawn } = drawPlan(ls, { bodyRows: undefined })
  expect(words(drawnLines(drawn.tree))).toEqual(words(ls))
})

test('the Buttons of the plan footer press as the footer keys of the pane do, and a dim key only asks for the keys', () => {
  const r = drawPlan(PLANS.tasks as readonly PlanLine[])
  const byKey = (k: string) => nodes(r.drawn.tree, 'Button').find(b => b.props.key === k) as Node
  ;(byKey('clean').props.onPress as () => void)()
  ;(byKey('refresh').props.onPress as () => void)()
  ;(byKey('view').props.onPress as () => void)() // dim: no work
  expect(r.calls).toEqual(['press:clean', 'press:refresh'])
  expect(r.asks.count).toBe(1)
  expect(byKey('clean').props.label).toBe('back')
  expect(byKey('help').props.label).toBe('help')
  expect(byKey('view').props.dimColor).toBe(true)
})
