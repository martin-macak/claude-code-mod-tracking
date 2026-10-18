// The item kind of Jira work items: its key, its record, its fold and its refresh through `acli`.
// Plan: L5 Task 4, K4, K5. Task 5 adds `claimUrl`; Task 6 `setLevel` and `findRow`; Task 8 `accept` and `restore`.

import type { Claim, ItemKind, JsonObject, Refreshable, RefreshContext } from '../../core/interfaces/items'
import { sighted } from '../../core/lib/records'
import { acliClient } from './client'
import type { JiraConfig } from './config'
import { JiraItem } from './jira-item'
import { carryPriorities, childRow, mergeNodePriorities, setNode } from './nodes'
import type { JiraRecord, JiraRef, JiraTarget } from './types'
import { JIRA_KEY, parseJiraUrl } from './urls'

/** The item key: the site in lower case, the issue key as written. */
export const jiraKeyOf = (ref: Pick<JiraRef, 'site' | 'issueKey'>): string =>
  `jira:${ref.site.toLowerCase()}/${ref.issueKey}`

/** The ref a claim carries: the kind's ref fields under the category. */
const refOf = (claim: Claim): JiraRef => ({ category: 'jira', ...claim.fields }) as unknown as JiraRef

function jiraRecord(ref: JiraRef, claim: Claim): JiraRecord {
  return {
    key: jiraKeyOf(ref),
    category: 'jira',
    url: ref.url,
    label: ref.issueKey,
    sources: [claim.source],
    firstSeen: claim.at,
    lastSeen: claim.at,
    seenCount: 1,
    site: ref.site,
    issueKey: ref.issueKey,
    trackOnly: ref.trackOnly,
    children: [],
  }
}

/** The client of the `acli` handle the owning tracker declared. The runner builds a handle for every live tool. */
const clientOf = (c: RefreshContext) =>
  acliClient(c.tools.handle('acli')!, { now: c.now, limits: () => c.config.slice() as unknown as JiraConfig })

export const jiraKind: ItemKind<JiraRecord> = {
  category: 'jira',
  rank: 20,
  claimUrl(url, _label, ctx) {
    const ref = parseJiraUrl(url)
    if (!ref) return null
    const { category, ...fields } = ref
    return {
      category,
      key: jiraKeyOf(ref),
      source: ctx.source,
      at: ctx.now,
      fields: fields as unknown as JsonObject,
    }
  },
  decode: item => (item.category === 'jira' && typeof item.issueKey === 'string' ? (item as JiraRecord) : null),
  merge: (cur, seen) => (cur === null ? jiraRecord(refOf(seen), seen) : sighted(cur, seen)),
  fold(_winner, loser, out) {
    out.children = mergeNodePriorities(out.children, loser.children)
    return out
  },
  keepMarks: (merged, live) => ({ ...merged, children: carryPriorities(merged.children, live.children) }),
  // A person marks a child by its row id. `top` comes from a rule only, so it marks nothing here.
  setLevel(item, rowId, level) {
    if (level === 'top') return null
    const children = setNode(item.children, item.key, rowId, level)
    return children ? { ...item, children } : null
  },
  // A key in any case names the item itself or a child of its tree.
  findRow(item, ref) {
    const key = ref.toUpperCase()
    if (!JIRA_KEY.test(key)) return undefined
    return item.issueKey === key ? item.key : childRow(item.children, item.key, key)
  },
  refresh: {
    tool: 'acli',
    fields: ['summary', 'issueType', 'status', 'statusCategory'],
    hydrate: (rec, c): Refreshable => new JiraItem(rec, clientOf(c), () => c.config.global().refresh.staleMs),
    refreshItems: (items: Refreshable[], c) => clientOf(c).refreshItems(items as unknown as JiraTarget[]),
    apply: (out, fresh) => ({ ...out, children: carryPriorities(fresh.children, out.children) }),
  },
}
