// writeMarks (issue #138): the one guarded write of the row marks, and the seam that the band press of #232 calls to mark a
// whole turn (tests/pane-turn.test.ts). On fakePorts, with a hand-made `Press` in place of the token that PaneSession makes.
import { expect, test } from 'claude-code/testing'
import { clearMarks, writeMarks } from '../hooks/pane-marks'
import type { Press } from '../hooks/pane-refocus'
import { fakePorts } from './fixtures/ports'

const open: Press = { keys: false, still: () => true }

test('writeMarks sets the marks to the list that change gives, and stores a copy of it', async () => {
  const w = fakePorts()
  const list = ['a', 'c']
  // The fake atom clones what it keeps, so the copy shows only in what the update function gives the atom.
  const given: unknown[] = []
  const atom = w.ports.state.marks as { update: (fn: (cur: string[]) => string[]) => Promise<string[]> }
  const real = atom.update.bind(atom)
  atom.update = fn =>
    real(cur => {
      const next = fn(cur)
      given.push(next)
      return next
    })
  await writeMarks(w.ports, open, () => list)
  expect(w.state.get('marks')).toEqual(['a', 'c'])
  expect(given).toEqual([['a', 'c']])
  expect(given[0]).not.toBe(list) // the caller keeps its list: the atom never holds it
})

test('writeMarks hands change the marks as they are, so a toggle and a clear are writes of the same kind', async () => {
  const w = fakePorts()
  w.state.set('marks', ['a'])
  await writeMarks(w.ports, open, cur => [...cur, 'b'])
  expect(w.state.get('marks')).toEqual(['a', 'b'])
  await writeMarks(w.ports, open, () => [])
  expect(w.state.get('marks')).toEqual([])
})

test('a press that began before a closing writes nothing: the marks stay as the closing left them', async () => {
  const w = fakePorts()
  let closings = 0
  const press: Press = { keys: false, still: () => closings === 0 }
  w.state.set('marks', ['a'])
  closings++ // the pane closed after the press began
  await writeMarks(w.ports, press, () => ['x', 'y'])
  expect(w.state.get('marks')).toEqual(['a'])
})

test('clearMarks empties the marks with no press to ask: the closing is what makes a press stale', async () => {
  const w = fakePorts()
  w.state.set('marks', ['a', 'c'])
  await clearMarks(w.ports)
  expect(w.state.get('marks')).toEqual([])
})
