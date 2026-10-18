// The five item kinds: refresh specs, decode, ranks, keys, merge, fold and migrate. Pure, fake tool handles.
// Plan: L5 Task 4, K4, K5, K17.
import { expect, test } from 'claude-code/testing'
import type { Claim, ItemKind, JsonObject, RefreshContext, StoredItem } from '../core/interfaces/items'
import type { RunResult } from '../core/interfaces/ports'
import type { ToolHandle } from '../core/interfaces/tracker'
import { GLOBAL_DEFAULTS } from '../core/lib/global-config'
import { CliTool } from '../core/lib/tool'
import type { Tools } from '../hooks/contracts'
import { hydrate, recordFromFile } from '../hooks/model/registry'
import { artifactKeyOf, artifactKind } from '../trackers/artifact/kind'
import { artifactFromWeb, artifactOrigin, markArtifactDeleted } from '../trackers/artifact/records'
import type { ArtifactRecord } from '../trackers/artifact/types'
import { fileKey, fileKind } from '../trackers/file/kind'
import type { FileRecord } from '../trackers/file/types'
import { GITHUB_DEFAULTS } from '../trackers/github/config'
import { githubKind } from '../trackers/github/kind'
import { githubKey, githubKeyOf, githubUrl, prKey } from '../trackers/github/urls'
import { JIRA_DEFAULTS } from '../trackers/jira/config'
import { jiraKeyOf, jiraKind } from '../trackers/jira/kind'
import { carryPriorities, childId, mergeNodePriorities } from '../trackers/jira/nodes'
import type { JiraNode, JiraRecord } from '../trackers/jira/types'
import { webKeyOf, webKind } from '../trackers/web/kind'
import type { WebRecord } from '../trackers/web/types'
import { PAGE_CODE_URL, PAGE_ID, PAGE_KEY, PAGE_URL, PAGE_UUID } from './fixtures/artifacts'

const NOW = 5_000_000
const SHIPPED: readonly ItemKind[] = [githubKind, jiraKind, artifactKind, fileKind, webKind]

const claim = (category: string, key: string, fields: Claim['fields'], source = 'prompt', at = 1): Claim => ({
  category,
  key,
  source,
  at,
  fields,
})
const ghClaim = (over: Record<string, unknown> = {}, source = 'prompt', at = 1): Claim =>
  claim(
    'github',
    'gh:github.com/acme/web#5',
    { host: 'github.com', owner: 'acme', repo: 'web', number: 5, type: 'pr', ...over },
    source,
    at,
  )
const jiraClaim = (source = 'prompt', at = 1): Claim =>
  claim(
    'jira',
    'jira:acme.atlassian.net/ISS-1',
    {
      site: 'Acme.Atlassian.net',
      issueKey: 'ISS-1',
      url: 'https://Acme.Atlassian.net/browse/ISS-1',
      trackOnly: false,
    },
    source,
    at,
  )
const webClaim = (source = 'prompt', at = 1): Claim =>
  claim('web', 'web:https://x.example/a', { url: 'https://x.example/a#f', label: 'X doc' }, source, at)
const artClaim = (over: Record<string, unknown> = {}, source = 'response', at = 1): Claim =>
  claim('artifact', PAGE_KEY, { uuid: PAGE_UUID, url: PAGE_URL, label: PAGE_ID, ...over }, source, at)
const fileClaim = (activity: string, at = 1, over: Record<string, unknown> = {}): Claim =>
  claim(
    'file',
    'file:/work/a.md',
    { path: '/work/a.md', label: '/work/a.md', activity, bySubagent: false, ...over },
    'tool',
    at,
  )

const made = <T extends StoredItem>(kind: ItemKind<T>, c: Claim): T => {
  const rec = kind.merge(null, c)
  if (!rec) throw new Error('no record')
  return rec
}

test('kinds: only github and jira refresh', () => {
  expect([webKind, artifactKind, fileKind].map(k => k.refresh)).toEqual([undefined, undefined, undefined])
  expect(githubKind.refresh?.tool).toBe('gh')
  expect(jiraKind.refresh?.tool).toBe('acli')
})

