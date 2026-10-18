// View model: pure functions over ItemRecord[]. No engine, no files.
import { expect, test } from 'claude-code/testing'
import { emptyAuto } from '../hooks/auto/ledger'
import type {
  ArtifactRecord,
  FileRecord,
  GitHubRecord,
  ItemRecord,
  JiraNode,
  JiraRecord,
  ToolStatus,
  WebRecord,
} from '../hooks/contracts'
import { markerOf } from '../hooks/model/priority'
import { composeBand, composeCommandText } from '../hooks/ui/auto-view'
import {
  ago,
  bandParts,
  buildPane,
  columnsFor,
  dismissKey,
  EMPTY_TEXT,
  focusTargets,
  foldKey,
  markKeys,
  textOf,
  toolNote,
  type ViewContext,
} from '../hooks/ui/view'
import { PAGE_CODE_URL, PAGE_ID, PAGE_KEY, PAGE_URL, PAGE_UUID } from './fixtures/artifacts'

const NOW = 1_000_000
const PROCESS_UI = { breaker: 'closed' as const }

const gh = (over: Partial<ToolStatus> = {}): ToolStatus => ({
  name: 'gh',
  available: true,
  loggedIn: true,
  breaker: 'closed',
  ...over,
})
const acli = (over: Partial<ToolStatus> = {}): ToolStatus => ({
  name: 'acli',
  available: true,
  loggedIn: true,
  breaker: 'closed',
  site: 'acme.atlassian.net',
  ...over,
})
const ctx = (over: Partial<ViewContext> = {}): ViewContext => ({
  now: NOW,
  folded: [],
  tools: { gh: gh(), acli: acli() },
  sessionRepo: null,
  ...over,
})

const base = (key: string, url: string, label: string, firstSeen: number) => ({
  key,
  url,
  label,
  sources: ['prompt' as const],
  firstSeen,
  lastSeen: firstSeen,
  seenCount: 1,
})

const node = (key: string, status: string, statusCategory: string, children: JiraNode[] = []): JiraNode => ({
  key,
  summary: 'S ' + key,
  issueType: 'Story',
  status,
  statusCategory,
  children,
})

const jira = (issueKey: string, over: Partial<JiraRecord> = {}): JiraRecord => ({
  ...base('jira:acme.atlassian.net/' + issueKey, `https://acme.atlassian.net/browse/${issueKey}`, issueKey, 10),
  category: 'jira',
  site: 'acme.atlassian.net',
  issueKey,
  trackOnly: false,
  children: [],
  ...over,
})

const pr = (number: number, over: Partial<GitHubRecord> = {}): GitHubRecord => ({
  ...base(`gh:github.com/o/r#${number}`, `https://github.com/o/r/pull/${number}`, `#${number}`, 20),
  category: 'github',
  host: 'github.com',
  owner: 'o',
  repo: 'r',
  number,
  type: 'pr',
  ...over,
})

const web = (url: string, label: string, firstSeen = 30): WebRecord => ({
  ...base('web:' + url, url, label, firstSeen),
  category: 'web',
})
/** A mention of the observed page, without a name. */
const artifact = (over: Partial<ArtifactRecord> = {}): ArtifactRecord => ({
  ...base(PAGE_KEY, PAGE_URL, PAGE_ID, 35),
  category: 'artifact',
  sources: ['response'],
  ...over,
})
const published: Partial<ArtifactRecord> = { label: 'Probe Page 29', sources: ['publish', 'response'] }

const file = (path: string, over: Partial<FileRecord> = {}, firstSeen = 40): FileRecord => ({
  ...base('file:' + path, path, path, firstSeen),
  category: 'file',
  created: true,
  edits: 0,
  views: 0,
  mentions: 0,
  ...over,
})
const rooted = (cwd: string): Partial<ViewContext> => ({ auto: { ...emptyAuto(), root: { cwd, at: 1 } } })

test('sections come in order jira, github, artifacts, web, files and empty ones are omitted', () => {
  const items: ItemRecord[] = [web('https://a.dev/x', 'A', 1), artifact(), pr(1), jira('ISS-1'), file('/work/plan.md')]
  expect(buildPane(items, ctx()).map(s => s.category)).toEqual(['jira', 'github', 'artifact', 'web', 'file'])
  expect(buildPane([pr(1)], ctx()).map(s => s.title)).toEqual(['GitHub'])
  expect(buildPane([], ctx())).toEqual([])
})

