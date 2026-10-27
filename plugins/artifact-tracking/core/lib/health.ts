// The health line of the pane (issue #138, owner decision Q4 of the delta study, comment 6412630538 on the issue; the knowledge base
// page tree-table.md, "The adaptive status area", links it): each tool of the trackers that run, in the words of a section note
// (`toolState`), then how many problems the help view lists. A tool of a tracker that is off is never probed and would say
// `checking…` for good, so the caller hands in the tools of the live trackers only. Pure.

import type { ToolStatus } from '../../types'
import type { Cell, StatusLine } from '../interfaces/view'
import { toolState } from './text'

/** The problem count in words, and the key that shows them. */
const problemsCell = (count: number): Cell =>
  count === 0
    ? { text: 'no problems', dim: true }
    : { text: `${count} ${count === 1 ? 'problem' : 'problems'}: h`, fg: 'warning' }

/**
 * `Health: lint not installed · fmt ready · 2 problems: h`. A tool with no status in the state is left out: the line makes no claim
 * about what it does not know. With no tool the count stands alone. The count is the tail of the line: a pane too narrow for it all
 * cuts a tool note first and never the count, which is the part that tells the person to press `h`.
 */
export function healthLine(
  tools: readonly { readonly id: string; readonly status: ToolStatus | undefined }[],
  now: number,
  problems: number,
): StatusLine {
  const cells = tools.flatMap(({ id, status }): Cell[] => {
    if (status === undefined) return []
    const { note, needsPerson } = toolState(status, now)
    return [{ text: `${id} ${note}`, ...(needsPerson ? { fg: 'warning' as const } : {}) }]
  })
  return { label: 'Health:', cells, tail: problemsCell(problems) }
}
