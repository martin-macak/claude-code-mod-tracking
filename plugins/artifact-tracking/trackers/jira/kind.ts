// The item kind of Jira work items: its key, its record, its fold and its refresh through `acli`, and the Jira site
// filter of tool output (`accept`) and of a stored copy (`restore`).
// Plan: L5 Task 4, K4, K5. Task 5 adds `claimUrl`; Task 6 `setLevel` and `findRow`; Task 8 `accept` and `restore`.

import type { Claim, ItemKind, JsonObject, KindContext, Refreshable, RefreshContext } from '../../core/interfaces/items'
import { sighted } from '../../core/lib/records'
import { acliOf } from './client'
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

/** The client of the `acli` handle the owning tracker declared. The runner builds a handle for every declared tool. */
const clientOf = (c: RefreshContext) => acliOf(c.tools, c.config, c.now)!

/**
 * The active Jira site:
 * - `undefined`: no acli (do not filter Jira refs)
 * - `null`: acli is there, but no active site could be loaded
 * - `<host>`: the active Jira site host
 */
async function activeSite(ctx: KindContext): Promise<string | null | undefined> {
  const acli = acliOf(ctx.tools, ctx.config, () => ctx.clock.wall())
  if (!acli) return undefined
  if (acli.activeSite !== undefined) return acli.activeSite
  try {
    return await acli.loadActiveSite()
  } catch {
    return null
  }
}

/** A Jira item that only a tool sighting knew stays only on the Jira site that is active now. */
function keepStored(rec: JiraRecord, site: string | null | undefined): boolean {
  if (site === undefined) return true
  if (rec.sources.length !== 1 || rec.sources[0] !== 'tool') return true
  return site !== null && rec.site.toLowerCase() === site.toLowerCase()
}

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
  /** A Jira URL in tool output counts only on the active site: a test file or a log may name any other. */
  async accept(claims, ctx) {
    if (ctx.source !== 'tool' || ctx.mode !== 'urls-only' || claims.length === 0) return claims
    const site = await activeSite(ctx)
    if (site === undefined) return claims
    if (site === null) return []
    const active = site.toLowerCase()
    return claims.filter(c => String(c.fields.site).toLowerCase() === active)
  },
  async restore(items, ctx) {
    const site = await activeSite(ctx)
    return items.filter(rec => keepStored(rec, site))
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
    // A manual refresh also forgets a site that could not be loaded.
    reset: c => clientOf(c).reset(),
  },
}
