import assert from 'node:assert/strict'
import { test } from 'node:test'
import { desiredSequence, optionsOf, plan, positionMoves, positionPlan } from '../scripts/core.mjs'
import { live, moveAfter, OPTIONS, project, REPO } from './helpers.mjs'

// The list after the moves, each on the list that the move before it left.
const applyMoves = (list, moves) => moves.reduce((out, m) => moveAfter(out, m.itemId, m.afterId), list)

// Longest subsequence of seq that grows, by brute force over all subsets. Small seq only.
function bruteLongestIncreasing(seq) {
  let best = 0
  for (let mask = 0; mask < 1 << seq.length; mask += 1) {
    const picked = seq.filter((_, i) => mask & (1 << i))
    if (picked.every((v, i) => i === 0 || picked[i - 1] < v)) best = Math.max(best, picked.length)
  }
  return best
}

// A small deterministic random generator, so a failure repeats.
function prng(seed) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}
const shuffled = (list, rnd) => {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

test('the desired sequence is ascending Order; a tie goes issue, PR, draft, then number or title', () => {
  const p = project()
    .draft('B draft', { order: 5 })
    .draft('A draft', { order: 5 })
    .pr(20, { order: 5 })
    .issue(30, { order: 5, title: 'A: sorts first by title' })
    .issue(10, { order: 5 })
    .issue(40, { order: 1 })
  const names = desiredSequence(p.build().items).map(i => (i.kind === 'draft' ? i.title : `${i.kind} ${i.number}`))
  assert.deepEqual(names, ['issue 40', 'issue 10', 'issue 30', 'pr 20', 'A draft', 'B draft'])
})

test('an item with no Order goes last, in its current relative order', () => {
  const p = project().issue(51).draft('x').issue(2, { order: 9 }).issue(50).issue(3, { order: 1 })
  const names = desiredSequence(p.build().items).map(i => i.title)
  assert.deepEqual(names, ['Issue 3', 'Issue 2', 'Issue 51', 'x', 'Issue 50'])
})

test('Order 0 and a decimal Order count as an Order', () => {
  const p = project().issue(1).issue(2, { order: 0 }).issue(3, { order: 0.5 })
  assert.deepEqual(
    desiredSequence(p.build().items).map(i => i.number),
    [2, 3, 1],
  )
})

test('a list that is in order needs no move', () => {
  assert.deepEqual(positionMoves(['a', 'b', 'c'], ['a', 'b', 'c']), [])
  assert.deepEqual(positionMoves([], []), [])
})

test('one item out of place is one move; the first place has afterId null', () => {
  assert.deepEqual(positionMoves(['b', 'c', 'a'], ['a', 'b', 'c']), [{ itemId: 'a', afterId: null }])
  assert.deepEqual(positionMoves(['a', 'c', 'b', 'd'], ['a', 'b', 'c', 'd']), [{ itemId: 'b', afterId: 'a' }])
})

test('a reversed list of n items needs n - 1 moves', () => {
  const desired = ['a', 'b', 'c', 'd', 'e']
  const moves = positionMoves([...desired].reverse(), desired)
  assert.equal(moves.length, 4)
  assert.deepEqual(applyMoves([...desired].reverse(), moves), desired)
})

test('the moves sort any order, and they are the fewest possible', () => {
  const rnd = prng(42)
  for (let round = 0; round < 300; round += 1) {
    const n = Math.floor(rnd() * 9)
    const desired = Array.from({ length: n }, (_, i) => `i${i}`)
    const current = shuffled(desired, rnd)
    const moves = positionMoves(current, desired)
    assert.deepEqual(applyMoves(current, moves), desired, `current ${current}`)
    const longest = bruteLongestIncreasing(current.map(id => desired.indexOf(id)))
    assert.equal(moves.length, n - longest, `current ${current}`)
  }
})

test('the moves sort a long list, and no item moves twice', () => {
  const rnd = prng(7)
  const desired = Array.from({ length: 120 }, (_, i) => `i${i}`)
  const current = shuffled(desired, rnd)
  const moves = positionMoves(current, desired)
  assert.deepEqual(applyMoves(current, moves), desired)
  assert.equal(new Set(moves.map(m => m.itemId)).size, moves.length)
})

test('plan gives the positions: how many items move, and each move by name', () => {
  const p = project().issue(3, { order: 3 }).issue(1, { order: 1 }).pr(2, { order: 2 }).draft('Layer', { order: 4 })
  const { items, graph } = p.build()
  const { positions } = plan({ items, graph, options: OPTIONS, repo: REPO })
  assert.equal(positions.total, 4)
  assert.deepEqual(positions.moves, [
    { itemId: 'PVTI_3', afterId: 'PVTI_pr2', kind: 'issue', ref: '#3', title: 'Issue 3', after: '#2' },
  ])
  assert.deepEqual(
    applyMoves(
      items.map(i => i.id),
      positions.moves,
    ),
    desiredSequence(items).map(i => i.id),
  )
})

test('positionPlan: an item that moves to the top has after null', () => {
  const { items } = project().issue(5).issue(1, { order: 1 }).build()
  const { moves } = positionPlan(items, REPO)
  assert.deepEqual(
    moves.map(m => [m.ref, m.afterId, m.after]),
    [['#1', null, null]],
  )
})

test('a draft is named by its title in a move', () => {
  const { items } = project().issue(2, { order: 2 }).draft('Layer 3', { order: 1 }).build()
  const [move] = positionPlan(items, REPO).moves
  assert.deepEqual([move.kind, move.ref, move.title, move.after], ['draft', null, 'Layer 3', null])
})

test('the live project: items were added in another order, so 11 of 23 items move', () => {
  const res = plan({ items: live.items, graph: live.graph, options: optionsOf(live.fields), repo: REPO })
  assert.equal(res.changes.length, 0)
  assert.equal(res.positions.total, 23)
  assert.equal(res.positions.moves.length, 11)
  const ids = live.items.map(i => i.id)
  const sorted = applyMoves(ids, res.positions.moves)
  assert.deepEqual(
    sorted,
    desiredSequence(live.items).map(i => i.id),
  )
  const byId = new Map(live.items.map(i => [i.id, i]))
  const order = sorted.map(id => byId.get(id).fields.Order)
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  )
  assert.deepEqual(
    sorted.slice(0, 6).map(id => byId.get(id).number),
    [48, 52, 51, 53, 66, 64],
  )
})

test('the live project in Order sequence needs no move', () => {
  const sortedItems = desiredSequence(live.items)
  const res = plan({ items: sortedItems, graph: live.graph, options: optionsOf(live.fields), repo: REPO })
  assert.deepEqual(res.positions.moves, [])
})
