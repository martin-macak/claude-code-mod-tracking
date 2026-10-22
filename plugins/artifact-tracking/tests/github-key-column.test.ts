// The name column of the Pull requests rows holds `owner/repo#N` of another repo (issue #158). Since the one table
// (issue #63) the section has no key column of its own: it shares the name column of every group, 24 cells at most, and a
// long name is cut. The row asks for a cut in the middle, so the number at the end is still there. Pure: the table draws
// the rows that `prRow` builds.
import { expect, test } from 'claude-code/testing'
import { prRow } from '../trackers/github/rows'
import type { GitHubRecord } from '../trackers/github/types'
import { cellWidth } from '../ux/text/cell-width'
import { resetWidths } from '../ux/tree-data-table/columns'
import { TreeDataTable } from '../ux/tree-data-table/table'
import { leaves, type Node, recorder, rowBoxes, view } from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { LANE } from './fixtures/reasons'
import { group } from './fixtures/sections'

const SESSION = { host: 'github.com', owner: 'acme', repo: 'web' }
const env = {
  facts: { read: (name: string) => (name === 'session.repo' ? SESSION : undefined) },
  levelOf: () => ({}),
} as unknown as Parameters<typeof prRow>[1]

const pr = (owner: string, repo: string, number: number): GitHubRecord => ({
  key: `gh:github.com/${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`,
  category: 'github',
  url: `https://github.com/${owner}/${repo}/pull/${number}`,
  label: `${owner}/${repo}#${number}`,
  ...LANE,
  firstSeen: 1,
  lastSeen: 1,
  seenCount: 0,
  host: 'github.com',
  owner,
  repo,
  number,
  type: 'pr',
  title: 'Emit the principal scope verdict',
  state: 'open',
  checks: 'success',
  headRefName: 'feat/brown-2901',
  baseRefName: 'main',
})

/** The text of the name cell of the one row the table draws. */
function nameOf(rec: GitHubRecord): string {
  resetWidths()
  const drawn = TreeDataTable.render([group('prs', [prRow(rec, env, 'main')])], view({}), EL, recorder().actions)
  const [, name] = (rowBoxes(drawn.tree)[0] as Node).children.slice(1) as Node[]
  return leaves(name).join('')
}

test('#158: owner/repo#N of another repo that fits the name column is drawn whole, in the case it has', () => {
  expect(nameOf(pr('Acme-Corp', 'web-app', 657))).toBe('Acme-Corp/web-app#657')
})

test('#158: a longer one is cut in the middle: the start of the owner and the number at the end stay', () => {
  // 26 cells in a column of 24: the end of the repo goes, the number stays.
  expect(nameOf(pr('VerticeOne', 'vertice-iam', 657))).toBe('VerticeOne/v…ice-iam#657')
  const name = nameOf(pr('VerticeOne', 'vertice-dynamic-records', 2751))
  expect(name).toMatch(/^VerticeOne\//)
  expect(name.endsWith('#2751')).toBe(true)
  expect(cellWidth(name)).toBe(24)
})

test('#158: a PR of the session repo reads #N, in any case of its repo, and is never cut', () => {
  expect(nameOf(pr('acme', 'web', 2751))).toBe('#2751')
  expect(nameOf(pr('ACME', 'Web', 2751))).toBe('#2751')
})

// The tree column (the Name column) cut every name at the end whatever the cell asked, so `keyClip: 'middle'` of the file
// and process names, and of the PR names here, did nothing. A cell with `clip: 'middle'` is cut in the middle there too.
test('the Name column cuts a cell with clip middle in the middle, and any other cell at the end', () => {
  resetWidths()
  const long = 'a-long-name-of-more-than-twenty-four-cells.md'
  const draw = (name: { text: string; clip?: 'end' | 'middle' }) => {
    const drawn = TreeDataTable.render(
      [group('s', [{ id: 'r', owner: 't', cells: { name } }])],
      view({}),
      EL,
      recorder().actions,
    )
    const [, cell] = (rowBoxes(drawn.tree)[0] as Node).children.slice(1) as Node[]
    return leaves(cell).join('')
  }
  expect(draw({ text: long, clip: 'middle' })).toBe('a-long-name-…ur-cells.md')
  expect(draw({ text: long })).toBe('a-long-name-of-more-tha…')
  expect(draw({ text: long, clip: 'end' })).toBe('a-long-name-of-more-tha…')
})
