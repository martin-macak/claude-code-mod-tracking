// Priority levels from the kinds: the staged resolver, the mark of a row, the row a ref names, and the `auto.branches`
// fact that R7 reads. Pure, on the shipped kinds and one fake kind. Plan: L5 Task 6, K6, K20.
import { expect, test } from 'claude-code/testing'
import { LifecycleManager } from '../core/infra/lifecycle'
import { effectiveLevels, rowIdOf, setLevel } from '../core/infra/priority'
import type { ItemKind, ItemsHost, Json, KindContext, Level, StoredItem } from '../core/interfaces/items'
import type { RunResult } from '../core/interfaces/ports'
import { scanContext } from '../core/lib/kind-context'
import type { KindTable } from '../core/lib/records'
import { artifactKind } from '../trackers/artifact/kind'
import type { AutoGithub } from '../trackers/auto'
import { autoTracker } from '../trackers/auto'
import { autoDismiss } from '../trackers/auto/dismiss-store'
import { emptyAuto } from '../trackers/auto/ledger'
import type { AutoState, BranchesFact } from '../trackers/auto/types'
import { fileKind } from '../trackers/file/kind'
import { GITHUB_DEFAULTS } from '../trackers/github/config'
import { githubKind } from '../trackers/github/kind'
import type { GitHubRecord } from '../trackers/github/types'
import { jiraKind } from '../trackers/jira/kind'
import type { JiraNode, JiraRecord } from '../trackers/jira/types'
import { webKind } from '../trackers/web/kind'
import type { WebRecord } from '../trackers/web/types'
import { fakeConfig } from './fixtures/config-fs'
import * as ev from './fixtures/events'
import { porcelain } from './fixtures/git'
import { IDLE_ITEMS } from './fixtures/items-host'
import { LIMITS } from './fixtures/limits'
import { fakePorts } from './fixtures/ports'

const SHIPPED: readonly ItemKind[] = [githubKind, jiraKind, artifactKind, fileKind, webKind]
const table: KindTable = category => SHIPPED.find(k => k.category === category)

const REPO = { host: 'github.com', owner: 'acme', repo: 'web' }
const BRANCHES = { seq: 1, reasons: [], current: 'feat/x', branches: ['main', 'feat/x'], overflow: 0 }
const facts = (f: Record<string, Json | undefined>) => ({
  read: <T extends Json>(name: string) => f[name] as T | undefined,
})
const FACTS = facts({ 'session.repo': REPO as unknown as Json, 'auto.branches': BRANCHES as unknown as Json })

const gh = (n: number, type: 'pr' | 'issue' | 'unknown', over: Partial<GitHubRecord> = {}): GitHubRecord => ({
  key: `gh:github.com/acme/web#${n}`,
  category: 'github',
  url: `https://github.com/acme/web/pull/${n}`,
  label: `acme/web#${n}`,
  sources: ['prompt'],
  firstSeen: n,
  lastSeen: n,
  seenCount: 1,
  host: 'github.com',
  owner: 'acme',
  repo: 'web',
  number: n,
  type,
  ...(type === 'pr' ? { state: 'open' as const, headRefName: 'feat/x' } : {}),
  ...over,
})
const web = (url: string, over: Partial<WebRecord> = {}): WebRecord => ({
  key: `web:${url}`,
  category: 'web',
  url,
  label: url,
  sources: ['prompt'],
  firstSeen: 1,
  lastSeen: 1,
  seenCount: 1,
  ...over,
})
const node = (key: string, children: JiraNode[] = [], priority?: 'high' | 'normal' | 'low'): JiraNode => ({
  key,
  ...(priority ? { priority } : {}),
  summary: key,
  issueType: 'Task',
  status: 'To Do',
  children,
})
const jira = (over: Partial<JiraRecord> = {}): JiraRecord => ({
  key: 'jira:acme.atlassian.net/ISS-1',
  category: 'jira',
  url: 'https://acme.atlassian.net/browse/ISS-1',
  label: 'ISS-1',
  sources: ['prompt'],
  firstSeen: 1,
  lastSeen: 1,
  seenCount: 1,
  site: 'acme.atlassian.net',
  issueKey: 'ISS-1',
  trackOnly: false,
  children: [node('ISS-2', [node('ISS-3')]), node('ISS-4')],
  ...over,
})

