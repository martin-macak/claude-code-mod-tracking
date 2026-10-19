// The Jira section: the issues the conversation named, each with its child tree. Pure: it reads the view context and
// writes nothing. Title, note, columns and band keep the text the pane drew before L6; tests/item-sections.test.ts pins them.
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, section 5.10. Plan: L5 Task 13, L6 A1.

import type { Json } from '../../core/interfaces/items'
import type { ToolStatus } from '../../core/interfaces/tracker'
import type { ColumnDef, SectionSpec, ViewContext } from '../../core/interfaces/view'
import { content, flex, lastRefreshOf, PRIO_COLUMN, sortedByLevel } from '../../core/lib/rows'
import { toolNote } from '../../core/lib/text'
import type { JiraConfig } from './config'
import { jiraSiteKey, nestedJira } from './nested'
import { jiraRecords, jiraRow, trackedOf } from './rows'

/** An `acli` the tools atom does not list reads as not probed. */
const IDLE: ToolStatus = { name: 'acli', available: null, loggedIn: null, breaker: 'closed' }

const COLUMNS: readonly ColumnDef[] = [
  PRIO_COLUMN,
  { id: 'key', header: 'Key', width: content(6, 18), role: 'tree' },
  { id: 'title', header: 'Summary', width: flex(10) },
  { id: 'type', header: 'Type', width: content(undefined, 12), priority: 2 },
  { id: 'status', header: 'Status', width: content(undefined, 14) },
]

export function sections(ctx: ViewContext<JiraConfig, Json>): readonly SectionSpec[] {
  const own = sortedByLevel(jiraRecords(ctx.items), ctx.levelOf)
  if (own.length === 0) return []
  const acli = ctx.tools.acli ?? IDLE
  // Nothing is folded here: the renderer folds. A record drawn under another root gets no root row of its own (#48).
  const nested = nestedJira(own)
  const tracked = trackedOf(own, ctx.levelOf)
  const note = ['acli', ...(acli.site ? [acli.site] : []), toolNote(acli, ctx.now, lastRefreshOf(own))].join(' · ')
  return [
    {
      id: 'jira',
      title: 'Jira work items',
      note: { text: note },
      rank: 20,
      band: { label: 'Jira', count: own.length, failing: 0, rank: 1 },
      columns: COLUMNS,
      rows: own.filter(r => !nested.has(jiraSiteKey(r.site, r.issueKey))).map(r => jiraRow(r, ctx, tracked)),
    },
  ]
}