test('rows sort by priority first, then by firstSeen inside a section', () => {
  const rows = buildPane(
    [
      pr(4, { firstSeen: 3, priority: 'low' }),
      pr(3, { firstSeen: 2 }),
      pr(2, { firstSeen: 50, priority: 'high' }),
      pr(1, { firstSeen: 5, priority: 'high' }),
    ],
    ctx(),
  )[0]!.rows
  expect(rows.map(r => r.key)).toEqual(['o/r#1', 'o/r#2', 'o/r#3', 'o/r#4'])
})

test('jira child rows sort by priority inside their parent and stay in the tree', () => {
  const withPriority = jira('ISS-1', {
    summary: 'Parent',
    issueType: 'Epic',
    children: [
      node('ISS-2', 'In Progress', 'indeterminate'),
      { ...node('ISS-3', 'To Do', 'new'), priority: 'high' },
      { ...node('ISS-4', 'Done', 'done'), priority: 'low' },
    ],
  })
  const rows = buildPane([withPriority], ctx())[0]!.rows
  expect(rows.map(r => r.key)).toEqual(['ISS-1', 'ISS-3', 'ISS-2', 'ISS-4'])
})

test('rows carry priority markers for high and low', () => {
  const rows = buildPane(
    [pr(1, { priority: 'high' }), pr(2), pr(3, { priority: 'low' }), jira('ISS-9', { priority: 'high' })],
    ctx(),
  )
  const github = rows.find(s => s.id === 'github')!.rows
  expect(github.map(r => markerOf(r.prio?.level))).toEqual(['▲', '', '▽'])
  const jiraRows = rows.find(s => s.id === 'jira')!.rows
  expect(markerOf(jiraRows[0]?.prio?.level)).toBe('▲')
})

test('every item section is marked, and every row in it has a mark, Jira children too', () => {
  const sections = buildPane(
    [jira('ISS-1', { children: [node('ISS-2', 'To Do', 'new')] }), pr(1), web('https://a.dev/x', 'A')],
    ctx(),
  )
  expect(sections.map(s => s.prio)).toEqual([true, true, true])
  expect(sections.flatMap(s => s.rows.map(r => r.prio !== undefined))).toEqual([true, true, true, true])
})

test('the Files section has levels too: rows sort by level, and the text puts the marker first', () => {
  const sections = buildPane(
    [
      file('/work/a.md', {}, 1),
      file('/work/b.md', { priority: 'high' }, 2),
      file('/work/c.md', { priority: 'low' }, 3),
    ],
    ctx(rooted('/work')),
  )
  const files = sections.find(s => s.id === 'file')!
  expect(files.prio).toBe(true)
  expect(files.rows.map(r => [r.title, r.prio])).toEqual([
    ['b.md', { level: 'high' }],
    ['a.md', {}],
    ['c.md', { level: 'low' }],
  ])
  const text = textOf(sections)
  expect(text).toContain('\n  ▲  b.md  created')
  expect(text).toContain('\n  a.md  created')
  expect(text).toContain('\n  ▽  c.md  created')
  expect([...markKeys(sections).keys()]).toEqual(['file:/work/b.md', 'file:/work/a.md', 'file:/work/c.md'])
})

test('the /track text puts the marker before the key; a row with no mark or normal has none', () => {
  const text = textOf(
    buildPane(
      [
        pr(1, { priority: 'high' }),
        pr(2),
        pr(3, { priority: 'low' }),
        pr(4, { priority: 'normal' }),
        jira('ISS-1', { children: [{ ...node('ISS-2', 'To Do', 'new'), priority: 'high' }] }),
      ],
      ctx(),
    ),
  )
  expect(text).toContain('\n  ▲ o/r#1  ')
  expect(text).toContain('\n  o/r#2')
  expect(text).toContain('\n  o/r#4')
  expect(text).toContain('\n  ▽ o/r#3')
  expect(text).toContain('\n    ▲ ISS-2  ')
})