test("kinds: decode round-trips each kind's record", () => {
  const gh = made(githubKind, ghClaim())
  const jira = made(jiraKind, jiraClaim())
  const web = made(webKind, webClaim())
  const art = made(artifactKind, artClaim())
  const file = made(fileKind, fileClaim('created'))
  expect(githubKind.decode(gh)).toEqual(gh)
  expect(jiraKind.decode(jira)).toEqual(jira)
  expect(webKind.decode(web)).toEqual(web)
  expect(artifactKind.decode(art)).toEqual(art)
  expect(fileKind.decode(file)).toEqual(file)
  for (const kind of SHIPPED) {
    for (const other of [gh, jira, web, art, file]) {
      if (other.category !== kind.category) expect(kind.decode(other)).toBeNull()
    }
  }
  // A guard checks the kind's own field, not just the category.
  expect(githubKind.decode({ ...gh, number: 'five' })).toBeNull()
  expect(jiraKind.decode({ ...jira, issueKey: 5 })).toBeNull()
})

test('kinds: ranks follow the claim order github, jira, artifact, file, web', () => {
  expect([githubKind, jiraKind, artifactKind, fileKind, webKind].map(k => k.rank)).toEqual([10, 20, 30, 80, 90])
})

test('file: a lone view makes no record; a view of a tracked file counts', () => {
  expect(fileKind.merge(null, fileClaim('viewed'))).toBeNull()
  const created = made(fileKind, fileClaim('created'))
  expect(fileKind.merge(created, fileClaim('viewed', 4))?.views).toBe(1)
  expect(fileKind.merge(null, fileClaim('mentioned'))).toMatchObject({ mentions: 1, created: false })
})

test('file: counters add up, created and bySubagent never go back, the first label stays', () => {
  let rec = made(fileKind, fileClaim('edited', 1, { label: '/first.md' }))
  rec = fileKind.merge(rec, fileClaim('created', 3, { bySubagent: true }))!
  rec = fileKind.merge(rec, fileClaim('edited', 5, { label: '/later.md' }))!
  expect(rec).toMatchObject({
    created: true,
    edits: 2,
    views: 0,
    bySubagent: true,
    label: '/first.md',
    firstSeen: 1,
    lastSeen: 5,
    seenCount: 3,
    sources: ['tool'],
  })
  expect(fileKey('/work/a.md')).toBe('file:/work/a.md')
})

test('keys: each kind builds its key', () => {
  expect(githubKeyOf({ host: 'GitHub.com', owner: 'ACME', repo: 'Web', number: 5 })).toBe('gh:github.com/acme/web#5')
  expect(githubKeyOf({ host: 'github.com', number: 7 })).toBe('gh:?#7')
  expect(githubKey('GH.example', 'O', 'R', 2)).toBe('gh:gh.example/o/r#2')
  expect(githubUrl('github.com', 'a', 'b', 'pr', 3)).toBe('https://github.com/a/b/pull/3')
  expect(githubUrl('github.com', 'a', 'b', 'unknown', 3)).toBe('https://github.com/a/b/issues/3')
  expect(prKey({ host: 'github.com', owner: 'Acme', repo: 'Web', number: 9 })).toBe('gh:github.com/acme/web#9')
  expect(jiraKeyOf({ site: 'Acme.Atlassian.net', issueKey: 'ISS-1' })).toBe('jira:acme.atlassian.net/ISS-1')
  expect(webKeyOf({ url: 'https://X.example/a#frag' })).toBe('web:https://x.example/a')
  expect(artifactKeyOf({ uuid: PAGE_UUID })).toBe(PAGE_KEY)
  expect(childId('jira:s/ISS-1', 'ISS-2')).toBe('jira:s/ISS-1/ISS-2')
})

