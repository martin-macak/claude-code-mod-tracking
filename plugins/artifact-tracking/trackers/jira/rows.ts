// The rows of the Jira section: an issue, with the child tree of its snapshot nested below it. Pure: it reads the record,
// the tool status of `acli` and the levels. The cells keep the text the pane drew
// before L6; tests/item-sections.test.ts pins them. A row always holds its whole tree: folding is the renderer's job.
// Plan: L5 Task 13, L6 A1.

import type { Effective, Priority, StoredItem } from '../../core/interfaces/items'
import type { ReasonSet } from '../../core/interfaces/reasons'
import type { RowStatus, StatusToken, TreeRow, ViewContext } from '../../core/interfaces/view'
import { byLevel } from '../../core/lib/levels'
import { itemRow, viaPrefix } from '../../core/lib/rows'
import { jiraSiteKey } from './nested'
import { childId } from './nodes'
import type { JiraNode, JiraRecord } from './types'

/** What a row reads of the view context. */
export type JiraEnv = Pick<ViewContext, 'tools' | 'levelOf'>

/** A tracked Jira record, as its nested row shows it: the via marker, the level and why it is tracked (#62). */
export type Tracked = { via: readonly string[] | undefined; level: Effective; reasons: ReasonSet }

const lower = (s: string | undefined): string => (s ?? '').toLowerCase()

/**
 * The tracked records by `site/KEY`. A child node that is also a tracked issue takes its via marker, its level and its
 * reasons: such a record has no root row, so its nested row is the only place that says why it is tracked.
 */
export function trackedOf(records: readonly JiraRecord[], levelOf: JiraEnv['levelOf']): ReadonlyMap<string, Tracked> {
  return new Map(
    records.map(r => [jiraSiteKey(r.site, r.issueKey), { via: r.via, level: levelOf(r.key), reasons: r.reasons }]),
  )
}

/** The tracked Jira records among the items of a view. */
export function jiraRecords(items: readonly StoredItem[]): JiraRecord[] {
  return items.filter((i): i is JiraRecord => i.category === 'jira' && typeof i.issueKey === 'string')
}

/**
 * The token of a Jira status category (design study of issue #63, section 5.4): `new` waits, `indeterminate` is under way,
 * `done` is done. No category, or one the map does not know, gives `none`: the mod does not guess from the status word.
 */
function categoryToken(statusCategory: string | undefined): StatusToken {
  switch (statusCategory) {
    case 'new':
      return 'waiting'
    case 'indeterminate':
      return 'active'
    case 'done':
      return 'done'
    default:
      return 'none'
  }
}

/** The level of a node the person marked, when no tracked record of the issue gives one. */
const markOf = (priority: Priority | undefined): Effective => (priority === undefined ? {} : { level: priority })

function nodeRows(
  parentId: string,
  nodes: readonly JiraNode[],
  site: string,
  tracked: ReadonlyMap<string, Tracked>,
): TreeRow[] {
  return [...nodes]
    .sort((a, b) => byLevel(a.priority, b.priority))
    .map(n => {
      const id = childId(parentId, n.key)
      const t = tracked.get(jiraSiteKey(site, n.key))
      return itemRow({
        id,
        owner: 'jira',
        level: t?.level.level !== undefined ? t.level : markOf(n.priority),
        dismiss: false,
        ...(t ? { reasons: t.reasons } : {}),
        children: nodeRows(id, n.children, site, tracked),
        ...(n.issueType ? { kind: n.issueType } : {}),
        text: {
          key: n.key,
          href: `https://${site}/browse/${n.key}`,
          title: viaPrefix(t?.via) + n.summary,
          type: n.issueType,
          status: { label: n.status, token: categoryToken(n.statusCategory) },
        },
      })
    })
}

/** An issue and its child tree. A site other than the active one, or a non-Cloud host, reads `track-only`. */
export function jiraRow(item: JiraRecord, env: JiraEnv, tracked: ReadonlyMap<string, Tracked>): TreeRow {
  const activeSite = env.tools.acli?.site
  let status: RowStatus
  if (item.error?.kind === 'not-found') {
    // A key that Jira does not know: the person has a wrong reference to fix.
    status = { label: 'not found', token: 'failed' }
  } else if (item.trackOnly || (activeSite && lower(item.site) !== lower(activeSite))) {
    // The mod cannot ask for this issue, so it knows no state.
    status = { label: 'track-only', token: 'none' }
  } else {
    status = { label: item.status ?? '', token: categoryToken(item.statusCategory) }
  }
  return itemRow({
    id: item.key,
    owner: 'jira',
    level: env.levelOf(item.key),
    dismiss: true,
    reasons: item.reasons,
    firstSeen: item.firstSeen,
    ...(item.issueType ? { kind: item.issueType } : {}),
    children: nodeRows(item.key, item.children, item.site, tracked),
    text: {
      key: item.issueKey,
      href: item.url,
      title: viaPrefix(item.via) + (item.summary ?? item.label),
      type: item.issueType ?? '',
      status,
    },
  })
}
