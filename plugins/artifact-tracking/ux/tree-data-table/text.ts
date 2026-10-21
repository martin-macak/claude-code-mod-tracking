// The /track text, made from the same groups as the pane. It shows every child, no detail, no cap and no N more row.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10 "Other renderers". Plan: L6 Task 9, G2.
// Issue #63, L1: the pane draws one table, but the text is the one it printed when each section had its own columns.
import type { CellId, GroupSpec, TreeRow } from '../../core/interfaces/view'
import { SHARED_COLUMNS } from './columns'

/** What the pane and the text say when no group has anything to show. */
export const EMPTY_TEXT = 'No tracked items yet.'

/** The non-empty texts of a row in the columns from `from` to `to`: a cell each, and each badge of the extras. */
function textsOf(r: TreeRow, from: number, to?: number): string[] {
  return SHARED_COLUMNS.slice(from, to)
    .flatMap(c => (c.id === 'extras' ? (r.extras ?? []).map(b => b.text) : [r.cells[c.id as CellId]?.text ?? '']))
    .filter(t => t !== '')
}

/**
 * A title line (the title, two spaces, the note), then one line per row, indented two spaces a level from the first.
 * The lead is the non-empty cells of the columns up to and including the tree column (the control and the name), joined
 * by one space. The other non-empty cells follow, joined by two spaces: the description, the type, the status, then
 * each badge as a cell of its own. Groups are separated by one empty line. The counts of a group are not printed.
 */
export function groupsText(groups: readonly GroupSpec[]): string {
  if (groups.length === 0) return EMPTY_TEXT
  const treeAt = SHARED_COLUMNS.findIndex(c => c.role === 'tree')
  const lines: string[] = []
  for (const g of groups) {
    if (lines.length > 0) lines.push('')
    lines.push(`${g.title}  ${g.note?.text ?? ''}`)
    const walk = (rows: readonly TreeRow[], depth: number): void => {
      for (const r of rows) {
        const lead = textsOf(r, 0, treeAt + 1).join(' ')
        const cells = [lead, ...textsOf(r, treeAt + 1)].filter(t => t !== '')
        lines.push('  '.repeat(depth + 1) + cells.join('  '))
        walk(r.children ?? [], depth + 1)
      }
    }
    walk(g.rows, 0)
  }
  return lines.join('\n')
}