test('github: a known key adds its source once, counts the sighting and takes a known type', () => {
  const first = made(githubKind, ghClaim({ type: 'unknown' }))
  expect(first).toMatchObject({ url: 'https://github.com/acme/web/issues/5', label: 'acme/web#5', type: 'unknown' })
  const again = githubKind.merge(first, ghClaim({ type: 'pr' }, 'prompt', 4))!
  expect(again).toMatchObject({ type: 'pr', seenCount: 2, lastSeen: 4, sources: ['prompt'] })
  const other = githubKind.merge(again, ghClaim({ type: 'unknown' }, 'response', 6))!
  expect(other).toMatchObject({ type: 'pr', sources: ['prompt', 'response'], seenCount: 3 })
  expect(first.sources).toEqual(['prompt']) // the old record is not mutated
  const bare = made(githubKind, claim('github', 'gh:?#9', { host: 'github.com', number: 9, type: 'unknown' }))
  expect(bare).toMatchObject({ key: 'gh:?#9', url: '', label: '#9' })
  expect('owner' in bare).toBe(false)
})

test('github: fold takes a known type; apply takes the refreshed type unless the record knows better', () => {
  const unknown = made(githubKind, ghClaim({ type: 'unknown' }))
  const pr = made(githubKind, ghClaim({ type: 'pr' }))
  expect(githubKind.fold!(unknown, pr, { ...unknown })).toMatchObject({ type: 'pr' })
  expect(githubKind.fold!(pr, unknown, { ...pr })).toMatchObject({ type: 'pr' })
  const apply = githubKind.refresh!.apply!
  expect(apply({ ...unknown }, { ...pr, type: 'unknown' }).type).toBe('unknown')
  expect(apply({ ...unknown }, { ...pr }).type).toBe('pr')
  expect(apply({ ...pr }, { ...pr, type: 'issue' }).type).toBe('issue')
  expect(apply({ ...pr }, { ...pr, type: 'unknown' }).type).toBe('pr')
})

const node = (key: string, priority?: 'high' | 'low', children: JiraNode[] = []): JiraNode => ({
  key,
  ...(priority ? { priority } : {}),
  summary: key,
  issueType: 'Task',
  status: 'To Do',
  children,
})

test('jira: a known key counts the sighting; fold and keepMarks carry the marks of the child tree', () => {
  const first = made(jiraKind, jiraClaim())
  expect(first).toMatchObject({
    key: 'jira:acme.atlassian.net/ISS-1',
    label: 'ISS-1',
    children: [],
    site: 'Acme.Atlassian.net',
  })
  expect(jiraKind.merge(first, jiraClaim('tool', 3))).toMatchObject({
    seenCount: 2,
    sources: ['prompt', 'tool'],
    lastSeen: 3,
  })
  const a: JiraRecord = { ...first, children: [node('A-1', 'high', [node('A-2')])] }
  const b: JiraRecord = { ...first, children: [node('A-1', 'low', [node('A-2', 'low')]), node('A-3')] }
  const folded = jiraKind.fold!(a, b, { ...a })
  expect(folded.children.map(c => [c.key, c.priority])).toEqual([['A-1', 'high']])
  expect(folded.children[0]?.children.map(c => [c.key, c.priority])).toEqual([['A-2', 'low']])
  const kept = jiraKind.keepMarks!({ ...first, children: [node('A-1', 'high')] }, { ...first, children: [node('A-1')] })
  expect('priority' in kept.children[0]!).toBe(false)
  const applied = jiraKind.refresh!.apply!(
    { ...a },
    { ...first, children: [node('A-1', undefined, [node('A-2')]), node('A-4')] },
  )
  expect(applied.children.map(c => [c.key, c.priority])).toEqual([
    ['A-1', 'high'],
    ['A-4', undefined],
  ])
  expect(mergeNodePriorities([node('X')], []).map(n => n.key)).toEqual(['X'])
  expect(carryPriorities([node('X')], [node('X', 'low')])[0]?.priority).toBe('low')
})

