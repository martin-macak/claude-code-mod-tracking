// The /track text, made from the same sections as the pane. It shows every child, no detail, no cap and no N more row.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10 "Other renderers". Plan: L6 Task 9, G2.
import type { SectionSpec, TreeRow } from '../../core/interfaces/view'

/** What the pane and the text say when no section has anything to show. */
export const EMPTY_TEXT = 'No tracked items yet.'

/**
 * A title line (the title, two spaces, the note), then one line per row, indented two spaces a level from the first.
 * The lead is the non-empty cells of the columns up to and including the tree column, joined by one space. The other
 * non-empty cells follow, joined by two spaces. Sections are separated by one empty line.
 */
export function sectionsText(sections: readonly SectionSpec[]): string {
  if (sections.length === 0) return EMPTY_TEXT
  const lines: string[] = []
  for (const s of sections) {
    if (lines.length > 0) lines.push('')
    lines.push(`${s.title}  ${s.note?.text ?? ''}`)
    const treeAt = s.columns.findIndex(c => c.role === 'tree')
    const textsOf = (r: TreeRow, from: number, to?: number): string[] =>
      s.columns
        .slice(from, to)
        .map(c => r.cells[c.id]?.text ?? '')
        .filter(t => t !== '')
    const walk = (rows: readonly TreeRow[], depth: number): void => {
      for (const r of rows) {
        const lead = textsOf(r, 0, treeAt + 1).join(' ')
        const cells = [lead, ...textsOf(r, treeAt + 1)].filter(t => t !== '')
        lines.push('  '.repeat(depth + 1) + cells.join('  '))
        walk(r.children ?? [], depth + 1)
      }
    }
    walk(s.rows, 0)
  }
  return lines.join('\n')
}