test('markKeys: a key per marked row with its place and its level; a moved or re-levelled row gets a new one', () => {
  const before = markKeys(buildPane([pr(1), pr(2, { firstSeen: 30 })], ctx()))
  expect([...before.values()]).toEqual(['mark:0:-:gh:github.com/o/r#1', 'mark:1:-:gh:github.com/o/r#2'])
  const after = markKeys(buildPane([pr(1), pr(2, { firstSeen: 30, priority: 'high' })], ctx()))
  expect(after.get('gh:github.com/o/r#2')).toBe('mark:0:high:gh:github.com/o/r#2')
  expect(after.get('gh:github.com/o/r#1')).toBe('mark:1:-:gh:github.com/o/r#1')
})

test('focusTargets: the mark, fold and x of a row all pick that row; a child picks itself', () => {
  const sections = buildPane([jira('ISS-1', { children: [node('ISS-2', 'To Do', 'new')] })], ctx())
  const keys = markKeys(sections)
  const targets = focusTargets(sections)
  const root = 'jira:acme.atlassian.net/ISS-1'
  const child = `${root}/ISS-2`
  expect(targets.get(keys.get(root)!)).toBe(root)
  expect(targets.get(foldKey(root))).toBe(root)
  expect(targets.get(dismissKey(root))).toBe(root)
  expect(targets.get(keys.get(child)!)).toBe(child)
  expect(targets.size).toBe(4)
})

const epic = jira('ISS-101', {
  summary: 'Onboarding',
  issueType: 'Epic',
  status: 'In Progress',
  statusCategory: 'indeterminate',
  children: [
    node('ISS-102', 'In Progress', 'indeterminate', [node('ISS-103', 'Done', 'done')]),
    node('ISS-110', 'To Do', 'new'),
  ],
})

test('jira tree: root, children and subtasks with depth, ids, links and tones', () => {
  const rows = buildPane([epic], ctx())[0]!.rows
  expect(rows.map(r => [r.id, r.depth])).toEqual([
    ['jira:acme.atlassian.net/ISS-101', 0],
    ['jira:acme.atlassian.net/ISS-101/ISS-102', 1],
    ['jira:acme.atlassian.net/ISS-101/ISS-102/ISS-103', 2],
    ['jira:acme.atlassian.net/ISS-101/ISS-110', 1],
  ])
  const [root, child, sub, leaf] = rows
  expect(root).toMatchObject({
    key: 'ISS-101',
    title: 'Onboarding',
    type: 'Epic',
    status: 'In Progress',
    tone: 'warn',
    foldable: true,
    folded: false,
  })
  expect(root!.href).toBe('https://acme.atlassian.net/browse/ISS-101')
  expect(child!.href).toBe('https://acme.atlassian.net/browse/ISS-102')
  expect(sub).toMatchObject({ status: 'Done', tone: 'ok', foldable: false })
  expect(leaf).toMatchObject({ status: 'To Do', tone: 'plain' })
})

test('a folded jira row hides its descendants and says so', () => {
  const rootId = 'jira:acme.atlassian.net/ISS-101'
  const rows = buildPane([epic], ctx({ folded: [rootId] }))[0]!.rows
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ foldable: true, folded: true })
  const inner = buildPane([epic], ctx({ folded: [rootId + '/ISS-102'] }))[0]!.rows
  expect(inner.map(r => r.key)).toEqual(['ISS-101', 'ISS-102', 'ISS-110'])
  expect(inner[1]).toMatchObject({ folded: true })
})

test('jira title falls back to the label; not-found wins over everything', () => {
  const r = buildPane([jira('ISS-5', { error: { kind: 'not-found', message: 'x', at: 1 } })], ctx())[0]!.rows[0]!
  expect(r).toMatchObject({ title: 'ISS-5', status: 'not found', tone: 'bad' })
})

