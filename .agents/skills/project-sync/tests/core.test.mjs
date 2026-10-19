import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatRefs, parseRefs, pickNext, plan } from '../scripts/core.mjs'
import { NONE, OPTIONS, project, REPO } from './helpers.mjs'

const run = (p, extra = {}) => plan({ ...p.build(), options: OPTIONS, repo: REPO, ...extra })
const find = (res, number, field) => res.changes.find(c => c.number === number && c.field === field)
const to = (res, number, field) => find(res, number, field)?.to

test('an issue with no open blocker gets Wave 0, Ready and the dash', () => {
  const res = run(project().issue(1))
  assert.deepEqual(
    res.changes.map(c => [c.number, c.field, c.from, c.to]),
    [
      [1, 'Wave', null, 'Wave 0'],
      [1, 'Status', null, 'Ready'],
      [1, 'Blocked by', null, NONE],
    ],
  )
  assert.equal(NONE, '—')
})

test('Wave is 1 plus the highest Wave of the open blockers', () => {
  const res = run(
    project()
      .issue(1)
      .issue(2, { blockedBy: [1] })
      .issue(3, { blockedBy: [2] })
      .issue(4, { blockedBy: [3, 1] }),
  )
  assert.deepEqual(
    [1, 2, 3, 4].map(n => to(res, n, 'Wave')),
    ['Wave 0', 'Wave 1', 'Wave 2', 'Wave 3'],
  )
})

test('a blocker with the lower Wave does not lower the Wave of an issue', () => {
  const res = run(
    project()
      .issue(1)
      .issue(2, { blockedBy: [1] })
      .issue(3, { blockedBy: [1, 2] }),
  )
  assert.equal(to(res, 3, 'Wave'), 'Wave 2')
})

test('a closed blocker does not count', () => {
  const res = run(
    project()
      .issue(1, { state: 'CLOSED' })
      .issue(2, { blockedBy: [1] }),
  )
  assert.equal(to(res, 2, 'Wave'), 'Wave 0')
  assert.equal(to(res, 2, 'Status'), 'Ready')
  assert.equal(to(res, 2, 'Blocked by'), NONE)
})

test('a blocker outside the project counts, and its Wave comes from its own open blockers', () => {
  const res = run(
    project()
      .external(70, { blockedBy: [71] })
      .external(71)
      .issue(6, { blockedBy: [70] }),
  )
  assert.equal(to(res, 6, 'Wave'), 'Wave 2')
  assert.equal(to(res, 6, 'Status'), 'Blocked')
  assert.equal(to(res, 6, 'Blocked by'), '#70')
})

test('the blockers of a closed blocker outside the project do not count', () => {
  const res = run(
    project()
      .external(70, { state: 'CLOSED', blockedBy: [71] })
      .external(71)
      .issue(6, { blockedBy: [70] }),
  )
  assert.equal(to(res, 6, 'Wave'), 'Wave 0')
})

test('an open blocker that has only closed blockers has Wave 0, so its dependent has Wave 1', () => {
  const res = run(
    project()
      .external(70, { blockedBy: [71] })
      .external(71, { state: 'CLOSED' })
      .issue(6, { blockedBy: [70] }),
  )
  assert.equal(to(res, 6, 'Wave'), 'Wave 1')
})

// [current Status, has an open blocker, expected Status write or null]
const STATUS_CASES = [
  [null, false, 'Ready'],
  [null, true, 'Blocked'],
  ['Blocked', false, 'Ready'],
  ['Blocked', true, null],
  ['Ready', false, null],
  ['Ready', true, 'Blocked'],
  ['In progress', false, null],
  ['In progress', true, null],
  ['In review', false, null],
  ['In review', true, null],
  ['Done', false, null],
  ['Done', true, null],
]
for (const [current, blocked, expected] of STATUS_CASES) {
  test(`Status ${current ?? 'empty'} with${blocked ? '' : 'out'} an open blocker: ${expected ? `becomes ${expected}` : 'stays'}`, () => {
    const p = project().issue(1, { status: 'In progress', wave: 'Wave 0', text: NONE })
    p.issue(2, { status: current, blockedBy: blocked ? [1] : [] })
    assert.equal(to(run(p), 2, 'Status') ?? null, expected)
  })
}

test('Wave and the blocker text are still planned for an issue that is In progress', () => {
  const res = run(
    project()
      .issue(1)
      .issue(2, { status: 'In progress', blockedBy: [1] }),
  )
  assert.equal(to(res, 2, 'Status'), undefined)
  assert.equal(to(res, 2, 'Wave'), 'Wave 1')
  assert.equal(to(res, 2, 'Blocked by'), '#1')
})

