// The Questions section (issue #71): one summary row for each call and one child row for each question, the status token
// and the facets of each row, the detail with every word, and the masking on the screen. Pure rows from the section.
import { expect, test } from 'claude-code/testing'
import type { Json } from '../core/interfaces/items'
import type { DetailLine, TreeRow, ViewContext } from '../core/interfaces/view'
import { GLOBAL_DEFAULTS } from '../core/lib/global-config'
import { listGroups, viewGroups } from '../core/lib/grouping'
import { reasonSet } from '../core/lib/reasons'
import { QUESTIONS_DEFAULTS, type QuestionsConfig } from '../trackers/questions/config'
import { MASKED } from '../trackers/questions/secrets'
import { sections } from '../trackers/questions/sections'
import type { QuestionCall, QuestionItem } from '../trackers/questions/types'
import { groupsText } from '../ux/tree-data-table/text'

const AT = Date.UTC(2026, 9, 21, 21, 41)
const ctx = (
  calls: readonly QuestionCall[],
  config: Partial<QuestionsConfig> = {},
): ViewContext<QuestionsConfig, Json> => ({
  now: AT,
  config: { slice: () => ({ ...QUESTIONS_DEFAULTS, ...config }), global: () => GLOBAL_DEFAULTS },
  data: calls as unknown as Json,
  items: [],
  facts: { read: () => undefined },
  tools: {},
  selected: null,
  expanded: new Set(),
  root: undefined,
  home: undefined,
  hidden: { showAll: false },
  isDismissed: () => false,
  levelOf: () => ({}),
})
const item = (over: Partial<QuestionItem> = {}): QuestionItem => ({
  question: 'Where should the records live?',
  header: 'Storage',
  multiSelect: false,
  options: [
    { label: 'State only', description: 'Keep them in the plugin state.', preview: 'state.set(records)\n  indented' },
    { label: 'State and store' },
  ],
  answer: 'State only',
  ...over,
})
const second = (over: Partial<QuestionItem> = {}): QuestionItem => ({
  question: 'Which checks should run?',
  header: 'Checks',
  multiSelect: true,
  options: [{ label: 'Lint' }, { label: 'E2E' }],
  answer: 'Lint, E2E',
  ...over,
})
const call = (id: string, n: number, over: Partial<QuestionCall> = {}): QuestionCall => ({
  id,
  n,
  kind: 'ask',
  state: 'answered',
  at: AT + n,
  turn: 7,
  items: [item(), second()],
  ...over,
})
const rowsOf = (calls: readonly QuestionCall[], config: Partial<QuestionsConfig> = {}): readonly TreeRow[] =>
  sections(ctx(calls, config))[0]?.rows ?? []
const textOf = (line: DetailLine): string => `${line.label ?? ''}|${line.cell.text}`
const detail = (row: TreeRow | undefined): string[] => (row?.detail?.() ?? []).map(textOf)

test('no call, no section', () => {
  expect(sections(ctx([]))).toEqual([])
  expect(sections({ ...ctx([]), data: undefined })).toEqual([])
})

test('the section is Questions, ranked after Processes, with a count in its note and no band part', () => {
  const [s] = sections(ctx([call('a', 1), call('b', 2)]))
  expect(s).toMatchObject({
    id: 'questions',
    title: 'Questions',
    rank: 90,
    note: { text: '2 calls · /track qa prints them' },
  })
  expect(s).not.toHaveProperty('band')
  expect(sections(ctx([call('a', 1)]))[0]?.note?.text).toBe('1 call · /track qa prints them')
})

test('the newest call comes first, so the cap of the pane hides the oldest', () => {
  expect(rowsOf([call('a', 1), call('b', 2), call('c', 3)]).map(r => r.id)).toEqual(['c', 'b', 'a'])
})

test('a summary row: the number, the first question and its answer, and how many more, the kind, the state and the turn', () => {
  const [row] = rowsOf([call('a', 2)])
  expect(row?.owner).toBe('questions')
  expect(row?.cells.name?.text).toBe('Q2')
  expect(row?.cells.description?.text).toBe('Storage → State only (+1)')
  expect(row?.cells.type?.text).toBe('question')
  expect(row?.cells.status).toEqual({ text: 'answered', fg: 'inactive' })
  expect(row?.extras).toEqual([{ text: 'T7', dim: true }])
  expect(row).not.toHaveProperty('turns') // the core puts it there from `turnsOf` (tests/questions-turns.test.ts), never from a cell
  expect(row?.cells.control).toBeUndefined() // nothing to mark
  expect(row?.can).toEqual({ dismiss: false, priority: false })
})