test('jira on another site, or flagged trackOnly, shows track-only', () => {
  const other = jira('ISS-200', { site: 'other.atlassian.net', status: 'Done', statusCategory: 'done' })
  expect(buildPane([other], ctx())[0]!.rows[0]).toMatchObject({ status: 'track-only', tone: 'dim' })
  const flagged = jira('ISS-201', { trackOnly: true })
  expect(buildPane([flagged], ctx())[0]!.rows[0]).toMatchObject({ status: 'track-only', tone: 'dim' })
  // active site unknown: not track-only on that ground
  const unknown = buildPane([other], ctx({ tools: { gh: gh(), acli: acli({ site: undefined }) } }))[0]!.rows[0]!
  expect(unknown.status).toBe('Done')
})

test('github keys: #N for the session repo, o/r#N otherwise, #N when unresolved', () => {
  const sess = { host: 'github.com', owner: 'O', repo: 'R' }
  const items: ItemRecord[] = [
    pr(14, { firstSeen: 1, owner: 'o', repo: 'r' }),
    pr(15, { firstSeen: 2, owner: 'x', repo: 'y', key: 'gh:github.com/x/y#15' }),
    pr(3, { firstSeen: 3, owner: undefined, repo: undefined, type: 'unknown', key: 'gh:?#3' }),
  ]
  const rows = buildPane(items, ctx({ sessionRepo: sess }))[0]!.rows
  expect(rows.map(r => r.key)).toEqual(['#14', 'x/y#15', '#3'])
  expect(rows[2]).toMatchObject({ title: 'unresolved: no repo', type: '' })
  expect(rows[0]).toMatchObject({ type: 'PR', title: '' })
  const noSession = buildPane([pr(14)], ctx())[0]!.rows[0]!
  expect(noSession.key).toBe('o/r#14')
})

test('github status and tone: open ok, merged and closed dim, draft dim, not found bad', () => {
  const st = (over: Partial<GitHubRecord>) => buildPane([pr(1, over)], ctx())[0]!.rows[0]!
  expect(st({ state: 'open' })).toMatchObject({ status: 'open', tone: 'ok' })
  expect(st({ state: 'merged' })).toMatchObject({ status: 'merged', tone: 'dim' })
  expect(st({ state: 'closed' })).toMatchObject({ status: 'closed', tone: 'dim' })
  expect(st({ state: 'open', isDraft: true })).toMatchObject({ status: 'draft', tone: 'dim' })
  expect(st({ error: { kind: 'not-found', message: 'x', at: 1 } })).toMatchObject({ status: 'not found', tone: 'bad' })
  expect(st({ type: 'issue' }).type).toBe('Issue')
})

test('failing checks show a red extra; pending yellow; success green; none nothing', () => {
  const ex = (checks: GitHubRecord['checks']) => buildPane([pr(1, { state: 'open', checks })], ctx())[0]!.rows[0]!
  expect(ex('failure')).toMatchObject({ extra: '✗ checks', extraTone: 'bad' })
  expect(ex('pending')).toMatchObject({ extra: '… checks', extraTone: 'warn' })
  expect(ex('success')).toMatchObject({ extra: '✓ checks', extraTone: 'ok' })
  expect(ex('none').extra).toBeUndefined()
  expect(ex(undefined).extra).toBeUndefined()
})

test('web rows: label as key, link href, host and path as title', () => {
  const r = buildPane([web('https://code.claude.com/docs/en/plugins/mods?x=1#top', 'Mods overview')], ctx())[0]!
    .rows[0]!
  expect(r).toMatchObject({
    key: 'Mods overview',
    href: 'https://code.claude.com/docs/en/plugins/mods?x=1#top',
    title: 'code.claude.com/docs/en/plugins/mods',
    type: '',
    status: '',
    depth: 0,
    foldable: false,
  })
})

test('file rows: the path relative to the session root in the title, one self-naming cell per activity', () => {
  const items = [
    file('/work/docs/plan.md', { edits: 3, views: 2, mentions: 1 }, 1),
    file('/work/README.md', { created: false, edits: 1, views: 5 }, 2),
    file('/work/docs/notes.md', { created: false, mentions: 2, views: 1, bySubagent: true }, 3),
    file('/elsewhere/a.md', { created: false, edits: 1 }, 4),
  ]
  const s = buildPane(items, ctx(rooted('/work')))[0]!
  expect(s).toMatchObject({ id: 'file', layout: 'files', note: '4 files', dismissable: true })
  const cells = s.rows.map(r => [r.key, r.title, r.type, r.status, r.extra, r.mark])
  expect(cells).toEqual([
    ['', 'docs/plan.md', 'created', 'edited 3', 'viewed 2', ''],
    ['', 'README.md', '', 'edited 1', 'viewed 5', ''],
    ['', 'docs/notes.md', 'mentioned', '', 'viewed 1', 'subagent'],
    ['', '/elsewhere/a.md', '', 'edited 1', '', ''],
  ])
  expect(s.rows[0]).toMatchObject({ id: 'file:/work/docs/plan.md', dismissId: 'file:/work/docs/plan.md' })
})