test('the blocker text lists the open blockers in ascending order', () => {
  const res = run(
    project()
      .issue(55)
      .issue(62)
      .issue(63, { blockedBy: [62, 55] }),
  )
  assert.equal(to(res, 63, 'Blocked by'), '#55, #62')
})

test('the blocker text keeps a note whose issue numbers equal the open blockers', () => {
  const res = run(
    project()
      .issue(55)
      .issue(56, { blockedBy: [55], text: '#55 (can start when L3 merges)' }),
  )
  assert.equal(find(res, 56, 'Blocked by'), undefined)
})

test('the blocker text is rewritten when a listed blocker closed', () => {
  const res = run(
    project()
      .issue(55, { state: 'CLOSED' })
      .issue(62)
      .issue(63, { blockedBy: [55, 62], text: '#55, #62' }),
  )
  assert.equal(to(res, 63, 'Blocked by'), '#62')
})

test('the blocker text is rewritten when a blocker is new', () => {
  const res = run(
    project()
      .issue(55)
      .issue(56, { blockedBy: [55], text: NONE }),
  )
  assert.equal(to(res, 56, 'Blocked by'), '#55')
})

test('the blocker text is the dash when nothing blocks, and a note without issue numbers stays', () => {
  const dash = run(project().issue(1, { text: NONE }))
  assert.equal(find(dash, 1, 'Blocked by'), undefined)
  const note = run(project().issue(1, { text: 'waits for design' }))
  assert.equal(find(note, 1, 'Blocked by'), undefined)
})

test('an empty or blank blocker text is written, also when nothing blocks', () => {
  assert.equal(to(run(project().issue(1, { text: '' })), 1, 'Blocked by'), NONE)
  assert.equal(to(run(project().issue(1, { text: '  ' })), 1, 'Blocked by'), NONE)
  assert.equal(to(run(project().issue(1)), 1, 'Blocked by'), NONE)
})

test('a blocker in another repo is written as owner/repo#N after the blockers of this repo', () => {
  const res = run(
    project()
      .external('acme/lib#9')
      .issue(4)
      .issue(5, { blockedBy: ['acme/lib#9', 4] }),
  )
  assert.equal(to(res, 5, 'Blocked by'), '#4, acme/lib#9')
})

test('sync never writes Order, and leaves PRs and drafts alone', () => {
  const res = run(
    project()
      .issue(1, { order: 3 })
      .issue(2, { blockedBy: [1], order: 2 })
      .pr(10, { status: 'In review', wave: 'Wave 0', order: 1, text: '#58 (stack)' })
      .pr(11)
      .draft('#55 L4: Config manager', { status: 'Blocked', wave: 'Wave 0', text: 'L3 (stack)' })
      .draft('empty draft'),
  )
  assert.ok(res.changes.length > 0)
  assert.equal(
    res.changes.some(c => c.field === 'Order'),
    false,
  )
  assert.deepEqual([...new Set(res.changes.map(c => c.number))].sort(), [1, 2])
})

test('a closed issue is left alone', () => {
  const res = run(project().issue(1, { state: 'CLOSED', status: 'Done' }).issue(2, { state: 'CLOSED' }))
  assert.deepEqual(res.changes, [])
})

test('a cycle is reported; its members and their dependents get no Wave but still get Status and text', () => {
  const res = run(
    project()
      .issue(1, { blockedBy: [2], status: 'Ready' })
      .issue(2, { blockedBy: [1] })
      .issue(3, { blockedBy: [1] })
      .issue(4),
  )
  assert.deepEqual(res.cycles, [['#1', '#2']])
  for (const n of [1, 2, 3]) assert.equal(find(res, n, 'Wave'), undefined, `Wave of #${n}`)
  assert.equal(to(res, 1, 'Status'), 'Blocked')
  assert.equal(to(res, 3, 'Status'), 'Blocked')
  assert.equal(to(res, 1, 'Blocked by'), '#2')
  assert.equal(to(res, 3, 'Blocked by'), '#1')
  assert.equal(to(res, 4, 'Wave'), 'Wave 0')
})

test('a cycle of three issues is reported as one cycle', () => {
  const res = run(project().issue(1, { blockedBy: [3] }).issue(2, { blockedBy: [1] }).issue(3, { blockedBy: [2] }))
  assert.deepEqual(res.cycles, [['#1', '#2', '#3']])
})

