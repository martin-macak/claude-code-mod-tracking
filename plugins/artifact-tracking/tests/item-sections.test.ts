// The sections of the five item trackers, drawn through a real LifecycleManager over fakePorts: viewOf, paneData and
// bandData read the state and write nothing, the sections come in the order of the pane and of the band, and each row
// and cell is what the legacy composers draw. Plan: L5 Task 13, K1, K2; L6 A1 to A5.
import { expect, test } from 'claude-code/testing'
import { NO_VIEW, sortSections } from '../core/infra/views'
import type { Json } from '../core/interfaces/items'
import type { Tracker } from '../core/interfaces/tracker'
import type { Cell, SectionSpec, TreeRow } from '../core/interfaces/view'
import { fakeConfig } from './fixtures/config-fs'
import { managerWorld } from './fixtures/manager'
import { KEYS, NOW, paneItems, paneWorld, seedPaneWorld, setBranches } from './fixtures/pane-world'

const ids = (sections: readonly SectionSpec[]) => sections.map(s => s.id)
const section = (sections: readonly SectionSpec[], id: string): SectionSpec => sections.find(s => s.id === id)!
const cell = (r: TreeRow | undefined, id: string): Cell => r?.cells[id] ?? { text: '<no cell>' }
const find = (sections: readonly SectionSpec[], id: string, rowId: string): TreeRow | undefined => {
  const walk = (rows: readonly TreeRow[]): TreeRow | undefined => {
    for (const r of rows) {
      if (r.id === rowId) return r
      const deeper = walk(r.children ?? [])
      if (deeper) return deeper
    }
    return undefined
  }
  return walk(section(sections, id).rows)
}
const column = (c: SectionSpec['columns'][number]) => [c.id, c.header]
/** The sections of the item trackers: they list items, so each row takes a mark. The other four are in tracker-sections.test.ts. */
const ITEM_SECTIONS = ['prs', 'jira', 'github', 'artifact', 'web', 'file']
const itemOnly = (sections: readonly SectionSpec[]) => sections.filter(s => ITEM_SECTIONS.includes(s.id))

test('viewOf with no view has nothing selected and nothing expanded', async () => {
  const t = await paneWorld()
  const ctx = await t.m.viewOf(t.w.ports, 'github')
  expect(ctx.selected).toBeNull()
  expect([...ctx.expanded]).toEqual([])
  expect(ctx.root).toBe('/work')
  expect(ctx.now).toBe(NOW)
  expect(ctx.data).toEqual({ prs: { ok: true, at: NOW - 30_000 }, defaultBranch: 'main' })
  const picked = await t.m.viewOf(t.w.ports, 'github', { selected: KEYS.issue, expanded: new Set([KEYS.jira]) })
  expect(picked.selected).toBe(KEYS.issue)
  expect(picked.expanded.has(KEYS.jira)).toBe(true)
})

test('viewOf gives the tracker its own config slice, the facts to read, the dismiss list and the levels', async () => {
  const t = await paneWorld()
  await t.m.dismiss(t.w.ports, [KEYS.web2])
  t.w.stateSets = {}
  const ctx = await t.m.viewOf(t.w.ports, 'github')
  expect(ctx.config.slice()).toEqual(t.m.config.slice('github'))
  expect(ctx.config.global()).toEqual(t.m.config.global())
  expect(ctx.facts.read('session.repo')).toEqual({ host: 'github.com', owner: 'acme', repo: 'web' })
  expect('publish' in ctx.facts).toBe(false)
  expect(ctx.isDismissed(KEYS.web2)).toBe(true)
  expect(ctx.isDismissed(KEYS.web)).toBe(false)
  expect(ctx.levelOf(KEYS.viaIssue)).toEqual({ level: 'high' }) // the person's mark
  expect(ctx.levelOf(KEYS.head)).toEqual({ level: 'top', auto: true }) // R7: the PR on the session branch
  expect(ctx.levelOf('gh:nobody')).toEqual({}) // an unknown key
  expect(ctx.tools.gh?.available).toBe(true)
  expect(ctx.items.length).toBeGreaterThan(20)
  expect(t.w.stateSets).toEqual({})
})