test('a call with one question has no count of more, and a call with no turn has no turn badge', () => {
  const [row] = rowsOf([call('a', 1, { items: [item()], turn: undefined })])
  expect(row?.cells.description?.text).toBe('Storage → State only')
  expect(row).not.toHaveProperty('extras')
  expect(row).not.toHaveProperty('turns')
})

test('a replayed call has no turn, so no badge and no turns', () => {
  const [row] = rowsOf([call('a', 1, { replayed: true, turn: undefined })])
  expect(row).not.toHaveProperty('turns')
})

test('the detail of a call leaves the turn to the core detail line, which reads TreeRow.turns', () => {
  const [row] = rowsOf([call('a', 1)])
  expect(detail(row).filter(l => l.startsWith('turn|'))).toEqual([])
})

test('the answer of a question: picked labels, typed text tagged, notes only, blank', () => {
  const answer = (q: QuestionItem) => rowsOf([call('a', 1, { items: [q] })])[0]?.cells.description?.text
  expect(answer(second({ answer: 'Lint, custom' }))).toBe('Checks → Lint, typed: custom')
  expect(answer(item({ answer: '(notes only)' }))).toBe('Storage → (notes only)')
  expect(answer(item({ answer: undefined }))).toBe('Storage → (blank)')
  expect(answer(item({ header: '' }))).toBe('Question 1 → State only')
})

test('the status token: answered and partial are done, declined is gone; the facets hold it with the first sighting and the kind', () => {
  const rows = rowsOf([
    call('a', 1),
    call('p', 2, { state: 'partial', items: [item({ answer: undefined })] }),
    call('d', 3, { state: 'declined', refusal: 'Esc', items: [item({ answer: undefined })] }),
  ])
  const by = (id: string) => rows.find(r => r.id === id)!
  expect(by('a').facets).toEqual({ status: { label: 'answered', token: 'done' }, firstSeen: AT + 1, kind: 'question' })
  expect(by('p').facets?.status).toEqual({ label: 'partial', token: 'done' }) // the dialog closed: nothing waits for the blank answer
  expect(by('d').facets?.status).toEqual({ label: 'declined', token: 'gone' })
  expect(by('p').cells.status).toEqual({ text: 'partial', fg: 'inactive' })
  expect(by('d').cells.description?.text).toBe('Storage → (declined)')
})

test('a replayed call has no first sighting: the time of a replay says nothing of when it was asked', () => {
  const [row] = rowsOf([call('a', 1, { replayed: true })])
  expect(row?.facets).toEqual({ status: { label: 'answered', token: 'done' }, kind: 'question' })
})

test('every row, the children too, has the reason created', () => {
  const [row] = rowsOf([call('a', 1)])
  expect(row?.reasons).toEqual(reasonSet('created'))
  for (const child of row?.children ?? []) expect(child.reasons).toEqual(reasonSet('created'))
})

test('one child row for each question: the header, the answer and its state; closed until the person opens the call', () => {
  const [row] = rowsOf([call('a', 1, { items: [item(), second({ answer: undefined })], state: 'partial' })])
  expect(row?.expandedByDefault).toBeUndefined()
  expect(row?.children?.map(c => c.id)).toEqual(['a:0', 'a:1'])
  const [first, blank] = row?.children ?? []
  expect(first?.cells.name?.text).toBe('Storage')
  expect(first?.cells.description?.text).toBe('State only')
  expect(first?.cells.status).toEqual({ text: 'answered', fg: 'inactive' })
  expect(blank?.cells.description?.text).toBe('(blank)')
  expect(blank?.facets?.status).toEqual({ label: 'blank', token: 'none' })
  expect(first?.can).toEqual({ dismiss: false, priority: false })
})

test('a question with notes and no option says notes only, with no state to speak of', () => {
  const [row] = rowsOf([call('a', 1, { state: 'partial', items: [item({ answer: '(notes only)', notes: 'maybe' })] })])
  expect(row?.children?.[0]?.facets?.status).toEqual({ label: 'notes only', token: 'none' })
})