test('file rows: with no session root known the path stays absolute', () => {
  const rows = buildPane([file('/work/docs/plan.md')], ctx())[0]!.rows
  expect(rows[0]!.title).toBe('/work/docs/plan.md')
})

test('file rows: the /track text keeps the long path whole and drops empty cells', () => {
  const long = '/work/docs/superpowers/specs/2026-10-10-artifact-tracking-design.md'
  const text = composeCommandText(
    [file(long, { edits: 2 }), file('/work/b.md', { created: false, mentions: 1, bySubagent: true })],
    [],
    PROCESS_UI,
    ctx(rooted('/work')),
  )
  expect(text).toBe(
    'Files  2 files\n' +
      '  docs/superpowers/specs/2026-10-10-artifact-tracking-design.md  created  edited 2\n' +
      '  b.md  mentioned  subagent',
  )
})

const artifactRow = (rec: ArtifactRecord) => buildPane([rec], ctx())[0]!.rows[0]!

test('artifact rows: the name links to the page, the id is the title, the origin is the type', () => {
  expect(artifactRow(artifact(published))).toEqual({
    id: PAGE_KEY,
    depth: 0,
    key: 'Probe Page 29',
    href: PAGE_URL,
    title: PAGE_ID,
    dismissId: PAGE_KEY,
    type: 'published',
    status: '',
    tone: 'plain',
    foldable: false,
    folded: false,
    prio: {}, // an item row with no mark (issue #30)
  })
  expect(artifactRow(artifact({ url: PAGE_CODE_URL, label: 'Design notes' }))).toMatchObject({
    key: 'Design notes',
    href: PAGE_CODE_URL,
    title: PAGE_UUID,
    type: 'mentioned',
  })
})

test('the Artifacts section has levels too: a high artifact sorts first and the text shows its marker', () => {
  const low = artifact({ priority: 'low', label: 'Low page' })
  const high = { ...artifact({ priority: 'high', label: 'High page' }), key: 'art:other', firstSeen: 99 }
  const section = buildPane([low, high], ctx()).find(s => s.id === 'artifact')!
  expect(section.prio).toBe(true)
  expect(section.rows.map(r => [r.key, r.prio?.level])).toEqual([
    ['High page', 'high'],
    ['Low page', 'low'],
  ])
  expect(textOf([section])).toContain('\n  ▲ High page  ')
})

test('artifact rows: a row without a name shows the id once', () => {
  expect(artifactRow(artifact())).toMatchObject({ key: PAGE_ID, title: '', type: 'mentioned' })
  expect(textOf(buildPane([artifact()], ctx()))).toBe(`Artifacts  1 artifacts\n  ${PAGE_ID}  mentioned`)
})

test('artifact rows: a deleted row is dim, has no link and says deleted', () => {
  const row = artifactRow(artifact({ ...published, deleted: true }))
  expect(row).toMatchObject({ key: 'Probe Page 29', status: 'deleted', tone: 'dim', dim: true, type: 'published' })
  expect(row.href).toBeUndefined()
  expect(textOf(buildPane([artifact({ ...published, deleted: true })], ctx()))).toBe(
    `Artifacts  1 artifacts\n  Probe Page 29  ${PAGE_ID}  published  deleted`,
  )
})