test('viewOf of an id no list holds rejects', async () => {
  const t = await paneWorld()
  await expect(t.m.viewOf(t.w.ports, 'nobody')).rejects.toThrow('views: no tracker nobody')
})

test('a view leaves out the items of a tracker that is off', async () => {
  const t = await paneWorld({ off: ['web'] })
  const ctx = await t.m.viewOf(t.w.ports, 'github')
  expect(ctx.items.some(i => i.category === 'web')).toBe(false)
  expect(ctx.items.some(i => i.category === 'github')).toBe(true)
})

test('paneData orders sections by rank: Worktrees, Agents, Pull requests, Jira work items, GitHub, …', async () => {
  const t = await paneWorld()
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  expect(ids(sections)).toEqual([
    'worktrees',
    'agents',
    'prs',
    'jira',
    'github',
    'artifact',
    'repos',
    'web',
    'file',
    'processes',
  ])
  expect(sections.map(s => s.title)).toEqual([
    'Worktrees',
    'Agents',
    'Pull requests',
    'Jira work items',
    'GitHub',
    'Artifacts',
    'Repos',
    'Web links',
    'Files',
    'Processes',
  ])
  expect(ids(itemOnly(sections))).toEqual(ITEM_SECTIONS) // the item part of the ids
})

test('bandData orders by band rank: Jira, GitHub, Artifacts, Links, Files, …, PRs', async () => {
  const t = await paneWorld()
  const band = await t.m.bandData(t.w.ports)
  expect(band.map(s => s.band?.label)).toEqual([
    'Jira',
    'GitHub',
    'Artifacts',
    'Links',
    'Files',
    'Repos',
    'Worktrees',
    'Agents',
    'PRs',
    'Processes',
  ])
  expect(band.map(s => [s.band?.count, s.band?.failing])).toEqual([
    [4, 0], // every Jira record, also the one drawn under ISS-1
    [7, 0], // the items the conversation named: not the ones only the lane found
    [2, 0], // not the deleted one
    [2, 0],
    [3, 0],
    [2, 0],
    [2, 0], // the live children of the root
    [2, 0], // the agents that run or wait
    [3, 1], // the open PRs of the lane, and the one with failed checks
    [3, 1],
  ])
})

test('paneData leaves out the sections of a tracker that is off', async () => {
  const t = await paneWorld({ off: ['web', 'github'] })
  expect(ids(await t.m.paneData(t.w.ports, NO_VIEW))).toEqual([
    'worktrees',
    'agents',
    'jira',
    'artifact',
    'repos',
    'file',
    'processes',
  ])
  expect((await t.m.bandData(t.w.ports)).map(s => s.band?.label)).toEqual([
    'Jira',
    'Artifacts',
    'Files',
    'Repos',
    'Worktrees',
    'Agents',
    'Processes',
  ])
})

test('the github columns are A1’s, in order', async () => {
  const t = await paneWorld()
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  expect(section(sections, 'github').columns.map(column)).toEqual([
    ['prio', ''],
    ['key', 'Ref'],
    ['title', 'Title'],
    ['type', 'Type'],
    ['status', 'State'],
    ['extra', 'Checks'],
  ])
  const heads: Record<string, string[][]> = {
    prs: [
      ['prio', ''],
      ['key', 'PR'],
      ['title', 'Title'],
      ['type', 'Branch'],
      ['status', 'State'],
      ['extra', 'Checks'],
    ],
    jira: [
      ['prio', ''],
      ['key', 'Key'],
      ['title', 'Summary'],
      ['type', 'Type'],
      ['status', 'Status'],
    ],
    artifact: [
      ['prio', ''],
      ['key', 'Name'],
      ['title', 'Id'],
      ['type', 'Origin'],
      ['status', 'State'],
    ],
    web: [
      ['prio', ''],
      ['key', 'Label'],
      ['title', 'URL'],
    ],
    file: [
      ['prio', ''],
      ['key', ''],
      ['title', 'File'],
      ['type', 'Origin'],
      ['status', 'Edits'],
      ['extra', 'Views'],
      ['mark', 'By'],
    ],
  }
  for (const [id, want] of Object.entries(heads)) expect(section(sections, id).columns.map(column)).toEqual(want)
  for (const s of sections) expect(s.columns.filter(c => c.role === 'tree').length).toBe(1)
  for (const s of itemOnly(sections))
    expect(s.columns[0]).toEqual({ id: 'prio', header: '', width: { kind: 'fixed', cells: 1 } })
  expect(section(sections, 'github').columns.map(c => c.width)).toEqual([
    { kind: 'fixed', cells: 1 },
    { kind: 'content', min: 4, max: 24 },
    { kind: 'flex', min: 10 },
    { kind: 'content', max: 6 },
    { kind: 'content', max: 10 },
    { kind: 'content', max: 10 },
  ])
  expect(section(sections, 'file').columns.map(c => c.priority)).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
    2,
    2,
    1,
  ])
})

