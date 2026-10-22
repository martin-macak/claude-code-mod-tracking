// The Questions section (issue #71): the calls of the session, newest first, as summary rows with one child row for each
// question. Pure: it reads the view context and writes nothing. A session with no call has no section.

import type { Json } from '../../core/interfaces/items'
import type { SectionSpec, ViewContext } from '../../core/interfaces/view'
import type { QuestionsConfig } from './config'
import { callsWithin } from './log'
import { masker } from './present'
import { callRow } from './rows'

/** Where the pane places the section: after Processes (80). */
const RANK = 90

export function sections(ctx: ViewContext<QuestionsConfig, Json>): readonly SectionSpec[] {
  const config = ctx.config.slice()
  const calls = callsWithin(ctx.data, config)
  if (calls.length === 0) return []
  const m = masker(config.mask)
  return [
    {
      id: 'questions',
      title: 'Questions',
      note: { text: `${calls.length} ${calls.length === 1 ? 'call' : 'calls'} · /track qa prints them` },
      rank: RANK,
      // The model reads every /track reply, so the text of the list names the group and no question, answer or note. The pane draws the rows.
      text: 'title',
      // The newest call first: the pane shows the first rows of a long section, and a decision of today matters more than one of an hour ago.
      rows: calls.map(c => callRow(c, m)).reverse(),
    },
  ]
}