test('web: a known key counts the sighting and keeps its label', () => {
  const first = made(webKind, webClaim())
  expect(first).toMatchObject({ key: 'web:https://x.example/a', url: 'https://x.example/a#f', label: 'X doc' })
  expect(webKind.merge(first, webClaim('response', 5))).toMatchObject({ seenCount: 2, lastSeen: 5, label: 'X doc' })
})

test('artifact: names rank a publish title over a label over the id; a deleted mark is sticky', () => {
  const mention = made(artifactKind, artClaim())
  expect(mention).toMatchObject({ key: PAGE_KEY, url: PAGE_URL, label: PAGE_ID, sources: ['response'] })
  expect(artifactOrigin(mention)).toBe('mentioned')
  const named = artifactKind.merge(mention, artClaim({ url: PAGE_CODE_URL, label: 'Design notes' }, 'response', 2))!
  expect(named.label).toBe('Design notes')
  const published = artifactKind.merge(named, artClaim({ label: 'Probe Page', titled: true }, 'publish', 3))!
  expect(published).toMatchObject({ label: 'Probe Page', url: PAGE_URL, seenCount: 3 })
  expect(artifactOrigin(published)).toBe('published')
  const mentionedAgain = artifactKind.merge(published, artClaim({ label: 'Other words' }, 'prompt', 4))!
  expect(mentionedAgain.label).toBe('Probe Page')
  const gone: ArtifactRecord = { ...published, deleted: true }
  const folded = artifactKind.fold!(mention, gone, { ...mention })
  expect(folded.deleted).toBe(true)
  expect(artifactKind.fold!(gone, mention, { ...gone }).deleted).toBe(true)
  expect(artifactKind.fold!(mention, published, { ...mention })).toMatchObject({ label: 'Probe Page' })
})

test('artifact: a web row of an artifact URL migrates; any other record does not', () => {
  const web: WebRecord = {
    key: `web:${PAGE_URL}`,
    category: 'web',
    url: PAGE_URL,
    label: 'Design notes',
    sources: ['response'],
    firstSeen: 1,
    lastSeen: 1,
    seenCount: 1,
  }
  expect(artifactKind.migrate!(web)).toMatchObject({ key: PAGE_KEY, category: 'artifact', label: 'Design notes' })
  expect(artifactFromWeb(web)).toMatchObject({ url: PAGE_URL })
  expect(artifactFromWeb({ ...web, url: 'https://x.example/a', label: 'x' })).toBeNull()
  expect(artifactKind.migrate!({ ...web, url: 'https://x.example/a' })).toBeNull()
  expect(artifactKind.migrate!(made(githubKind, ghClaim()))).toBeNull()
  // The host-and-path label of an old row is no name: the row shows the id.
  expect(artifactFromWeb({ ...web, label: `claude.ai/artifact/${PAGE_ID}` })?.label).toBe(PAGE_ID)
  const list: StoredItem[] = [made(artifactKind, artClaim())]
  expect(markArtifactDeleted(list, PAGE_KEY)[0]?.deleted).toBe(true)
})

// ---------------------------------------------------------------- the refresh specs, over fake tool handles

const res = (stdout = '', exitCode = 0, stderr = ''): RunResult => ({ exitCode, stdout, stderr })

function handleOf(
  id: string,
  answer: (argv: readonly string[]) => RunResult,
): { handle: ToolHandle; calls: string[][] } {
  const calls: string[][] = []
  const handle = new CliTool(
    { id, probe: [id, '--version'], timeoutMs: () => 1000, probeTimeoutMs: () => 1000 },
    async argv => {
      calls.push([...argv])
      return answer(argv)
    },
    () => NOW,
  )
  return { handle, calls }
}

function contextOf(handles: Record<string, ToolHandle>, slice: JsonObject): RefreshContext {
  return {
    tools: {
      handle: id => handles[id],
      run: async () => {
        throw new Error('no raw run here')
      },
    },
    config: { slice: () => slice, global: () => GLOBAL_DEFAULTS },
    facts: { read: () => undefined },
    now: () => NOW,
  }
}

