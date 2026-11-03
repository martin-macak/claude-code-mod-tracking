// The help model of the narrow-pane tests (issue #287): the real core, GitHub and Questions keys, one row of each tracker and three
// problems, the model of the probe in the issue. Pure.
import { CORE_KEYS } from '../../core/infra/keys'
import { KEYS as GITHUB_ROW_KEYS } from '../../trackers/github/actions'
import { QUESTION_KEYS } from '../../trackers/questions/actions'
import { helpModel } from '../../ux/tree-data-table/help'
import { row } from './sections'

export const narrowModel = (version: string | undefined = undefined, problems = 3) =>
  helpModel(
    [
      ...CORE_KEYS,
      ...GITHUB_ROW_KEYS.map(k => ({ ...k, owner: 'github' })),
      ...QUESTION_KEYS.map(k => ({ ...k, owner: 'questions' })),
    ],
    [
      { title: 'Pull requests', rows: [row('p1', {}, { owner: 'github' })] },
      { title: 'questions', rows: [row('q1', {}, { owner: 'questions' })] },
    ],
    '/h/.config/claude-code/mods/tracker/config.json',
    ['A.', 'B.', 'C.'].slice(0, problems),
    version,
  )

/**
 * The smallest body a docked pane gives, in rows. The issue's probe fits 31 rows (120x37, tree-table.md, "Docked panes"); the summary
 * row and the hint line take 2 of the 30 body rows of a 120x36 terminal, so the smallest docked body the e2e harness opens is 28.
 */
export const DOCK_MIN_BODY = 28
