// The `/track` text of a list of sections, as the router prints it (plan L6, decision G2). The parity test compares it to
// the text the legacy composers make; the L6 text renderer replaces it. Pure.
import type { SectionSpec, TreeRow } from '../../core/interfaces/view'

/** The `/track` text when no section draws anything. */
export const EMPTY_SECTIONS_TEXT = 'No tracked items yet.'

/**
 * A title line (`title`, two spaces, the note), then one line per row, indented by its depth. The lead is the non-empty
 * cells of the columns up to the tree column, joined by one space. The other non-empty cells follow, joined by two
 * spaces. Every child shows. Sections are separated by an empty line.
 */
export function sectionsText(sections: readonly SectionSpec[]): string {
  if (sections.length === 0) return EMPTY_SECTIONS_TEXT
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
