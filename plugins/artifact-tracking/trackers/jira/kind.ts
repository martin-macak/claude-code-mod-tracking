// The item kind of Jira work items: its key, its record, its fold and its refresh through `acli`, and the Jira site
// filter of tool output (`accept`) and of a stored copy (`restore`).
// Plan: L5 Task 4, K4, K5. Task 5 adds `claimUrl`; Task 6 `setLevel` and `findRow`; Task 8 `accept` and `restore`.

import type {
  Claim,
  CoreReason,
  ItemKind,
  JsonObject,
  KindContext,
  Refreshable,
  RefreshContext,
} from '../../core/interfaces/items'
import { isRecord } from '../../core/lib/json'
import { reasonOfSource, reasonSet } from '../../core/lib/reasons'
import { sighted } from '../../core/lib/records'
import { acliWorkitems } from './acli-command'
import { acliOf } from './client'
import { JiraItem } from './jira-item'
import { carryPriorities, childRow, mergeNodePriorities, setNode } from './nodes'
import { jiraRecords, jiraRow, trackedOf } from './rows'
import type { JiraRecord, JiraRef, JiraTarget } from './types'
import { JIRA_KEY, parseJiraUrl } from './urls'

/** The item key: the site in lower case, the issue key as written. */
export const jiraKeyOf = (ref: Pick<JiraRef, 'site' | 'issueKey'>): string =>
  `jira:${ref.site.toLowerCase()}/${ref.issueKey}`

/** The ref a claim carries: the kind's ref fields under the category. */
const refOf = (claim: Claim): JiraRef => ({ category: 'jira', ...claim.fields }) as unknown as JiraRef

/** The claim of a ref, seen now from the source of `ctx`: the ref fields under the category. */
function claimOf(ref: JiraRef, ctx: KindContext, reason: CoreReason): Claim {
  const { category, ...fields } = ref
  return {
    category,
    key: jiraKeyOf(ref),
    source: ctx.source,
    reason,
    at: ctx.now,
    fields: fields as unknown as JsonObject,
  }
}

function jiraRecord(ref: JiraRef, claim: Claim): JiraRecord {
  return {
    key: jiraKeyOf(ref),
    category: 'jira',
    url: ref.url,
    label: ref.issueKey,
    sources: [claim.source],
    reasons: reasonSet(claim.reason),
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
    return ref ? claimOf(ref, ctx, reasonOfSource(ctx.source)) : null
  },
  /**
   * An `acli jira workitem` call names its item by key, with no URL in its output. acli acts on its active site, so the
   * key is an item of that site. The reason comes from the command (`acliWorkitems`): `read`, `updated` or `mentioned`.
   * A denied call, a call the tool reported as an error and a run with no active site add nothing: a failing call usually
   * names a key that does not exist. The tool gives one exit status for the whole command, so a failure behind a pipe, a
   * `;` or `|| true` goes unseen and still tracks the key.
   *
   * The first call of a session waits for `acli jira auth status`, and the tool hook holds the result of the call meanwhile.
   * `accept` and `restore` wait for the same lookup. It is bounded (`global.tools.timeoutMs`, the breaker) and shared by
   * the callers that ask at once. A site or a "not logged in" answer is cached. A lookup that fails for another reason is
   * asked again by the next acli call, until the breaker opens. A load does not warm it (only the restore of a stored
   * copy asks): a new session that runs no acli makes no lookup, and `/track` makes only the version probe
   * (`tests/toggles.test.ts`).
   */
  fromTool: {
    Bash: async (ev, ctx) => {
      if (isRecord(ev.result) && (ev.result.deny !== undefined || ev.result.isError === true)) return []
      const command = isRecord(ev.input) && typeof ev.input.command === 'string' ? ev.input.command : ''
      const found = acliWorkitems(command)
      if (found.length === 0) return []
      const site = await activeSite(ctx)
      if (!site) return []
      return found.flatMap(({ key, reason }): Claim[] => {
        const ref = parseJiraUrl(`https://${site}/browse/${key}`)
        return ref ? [claimOf(ref, ctx, reason)] : []
      })
    },
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
  row: (item, ctx) => jiraRow(item, ctx, trackedOf(jiraRecords(ctx.items), ctx.levelOf)),
}
