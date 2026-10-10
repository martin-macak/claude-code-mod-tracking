// Tracked item classes: refresh path, canRefresh rules, isDue, record round-trip. Pure, fake tools.
import { expect, test } from 'claude-code/testing'
import type { GitHubToolApi, JiraToolApi, GitHubRecord, JiraRecord, ToolStatus } from '../hooks/contracts'
import { LIMITS } from '../hooks/contracts'
import { GitHubItem } from '../hooks/model/github-item'
import { JiraItem } from '../hooks/model/jira-item'
import { WebLink } from '../hooks/model/web-link'

const status = (name: 'gh' | 'acli'): ToolStatus => ({ name, available: true, loggedIn: null, breaker: 'closed' })
function ghTool(over: Partial<GitHubToolApi> = {}) {
  const calls: string[][] = []
  const t: GitHubToolApi = {
    name: 'gh', isAvailable: true, canCall: () => true, reset() {}, status: () => status('gh'),
    async refreshItems(items) { calls.push(items.map((i) => i.key)); for (const i of items) { i.title = 'T'; i.refreshedAt = 1 } },
    isHostAuthed: () => undefined, checkHost: async () => true, defaultRepo: async () => null, ...over,
  }
  return { t, calls }
}
function acliTool(site: string | null | undefined, over: Partial<JiraToolApi> = {}): JiraToolApi {
  return { name: 'acli', isAvailable: true, activeSite: site, canCall: () => true, reset() {}, status: () => status('acli'),
    async refreshItems() {}, loadActiveSite: async () => site ?? null, ...over }
}
const gh = (over: Partial<GitHubRecord> = {}): GitHubRecord => ({ key: 'gh:github.com/acme/web#5', category: 'github', url: 'https://github.com/acme/web/pull/5', label: 'acme/web#5', sources: ['prompt'], firstSeen: 0, lastSeen: 0, seenCount: 1, host: 'github.com', owner: 'acme', repo: 'web', number: 5, type: 'pr', ...over })
const jira = (over: Partial<JiraRecord> = {}): JiraRecord => ({ key: 'jira:acme.atlassian.net/ISS-1', category: 'jira', url: 'https://acme.atlassian.net/browse/ISS-1', label: 'ISS-1', sources: ['response'], firstSeen: 0, lastSeen: 0, seenCount: 1, site: 'acme.atlassian.net', issueKey: 'ISS-1', trackOnly: false, children: [], ...over })

test('GitHubItem.refresh goes through tool.refreshItems with itself', async () => {
  const { t, calls } = ghTool()
  const i = new GitHubItem(gh(), t)
  await i.refresh()
  expect(calls).toEqual([['gh:github.com/acme/web#5']])
  expect(i.toRecord()).toMatchObject({ title: 'T', refreshedAt: 1 })
})

test('GitHubItem.canRefresh: unresolved, host auth, breaker', () => {
  expect(new GitHubItem(gh({ owner: undefined, repo: undefined, key: 'gh:?#5' }), ghTool().t).canRefresh(0)).toBe(false)
  expect(new GitHubItem(gh(), ghTool({ isHostAuthed: () => false }).t).canRefresh(0)).toBe(false)
  expect(new GitHubItem(gh({ host: 'ghe.corp' }), ghTool().t).canRefresh(0)).toBe(false) // GHE needs a known yes
  expect(new GitHubItem(gh({ host: 'ghe.corp' }), ghTool({ isHostAuthed: () => true }).t).canRefresh(0)).toBe(true)
  expect(new GitHubItem(gh(), ghTool({ canCall: () => false }).t).canRefresh(0)).toBe(false)
})

