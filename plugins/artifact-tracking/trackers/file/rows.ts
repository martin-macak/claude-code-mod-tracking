// The row of a Markdown file: the file name, its folder below the session root, and one cell per activity, each naming itself;
// an activity that never happened leaves its cell empty (issue #28). Pure. The cells keep the text the pane drew before L6,
// but for the Name and the Description (issue #63, L2); tests/item-sections.test.ts and tests/status-tokens.test.ts pin them.
// Plan: L5 Task 13, L6 A1.

import type { TreeRow, ViewContext } from '../../core/interfaces/view'
import { baseName, dirName, relativeToRoot } from '../../core/lib/paths'
import { itemRow } from '../../core/lib/rows'
import type { FileRecord } from './types'

/**
 * The file name is the Name cell, and the folder below the session root is the Description: the name says which file, the
 * folder says where. A file at the root has no folder, so its Description is empty. The Name cell used to be empty, and the
 * Description held the whole path (issue #63, L2). A folder next to the name repeats nothing in the `/track` text.
 */
export function fileRow(item: FileRecord, env: Pick<ViewContext, 'levelOf' | 'root'>): TreeRow {
  const path = env.root ? relativeToRoot(item.label, env.root) : item.label
  const name = baseName(path)
  return itemRow({
    id: item.key,
    owner: 'file',
    level: env.levelOf(item.key),
    firstSeen: item.firstSeen,
    dismiss: true,
    reasons: item.reasons,
    text: {
      key: name,
      keyClip: 'middle', // a file name keeps its extension
      title: dirName(path),
      titleClip: 'middle', // a folder keeps both ends
      type: item.created ? 'created' : item.mentions > 0 ? 'mentioned' : '',
      // The counts of the edits are no state: a file is never failed, waiting or done.
      status: { label: item.edits > 0 ? `edited ${item.edits}` : '', token: 'none' },
      extra: item.views > 0 ? `viewed ${item.views}` : '',
      mark: item.bySubagent ? 'subagent' : '',
    },
  })
}