test('a cycle through an issue outside the project is reported', () => {
  const res = run(
    project()
      .external(70, { blockedBy: [6] })
      .issue(6, { blockedBy: [70] }),
  )
  assert.deepEqual(res.cycles, [['#6', '#70']])
})

test('an issue that blocks itself is a cycle', () => {
  const res = run(project().issue(1, { blockedBy: [1] }))
  assert.deepEqual(res.cycles, [['#1']])
})

test('a diamond is not a cycle', () => {
  const res = run(
    project()
      .issue(1)
      .issue(2, { blockedBy: [1] })
      .issue(3, { blockedBy: [1] })
      .issue(4, { blockedBy: [2, 3] }),
  )
  assert.deepEqual(res.cycles, [])
  assert.equal(to(res, 4, 'Wave'), 'Wave 2')
})

test('an Order inversion is an issue ordered before an open blocker that is in the project', () => {
  const res = run(
    project()
      .issue(1, { order: 10 })
      .issue(2, { blockedBy: [1], order: 5 }),
  )
  assert.deepEqual(res.inversions, [{ ref: '#2', order: 5, blocker: '#1', blockerOrder: 10 }])
})

test('no Order inversion: equal Order, blocker closed, blocker outside the project, or an Order is empty', () => {
  const none = project()
    .issue(1, { order: 5 })
    .issue(2, { blockedBy: [1], order: 5 })
    .issue(3, { state: 'CLOSED', order: 50 })
    .issue(4, { blockedBy: [3], order: 1 })
    .external(70)
    .issue(5, { blockedBy: [70], order: 1 })
    .issue(6, { order: 9 })
    .issue(7, { blockedBy: [6] })
    .issue(8)
    .issue(9, { blockedBy: [8], order: 1 })
  assert.deepEqual(run(none).inversions, [])
})

test('milestone issues that are not in the project are reported', () => {
  const res = run(project().issue(1), {
    milestoneIssues: [
      { key: `${REPO}#1`, number: 1, title: 'In', milestone: 'm' },
      { key: `${REPO}#7`, number: 7, title: 'Out', milestone: 'm' },
    ],
  })
  assert.deepEqual(res.missingFromProject, [{ ref: '#7', number: 7, title: 'Out', milestone: 'm' }])
})

test('items with no Status are reported, whatever their kind, unless the plan gives them one', () => {
  const res = run(
    project()
      .issue(1, { status: 'Ready' })
      .issue(2) // the plan writes its Status, so it is not listed
      .issue(5, { state: 'CLOSED' }) // a closed issue is left alone, so it stays in the list
      .pr(3)
      .pr(4, { status: 'In review' })
      .draft('no status')
      .draft('has status', { status: 'Blocked' }),
  )
  assert.equal(to(res, 2, 'Status'), 'Ready')
  assert.deepEqual(res.noStatus, [
    { ref: '#5', kind: 'issue', title: 'Issue 5' },
    { ref: '#3', kind: 'pr', title: 'PR 3' },
    { ref: null, kind: 'draft', title: 'no status' },
  ])
})