const levelsOf = (items: StoredItem[], f = FACTS) =>
  Object.fromEntries([...effectiveLevels(items, table, f)].map(([k, v]) => [k.replace(/^.*#/, '#'), v]))

test('levels: a manual mark wins over every rule', () => {
  const pr = gh(1, 'pr', { priority: 'low' })
  const issue = gh(9, 'issue', { priority: 'normal' })
  const noted: ItemKind = {
    category: 'note',
    rank: 50,
    decode: i => i,
    merge: cur => cur,
    rules: [{ id: 'note', stage: 0, level: () => 'high' }],
  }
  const own = { key: 'note:a', category: 'note', priority: 'normal' } as unknown as StoredItem
  const other = { key: 'note:b', category: 'note' } as unknown as StoredItem
  const out = effectiveLevels(
    [pr, { ...issue, closes: undefined } as StoredItem, own, other],
    c => (c === 'note' ? noted : table(c)),
    FACTS,
  )
  expect(out.get(pr.key)).toEqual({ level: 'low' }) // the rule would say top
  expect(out.get(issue.key)).toEqual({ level: 'normal' })
  expect(out.get('note:a')).toEqual({ level: 'normal' })
  expect(out.get('note:b')).toEqual({ level: 'high', auto: true })
})

test('levels: stage 1 reads the stage 0 levels (R8)', () => {
  const issue = gh(9, 'issue')
  const pr = gh(1, 'pr', { closes: [issue.key] })
  const expected = { '#9': { level: 'top', auto: true }, '#1': { level: 'top', auto: true } }
  expect(levelsOf([issue, pr])).toEqual(expected) // the order of the list does not matter
  expect(levelsOf([pr, issue])).toEqual(expected)
  // The PR is off the branch: no level, so the issue has none either. Normal is no level.
  expect(levelsOf([gh(1, 'pr', { headRefName: 'main', closes: [issue.key] }), issue])).toEqual({ '#1': {}, '#9': {} })
  // A person's mark on the PR is the PR's level, and the issue takes it.
  const marked = gh(2, 'pr', { headRefName: 'o', priority: 'high', closes: [issue.key] })
  const low = gh(3, 'pr', { headRefName: 'p', priority: 'low', closes: [issue.key] })
  expect(levelsOf([low, issue, marked])['#9']).toEqual({ level: 'high', auto: true })
  expect(levelsOf([low, issue])['#9']).toEqual({ level: 'low', auto: true })
  // An issue with its own mark keeps it.
  expect(levelsOf([pr, { ...issue, priority: 'low' }])['#9']).toEqual({ level: 'low' })
})

test('levels: an item of unknown type, a kind with no rule and a kind nobody knows have no level', () => {
  const stranger = { key: 'x:1', category: 'stranger' } as unknown as StoredItem
  expect(
    levelsOf([gh(5, 'unknown', { state: 'open', headRefName: 'feat/x' }), web('https://x.example/'), stranger]),
  ).toEqual({ '#5': {}, 'web:https://x.example/': {}, 'x:1': {} })
  expect(levelsOf([])).toEqual({})
})

test('R7 reads auto.branches.current', () => {
  const pr = gh(1, 'pr')
  const at = (current: string | undefined) =>
    levelsOf(
      [pr],
      facts({ 'session.repo': REPO as unknown as Json, 'auto.branches': { ...BRANCHES, current } as unknown as Json }),
    )
  expect(at('feat/x')).toEqual({ '#1': { level: 'top', auto: true } })
  expect(at('main')).toEqual({ '#1': {} })
  expect(at(undefined)).toEqual({ '#1': {} }) // a detached HEAD has no current branch
  // A draft counts, a merged PR does not, the repo match ignores case, another repo does not count.
  expect(levelsOf([gh(2, 'pr', { isDraft: true, owner: 'ACME' })])['#2']).toEqual({ level: 'top', auto: true })
  expect(levelsOf([gh(2, 'pr', { state: 'merged' })])['#2']).toEqual({})
  expect(levelsOf([gh(2, 'pr', { owner: 'fork' })])['#2']).toEqual({})
  expect(levelsOf([gh(2, 'pr', { headRefName: undefined })])['#2']).toEqual({})
})

test('R7 guards the facts it reads: a missing or wrong fact gives no level', () => {
  const pr = gh(1, 'pr')
  const none = { '#1': {} }
  expect(levelsOf([pr], facts({}))).toEqual(none)
  expect(levelsOf([pr], facts({ 'session.repo': REPO as unknown as Json }))).toEqual(none) // no branch fact
  expect(levelsOf([pr], facts({ 'auto.branches': BRANCHES as unknown as Json }))).toEqual(none) // no session repo
  expect(levelsOf([pr], facts({ 'session.repo': null, 'auto.branches': BRANCHES as unknown as Json }))).toEqual(none)
  expect(levelsOf([pr], facts({ 'session.repo': 'acme/web', 'auto.branches': BRANCHES as unknown as Json }))).toEqual(
    none,
  )
  expect(levelsOf([pr], facts({ 'session.repo': REPO as unknown as Json, 'auto.branches': 'feat/x' }))).toEqual(none)
  expect(levelsOf([pr], facts({ 'session.repo': REPO as unknown as Json, 'auto.branches': { current: 7 } }))).toEqual(
    none,
  )
  expect(
    levelsOf(
      [pr],
      facts({
        'session.repo': { host: 'github.com' } as unknown as Json,
        'auto.branches': BRANCHES as unknown as Json,
      }),
    ),
  ).toEqual(none)
})

test('levels: the closing index is built once per list and read for every issue', () => {
  const issues = [gh(8, 'issue'), gh(9, 'issue')]
  const pr = gh(1, 'pr', { closes: [issues[0]!.key, issues[1]!.key] })
  const list: StoredItem[] = [pr, ...issues]
  const first = effectiveLevels(list, table, FACTS)
  expect([...first.values()].map(v => v.level)).toEqual(['top', 'top', 'top'])
  expect(effectiveLevels(list, table, FACTS)).toEqual(first) // the second call reads the cached index
})

// ---------------------------------------------------------------- setLevel

test('setLevel marks an item by its key and removes the mark again', () => {
  const list: StoredItem[] = [gh(1, 'pr'), web('https://x.example/')]
  const marked = setLevel(list, 'web:https://x.example/', 'high', table)
  expect(marked).not.toBe(list)
  expect(marked.map(i => i.priority)).toEqual([undefined, 'high'])
  expect(list[1]?.priority).toBeUndefined() // the input is not changed
  expect(setLevel(marked, 'web:https://x.example/', 'high', table)).toBe(marked) // no change
  const cleared = setLevel(marked, 'web:https://x.example/', undefined, table)
  expect('priority' in cleared[1]!).toBe(false)
  expect(setLevel(cleared, 'web:https://x.example/', undefined, table)).toBe(cleared)
})

test('setLevel marks a Jira child by its row id and gives the same list for no change', () => {
  const list: StoredItem[] = [jira(), web('https://x.example/')]
  const id = 'jira:acme.atlassian.net/ISS-1/ISS-2/ISS-3'
  const marked = setLevel(list, id, 'low', table)
  const root = marked[0] as JiraRecord
  expect(root.children[0]?.children[0]?.priority).toBe('low')
  expect(root.children[1]?.priority).toBeUndefined()
  expect(marked[1]).toBe(list[1]) // the other items are the same objects
  expect(setLevel(marked, id, 'low', table)).toBe(marked) // the same mark
  expect(setLevel(list, 'jira:acme.atlassian.net/ISS-1/ISS-9', 'low', table)).toBe(list) // no such child
  expect(setLevel(list, 'jira:acme.atlassian.net/ISS-1/ISS-4', undefined, table)).toBe(list) // nothing to remove
  const cleared = setLevel(marked, id, undefined, table)
  expect('priority' in (cleared[0] as JiraRecord).children[0]!.children[0]!).toBe(false)
  expect(setLevel(list, 'gh:nowhere#1', 'high', table)).toBe(list) // an unknown id
})

test('setLevel prefers the item with the exact key; only a kind with setLevel owns the rows below its key', () => {
  const box: ItemKind = {
    category: 'box',
    rank: 50,
    decode: i => i,
    merge: cur => cur,
    setLevel: (item, rowId, level: Level | undefined) =>
      rowId === `${item.key}/inner` ? ({ ...item, priority: level } as StoredItem) : null,
  }
  const kinds: KindTable = c => (c === 'box' ? box : undefined)
  const a = { key: 'box:a', category: 'box' } as unknown as StoredItem
  const ab = { key: 'box:a/inner', category: 'box' } as unknown as StoredItem
  // `box:a/inner` is both the key of an item and a row below `box:a`: the item wins.
  const out = setLevel([a, ab], 'box:a/inner', 'high', kinds)
  expect(out.map(i => i.priority)).toEqual([undefined, 'high'])
  // Below a key without such an item, the kind of the item that prefixes it decides.
  const below = setLevel([a], 'box:a/inner', 'low', kinds)
  expect(below[0]?.priority).toBe('low')
  expect(setLevel([a], 'box:a/other', 'low', kinds)).toEqual([a])
})

// ---------------------------------------------------------------- rowIdOf

const ctx = (
  f: Record<string, Json | undefined> = { 'session.repo': REPO as unknown as Json, 'github.hosts': [] },
): KindContext => scanContext({ mode: 'full', purpose: 'lookup', facts: f, slice: { ...GITHUB_DEFAULTS } })
const KINDS_NO_FILE = SHIPPED.filter(k => k.category !== 'file')

test('rowIdOf: a Jira key in lower case names a child; a URL names its item; an unknown ref is undefined', () => {
  const issue = jira()
  const list: StoredItem[] = [issue, gh(5, 'issue'), web('https://docs.example/a')]
  const id = (ref: string) => rowIdOf(list, ref, KINDS_NO_FILE, ctx())
  expect(id('iss-3')).toBe('jira:acme.atlassian.net/ISS-1/ISS-2/ISS-3')
  expect(id('ISS-4')).toBe('jira:acme.atlassian.net/ISS-1/ISS-4')
  expect(id('iss-1')).toBe(issue.key)
  expect(id('ISS-99')).toBeUndefined() // a Jira key nothing tracks
  expect(id('https://docs.example/a')).toBe('web:https://docs.example/a')
  expect(id('https://docs.example/nope')).toBeUndefined() // a URL the list lacks
  expect(id('https://github.com/acme/web/issues/5')).toBe('gh:github.com/acme/web#5')
  expect(id('acme/web#5')).toBe('gh:github.com/acme/web#5')
  expect(id('#5')).toBe('gh:github.com/acme/web#5') // a lookup counts a bare #N in the session repo
  expect(id('#6')).toBeUndefined()
  expect(id('nothing here')).toBeUndefined()
  expect(rowIdOf(list, '#5', KINDS_NO_FILE, ctx({ 'github.hosts': [] }))).toBeUndefined() // no session repo: gh:?#5 is not tracked
  expect(
    rowIdOf([gh(5, 'issue', { key: 'gh:?#5', owner: undefined, repo: undefined })], '#5', KINDS_NO_FILE, ctx({})),
  ).toBe('gh:?#5')
})

test('rowIdOf: the first row any kind names wins over a scan', () => {
  const box: ItemKind = {
    category: 'box',
    rank: 50,
    decode: i => i,
    merge: cur => cur,
    findRow: (item, ref) => (ref === 'hello' ? `${item.key}/hello` : undefined),
  }
  const list = [{ key: 'box:a', category: 'box' } as unknown as StoredItem]
  expect(rowIdOf(list, 'hello', [box], ctx())).toBe('box:a/hello')
  expect(rowIdOf(list, 'bye', [box], ctx())).toBeUndefined()
})

// ---------------------------------------------------------------- auto.branches

declare function setTimeout(fn: () => void, ms: number): unknown
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const ROOT = '/work'
const START_AT = 1_000_000
const WINDOW = LIMITS.autoDebounceMs + 10

function autoWorld() {
  const w = fakePorts({ now: START_AT, session: { cwd: ROOT } })
  const gh: AutoGithub = {
    discovery: {} as AutoGithub['discovery'],
    ready: async () => false,
    repo: async () => null,
    hosts: () => [],
    lane: () => ({ headPrsPerBranch: 5, basePrsPerBranch: 10, closingRefsPerPr: 10, maxBodyRefs: 50 }),
  }
  const host = {
    ...IDLE_ITEMS,
    slot: {
      id: 'items',
      persist: true,
      read: async () => [] as unknown as Json,
      empty: () => true,
      settle: async (live: Json | undefined) => live as Json,
      restore: async () => {},
    },
    start: async () => {},
    capture: async () => {},
    replay: async () => {},
    tick: async () => {},
    sessionChanged: async () => {},
    dispose: () => {},
    list: async () => [],
    update: async () => false,
    track: async () => {},
    refresh: () => {},
  } as unknown as ItemsHost
  const trackers = [autoTracker(gh)]
  const m = new LifecycleManager(
    {
      trackers,
      items: host,
      dismiss: p => autoDismiss(p.state.slot),
      config: () => fakeConfig({ specs: trackers }),
      paneId: 'track',
    },
    w.ports,
  )
  const res = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '' })
  w.run = async argv => {
    if (argv[0] !== 'git') return undefined
    if (argv[1] === 'rev-parse') return res(`${ROOT}\n`)
    if (argv[1] === 'worktree') return res(porcelain(ROOT))
    return undefined
  }
  // The run has a root, as if the first session.start had pinned it: the rounds below then carry only their own reason.
  w.state.set('auto', { ...emptyAuto(), root: { cwd: ROOT, at: START_AT } } as unknown as Json)
  return { w, m }
}

test('auto: each round publishes auto.branches with a new seq and its reasons', async () => {
  const { w, m } = autoWorld()
  const read = () => m.facts.read<BranchesFact>('auto.branches')
  await m.ensureStarted(w.ports)
  expect(read()).toEqual({ seq: 0, reasons: [], branches: [], overflow: 0 }) // init publishes what the slot holds
  await m.tick()
  await sleep(20)
  const first = read()
  expect(first).toMatchObject({ seq: 1, reasons: ['tick'], overflow: 0 })
  expect(first?.current).toEqual(expect.any(String)) // the master agent's branch
  expect(first?.branches).toContain(first?.current)
  await m.agentSpawn(w.ports, { input: ev.SPAWN_INPUT as Json, answer: ev.SPAWN_ANSWER as Json })
  await w.clock.advance(WINDOW)
  await sleep(15)
  expect(read()).toMatchObject({ seq: 2, reasons: ['agent'], current: first?.current })
  const state = w.state.get('auto') as unknown as AutoState
  expect(read()?.branches).toEqual(state.snapshot?.branches)
})
