// The groups of the pane: what the one table draws from the sections of the trackers. L1 of issue #63 has one view, "by
// list": each section is one group, in the order of the pane. Pure: no `$`, no I/O, no tracker named.
// Design study of issue #63, sections 5.2 and 5.10.

import type { GroupSpec, SectionSpec } from '../interfaces/view'

/** The view the pane draws today: one group for each section of a tracker. */
export const LIST_VIEW = 'list'

/** `<view>:<group key>`, e.g. `list:prs`. The caps of the table key the rows that "N more" opened by it. */
export const groupId = (view: string, key: string): string => `${view}:${key}`

/**
 * The by-list view: a group for each section, in the order given. The count is the one the section sets, else its
 * top-level rows, and the failing count is the one its band carries (a section with no band has none).
 */
export function listGroups(sections: readonly SectionSpec[]): readonly GroupSpec[] {
  return sections.map(s => ({
    id: groupId(LIST_VIEW, s.id),
    title: s.title,
    ...(s.note !== undefined ? { note: s.note } : {}),
    rows: s.rows,
    count: s.count ?? s.rows.length,
    failing: s.band?.failing ?? 0,
    ...(s.empty !== undefined ? { empty: s.empty } : {}),
  }))
}