test('the questions of a declined call are declined, not blank', () => {
  const [row] = rowsOf([call('a', 1, { state: 'declined', items: [item({ answer: undefined })] })])
  expect(row?.children?.[0]?.facets?.status).toEqual({ label: 'declined', token: 'gone' })
})

// ---------------------------------------------------------------- the detail, word for word

test('the detail of a question shows the question, every option with its description and preview, the pick and the notes', () => {
  const [row] = rowsOf([call('a', 1, { items: [item({ notes: 'keep it simple', description: 'One line.' })] })])
  expect(detail(row?.children?.[0])).toEqual([
    'question|Where should the records live?',
    'about|One line.',
    'option|[x] State only: Keep them in the plugin state.',
    'preview|state.set(records)',
    '|  indented',
    'option|[ ] State and store',
    'notes|keep it simple',
  ])
})

test('the chosen option and the typed text draw in the color of success; the rest draws plain', () => {
  const [row] = rowsOf([call('a', 1, { items: [second({ answer: 'Lint, custom' })] })])
  const lines = row?.children?.[0]?.detail?.() ?? []
  expect(lines.map(l => [l.cell.text, l.cell.fg])).toEqual([
    ['Which checks should run?', undefined],
    ['[x] Lint', 'success'],
    ['[ ] E2E', undefined],
    ['custom', 'success'],
  ])
  expect(lines.at(-1)?.label).toBe('typed')
})

test('a blank question says so in its detail, and a text with several lines is one line each', () => {
  const [row] = rowsOf([call('a', 1, { items: [item({ answer: undefined, question: 'one\ntwo' })] })])
  expect(detail(row?.children?.[0])).toEqual([
    'question|one',
    '|two',
    'option|[ ] State only: Keep them in the plugin state.',
    'preview|state.set(records)',
    '|  indented',
    'option|[ ] State and store',
    'answer|(left blank)',
  ])
})

test('a line longer than the detail can draw is split, so no word is lost', () => {
  const long = 'word '.repeat(200).trim()
  const [row] = rowsOf([call('a', 1, { items: [item({ answer: undefined, question: long })] })])
  const lines = row?.children?.[0]?.detail?.() ?? []
  const question = lines.filter(l => l.label === 'question' || (l.label === undefined && l.cell.text.includes('word')))
  expect(question.map(l => l.cell.text).join('')).toBe(long)
  for (const l of lines) expect([...l.cell.text].length).toBeLessThanOrEqual(240)
})

test('the detail of a call: when, its id, who asked, and the words of a refusal (the core adds the turns line)', () => {
  const [row] = rowsOf([
    call('toolu_x', 3, {
      state: 'declined',
      plugin: true,
      agentId: 'agent-9',
      cut: true,
      refusal: 'No.\nStop.',
      items: [item({ answer: undefined })],
    }),
  ])
  expect(detail(row)).toEqual([
    'asked|2026-10-21 21:41 UTC',
    'call|toolu_x',
    'by|a plugin (the engine does not name it)',
    'agent|agent-9',
    'cut|the texts were cut to fit the byte cap',
    'declined|No.',
    '|Stop.',
  ])
})

test('the detail of a replayed call says that the time is not known; the follow-up, response and AFK answer are told', () => {
  const [row] = rowsOf([
    call('a', 1, {
      replayed: true,
      turn: undefined,
      followUp: true,
      response: 'Chat',
      afkTimeoutMs: 5000,
      state: 'partial',
    }),
  ])
  expect(detail(row)).toEqual([
    'asked|not known (read back from the transcript)',
    'call|a',
    'follow-up|the person asked for another round',
    'response|Chat',
    'away|the dialog answered itself after 5 s',
  ])
})

// ---------------------------------------------------------------- plans

const plan = (over: Partial<QuestionCall> = {}): QuestionCall => ({
  id: 'toolu_plan',
  n: 4,
  kind: 'plan',
  state: 'answered',
  at: AT,
  turn: 2,
  plan: '# Plan\n\n1. Add the tracker.\n2. Add the tests.',
  planFile: '/home/x/.claude/plans/p.md',
  ...over,
})

