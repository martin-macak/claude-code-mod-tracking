// The shared columns of the one table (issue #63, L1): the solver over every row of the pane, whatever its group. Pure.
// The generic cases of the solver are in columns.test.ts.
import { expect, test } from 'claude-code/testing'
import type { TreeRow } from '../core/interfaces/view'
import {
  cellOf,
  GAP,
  GLYPH_BOX,
  resetWidths,
  SHARED_COLUMNS,
  type Solved,
  solveColumns,
} from '../ux/tree-data-table/columns'

const at = (depth: number, r: TreeRow) => ({ depth, row: r })
const widthOf = (s: Solved, id: string) => s.columns.find(c => c.id === id)?.width
const idsOf = (s: Solved) => s.columns.map(c => c.id)
const total = (s: Solved) => s.columns.reduce((n, c) => n + c.width, 0) + GAP * (s.columns.length - 1)

/** A row that fills every shared column: the widest a PR row gets. */
const full = (id: string, depth = 0) =>
  at(depth, {
    id,
    owner: 't',
    cells: {
      control: { text: '▲' },
      name: { text: 'a-name-of-19-chars!' },
      description: { text: 'A title that is longer than any room it gets' },
      type: { text: 'background task' },
      status: { text: 'In Progress' },
    },
    extras: [{ text: '✗ conflicts' }, { text: '✗ checks' }],
  })

test('the shared columns are control, name, description, type, status and extras, with the headers of the table', () => {
  expect(SHARED_COLUMNS.map(c => [c.id, c.header])).toEqual([
    ['control', ''],
    ['name', 'Name'],
    ['description', 'Description'],
    ['type', 'Type'],
    ['status', 'Status'],
    ['extras', ''],
  ])
  expect(SHARED_COLUMNS.map(c => [c.id, c.width, c.priority, c.role])).toEqual([
    ['control', { kind: 'fixed', cells: 2 }, undefined, undefined],
    ['name', { kind: 'content', min: 6, max: 24 }, undefined, 'tree'],
    ['description', { kind: 'flex', min: 10 }, undefined, undefined],
    ['type', { kind: 'content', max: 20 }, 2, undefined],
    ['status', { kind: 'content', max: 14 }, undefined, undefined],
    ['extras', { kind: 'content', max: 14 }, 1, undefined],
  ])
})

test('at 96 body columns all six shared columns show, and the description takes what is left', () => {
  resetWidths()
  const s = solveColumns('pane', SHARED_COLUMNS, [full('a')], 96)
  expect(idsOf(s)).toEqual(['control', 'name', 'description', 'type', 'status', 'extras'])
  expect(s.dropped).toEqual([])
  expect(['control', 'name', 'type', 'status', 'extras'].map(id => widthOf(s, id))).toEqual([
    2,
    19 + GLYPH_BOX,
    15, // `background task`, whole
    11, // `In Progress`, whole
    14,
  ])
  expect(total(s)).toBe(96)
})

test('the caps keep what each section showed whole before the one table: a status of 14 cells, a type of 20', () => {
  const widthFor = (cells: TreeRow['cells']) => {
    resetWidths()
    const s = solveColumns('pane', SHARED_COLUMNS, [at(0, { id: 'a', owner: 't', cells })], 96)
    return [widthOf(s, 'type'), widthOf(s, 'status')]
  }
  // Jira cut a status at 14 and a PR branch, an agent worktree and a repo's agents at 20 or more; a process kind at 18.
  expect(widthFor({ type: { text: 'feat/twenty-chars-ab' }, status: { text: 'In Progress' } })).toEqual([20, 11])
  expect(widthFor({ type: { text: 'x'.repeat(30) }, status: { text: 'Waiting for review' } })).toEqual([20, 14])
  expect(widthFor({ type: { text: 'background task' }, status: { text: 'Ready for QA' } })).toEqual([15, 12])
})

test('at 49 and at 40 body columns control, name, status and description stay, and type then extras drop first', () => {
  for (const avail of [49, 40]) {
    resetWidths()
    const s = solveColumns('pane', SHARED_COLUMNS, [full('a')], avail)
    expect(idsOf(s), `at ${avail}`).toEqual(['control', 'name', 'description', 'status'])
    expect(s.dropped, `at ${avail}`).toEqual(['type', 'extras'])
    expect(total(s), `at ${avail}`).toBe(avail)
  }
})

test('in between, the type goes before the extras, and a pane that holds the extras keeps them', () => {
  const dropAt = (avail: number) => {
    resetWidths()
    return solveColumns('pane', SHARED_COLUMNS, [full('a')], avail).dropped
  }
  expect(dropAt(80)).toEqual([])
  expect(dropAt(78)).toEqual([]) // 78 cells wanted
  expect(dropAt(77)).toEqual(['type'])
  expect(dropAt(62)).toEqual(['type']) // without the type 62
  expect(dropAt(61)).toEqual(['type', 'extras'])
  expect(dropAt(50)).toEqual(['type', 'extras'])
})

test('the extras column is as wide as its badges joined by a space, at most 14, and absent while no row has a badge', () => {
  const widthFor = (extras: readonly { text: string }[]) => {
    resetWidths()
    const row = at(0, { id: 'a', owner: 't', cells: { name: { text: 'n' } }, extras })
    return widthOf(solveColumns('pane', SHARED_COLUMNS, [row], 96), 'extras')
  }
  expect(widthFor([{ text: '✓ checks' }])).toBe(8)
  expect(widthFor([{ text: '✓' }, { text: 'ab' }])).toBe(4) // `✓ ab`
  expect(widthFor([{ text: '✗ conflicts' }, { text: '✗ checks' }])).toBe(14) // 20 joined, cut at the cap
  expect(widthFor([])).toBeUndefined()
  expect(widthFor([{ text: '' }])).toBeUndefined()
})

test('the rows of every group give one solution: the widest cell of any group sets the column', () => {
  const a = at(0, { id: 'a', owner: 't', cells: { name: { text: 'short' }, type: { text: 'PR' } } })
  const b = at(0, { id: 'b', owner: 't', cells: { name: { text: 'a-longer-name' }, type: { text: 'Epic' } } })
  resetWidths()
  const both = solveColumns('pane', SHARED_COLUMNS, [a, b], 96)
  resetWidths()
  const alone = solveColumns('pane', SHARED_COLUMNS, [a], 96)
  expect(widthOf(both, 'name')).toBe(13 + GLYPH_BOX)
  expect(widthOf(alone, 'name')).toBe(6 + GLYPH_BOX)
  expect(widthOf(both, 'type')).toBe(4)
})

test('cellOf: the cell of a column; for the extras the badges joined by a space; nothing when there is none', () => {
  const r = full('a').row
  expect(cellOf(r, 'name')).toEqual({ text: 'a-name-of-19-chars!' })
  expect(cellOf(r, 'extras')).toEqual({ text: '✗ conflicts ✗ checks' })
  expect(cellOf(r, 'nothing')).toBeUndefined()
  expect(cellOf({ id: 'b', owner: 't', cells: {} }, 'extras')).toBeUndefined()
  expect(cellOf({ id: 'c', owner: 't', cells: {}, extras: [] }, 'extras')).toBeUndefined()
})