test('a missing Wave option fails loudly and names the option, the issues and the owner', () => {
  const p = project()
    .issue(1)
    .issue(2, { blockedBy: [1] })
    .issue(3, { blockedBy: [2] })
    .issue(4, { blockedBy: [3] })
  p.issue(5, { blockedBy: [4] })
  assert.throws(
    () => run(p),
    err => {
      assert.equal(err.name, 'PlanError')
      assert.match(err.message, /"Wave 4"/)
      assert.match(err.message, /#5/)
      assert.match(err.message, /owner/i)
      return true
    },
  )
})

test('a missing Status option fails loudly', () => {
  const opts = { ...OPTIONS, Status: ['Blocked', 'In progress'] }
  assert.throws(() => plan({ ...project().issue(1).build(), options: opts, repo: REPO }), /"Ready"/)
})

test('the plan is stable: applying it leaves nothing to change', () => {
  const p = project()
    .issue(55, { status: 'In progress', order: 5 })
    .issue(56, { blockedBy: [55], status: 'Ready', text: '#55 (note)', order: 10 })
    .issue(63, { blockedBy: [62, 55], order: 17 })
    .issue(62, { blockedBy: [55], order: 15 })
    .external(70)
    .issue(64, { blockedBy: [70] })
    .pr(7, { status: 'In review' })
  const first = run(p)
  assert.ok(first.changes.length > 0)
  const second = plan({ items: first.effective, graph: p.build().graph, options: OPTIONS, repo: REPO })
  assert.deepEqual(second.changes, [])
})

test('changes come in order of issue number, then Wave, Status, Blocked by', () => {
  const res = run(
    project()
      .issue(9)
      .issue(3, { blockedBy: [9] }),
  )
  assert.deepEqual(
    res.changes.map(c => `${c.number}:${c.field}`),
    ['3:Wave', '3:Status', '3:Blocked by', '9:Wave', '9:Status', '9:Blocked by'],
  )
  assert.equal(res.changes[0].itemId, 'PVTI_3')
  assert.equal(res.changes[0].title, 'Issue 3')
})

test('parseRefs reads #N and owner/repo#N, and ignores other text', () => {
  assert.deepEqual(parseRefs('#55 (can start when L3 merges)', REPO), [`${REPO}#55`])
  assert.deepEqual(parseRefs('#55, #62', REPO), [`${REPO}#55`, `${REPO}#62`])
  assert.deepEqual(parseRefs('see acme/lib#9 and #3', REPO), ['acme/lib#9', `${REPO}#3`])
  assert.deepEqual(parseRefs(NONE, REPO), [])
  assert.deepEqual(parseRefs('L3 (stack)', REPO), [])
  assert.deepEqual(parseRefs(null, REPO), [])
})

test('formatRefs sorts, and gives the dash for an empty list', () => {
  assert.equal(formatRefs([`${REPO}#62`, `${REPO}#9`, 'acme/lib#1'], REPO), '#9, #62, acme/lib#1')
  assert.equal(formatRefs([], REPO), NONE)
})

// pickNext: the Ready item with the lowest Wave, then the lowest Order.
const pick = p => pickNext(p.build().items)

test('next is the Ready item with the lowest Wave, then the lowest Order', () => {
  const p = project()
    .issue(1, { status: 'Ready', wave: 'Wave 1', order: 1 })
    .issue(2, { status: 'Ready', wave: 'Wave 0', order: 9 })
    .issue(3, { status: 'Ready', wave: 'Wave 0', order: 4 })
    .issue(4, { status: 'In progress', wave: 'Wave 0', order: 0 })
  const { next, ready } = pick(p)
  assert.equal(next.number, 3)
  assert.deepEqual(
    ready.map(i => i.number),
    [3, 2, 1],
  )
})

test('next breaks a tie in Wave and Order by issue number (#9 before #10)', () => {
  const p = project()
    .issue(10, { status: 'Ready', wave: 'Wave 0', order: 5 })
    .issue(9, { status: 'Ready', wave: 'Wave 0', order: 5 })
  assert.equal(pick(p).next.number, 9)
})

test('next counts drafts and skips PRs and items that are not Ready', () => {
  const p = project()
    .pr(10, { status: 'Ready', wave: 'Wave 0', order: 1 })
    .draft('#55 L4: Config manager', { status: 'Ready', wave: 'Wave 0', order: 2 })
    .issue(2, { status: 'Blocked', wave: 'Wave 0', order: 3 })
    .issue(3, { status: 'Done', wave: 'Wave 0', order: 4 })
  const { next } = pick(p)
  assert.equal(next.kind, 'draft')
  assert.equal(next.title, '#55 L4: Config manager')
})

test('next sorts an item with no Wave or no Order last, and is null with nothing Ready', () => {
  const p = project()
    .draft('no wave', { status: 'Ready', order: 1 })
    .draft('no order', { status: 'Ready', wave: 'Wave 2' })
    .draft('both', { status: 'Ready', wave: 'Wave 2', order: 8 })
  assert.deepEqual(
    pick(p).ready.map(i => i.title),
    ['both', 'no order', 'no wave'],
  )
  assert.equal(pick(project().issue(1, { status: 'In progress' })).next, null)
})

test('next skips a closed issue that still says Ready', () => {
  assert.equal(pick(project().issue(1, { state: 'CLOSED', status: 'Ready', wave: 'Wave 0', order: 1 })).next, null)
})

test('next uses the Status that sync would write', () => {
  const p = project()
    .issue(1, { status: 'In progress', wave: 'Wave 0', order: 1, text: NONE })
    .issue(2, { status: 'Blocked', wave: 'Wave 1', order: 2, blockedBy: [1], text: '#1' })
    .issue(3, { status: 'Blocked', wave: 'Wave 1', order: 3, text: '#9' })
  assert.equal(pickNext(run(p).effective).next.number, 3)
})