test('an approved plan is one row of the kind plan: its first line, approved, and the plan word for word in the detail', () => {
  const [row] = rowsOf([plan()])
  expect(row?.cells.description?.text).toBe('Plan')
  expect(row?.cells.type?.text).toBe('plan')
  expect(row?.cells.status).toEqual({ text: 'approved', fg: 'inactive' })
  expect(row?.facets).toEqual({ status: { label: 'approved', token: 'done' }, firstSeen: AT, kind: 'plan' })
  expect(row?.children).toBeUndefined()
  expect(detail(row)).toEqual([
    'asked|2026-10-21 21:41 UTC',
    'call|toolu_plan',
    'plan|# Plan',
    '|',
    '|1. Add the tracker.',
    '|2. Add the tests.',
    'file|/home/x/.claude/plans/p.md',
  ])
})

test('a rejected plan is declined, says rejected and shows the words of the person', () => {
  const [row] = rowsOf([plan({ state: 'declined', refusal: 'Use fewer steps' })])
  expect(row?.cells.status).toEqual({ text: 'rejected', fg: 'inactive' })
  expect(row?.facets?.status).toEqual({ label: 'rejected', token: 'gone' })
  expect(detail(row).at(-1)).toBe('rejected|Use fewer steps')
})

test('a plan with no text has the description Plan and says so in its detail', () => {
  const [row] = rowsOf([plan({ plan: undefined })])
  expect(row?.cells.description?.text).toBe('Plan')
  expect(detail(row)).toContain('plan|(the engine gave no plan text)')
})

// ---------------------------------------------------------------- the screen masks, the record does not

const KEY = `ghp_${'a1b2c3d4e5'.repeat(4)}`

test('a secret in a typed answer, a note or a preview is masked on the screen by default', () => {
  const calls = [
    call('a', 1, {
      items: [
        item({
          answer: `token is ${KEY}`,
          notes: `see ${KEY}`,
          options: [{ label: 'A', preview: `export TOKEN=${KEY}` }],
        }),
      ],
    }),
  ]
  const [row] = rowsOf(calls)
  const all = JSON.stringify([row, ...(row?.children ?? []).map(c => c.detail?.())])
  expect(all).not.toContain(KEY)
  expect(row?.cells.description?.text).toBe(`Storage → typed: token is ${MASKED}`)
  expect(JSON.stringify(rowsOf(calls, { mask: false }))).toContain(KEY)
  expect(JSON.stringify(calls)).toContain(KEY) // the record is untouched
})

test('the answer to a question that asks for a password is masked whole', () => {
  const [row] = rowsOf([
    call('a', 1, {
      items: [item({ question: 'What is the password?', header: 'Login', options: [], answer: 'hunter2' })],
    }),
  ])
  expect(row?.cells.description?.text).toBe(`Login → typed: ${MASKED}`)
})

test('the answer to an item that the byte cut marked sensitive is masked whole on the screen, in the row and in the detail', () => {
  const marked = item({
    question: 'Which one?',
    header: 'Pick',
    options: [],
    answer: 'hunter2',
    notes: 'it is hunter2',
    sensitive: true,
  })
  const [row] = rowsOf([call('a', 1, { items: [marked] })])
  expect(row?.cells.description?.text).toBe(`Pick → typed: ${MASKED}`)
  const all = JSON.stringify([row, ...(row?.children ?? []).map(c => c.detail?.())])
  expect(all).not.toContain('hunter2')
  const [open] = rowsOf([call('b', 2, { items: [{ ...marked, sensitive: undefined }] })])
  expect(open?.cells.description?.text).toBe('Pick → typed: hunter2')
})

test('the detail of a text and of a number question tells its control, word for word', () => {
  const [row] = rowsOf([
    call('a', 1, {
      items: [
        item({ kind: 'text', options: [], answer: 'Ada', placeholder: 'e.g. Ada' }),
        item({ kind: 'number', options: [], answer: '4', min: 1, max: 10, step: 0.5, defaultValue: 0, unit: 'px' }),
      ],
    }),
  ])
  expect(detail(row?.children?.[0])).toContain('placeholder|e.g. Ada')
  const number = detail(row?.children?.[1])
  expect(number).toEqual(expect.arrayContaining(['min|1', 'max|10', 'step|0.5', 'default|0', 'unit|px']))
  expect(detail(rowsOf([call('b', 2, { items: [item()] })])[0]?.children?.[0]).join('\n')).not.toMatch(
    /placeholder|^min\|/,
  )
})

