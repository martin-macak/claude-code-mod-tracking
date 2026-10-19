// The row of a Markdown file: one cell per activity, each naming itself, and an activity that never happened leaves its
// cell empty (issue #28). The path shows relative to the session root. Pure. The cells keep the text the pane
// drew before L6; tests/item-sections.test.ts pins them.
// Plan: L5 Task 13, L6 A1.

import type { TreeRow, ViewContext } from '../../core/interfaces/view'
import { itemRow } from '../../core/lib/rows'
import { relativeToRoot } from './files'
import type { FileRecord } from './types'

export function fileRow(item: FileRecord, env: Pick<ViewContext, 'levelOf' | 'root'>): TreeRow {
  return itemRow({
    id: item.key,
    owner: 'file',
    level: env.levelOf(item.key),
    dismiss: true,
    text: {
      key: '',
      title: env.root ? relativeToRoot(item.label, env.root) : item.label,
      type: item.created ? 'created' : item.mentions > 0 ? 'mentioned' : '',
      status: item.edits > 0 ? `edited ${item.edits}` : '',
      extra: item.views > 0 ? `viewed ${item.views}` : '',
      mark: item.bySubagent ? 'subagent' : '',
    },
  })
}