test('every section is placed by its rank and band rank (K2)', async () => {
  const t = await paneWorld()
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  expect(sections.map(s => [s.id, s.rank, s.band?.rank])).toEqual([
    ['worktrees', 10, 7],
    ['agents', 11, 8],
    ['prs', 12, 9],
    ['jira', 20, 1],
    ['github', 30, 2],
    ['artifact', 40, 3],
    ['repos', 50, 6],
    ['web', 60, 4],
    ['file', 70, 5],
    ['processes', 80, 10],
  ])
})

test('a Jira root holds its children with expandedByDefault and child ids parent/key', async () => {
  const t = await paneWorld()
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  const root = find(sections, 'jira', KEYS.jira)!
  expect(root.expandedByDefault).toBe(true)
  expect(root.children?.map(r => r.id)).toEqual([
    'jira:acme.atlassian.net/ISS-1/PROJ-201',
    'jira:acme.atlassian.net/ISS-1/PROJ-202',
  ])
  const task = root.children![0]!
  expect(task.expandedByDefault).toBe(true)
  expect(task.children?.map(r => r.id)).toEqual(['jira:acme.atlassian.net/ISS-1/PROJ-201/PROJ-301'])
  expect(task.children![0]!.expandedByDefault).toBeUndefined() // a leaf has nothing to open
  // PROJ-201 is a tracked issue and a node of ISS-1: it has no root row of its own (#48), and its mark and via show in the tree.
  expect(find(sections, 'jira', KEYS.jiraNested)).toBeUndefined()
  expect(cell(task, 'prio').text).toBe('▽')
  expect(cell(task, 'title').text).toBe('↳#22 The task')
  // The nodes sort by their own mark: the high one first.
  expect(root.owner).toBe('jira')
  expect(cell(root, 'title').text).toBe('↳#21 The epic')
  expect(cell(root, 'key').href).toBe('https://acme.atlassian.net/browse/ISS-1')
})

test('the Jira status words: track-only on a site that is not active, not found, and the category tones', async () => {
  const t = await paneWorld()
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  expect(cell(find(sections, 'jira', KEYS.jiraTrackOnly), 'status')).toEqual({ text: 'track-only', dim: true })
  expect(cell(find(sections, 'jira', KEYS.jiraGone), 'status')).toEqual({ text: 'not found', fg: 'error' })
  expect(cell(find(sections, 'jira', KEYS.jira), 'status')).toEqual({ text: 'In Progress', fg: 'warning' })
  const subtask = find(sections, 'jira', 'jira:acme.atlassian.net/ISS-1/PROJ-201/PROJ-301')
  expect(cell(subtask, 'status')).toEqual({ text: 'Done', fg: 'success' })
  expect(cell(subtask, 'prio')).toEqual({ text: '▲' })
  expect(section(sections, 'jira').note).toEqual({ text: 'acli · acme.atlassian.net · refreshed 1m ago' })
  // A site is "not the active one" only when acli names an active one.
  t.w.state.set('tools', {})
  const idle = await t.m.paneData(t.w.ports, NO_VIEW)
  expect(cell(find(idle, 'jira', KEYS.jira), 'status').text).toBe('In Progress')
  expect(section(idle, 'jira').note).toEqual({ text: 'acli · checking…' })
  expect(section(idle, 'github').note).toEqual({ text: 'gh · checking…' })
})

