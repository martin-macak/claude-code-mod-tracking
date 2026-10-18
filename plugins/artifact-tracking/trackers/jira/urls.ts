// Jira issue keys and URLs. Pure: no state, no I/O. Moved from `hooks/scan/refs.ts` and `hooks/contracts.ts` in plan L5,
// Task 5; the jira kind claims an URL with `parseJiraUrl`.

import type { JiraRef } from './types'

/** An issue key: upper-case project, a dash, a number. */
export const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/

function jiraKey(u: URL, cloud: boolean): string | null {
  const browse = /^\/browse\/([^/]+)\/?$/.exec(u.pathname)
  if (browse && JIRA_KEY.test(browse[1]!)) return browse[1]!
  if (!cloud) return null
  const sel = u.searchParams.get('selectedIssue')
  if (sel !== null && JIRA_KEY.test(sel)) return sel
  const tail = /\/issues\/([^/]+)\/?$/.exec(u.pathname)
  return tail && JIRA_KEY.test(tail[1]!) ? tail[1]! : null
}

/**
 * The work item an URL names: `/browse/KEY`, and on Atlassian Cloud also `selectedIssue=KEY` and `/issues/KEY`. A host
 * outside `atlassian.net` is track-only: acli cannot refresh it.
 */
export function parseJiraUrl(url: string): JiraRef | null {
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const site = u.hostname.toLowerCase()
  const cloud = site.endsWith('.atlassian.net')
  const key = jiraKey(u, cloud)
  if (key === null) return null
  return { category: 'jira', site, issueKey: key, url: `https://${site}/browse/${key}`, trackOnly: !cloud }
}