test('section notes', () => {
  const items: ItemRecord[] = [
    jira('ISS-1', { refreshedAt: NOW - 60_000 }),
    pr(1, { refreshedAt: NOW - 20_000 }),
    artifact(),
    web('https://a.dev', 'A', 1),
    web('https://b.dev', 'B', 2),
  ]
  const s = buildPane(items, ctx())
  expect(s[0]!.note).toBe('acli · acme.atlassian.net · refreshed 1m ago')
  expect(s[1]!.note).toBe('gh · refreshed 20s ago')
  expect(s[2]!.note).toBe('1 artifacts')
  expect(s[3]!.note).toBe('2 links')
  const noSite = buildPane([jira('ISS-1')], ctx({ tools: { gh: gh(), acli: acli({ site: undefined }) } }))
  expect(noSite[0]!.note).toBe('acli · ready')
})

test('toolNote covers every branch in order', () => {
  expect(toolNote(gh({ available: false }), NOW)).toBe('not installed')
  expect(toolNote(gh({ available: null }), NOW)).toBe('checking…')
  expect(toolNote(gh({ loggedIn: false }), NOW)).toBe('not logged in')
  // logged-out beats an open breaker (Review Focus 3 and 4)
  expect(toolNote(gh({ loggedIn: false, breaker: 'open', openUntil: NOW + 1000 }), NOW)).toBe('not logged in')
  expect(toolNote(gh({ breaker: 'open', openUntil: NOW + 4 * 60_000 }), NOW, NOW - 5000)).toBe('paused 4m')
  expect(toolNote(gh(), NOW, NOW - 12_000)).toBe('refreshed 12s ago')
  expect(toolNote(gh({ breaker: 'half-open' }), NOW, NOW - 2 * 3_600_000)).toBe('refreshed 2h ago')
  expect(toolNote(gh(), NOW)).toBe('ready')
  expect(toolNote(gh({ loggedIn: null }), NOW)).toBe('ready')
  // not installed is checked before logged in
  expect(toolNote(gh({ available: false, loggedIn: false }), NOW)).toBe('not installed')
})

test('toolNote says "just now" for a refresh under a second ago', () => {
  expect(toolNote(gh(), NOW, NOW - 500)).toBe('refreshed just now')
  expect(toolNote(gh(), NOW, NOW + 500)).toBe('refreshed just now') // clock skew
})

test('buildPane stays fast on a web URL with a long slash run', () => {
  const t0 = Date.now()
  buildPane([web('https://e.com/' + '/'.repeat(60_000) + 'x', 'Big')], ctx())
  expect(Date.now() - t0).toBeLessThan(200)
})

test('ago steps', () => {
  expect(ago(0)).toBe('now')
  expect(ago(999)).toBe('now')
  expect(ago(1000)).toBe('1s')
  expect(ago(12_000)).toBe('12s')
  expect(ago(4 * 60_000)).toBe('4m')
  expect(ago(2 * 3_600_000)).toBe('2h')
  expect(ago(3 * 86_400_000)).toBe('3d')
})

test('composeBand counts categories and failing PRs; null when empty', () => {
  const items: ItemRecord[] = [
    jira('ISS-1'),
    jira('ISS-2'),
    pr(1, { checks: 'failure' }),
    pr(2, { checks: 'success' }),
    pr(3, { checks: 'failure' }),
    artifact(),
    web('https://a.dev', 'A'),
    file('/work/docs/plan.md'),
  ]
  expect(composeBand(items, [], null)).toBe('Jira 2 · GitHub 3 (2 ✗) · Artifacts 1 · Links 1 · Files 1')
  expect(composeBand([artifact({ deleted: true })], [], null)).toBeNull() // a deleted artifact is not counted
  expect(composeBand([pr(1)], [], null)).toBe('GitHub 1')
  expect(composeBand([web('https://a.dev', 'A')], [], null)).toBe('Links 1')
  expect(composeBand([file('/work/docs/plan.md')], [], null)).toBe('Files 1')
  expect(composeBand([], [], null)).toBeNull()
})

