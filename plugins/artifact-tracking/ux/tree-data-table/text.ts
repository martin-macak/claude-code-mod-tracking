// The /track text, made from the same groups as the pane. It shows every child, no detail, no cap and no N more row.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10 "Other renderers". Plan: L6 Task 9, G2.
// Issue #63, L1: the pane draws one table, but the text is the one it printed when each section had its own columns.
import type { CellId, GroupSpec, SectionSpec, TreeRow } from '../../core/interfaces/view'
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
 * The title line of a group or a section: the title, two spaces and the note. A group of a view other than by list has no
 * note: its line ends at the title, with no trailing space.
 */
export const titleLine = (g: { readonly title: string; readonly note?: { readonly text: string } }): string =>
  g.note === undefined ? g.title : `${g.title}  ${g.note.text}`

/**
 * The title line of each section that keeps its rows out of the text (`text: 'title'`) and has rows. A view other than by
 * list prints no row of such a section, so these lines, at the end of its text, say that the section exists and what it
 * says in the by-list view: the title and the note (`Questions  2 calls · /track qa prints them`), never a row.
 */
export const quietTitles = (sections: readonly Pick<SectionSpec, 'title' | 'note' | 'text' | 'rows'>[]): string[] =>
  sections.filter(s => s.text === 'title' && s.rows.length > 0).map(titleLine)

/**
 * The title line and the `textMore` line of each section that leaves rows out of the text (`SectionSpec.textMore`): `Files  188
 * more files read only`. A view other than by list prints no row marked `quiet`, so these lines, at the end of its text, say
 * how many rows the text left out. The by-list view says it in the group (`GroupSpec.textMore`).
 */
export const moreLines = (sections: readonly Pick<SectionSpec, 'title' | 'textMore'>[]): string[] =>
  sections.flatMap(s => (s.textMore === undefined ? [] : [`${s.title}  ${s.textMore.line}`]))

/**
 * A title line (the title, two spaces, the note), then one line per row, indented two spaces a level from the first.
 * The lead is the non-empty cells of the columns up to and including the tree column (the control and the name), joined
 * by one space. The other non-empty cells follow, joined by two spaces: the description, the type, the status, then
 * each badge as a cell of its own. Groups are separated by one empty line. The counts of a group are not printed. A group
 * with `text: 'title'` prints its title line only, and a `quiet` row prints nothing, with its children, in any group: the
 * model reads every `/track` reply. A group of a view that holds quiet rows only prints no title line either (the caller
 * names the quiet section once, at the end: `quietTitles`). A group with a `textMore` line prints it last, indented as a row,
 * and keeps its title line even when every row is quiet (the files that were only read, issue #57). With no group at all it
 * says `EMPTY_TEXT`; with groups that all print nothing it is empty.
 */
export function groupsText(groups: readonly GroupSpec[]): string {
  if (groups.length === 0) return EMPTY_TEXT
  const treeAt = SHARED_COLUMNS.findIndex(c => c.role === 'tree')
  const lines: string[] = []
  for (const g of groups) {
    if (g.text !== 'title' && g.textMore === undefined && g.rows.length > 0 && g.rows.every(r => r.quiet === true))
      continue
    if (lines.length > 0) lines.push('')
    lines.push(titleLine(g))
    if (g.text === 'title') continue
    const walk = (rows: readonly TreeRow[], depth: number): void => {
      for (const r of rows) {
        if (r.quiet === true) continue // with its children: the model reads this text
        const lead = textsOf(r, 0, treeAt + 1).join(' ')
        const cells = [lead, ...textsOf(r, treeAt + 1)].filter(t => t !== '')
        lines.push('  '.repeat(depth + 1) + cells.join('  '))
        walk(r.children ?? [], depth + 1)
      }
    }
    walk(g.rows, 0)
    if (g.textMore !== undefined) lines.push(`  ${g.textMore}`)
  }
  return lines.join('\n')
}
