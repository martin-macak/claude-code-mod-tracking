import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  checkFields,
  desiredSequence,
  mergeIssueNodes,
  normalizeProject,
  optionsOf,
  pickNext,
  plan,
  unloadedOpenIds,
  withNewItem,
} from '../scripts/core.mjs'
import { issueNode, keyOf as key, live, REPO, snapshot, stubNode } from './helpers.mjs'

const node = snapshot.data.repositoryOwner.projectV2

test('the snapshot has 23 items: 12 issues, 5 PRs and 6 drafts', () => {
  const count = kind => live.items.filter(i => i.kind === kind).length
  assert.deepEqual([live.items.length, count('issue'), count('pr'), count('draft')], [23, 12, 5, 6])
  assert.deepEqual(live.project, {
    id: 'PVT_kwHOAA7Bx84BnlRd',
    title: 'artifact-tracking 0.2.0',
    url: 'https://github.com/users/martin-macak/projects/3',
  })
})

test('an issue item carries its key, state, milestone and field values', () => {
  const it = live.items.find(i => i.number === 56)
  assert.equal(it.id, 'PVTI_lAHOAA7Bx84BnlRdzhBmYOc')
  assert.equal(it.kind, 'issue')
  assert.equal(it.key, key(56))
  assert.equal(it.state, 'OPEN')
  assert.deepEqual(it.milestone, { number: 1, title: 'artifact-tracking 0.2.0', state: 'OPEN' })
  assert.deepEqual(it.fields, {
    Status: 'Blocked',
    Wave: 'Wave 1',
    Order: 10,
    Release: '0.2.0',
    Area: 'trackers',
    'Blocked by': '#55 (can start when L3 merges)',
  })
})

test('a PR item has a key and no milestone; a draft item has neither key nor number', () => {
  const pr = live.items.find(i => i.kind === 'pr' && i.number === 60)
  assert.equal(pr.key, key(60))
  assert.equal(pr.state, 'OPEN')
  assert.equal(pr.fields.Status, 'In review')
  const draft = live.items.find(i => i.kind === 'draft' && i.title.startsWith('#55 L3'))
  assert.deepEqual([draft.key, draft.number, draft.state], [null, null, null])
  assert.equal(draft.fields.Status, 'In progress')
  assert.equal(draft.fields['Blocked by'], '#60 (stack)')
})

test('the graph holds each project issue with its blockers as keys, in API order', () => {
  assert.deepEqual(live.graph[key(63)].blockedBy, [key(62), key(55)])
  assert.deepEqual(live.graph[key(55)].blockedBy, [])
  assert.equal(live.graph[key(55)].state, 'OPEN')
  assert.deepEqual(live.graph[key(63)], {
    key: key(63),
    id: 'I_kwDOVCiCwM8AAAABYC8dJw',
    repo: REPO,
    number: 63,
    state: 'OPEN',
    blockedBy: [key(62), key(55)],
  })
  assert.equal(Object.keys(live.graph).length, 12)
})

test('field ids and option names come from the project', () => {
  assert.equal(live.fields.Order.id, 'PVTF_lAHOAA7Bx84BnlRdzhmJcl0')
  assert.equal(live.fields.Status.options.find(o => o.name === 'Ready').id, 'f75ad846')
  assert.deepEqual(optionsOf(live.fields), {
    Status: ['Blocked', 'Ready', 'In progress', 'In review', 'Done'],
    Wave: ['Wave 0', 'Wave 1', 'Wave 2', 'Wave 3'],
    Release: ['0.2.0', 'Later', 'Tooling'],
    Area: ['core', 'ux', 'trackers', 'tooling', 'release'],
  })
})

test('checkFields accepts the snapshot and names a missing field or a wrong type', () => {
  assert.doesNotThrow(() => checkFields(live.fields))
  const { Wave, ...noWave } = live.fields
  assert.throws(() => checkFields(noWave), /no field "Wave"/)
  const badType = { ...live.fields, Order: { ...live.fields.Order, dataType: 'TEXT' } }
  assert.throws(() => checkFields(badType), /"Order".*NUMBER/)
})