test('cells carry tones as tokens', async () => {
  const t = await paneWorld()
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  const head = find(sections, 'prs', KEYS.head)
  expect(cell(head, 'status')).toEqual({ text: 'open', fg: 'success' })
  expect(cell(head, 'extra')).toEqual({ text: '✗ checks', fg: 'error' })
  expect(cell(head, 'prio')).toEqual({ text: '★', dim: true }) // a rule gave the level
  expect(cell(find(sections, 'prs', KEYS.stacked), 'extra')).toEqual({ text: '… checks', fg: 'warning' })
  expect(cell(find(sections, 'prs', KEYS.merged), 'status')).toEqual({ text: 'merged', dim: true })
  expect(cell(find(sections, 'github', KEYS.viaIssue), 'prio')).toEqual({ text: '▲' }) // the person's mark
  expect(cell(find(sections, 'github', KEYS.draft), 'status')).toEqual({ text: 'draft', dim: true })
  expect(cell(find(sections, 'file', KEYS.viewed), 'mark')).toEqual({ text: 'subagent', dim: true })
})

test('GitHub rows: #N in the session repo, owner/repo#N elsewhere, an unresolved ref, a via marker, and no link for none', async () => {
  const t = await paneWorld()
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  const gh = (key: string) => find(sections, 'github', key)
  expect(cell(gh(KEYS.issue), 'key')).toEqual({ text: '#5', href: 'https://github.com/acme/web/issues/5' })
  expect(cell(gh(KEYS.other), 'key').text).toBe('cli/cli#14640')
  expect(cell(gh(KEYS.bare), 'key')).toEqual({ text: '#7' }) // an unresolved ref has no URL
  expect(cell(gh(KEYS.bare), 'title').text).toBe('unresolved: no repo')
  expect(cell(gh(KEYS.viaIssue), 'title').text).toBe('↳#21 Name the lane')
  expect(cell(gh(KEYS.gone), 'status')).toEqual({ text: 'not found', fg: 'error' })
  expect(cell(gh(KEYS.pr), 'type').text).toBe('PR')
  expect(cell(gh(KEYS.issue), 'type').text).toBe('Issue')
  expect(cell(gh(KEYS.bare), 'type').text).toBe('')
  // With no session repo fact, every ref reads owner/repo#N.
  const t2 = await paneWorld()
  t2.m.facts.publish('session.repo', undefined)
  const bare = find(await t2.m.paneData(t2.w.ports, NO_VIEW), 'github', KEYS.issue)
  expect(cell(bare, 'key').text).toBe('acme/web#5')
})

test('the Pull requests rows: the branch, a stacked PR, the title without the via marker, merged dimmed', async () => {
  const t = await paneWorld()
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  expect(section(sections, 'prs').rows.map(r => r.id)).toEqual([KEYS.head, KEYS.stacked, KEYS.merged, KEYS.named])
  expect(cell(find(sections, 'prs', KEYS.head), 'type').text).toBe('feat/x')
  expect(cell(find(sections, 'prs', KEYS.stacked), 'type').text).toBe('→feat/x') // stacked on a branch other than main
  expect(find(sections, 'prs', KEYS.merged)?.dim).toBe(true)
  expect(find(sections, 'prs', KEYS.head)?.dim).toBeUndefined()
  // The PR the conversation named too is in this section only.
  expect(find(sections, 'github', KEYS.named)).toBeUndefined()
  // Without a default branch no PR reads as stacked.
  t.w.state.set('github', { prs: { ok: true } })
  const open = find(await t.m.paneData(t.w.ports, NO_VIEW), 'prs', KEYS.stacked)
  expect(cell(open, 'type').text).toBe('feat/y')
})

test('the Pull requests note: the tool, a failed discovery, a skip, and the branches not polled', async () => {
  const t = await paneWorld()
  const note = async () => section(await t.m.paneData(t.w.ports, NO_VIEW), 'prs').note?.text
  expect(await note()).toBe('gh · refreshed 2m ago')
  t.w.state.set('github', { prs: { ok: false, error: 'boom', untracked: 2 } })
  setBranches(t.m, { branches: ['main'], overflow: 3 })
  expect(await note()).toBe('gh · discovery failed: boom · +3 branches not polled · +2 not tracked')
  for (const [skipped, text] of [
    ['no-repo', 'no GitHub repo'],
    ['no-gh', 'gh not installed'],
    ['not-logged-in', 'gh not logged in to github.com'],
    ['host-not-authed', 'gh not logged in to github.com'],
    ['paused', 'gh · refreshed 2m ago'],
  ] as const) {
    t.w.state.set('github', { prs: { ok: false, skipped } })
    setBranches(t.m, { branches: ['main'] })
    expect(await note()).toBe(text)
  }
})

