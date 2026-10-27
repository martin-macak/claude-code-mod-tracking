// The row of a file: the file name, its folder below the session root, its type, and what Claude did with it (issues #28 and
// #57). The type cell holds the type word (`code`, `config`, `docs`, `data`, `markup`, `image`, `other`) and so does
// `facets.kind`. The status cell says `deleted`, `created` or `edited N`; the reason `mentioned` is in the reasons of the row,
// not in a cell. A badge says `viewed N` (and `edited N` when the status says `created`), and a mark says `subagent`. A file
// that was only read or named draws dim. A file that was only read is counted in one line of the `/track` text and not
// listed (the section says so in `SectionSpec.textMore`; the view marks the row quiet). What counts as written, named or only
// read is `activity.ts`. Pure. tests/file-rows.test.ts pins the cells.
// Plan: L5 Task 13, L6 A1.

import type { TreeRow, ViewContext } from '../../core/interfaces/view'
import { baseName, dirName, relativeToRoot } from '../../core/lib/paths'
import { itemRow } from '../../core/lib/rows'
import { isWritten } from './activity'
import { fileTypeOf } from './file-type'
import type { FileRecord } from './types'

/** The words of the status cell: the strongest thing that Claude did to the file. A file that was only read or named has none. */
function statusOf(r: FileRecord): string {
  if (r.deleted) return 'deleted'
  if (r.created) return 'created'
  return r.edits > 0 ? `edited ${r.edits}` : ''
}

/**
 * The file name is the Name cell, and the folder below the session root is the Description: the name says which file, the
 * folder says where. A file at the root has no folder, so its Description is empty. A folder next to the name repeats nothing
 * in the `/track` text.
 */
export function fileRow(item: FileRecord, env: Pick<ViewContext, 'levelOf' | 'root'>): TreeRow {
  const path = env.root ? relativeToRoot(item.label, env.root) : item.label
  const type = fileTypeOf(item)
  const status = statusOf(item)
  // The status says `created` or `deleted` for a file that was edited too: the badge keeps the count of the edits.
  const badges = [
    item.edits > 0 && (item.created || item.deleted === true) ? `edited ${item.edits}` : '',
    item.views > 0 ? `viewed ${item.views}` : '',
  ]
  return itemRow({
    id: item.key,
    owner: 'file',
    level: env.levelOf(item.key),
    firstSeen: item.firstSeen,
    kind: type,
    dismiss: true,
    reasons: item.reasons,
    dim: !isWritten(item),
    text: {
      key: baseName(path),
      keyClip: 'middle', // a file name keeps its extension
      title: dirName(path),
      titleClip: 'middle', // a folder keeps both ends
      type,
      // The counts of the edits are no state: a file is never failed, waiting or done.
      status: { label: status, token: 'none' },
      extra: badges.filter(b => b !== '').join(' '),
      mark: item.bySubagent ? 'subagent' : '',
    },
  })
}