test('isDue: new, stale, pending PR, not-found', () => {
  const t = ghTool().t
  expect(new GitHubItem(gh(), t).isDue(0)).toBe(true)
  expect(new GitHubItem(gh({ refreshedAt: 0 }), t).isDue(LIMITS.staleMs - 1)).toBe(false)
  expect(new GitHubItem(gh({ refreshedAt: 0 }), t).isDue(LIMITS.staleMs)).toBe(true)
  expect(new GitHubItem(gh({ refreshedAt: 0, checks: 'pending' }), t).isDue(LIMITS.pendingStaleMs)).toBe(true)
  expect(new GitHubItem(gh({ error: { kind: 'not-found', message: 'x', at: 0 } }), t).isDue(1e12)).toBe(false)
})

test('JiraItem.canRefresh: track-only, bad key, site match, unknown site, logged out', () => {
  expect(new JiraItem(jira({ trackOnly: true }), acliTool('acme.atlassian.net')).canRefresh(0)).toBe(false)
  expect(new JiraItem(jira({ issueKey: 'iss-1' }), acliTool('acme.atlassian.net')).canRefresh(0)).toBe(false)
  expect(new JiraItem(jira(), acliTool('other.atlassian.net')).canRefresh(0)).toBe(false)
  expect(new JiraItem(jira(), acliTool(undefined)).canRefresh(0)).toBe(true)
  expect(new JiraItem(jira(), acliTool(null)).canRefresh(0)).toBe(false)
})

test('WebLink never refreshes and toRecord round-trips', async () => {
  const rec = { key: 'web:https://x.example/', category: 'web' as const, url: 'https://x.example/', label: 'x.example', sources: ['response' as const], firstSeen: 1, lastSeen: 2, seenCount: 2 }
  const w = new WebLink(rec)
  expect(w.canRefresh(0)).toBe(false)
  expect(w.isDue(0)).toBe(false)
  await w.refresh()
  expect(w.toRecord()).toEqual(rec)
})

test('GitHubItem does not mutate its input record and toRecord omits undefined fields', () => {
  const rec = gh()
  const i = new GitHubItem(rec, ghTool().t)
  i.title = 'changed'
  i.sources.push('tool')
  expect(rec.title).toBeUndefined()
  expect(rec.sources).toEqual(['prompt'])
  const out = i.toRecord()
  expect(out).not.toBe(rec)
  expect('state' in out).toBe(false)
  expect('error' in out).toBe(false)
  expect(out).toMatchObject({ title: 'changed', sources: ['prompt', 'tool'] })
})

test('GitHubItem round-trips every status field', () => {
  const rec = gh({ title: 'T', state: 'merged', stateReason: 'COMPLETED', isDraft: false, reviewDecision: 'APPROVED', checks: 'success', refreshedAt: 7, error: { kind: 'failed', message: 'm', at: 3 } })
  expect(new GitHubItem(rec, ghTool().t).toRecord()).toEqual(rec)
})

test('JiraItem deep-copies children and round-trips', () => {
  const rec = jira({ summary: 'S', issueType: 'Epic', status: 'To Do', statusCategory: 'new', refreshedAt: 4,
    children: [{ key: 'ISS-2', summary: 'c', issueType: 'Story', status: 'Done', children: [{ key: 'ISS-3', summary: 'g', issueType: 'Sub-task', status: 'Done', children: [] }] }] })
  const i = new JiraItem(rec, acliTool('acme.atlassian.net'))
  expect(i.toRecord()).toEqual(rec)
  i.children[0]!.status = 'Changed'
  i.children[0]!.children.pop()
  expect(rec.children[0]!.status).toBe('Done')
  expect(rec.children[0]!.children.length).toBe(1)
  const out = i.toRecord() as JiraRecord
  out.children[0]!.summary = 'x'
  expect(i.children[0]!.summary).toBe('c')
})

test('pending uses the short window for a PR only', () => {
  const t = ghTool().t
  expect(new GitHubItem(gh({ type: 'issue', refreshedAt: 0, checks: 'pending' }), t).isDue(LIMITS.pendingStaleMs)).toBe(false)
  expect(new GitHubItem(gh({ refreshedAt: 0, checks: 'pending' }), t).isDue(LIMITS.pendingStaleMs - 1)).toBe(false)
})