test('the Pull requests section: with no PR it shows only for a skip that needs a word, and only with branches', async () => {
  const t = await paneWorld()
  const items = (t.w.state.get('items') as unknown as { sources: string[] }[]).filter(i => !i.sources.includes('auto'))
  t.w.state.set('items', items as unknown as Json)
  const has = async () => ids(await t.m.paneData(t.w.ports, NO_VIEW)).includes('prs')
  expect(await has()).toBe(false) // no PR, nothing to say
  t.w.state.set('github', { prs: { ok: false, skipped: 'not-logged-in' } })
  expect(await has()).toBe(true) // gh needs a login: say so
  t.w.state.set('github', { prs: { ok: false, skipped: 'no-repo' } })
  expect(await has()).toBe(false) // a skip with no word of its own
  t.w.state.set('github', { prs: { ok: false, error: 'boom' } })
  expect(await has()).toBe(true)
  setBranches(t.m, { branches: [] })
  expect(await has()).toBe(false) // no branch was polled: nothing failed
  t.w.state.delete('github')
  t.m.facts.publish('auto.branches', 'not the fact' as unknown as Json)
  expect(await has()).toBe(false)
  expect((await t.m.bandData(t.w.ports)).map(s => s.id)).not.toContain('prs')
})

test('artifact, web and file rows', async () => {
  const t = await paneWorld()
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  const published = find(sections, 'artifact', KEYS.published)
  expect(cell(published, 'key')).toEqual({
    text: 'Design notes',
    href: 'https://claude.ai/artifact/11111111-1111-4111-8111-111111111111',
  })
  expect(cell(published, 'title').text).toBe('11111111-1111-4111-8111-111111111111') // the name is not the id
  expect(cell(published, 'type').text).toBe('published')
  const deleted = find(sections, 'artifact', KEYS.deleted)
  expect(deleted?.dim).toBe(true)
  expect(cell(deleted, 'key').href).toBeUndefined() // a deleted page has no link
  expect(cell(deleted, 'status')).toEqual({ text: 'deleted', dim: true })
  const mentioned = find(sections, 'artifact', KEYS.mentioned)
  expect(cell(mentioned, 'title').text).toBe('') // the name is the id: it shows once
  expect(cell(mentioned, 'type').text).toBe('mentioned')
  expect(section(sections, 'artifact').note).toEqual({ text: '3 artifacts' })
  // A web link shows the host and path of its URL: no scheme, query or trailing slash.
  expect(cell(find(sections, 'web', KEYS.web), 'title').text).toBe('↳#21 docs.example/a')
  expect(cell(find(sections, 'web', KEYS.web2), 'title').text).toBe('docs.example/b')
  expect(cell(find(sections, 'web', KEYS.web2), 'key').text).toBe('The B page')
  expect(section(sections, 'web').note).toEqual({ text: '2 links' })
  // A file shows its path below the session root, one cell per activity.
  const created = find(sections, 'file', KEYS.created)
  expect(cell(created, 'key')).toEqual({ text: '' })
  expect(cell(created, 'title').text).toBe('plan.md')
  expect(cell(created, 'type').text).toBe('created')
  const edited = find(sections, 'file', KEYS.edited)
  expect([cell(edited, 'title').text, cell(edited, 'status').text, cell(edited, 'extra').text]).toEqual([
    'docs/spec.md',
    'edited 2',
    'viewed 1',
  ])
  expect(section(sections, 'file').note).toEqual({ text: '3 files' })
  // With no root the path shows as written; a mention that nothing else touched reads as mentioned.
  t.m.facts.publish('auto.root', undefined)
  const mention = {
    ...paneItems().at(-1)!,
    key: 'file:/work/m.md',
    label: '/work/m.md',
    url: '/work/m.md',
    mentions: 1,
  }
  t.w.state.set('items', [{ ...mention, views: 0, bySubagent: undefined }] as unknown as Json)
  const rows = section(await t.m.paneData(t.w.ports, NO_VIEW), 'file').rows
  expect([cell(rows[0], 'title').text, cell(rows[0], 'type').text, cell(rows[0], 'mark').text]).toEqual([
    '/work/m.md',
    'mentioned',
    '',
  ])
})