test('github refresh: hydrate follows the ttl of the config and refreshItems fills the status fields', async () => {
  const issue = {
    data: {
      a0: { issueOrPullRequest: { __typename: 'Issue', number: 5, title: 'Hello', state: 'OPEN', url: 'https://x' } },
    },
  }
  const { handle, calls } = handleOf('gh', () => res(JSON.stringify(issue)))
  const ctx = contextOf({ gh: handle }, { ...GITHUB_DEFAULTS, pendingStaleMs: 10 })
  const refresh = githubKind.refresh!
  const rec = made(githubKind, ghClaim({ type: 'pr' }))
  const settled = refresh.hydrate({ ...rec, checks: 'success', refreshedAt: NOW }, ctx)
  expect(settled.isDue(NOW + GLOBAL_DEFAULTS.refresh.staleMs - 1)).toBe(false)
  expect(settled.isDue(NOW + GLOBAL_DEFAULTS.refresh.staleMs)).toBe(true)
  const pending = refresh.hydrate({ ...rec, checks: 'pending', refreshedAt: NOW }, ctx)
  expect(pending.isDue(NOW + 9)).toBe(false)
  expect(pending.isDue(NOW + 10)).toBe(true)
  const item = refresh.hydrate({ ...rec, type: 'unknown' }, ctx)
  await refresh.refreshItems([item], ctx)
  expect(calls).toHaveLength(1)
  expect(calls[0]?.slice(0, 3)).toEqual(['gh', 'api', 'graphql'])
  expect(item.toRecord()).toMatchObject({ type: 'issue', title: 'Hello', state: 'open', refreshedAt: NOW })
})

test('jira refresh: hydrate follows global staleMs and refreshItems fills the summary through the handle', async () => {
  const view = {
    key: 'ISS-1',
    fields: { summary: 'S', issuetype: { name: 'Task' }, status: { name: 'To Do', statusCategory: { key: 'new' } } },
  }
  const { handle, calls } = handleOf('acli', argv =>
    argv[2] === 'auth' ? res('Site: acme.atlassian.net\n') : res(JSON.stringify(view)),
  )
  const ctx = contextOf({ acli: handle }, { ...JIRA_DEFAULTS })
  const refresh = jiraKind.refresh!
  const rec = made(jiraKind, jiraClaim())
  const fresh = refresh.hydrate({ ...rec, refreshedAt: NOW }, ctx)
  expect(fresh.isDue(NOW + GLOBAL_DEFAULTS.refresh.staleMs - 1)).toBe(false)
  expect(fresh.isDue(NOW + GLOBAL_DEFAULTS.refresh.staleMs)).toBe(true)
  const item = refresh.hydrate({ ...rec, site: 'acme.atlassian.net' }, ctx)
  await refresh.refreshItems([item], ctx)
  expect(calls.map(c => c.slice(0, 4))).toEqual([
    ['acli', 'jira', 'auth', 'status'],
    ['acli', 'jira', 'workitem', 'view'],
  ])
  expect(item.toRecord()).toMatchObject({ summary: 'S', issueType: 'Task', status: 'To Do', refreshedAt: NOW })
})

test('a record of a kind with no refresh is plain data: the registry binding hydrates it never due and round-trips it', async () => {
  const file: FileRecord = made(fileKind, fileClaim('created'))
  expect(fileKind.refresh).toBeUndefined()
  expect(fileKind.decode(file)).toBe(file)
  const tools = {} as Tools
  for (const rec of [file, made(webKind, webClaim()), made(artifactKind, artClaim())]) {
    const item = hydrate(rec, tools)
    expect(item.canRefresh(0)).toBe(false)
    expect(item.isDue(1e12)).toBe(false)
    await item.refresh()
    expect(item.toRecord()).toEqual(rec)
  }
  const hit = { path: '/work/a.md', label: '/work/a.md', kind: 'edited' as const, bySubagent: true }
  expect(recordFromFile(hit, { source: 'tool', at: 3 })).toMatchObject({
    key: 'file:/work/a.md',
    edits: 1,
    bySubagent: true,
  })
})
