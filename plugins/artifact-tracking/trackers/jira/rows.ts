// The rows of the Jira section: an issue, with the child tree of its snapshot nested below it. Pure: it reads the record,
// the tool status of `acli` and the levels. The cells are today's `jiraRows` and `nodeRows` (hooks/ui/view.ts), which
// the parity test pins. A row always holds its whole tree: folding is the renderer's job.
// Plan: L5 Task 13, L6 A1.

import type { Effective, Priority, StoredItem } from '../../core/interfaces/items'
import type { TreeRow, ViewContext } from '../../core/interfaces/view'
import { byLevel } from '../../core/lib/levels'
import { itemRow, type Tone, viaPrefix } from '../../core/lib/rows'
import { jiraSiteKey } from './nested'
import { childId } from './nodes'
import type { JiraNode, JiraRecord } from './types'

/** What a row reads of the view context. */
export type JiraEnv = Pick<ViewContext, 'tools' | 'levelOf'>

/** A tracked Jira record, as its nested row shows it: the via marker and the level. */
export type Tracked = { via: readonly string[] | undefined; level: Effective }

const lower = (s: string | undefined): string => (s ?? '').toLowerCase()

/** The tracked records by `site/KEY`. A child node that is also a tracked issue takes its via marker and its level. */
export function trackedOf(records: readonly JiraRecord[], levelOf: JiraEnv['levelOf']): ReadonlyMap<string, Tracked> {
  return new Map(records.map(r => [jiraSiteKey(r.site, r.issueKey), { via: r.via, level: levelOf(r.key) }]))
}

/** The tracked Jira records among the items of a view. */
export function jiraRecords(items: readonly StoredItem[]): JiraRecord[] {
  return items.filter((i): i is JiraRecord => i.category === 'jira' && typeof i.issueKey === 'string')
}

function categoryTone(statusCategory: string | undefined): Tone {
  if (statusCategory === 'done') return 'ok'
  if (statusCategory === 'indeterminate') return 'warn'
  return 'plain'
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
        children: nodeRows(id, n.children, site, tracked),
        text: {
          key: n.key,
          href: `https://${site}/browse/${n.key}`,
          title: viaPrefix(t?.via) + n.summary,
          type: n.issueType,
          status: n.status,
          tone: categoryTone(n.statusCategory),
        },
      })
    })
}

/** An issue and its child tree. A site other than the active one, or a non-Cloud host, reads `track-only`. */
export function jiraRow(item: JiraRecord, env: JiraEnv, tracked: ReadonlyMap<string, Tracked>): TreeRow {
  const activeSite = env.tools.acli?.site
  let status: string
  let tone: Tone
  if (item.error?.kind === 'not-found') {
    status = 'not found'
    tone = 'bad'
  } else if (item.trackOnly || (activeSite && lower(item.site) !== lower(activeSite))) {
    status = 'track-only'
    tone = 'dim'
  } else {
    status = item.status ?? ''
    tone = categoryTone(item.statusCategory)
  }
  return itemRow({
    id: item.key,
    owner: 'jira',
    level: env.levelOf(item.key),
    dismiss: true,
    children: nodeRows(item.key, item.children, item.site, tracked),
    text: {
      key: item.issueKey,
      href: item.url,
      title: viaPrefix(item.via) + (item.summary ?? item.label),
      type: item.issueType ?? '',
      status,
      tone,
    },
  })
}