test('composeCommandText: empty text and an indented tree', () => {
  expect(composeCommandText([], [], PROCESS_UI, ctx())).toBe(EMPTY_TEXT)
  const text = composeCommandText(
    [epic, pr(1, { state: 'open', title: 'Fix', checks: 'failure' })],
    [],
    PROCESS_UI,
    ctx({ folded: ['jira:acme.atlassian.net/ISS-101'] }),
  )
  const lines = text.split('\n')
  expect(lines[0]).toContain('Jira work items')
  expect(lines.some(l => l.startsWith('  ISS-101'))).toBe(true)
  // plain text shows the whole tree, folded or not
  expect(lines.some(l => l.startsWith('    ISS-102'))).toBe(true)
  expect(lines.some(l => l.startsWith('      ISS-103'))).toBe(true)
  expect(text).toContain('✗ checks')
  expect(text).toContain('GitHub')
})

test('columnsFor: defaults, and a narrow pane drops the extra column', () => {
  expect(columnsFor(undefined)).toEqual({ key: 16, type: 9, status: 13, extra: 10 })
  expect(columnsFor(96)).toEqual({ key: 16, type: 9, status: 13, extra: 10 })
  expect(columnsFor(70)).toEqual({ key: 16, type: 9, status: 13, extra: 10 })
  expect(columnsFor(60)).toEqual({ key: 16, type: 9, status: 13, extra: 0 })
  expect(columnsFor(60).type).toBeGreaterThanOrEqual('published'.length) // the artifact origin is not cut
})

// ---------------------------------------------------------------- auto sources (spec A17)

const autoPr = (n: number): GitHubRecord => ({
  key: `gh:github.com/acme/web#${n}`,
  category: 'github',
  url: `https://github.com/acme/web/pull/${n}`,
  label: `acme/web#${n}`,
  sources: ['auto'],
  firstSeen: n,
  lastSeen: n,
  seenCount: 0,
  host: 'github.com',
  owner: 'acme',
  repo: 'web',
  number: n,
  type: 'pr',
  state: 'open',
  checks: 'failure',
})

test('items with source auto are not in the GitHub section; a mentioned PR with auto is not either', () => {
  const mentioned: GitHubRecord = { ...autoPr(2), sources: ['prompt', 'auto'] }
  const issue: GitHubRecord = { ...autoPr(3), sources: ['pr-body'], type: 'issue', via: [autoPr(7).key] }
  const sections = buildPane([autoPr(1), mentioned, issue], ctx())
  expect(sections).toHaveLength(1)
  expect(sections[0]?.id).toBe('github')
  expect(sections[0]?.category).toBe('github')
  expect(sections[0]?.rows.map(r => r.id)).toEqual([issue.key])
})

test('a body ref gets the via prefix; every top-level item has a dismiss id', () => {
  const issue: GitHubRecord = {
    ...autoPr(3),
    sources: ['pr-body'],
    type: 'issue',
    title: 'Bug',
    via: [autoPr(7).key, autoPr(9).key],
  }
  const kept: GitHubRecord = {
    ...autoPr(4),
    sources: ['prompt', 'pr-body'],
    type: 'issue',
    title: 'Kept',
    via: [autoPr(7).key],
  }
  const rows = buildPane([issue, kept], ctx())[0]!.rows
  expect(rows[0]).toMatchObject({ title: '↳#7,#9 Bug', dismissId: issue.key })
  expect(rows[1]?.title).toBe('↳#7 Kept')
  expect(rows[1]?.dismissId).toBe(kept.key)
  expect(buildPane([issue, kept], ctx())[0]?.dismissable).toBe(true)
})

test('an item section without auto rows is still dismissable and has no via prefix', () => {
  const plain: GitHubRecord = { ...autoPr(5), sources: ['prompt'], title: 'Plain' }
  const section = buildPane([plain], ctx())[0]!
  expect(section.dismissable).toBe(true)
  expect(section.rows[0]?.title).toBe('Plain')
  expect(section.rows[0]?.dismissId).toBe(plain.key)
})

test('bandParts counts GitHub items without source auto; composeBand adds the auto PRs apart', () => {
  const plain: GitHubRecord = { ...autoPr(5), sources: ['prompt'] }
  expect(bandParts([autoPr(1), plain, artifact(), artifact({ key: 'art:x', deleted: true })])).toEqual([
    'GitHub 1 (1 ✗)',
    'Artifacts 1',
  ])
  expect(bandParts([autoPr(1)])).toEqual([])
  expect(composeBand([plain], [], null)).toBe('GitHub 1 (1 ✗)')
})
