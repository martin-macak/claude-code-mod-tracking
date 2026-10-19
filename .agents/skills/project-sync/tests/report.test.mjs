import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatNext, formatReport, pickNext, plan } from '../scripts/core.mjs'
import { NONE, OPTIONS, project, REPO } from './helpers.mjs'

const PROJECT = { title: 'artifact-tracking 0.2.0', url: 'https://github.com/users/martin-macak/projects/3' }
const build = (p, extra = {}) => {
  const { items, graph } = p.build()
  const result = plan({ items, graph, options: OPTIONS, repo: REPO, ...extra })
  return { items, result, text: formatReport({ project: PROJECT, repo: REPO, items }, result) }
}

test('the report of a project in sync says none for every part', () => {
  const { text } = build(project().issue(1, { status: 'Ready', wave: 'Wave 0', text: NONE }).pr(2).draft('d'))
  assert.equal(
    text,
    [
      'Project "artifact-tracking 0.2.0": https://github.com/users/martin-macak/projects/3',
      `Repo ${REPO}. Items: 3 (issues 1, PRs 1, drafts 1).`,
      '',
      'Planned changes: none.',
      'Item positions: in order.',
      'Cycles: none.',
      'Order inversions: none.',
      'Open milestone issues missing from the project: none.',
      'Items with no Status (2):',
      '  PR #2 PR 2',
      '  draft "d"',
    ].join('\n'),
  )
})

test('planned changes are grouped by item, with the old and the new value', () => {
  const { text } = build(
    project()
      .issue(55, { status: 'In progress', wave: 'Wave 0', text: NONE })
      .issue(56, { blockedBy: [55], status: 'Ready', wave: 'Wave 0', title: 'Ended tasks stay running' }),
  )
  assert.match(
    text,
    new RegExp(
      [
        'Planned changes \\(3\\):',
        '  #56 Ended tasks stay running',
        '    Wave: Wave 0 -> Wave 1',
        '    Status: Ready -> Blocked',
        '    Blocked by: \\(empty\\) -> "#55"',
      ].join('\\n'),
    ),
  )
})

test('cycles, inversions and missing milestone issues are listed', () => {
  const { text } = build(
    project()
      .issue(1, { blockedBy: [2], order: 3, status: 'Blocked', wave: 'Wave 0', text: '#2' })
      .issue(2, { blockedBy: [1], order: 3, status: 'Blocked', wave: 'Wave 0', text: '#1' })
      .issue(3, { order: 9, status: 'Ready', wave: 'Wave 0', text: NONE })
      .issue(4, { blockedBy: [3], order: 4, status: 'Blocked', wave: 'Wave 1', text: '#3' }),
    { milestoneIssues: [{ key: `${REPO}#7`, number: 7, title: 'Lost issue', milestone: 'artifact-tracking 0.2.0' }] },
  )
  assert.match(text, /Cycles \(1\):\n {2}#1, #2\n/)
  assert.match(text, /Order inversions \(1\):\n {2}#4 \(Order 4\) is ordered before its blocker #3 \(Order 9\)\n/)
  assert.match(
    text,
    /Open milestone issues missing from the project \(1\):\n {2}#7 Lost issue \(milestone "artifact-tracking 0\.2\.0"\)/,
  )
})

test('item positions list the moves, ten at most, and name a draft by its title', () => {
  const p = project()
  for (let n = 14; n >= 1; n -= 1) p.issue(n, { order: n, status: 'Ready', wave: 'Wave 0', text: NONE })
  const { result, text } = build(p)
  assert.equal(result.positions.moves.length, 13)
  assert.match(text, /\nItem positions \(13 of 14 items move to follow Order\):\n {2}#1 to the top\n {2}#2 after #1\n/)
  assert.match(text, /\n {2}#10 after #9\n {2}\.\.\. and 3 more \(--json lists all\)\n/)
  const mixed = build(project().issue(5, { order: 5 }).pr(6, { order: 4 }).draft('Layer 3', { order: 1 }))
  assert.match(
    mixed.text,
    /Item positions \(2 of 3 items move to follow Order\):\n {2}draft "Layer 3" to the top\n {2}#6 after draft "Layer 3"\n/,
  )
})

test('a long title is cut', () => {
  const { text } = build(project().issue(1, { title: 'x'.repeat(100) }))
  assert.match(text, / {2}#1 x{57}\.\.\.\n/)
})

test('a long title is cut by code point, so an emoji is never split', () => {
  const { text } = build(project().issue(1, { title: `Ship it ${'🚀'.repeat(70)}` }))
  assert.doesNotMatch(text, /[\ud800-\udbff](?![\udc00-\udfff])/)
  assert.match(text, / {2}#1 Ship it (?:🚀){49}\.\.\.\n/u)
})

test('formatNext prints the item, its place and the other Ready items', () => {
  const p = project()
    .issue(64, {
      status: 'Ready',
      wave: 'Wave 0',
      order: 4,
      release: '0.2.0',
      area: 'release',
      title: 'Take the version',
    })
    .draft('#55 L4: Config manager', { status: 'Ready', wave: 'Wave 1', order: 12 })
  const { items } = p.build()
  assert.equal(
    formatNext(pickNext(items), REPO),
    [
      'Next: #64 Take the version',
      `  https://github.com/${REPO}/issues/64`,
      '  Wave 0, Order 4, Release 0.2.0, Area release',
      'Other Ready: draft "#55 L4: Config manager" (Wave 1, Order 12)',
    ].join('\n'),
  )
})

test('formatNext says so when nothing is Ready', () => {
  assert.equal(formatNext(pickNext([]), REPO), 'Next: no Ready item.')
})

test('formatNext names a draft; an Other Ready item with no Wave and no Order has no empty parentheses', () => {
  const p = project().draft('Layer 4', { status: 'Ready', wave: 'Wave 0', order: 5 }).issue(7, { status: 'Ready' })
  assert.equal(
    formatNext(pickNext(p.build().items), REPO),
    ['Next: draft "Layer 4"', '  Wave 0, Order 5', 'Other Ready: #7 Issue 7'].join('\n'),
  )
})

test('formatNext says so when the Next item has no place', () => {
  const p = project().issue(7, { status: 'Ready' })
  assert.equal(
    formatNext(pickNext(p.build().items), REPO),
    ['Next: #7 Issue 7', `  https://github.com/${REPO}/issues/7`, '  no Wave, no Order'].join('\n'),
  )
})

test('formatNext caps Other Ready at five items and counts the rest', () => {
  const ready = count => {
    const p = project()
    for (let n = 1; n <= count; n += 1) p.issue(n, { status: 'Ready', wave: 'Wave 0', order: n })
    return formatNext(pickNext(p.build().items), REPO).split('\n')
  }
  assert.match(ready(8).at(-1), /^Other Ready: #2 .*; #6 Issue 6 \(Wave 0, Order 6\); and 2 more$/)
  // Six Ready items fill the cap exactly: Next and five others, so there is no tail.
  assert.match(ready(6).at(-1), /^Other Ready: #2 .*; #6 Issue 6 \(Wave 0, Order 6\)$/)
})
