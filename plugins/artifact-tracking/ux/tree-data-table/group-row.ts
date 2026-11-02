// The row of a foldable group (issue #256, the tree view): the title, the note and the count of the group as a `TreeRow`, so the one
// table draws it in the shared columns, the status area names it (`Selected:` and the quick view) and the key routing treats it as
// a row that only `o` works on. Its id is the id of the group. Pure.
import type { GroupSpec, RowRef, TreeRow } from '../../core/interfaces/view'

/** The owner of a group row: core's, not a tracker's, so no tracker key is live on it. */
export const GROUP_OWNER = 'core'

/**
 * The count of a group as the status cell says it: the number of rows, then `(n failed)` when some failed. The cell has one color, so
 * the whole text takes the error color then. A cap or a fold never changes the numbers: they are the numbers of the group.
 */
export const countText = (spec: Pick<GroupSpec, 'count' | 'failing'>): string =>
  spec.failing > 0 ? `${spec.count} (${spec.failing} failed)` : String(spec.count)

/** The row that stands for the group `spec`: the title in bold, the note in the description column, the count in the status column. */
export function groupRowOf(spec: GroupSpec): TreeRow {
  const note = spec.note
  return {
    id: spec.id,
    owner: GROUP_OWNER,
    cells: {
      name: { text: spec.title, weight: 'bold' },
      ...(note === undefined ? {} : { description: note.fg === undefined ? { ...note, dim: true } : note }),
      status: { text: countText(spec), ...(spec.failing > 0 ? { fg: 'error' as const } : {}) },
    },
  }
}

/** The key routing's view of a group row: `o` folds it when it has rows, and no other key has a target on it. */
export const groupRefOf = (spec: GroupSpec): RowRef => ({
  id: spec.id,
  owner: GROUP_OWNER,
  group: spec.id,
  can: { open: spec.rows.length > 0 },
})