test('can is always written', async () => {
  const t = await paneWorld()
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  const all: { row: TreeRow; depth: number }[] = []
  const walk = (rows: readonly TreeRow[], depth: number) => {
    for (const row of rows) {
      all.push({ row, depth })
      walk(row.children ?? [], depth + 1)
    }
  }
  for (const s of itemOnly(sections)) walk(s.rows, 0)
  expect(all.length).toBeGreaterThan(20)
  for (const { row, depth } of all) {
    expect(typeof row.can?.dismiss).toBe('boolean')
    expect(typeof row.can?.priority).toBe('boolean')
    expect(row.can?.priority).toBe(true) // every item row and every Jira node takes a mark
    expect(row.can?.dismiss).toBe(depth === 0) // a Jira node is part of its issue: only the issue is dismissed
  }
  // The rows of the other four trackers write both too, and none takes a mark.
  const others: TreeRow[] = []
  const collect = (rows: readonly TreeRow[]) => {
    for (const row of rows) {
      others.push(row)
      collect(row.children ?? [])
    }
  }
  for (const s of sections.filter(x => !ITEM_SECTIONS.includes(x.id))) collect(s.rows)
  expect(others.length).toBe(14) // 4 worktrees, 5 agents, 2 repos, 3 processes
  for (const row of others) {
    expect(typeof row.can?.dismiss).toBe('boolean')
    expect(row.can?.priority).toBe(false)
  }
  expect(find(sections, 'jira', 'jira:acme.atlassian.net/ISS-1/PROJ-202')?.can).toEqual({
    dismiss: false,
    priority: true,
  })
  expect(find(sections, 'github', KEYS.issue)?.can).toEqual({ dismiss: true, priority: true })
})

test('items of each section sort by level, then by the first sighting', async () => {
  const t = await paneWorld()
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  // R8 lifts #5 to top (the PR that closes it is top), the person's high mark comes next, the rest by first sighting.
  expect(section(sections, 'github').rows.map(r => r.id)).toEqual([
    KEYS.issue,
    KEYS.viaIssue,
    KEYS.pr,
    KEYS.other,
    KEYS.bare,
    KEYS.gone,
    KEYS.draft,
  ])
})

test('paneData and bandData write nothing and run no session check', async () => {
  const t = await paneWorld()
  let checks = 0
  const check = t.m.watch.check.bind(t.m.watch)
  t.m.watch.check = () => {
    checks++
    return check()
  }
  const before = { sets: t.w.storeSets, calls: t.w.calls.length }
  await t.m.paneData(t.w.ports, NO_VIEW)
  await t.m.bandData(t.w.ports)
  await t.m.levels(t.w.ports)
  await t.m.viewOf(t.w.ports, 'jira')
  expect(t.w.stateSets).toEqual({})
  expect(t.w.storeSets).toBe(before.sets)
  expect(t.w.calls.length).toBe(before.calls)
  expect(checks).toBe(0)
})

test('paneData reads before the start: a world with no state draws no section', async () => {
  const t = managerWorld({ config: specs => fakeConfig({ specs }) })
  expect(await t.m.paneData(t.w.ports, NO_VIEW)).toEqual([])
  expect(await t.m.bandData(t.w.ports)).toEqual([])
  expect(t.w.stateSets).toEqual({})
  expect(t.w.calls).toEqual([])
})

test('levels gives the level of every item by key', async () => {
  const t = await paneWorld()
  const levels = await t.m.levels(t.w.ports)
  expect(levels.get(KEYS.head)).toEqual({ level: 'top', auto: true })
  expect(levels.get(KEYS.issue)).toEqual({ level: 'top', auto: true })
  expect(levels.get(KEYS.viaIssue)).toEqual({ level: 'high' })
  expect(levels.get(KEYS.web)).toEqual({})
  expect(levels.size).toBe((t.w.state.get('items') as unknown as unknown[]).length)
})