test('an issue with more than 100 blockers fails loudly', () => {
  const copy = JSON.parse(JSON.stringify(node))
  const issue = copy.items.nodes.find(i => i.content.number === 63)
  issue.content.blockedBy.pageInfo = { hasNextPage: true }
  assert.throws(() => normalizeProject(copy), /#63.*more than 100 blockers/)
})

test('unloadedOpenIds lists open issues whose blockers are not known yet', () => {
  const graph = {
    a: { key: 'a', id: 'IA', state: 'OPEN', blockedBy: ['b', 'c', 'd'] },
    b: { key: 'b', id: 'IB', state: 'OPEN', blockedBy: null },
    c: { key: 'c', id: 'IC', state: 'CLOSED', blockedBy: null },
    d: { key: 'd', id: 'ID', state: 'OPEN', blockedBy: [] },
  }
  assert.deepEqual(unloadedOpenIds(graph), ['IB'])
})

test('mergeIssueNodes loads an outside issue and adds its blockers as unloaded', () => {
  const graph = { [key(70)]: stubNode(70) }
  const warnings = mergeIssueNodes(graph, [issueNode(70, { blockers: [71, [72, 'CLOSED']] })], ['I_70'])
  assert.deepEqual(warnings, [])
  assert.deepEqual(graph[key(70)].blockedBy, [key(71), key(72)])
  assert.deepEqual(graph[key(71)], stubNode(71))
  assert.deepEqual(unloadedOpenIds(graph), ['I_71'])
})

test('mergeIssueNodes keeps a loaded issue when a later blocker list names it again', () => {
  const graph = { [key(1)]: { ...stubNode(1), blockedBy: [] }, [key(70)]: stubNode(70) }
  mergeIssueNodes(graph, [issueNode(70, { blockers: [1] })], ['I_70'])
  assert.deepEqual(graph[key(1)].blockedBy, [])
})

test('mergeIssueNodes counts an unreadable issue as open with no blockers, and warns', () => {
  const graph = { [key(70)]: stubNode(70) }
  const warnings = mergeIssueNodes(graph, [null], ['I_70'])
  assert.equal(graph[key(70)].state, 'OPEN')
  assert.deepEqual(graph[key(70)].blockedBy, [])
  assert.match(warnings[0], /#70.*could not be read/)
})

test('mergeIssueNodes fails loudly when an issue has more than 100 blockers', () => {
  const graph = { [key(70)]: stubNode(70) }
  const big = issueNode(70)
  big.blockedBy.pageInfo.hasNextPage = true
  assert.throws(() => mergeIssueNodes(graph, [big], ['I_70']), /#70.*more than 100 blockers/)
})

const content = { url: 'u', id: 'I_70', repo: REPO, number: 70, kind: 'issue', state: 'OPEN', title: 'T', milestone: null }

test('withNewItem puts an issue last with no field set, and in the graph with unknown blockers', () => {
  const added = withNewItem(live, content, 'NEW')
  assert.equal(added.items.length, 24)
  assert.equal(added.items.at(-1), added.item)
  assert.deepEqual(added.item, {
    id: 'NEW',
    kind: 'issue',
    key: key(70),
    repo: REPO,
    number: 70,
    title: 'T',
    state: 'OPEN',
    milestone: null,
    fields: { Status: null, Wave: null, Order: null, Release: null, Area: null, 'Blocked by': null },
  })
  assert.deepEqual(added.graph[key(70)], stubNode(70))
  assert.deepEqual(unloadedOpenIds(added.graph), ['I_70'])
  // The project that it was given stays as it was.
  assert.equal(live.items.length, 23)
  assert.equal(key(70) in live.graph, false)
})

test('withNewItem keeps the node of an issue that the graph holds already, and leaves the graph alone for a PR', () => {
  const known = { ...live.graph, [key(70)]: { ...stubNode(70), blockedBy: [] } }
  assert.deepEqual(withNewItem({ items: live.items, graph: known }, content, 'NEW').graph[key(70)].blockedBy, [])
  const pr = withNewItem(live, { ...content, id: 'PR_70', kind: 'pr' }, 'NEW')
  assert.equal(pr.item.kind, 'pr')
  assert.equal(pr.graph, live.graph)
})

// The regression for the Definition of done: after the setup, a dry run shows no change.
// The snapshot is the state before the position moves, so this test looks at the fields only.
test('sync on the snapshot of the live project plans no field change and reports nothing', () => {
  const milestoneIssues = [55, 62, 63, 48, 56, 64, 65].map(n => ({
    key: key(n),
    number: n,
    title: `#${n}`,
    milestone: 'artifact-tracking 0.2.0',
  }))
  const res = plan({
    items: live.items,
    graph: live.graph,
    options: optionsOf(live.fields),
    repo: REPO,
    milestoneIssues,
  })
  assert.deepEqual(res.changes, [])
  assert.deepEqual(res.cycles, [])
  assert.deepEqual(res.inversions, [])
  assert.deepEqual(res.missingFromProject, [])
  assert.deepEqual(res.noStatus, [])
})

test('the snapshot in Order sequence plans no change at all', () => {
  const res = plan({ items: desiredSequence(live.items), graph: live.graph, options: optionsOf(live.fields), repo: REPO })
  assert.deepEqual([res.changes, res.positions.moves], [[], []])
})

test('next on the snapshot is #64, the only Ready item', () => {
  const { next, ready } = pickNext(live.items)
  assert.equal(next.number, 64)
  assert.equal(ready.length, 1)
})