test('the placeholder is masked like the other words of a question', () => {
  const [row] = rowsOf([
    call('a', 1, { items: [item({ kind: 'text', options: [], answer: 'x', placeholder: `token ${KEY}` })] }),
  ])
  expect(JSON.stringify(detail(row?.children?.[0]))).not.toContain(KEY)
})

test('the file of a plan is masked in the detail like the other words of the plan, and shows when masking is off', () => {
  const file = '/plans/password=hunter2/plan.md'
  const [row] = rowsOf([plan({ planFile: file })])
  expect(detail(row)).toContain(`file|/plans/password=${MASKED}`)
  expect(JSON.stringify(detail(row))).not.toContain('hunter2')
  expect(detail(rowsOf([plan({ planFile: file })], { mask: false })[0])).toContain(`file|${file}`)
})

test('the helper text of a question counts: Production password makes the typed answer secret, in the row and the detail', () => {
  const q = item({
    question: 'Enter the value?',
    header: 'Value',
    description: 'Production password',
    options: [],
    answer: 'hunter2',
    notes: 'it is hunter2',
  })
  const [row] = rowsOf([call('a', 1, { items: [q] })])
  expect(row?.cells.description?.text).toBe(`Value → typed: ${MASKED}`)
  expect(JSON.stringify([row, ...(row?.children ?? []).map(c => detail(c))])).not.toContain('hunter2')
})

test('the freeform response of a call with a question that asks for a secret is masked whole in the detail', () => {
  const asks = item({ question: 'What is the password?', header: 'Login', options: [], answer: 'x' })
  const [secret] = rowsOf([call('a', 1, { items: [asks], response: 'it is hunter2' })])
  expect(JSON.stringify(detail(secret))).not.toContain('hunter2')
  expect(detail(secret)).toContain(`response|${MASKED}`)
  const [plain] = rowsOf([call('b', 2, { items: [item()], response: 'it is hunter2' })])
  expect(detail(plain)).toContain('response|it is hunter2')
})

// ---------------------------------------------------------------- the /track text

test('the /track text names the Questions group and holds no question, answer or note: the model reads every /track reply', () => {
  const text = groupsText(listGroups(sections(ctx([call('a', 1), plan({ n: 2, id: 'p' })]))))
  expect(text).toBe('Questions  2 calls · /track qa prints them')
  for (const word of ['Storage', 'State only', 'Lint', 'Plan']) expect(text).not.toContain(word)
})

// The views of issue #63 regroup the rows of every section: by status, by tracker, by reason or flat. A group of such a view
// mixes the rows of several sections, so the section's `text` cannot ride on a group. The rows carry the mark instead.
test('in every view the /track text holds no question, answer or note: the rows of the Questions section are quiet', () => {
  const secs = sections(ctx([call('a', 1), plan({ n: 2, id: 'p' })]))
  for (const view of ['list', 'tracker', 'status', 'reason', 'flat'] as const) {
    const { groups } = viewGroups(secs, view, { touchedOnly: false })
    const text = groupsText(groups)
    for (const word of ['Storage', 'State only', 'Lint', 'Plan', 'Q1', 'Q2', 'typed', 'Checks'])
      expect(text, `${view}: ${word}`).not.toContain(word)
    // The pane still draws every row, in the groups of the view.
    expect(groups.flatMap(g => g.rows.map(r => r.id)).sort(), view).toEqual(['a', 'p'])
  }
})

test('a row of another section keeps its text in a view that groups it with the quiet rows', () => {
  const web: TreeRow = {
    id: 'w',
    owner: 'web',
    cells: { name: { text: 'link' } },
    can: { dismiss: true, priority: true },
  }
  const mixed = [...sections(ctx([call('a', 1)])), { id: 'web', title: 'Web', rows: [web] }]
  const text = groupsText(viewGroups(mixed, 'flat', { touchedOnly: false }).groups)
  expect(text).toContain('link')
  expect(text).not.toContain('Storage')
})

test('the pane still draws every row of the group that the /track text keeps out', () => {
  const [group] = listGroups(sections(ctx([call('a', 1), plan({ n: 2, id: 'p' })])))
  expect(group?.rows.map(r => r.cells.name?.text)).toEqual(['Q2', 'Q1'])
  expect(group?.rows[1]?.children).toHaveLength(2)
})