test('a tracker whose sections throw loses them, the others still draw, and one line is logged', async () => {
  const broken: Tracker = {
    id: 'broken',
    order: 5,
    config: { defaults: { enabled: true }, normalise: (_raw, defaults) => defaults },
    init: () => {},
    store: ctx => ctx.config.slice(),
    sections: () => {
      throw new Error('boom')
    },
  }
  const t = managerWorld({ extra: [broken], config: specs => fakeConfig({ specs }) })
  await t.m.ensureStarted(t.w.ports)
  seedPaneWorld(t.w.state, t.m)
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  expect(ids(sections)).toEqual([
    'worktrees',
    'agents',
    'prs',
    'jira',
    'github',
    'artifact',
    'repos',
    'web',
    'file',
    'processes',
  ])
  expect(t.w.logs).toContain('views: sections of broken failed: boom')
})

test('sortSections: the pane by rank, else the order; the band by band rank, else rank, else the order; ties keep the input order', () => {
  const s = (id: string, o: Partial<SectionSpec> = {}): SectionSpec => ({ id, title: id, columns: [], rows: [], ...o })
  const list = [
    { s: s('a'), order: 30 },
    { s: s('b', { rank: 5 }), order: 90 },
    { s: s('c', { band: { label: 'C', count: 1, failing: 0, rank: 1 } }), order: 40 },
    { s: s('d', { rank: 30 }), order: 10 },
  ]
  expect(ids(sortSections(list, 'pane'))).toEqual(['b', 'a', 'd', 'c']) // a and d tie at 30: a came first
  expect(ids(sortSections(list, 'band'))).toEqual(['c', 'b', 'a', 'd']) // c 1, b 5, then a 30 and d 30
  expect(list.map(x => x.s.id)).toEqual(['a', 'b', 'c', 'd']) // the input is not sorted in place
})

test('setPriority marks the row and touches persistence once', async () => {
  const t = await paneWorld()
  let touched = 0
  const touch = t.m.persistence.touch.bind(t.m.persistence)
  t.m.persistence.touch = () => {
    touched++
    return touch()
  }
  await t.m.setPriority(t.w.ports, KEYS.web, 'high')
  expect(touched).toBe(1)
  const stored = () => t.w.state.get('items') as unknown as { key: string; priority?: string }[]
  expect(stored().find(i => i.key === KEYS.web)?.priority).toBe('high')
  expect(cell(find(await t.m.paneData(t.w.ports, NO_VIEW), 'web', KEYS.web), 'prio')).toEqual({ text: '▲' })
  // A Jira node takes a mark by its row id.
  await t.m.setPriority(t.w.ports, 'jira:acme.atlassian.net/ISS-1/PROJ-202', 'high')
  const marked = find(await t.m.paneData(t.w.ports, NO_VIEW), 'jira', 'jira:acme.atlassian.net/ISS-1/PROJ-202')
  expect(cell(marked, 'prio').text).toBe('▲')
  // `undefined` removes the mark. `top` is not settable: it does nothing.
  await t.m.setPriority(t.w.ports, KEYS.web, undefined)
  touched = 0
  await t.m.setPriority(t.w.ports, KEYS.web, 'top')
  expect(touched).toBe(0)
  expect(stored().find(i => i.key === KEYS.web)?.priority).toBeUndefined()
})

test('refreshManual kicks the items and sends manual to the trackers', async () => {
  const log: string[] = []
  const recorder: Tracker = {
    id: 'recorder',
    order: 5,
    config: { defaults: { enabled: true }, normalise: (_raw, defaults) => defaults },
    init: () => {},
    store: ctx => ctx.config.slice(),
    events: { command: (_ctx, ev) => void log.push(`command:${ev.sub}:${ev.wait}`) },
  }
  const t = managerWorld({ extra: [recorder], config: specs => fakeConfig({ specs }) })
  const kicks: string[] = []
  const kick = t.m.items.kick.bind(t.m.items)
  t.m.items.kick = reason => {
    kicks.push(`${reason}:${log.length}`) // how many tracker commands were heard before the kick
    kick(reason)
  }
  await t.m.refreshManual(t.w.ports)
  expect(kicks).toEqual(['manual:0'])
  expect(log).toEqual(['command:manual:false'])
  expect(t.m.items.ready).toBe(true) // the entry started the load
})
