// Why an item is tracked (issue #62), end to end over the real trackers on fakePorts: the reason each signal that exists today
// stands for (the mapping table of the PR), the Traceable interface of the slot trackers, the kind reasons that fail at
// build, the stored records that drop, and the rows that carry the reasons to the pane. Pure: no `$`, no engine.
import { expect, test } from 'claude-code/testing'
import { Kinds, type KindsDeps } from '../core/infra/kinds'
import { transcriptItems } from '../core/infra/replay'
import { NO_VIEW } from '../core/infra/views'
import type { Claim, KindContext, StoredItem } from '../core/interfaces/items'
import type { ReasonSet } from '../core/interfaces/reasons'
import type { Tracker } from '../core/interfaces/tracker'
import type { TreeRow } from '../core/interfaces/view'
import { GLOBAL_DEFAULTS } from '../core/lib/global-config'
import { bool, specOf } from '../core/lib/normalise'
import { isTraceable, kindReason, reasonSet } from '../core/lib/reasons'
import { helpTextOf } from '../hooks/pane-session'
import { TRACKERS } from '../trackers'
import { autoReasonsOf } from '../trackers/auto/reasons'
import { processReasonsOf } from '../trackers/processes/reasons'
import { repoReasonsOf } from '../trackers/repos/reasons'
import { DELETE, DOC_URL, PAGE_URL, PUBLISH } from './fixtures/artifacts'
import { fakeItems, itemTrackers, promptRow, responseRow, toolResultRow } from './fixtures/items'
import { managerWorld } from './fixtures/manager'
import { paneWorld, WORLD_AUTO, WORLD_PROCESSES, WORLD_REPOS, WORLD_SNAPSHOT } from './fixtures/pane-world'

/** The `[first, all, strongest]` of a set, to compare in one line. */
const why = (s: ReasonSet | undefined) => (s ? [s.first, [...s.all], s.strongest] : undefined)

// ---------------------------------------------------------------- the mapping table: conversation items

const world = async () => {
  const w = managerWorld()
  await w.m.ensureStarted(w.w.ports)
  const see = (ev: ReturnType<typeof promptRow>) => w.m.row(w.w.ports, ev)
  const record = (key: string) => w.items().find(i => i.key === key)
  return { ...w, see, record }
}

test('github, jira and web: a prompt or a response mentions the item, a tool result reads it', async () => {
  const t = await world()
  await t.see(
    promptRow(
      'See https://github.com/acme/web/pull/5, https://acme.atlassian.net/browse/ISS-1 and https://docs.example/a',
    ),
  )
  await t.see(responseRow('And https://github.com/acme/web/issues/6'))
  await t.see(toolResultRow('opened https://github.com/acme/web/pull/7 and https://acme.atlassian.net/browse/ISS-2'))
  const mentioned = reasonSet('mentioned')
  const read = reasonSet('read')
  expect(t.record('gh:github.com/acme/web#5')?.reasons).toEqual(mentioned)
  expect(t.record('jira:acme.atlassian.net/ISS-1')?.reasons).toEqual(mentioned)
  expect(t.record('web:https://docs.example/a')?.reasons).toEqual(mentioned)
  expect(t.record('gh:github.com/acme/web#6')?.reasons).toEqual(mentioned) // a response is conversation text too
  expect(t.record('gh:github.com/acme/web#7')?.reasons).toEqual(read)
  expect(t.record('jira:acme.atlassian.net/ISS-2')?.reasons).toEqual(read)
  // The channel stays in `sources`, and only the channel.
  expect(t.record('gh:github.com/acme/web#5')?.sources).toEqual(['prompt'])
  expect(t.record('gh:github.com/acme/web#6')?.sources).toEqual(['response'])
  expect(t.record('gh:github.com/acme/web#7')?.sources).toEqual(['tool'])
})

test('web: a tool result never tracks a link, so a web item has no `read` today', async () => {
  const t = await world()
  await t.see(toolResultRow('fetched https://other.example/x'))
  expect(t.keys()).toEqual([])
})

test('a mention and then a read: both reasons are kept, `first` is the mention and `strongest` the read', async () => {
  const t = await world()
  await t.see(promptRow('See https://github.com/acme/web/pull/5'))
  await t.see(toolResultRow('opened https://github.com/acme/web/pull/5'))
  expect(why(t.record('gh:github.com/acme/web#5')?.reasons)).toEqual(['mentioned', ['read', 'mentioned'], 'read'])
  expect(t.record('gh:github.com/acme/web#5')?.sources).toEqual(['prompt', 'tool'])
})

// ---------------------------------------------------------------- the mapping table: artifacts and files

test('artifact: a publish is published, a mention is mentioned, a delete adds deleted', async () => {
  const t = await world()
  await t.call('Artifact', PUBLISH.input, { result: PUBLISH.result })
  await t.see(promptRow(`and ${DOC_URL}`))
  const [published, mentioned] = t.items().filter(i => i.category === 'artifact')
  expect(why(published?.reasons)).toEqual(['published', ['published'], 'published'])
  expect(why(mentioned?.reasons)).toEqual(['mentioned', ['mentioned'], 'mentioned'])
  // A publish is a tool sighting: the channel is `tool`, not a `publish` source.
  expect(published?.sources).toEqual(['tool'])
  await t.call('Artifact', DELETE.input, { result: DELETE.result })
  const gone = t.items().find(i => i.key === published?.key)
  expect(why(gone?.reasons)).toEqual(['published', ['deleted', 'published'], 'deleted'])
  expect(gone?.deleted).toBe(true)
})

test('artifact: a delete through the Artifact tool is a tool sighting, so a page named in text keeps both channels', async () => {
  const t = await world()
  await t.see(promptRow(`see ${PAGE_URL}`))
  expect(t.items().find(i => i.category === 'artifact')?.sources).toEqual(['prompt'])
  await t.call('Artifact', DELETE.input, { result: DELETE.result })
  const gone = t.items().find(i => i.category === 'artifact')
  expect(gone?.sources).toEqual(['prompt', 'tool'])
  expect(gone?.deleted).toBe(true)
  expect(why(gone?.reasons)).toEqual(['mentioned', ['deleted', 'mentioned'], 'deleted'])
  // A second delete leaves the marked row as it is.
  await t.call('Artifact', DELETE.input, { result: DELETE.result })
  expect(t.items().find(i => i.category === 'artifact')?.sources).toEqual(['prompt', 'tool'])
})

const made = (filePath: string) => ({
  type: 'create',
  filePath,
  content: '# x',
  structuredPatch: [],
  originalFile: null,
})
const edited = (filePath: string) => ({
  filePath,
  oldString: 'a',
  newString: 'b',
  originalFile: 'a',
  structuredPatch: [],
})
const viewed = (filePath: string) => ({
  type: 'text',
  file: { filePath, content: '# x', numLines: 1, startLine: 1, totalLines: 1 },
})

test('file: a Write that makes it is created, an Edit is updated, a Read is read, a name is mentioned', async () => {
  const t = await world()
  t.w.files['/work/named.md'] = '# named'
  await t.call('Write', { file_path: '/work/a.md' }, { result: made('/work/a.md') })
  await t.call('Edit', { file_path: '/work/b.md' }, { result: edited('/work/b.md') })
  await t.see(responseRow('Notes are in /work/named.md'))
  // A Read alone adds no row; a Read of a known file adds the reason.
  await t.call('Read', { file_path: '/work/lone.md' }, { result: viewed('/work/lone.md') })
  await t.call('Read', { file_path: '/work/a.md' }, { result: viewed('/work/a.md') })
  expect(t.keys().filter(k => k.startsWith('file:'))).toEqual([
    'file:/work/a.md',
    'file:/work/b.md',
    'file:/work/named.md',
  ])
  expect(why(t.record('file:/work/a.md')?.reasons)).toEqual(['created', ['created', 'read'], 'created'])
  expect(why(t.record('file:/work/b.md')?.reasons)).toEqual(['updated', ['updated'], 'updated'])
  expect(why(t.record('file:/work/named.md')?.reasons)).toEqual(['mentioned', ['mentioned'], 'mentioned'])
})

test('file: edited, then made, then named: the order of the sightings changes neither `all` nor `strongest`', async () => {
  const forward = await world()
  forward.w.files['/work/n.md'] = '# n'
  await forward.call('Edit', { file_path: '/work/n.md' }, { result: edited('/work/n.md') })
  await forward.call('Write', { file_path: '/work/n.md' }, { result: made('/work/n.md') })
  await forward.see(responseRow('See /work/n.md'))
  const backward = await world()
  backward.w.files['/work/n.md'] = '# n'
  await backward.see(responseRow('See /work/n.md'))
  await backward.call('Write', { file_path: '/work/n.md' }, { result: made('/work/n.md') })
  await backward.call('Edit', { file_path: '/work/n.md' }, { result: edited('/work/n.md') })
  const a = forward.record('file:/work/n.md')?.reasons
  const b = backward.record('file:/work/n.md')?.reasons
  expect([a?.all, a?.strongest]).toEqual([['created', 'updated', 'mentioned'], 'created'])
  expect([b?.all, b?.strongest]).toEqual([a?.all, a?.strongest])
  expect([a?.first, b?.first]).toEqual(['updated', 'mentioned'])
})

// ---------------------------------------------------------------- Traceable: repos, processes, auto

test('repos, processes and auto implement Traceable, and no other tracker does', () => {
  expect(TRACKERS.filter(isTraceable).map(t => t.id)).toEqual(['repos', 'processes', 'auto'])
  expect(TRACKERS.filter(t => !isTraceable(t)).map(t => t.id)).toEqual(['github', 'jira', 'web', 'artifact', 'file'])
})

test('repos: an edited repo is updated, a read one is read, an older row with no mode reads as read', () => {
  const [sdk, web] = WORLD_REPOS
  expect(sdk?.mode).toBe('edit')
  expect(why(repoReasonsOf(WORLD_REPOS, `rp:${sdk!.key}`))).toEqual(['updated', ['updated'], 'updated'])
  expect(why(repoReasonsOf(WORLD_REPOS, `rp:${web!.key}`))).toEqual(['read', ['read'], 'read'])
  const { mode: _mode, ...old } = web!
  expect(why(repoReasonsOf([old], `rp:${web!.key}`))).toEqual(['read', ['read'], 'read'])
  expect(repoReasonsOf(WORLD_REPOS, 'rp:remote:nope')).toBeUndefined()
  expect(repoReasonsOf(undefined, `rp:${sdk!.key}`)).toBeUndefined()
})

test('processes: every row was started by this session, so it is created', () => {
  for (const r of WORLD_PROCESSES)
    expect(why(processReasonsOf(WORLD_PROCESSES as never, r.id))).toEqual(['created', ['created'], 'created'])
  expect(processReasonsOf(WORLD_PROCESSES as never, 'bg:nope')).toBeUndefined()
  expect(processReasonsOf(undefined, 'bg:1')).toBeUndefined()
})

const PROOFS = {
  ...WORLD_AUTO,
  worktrees: [{ path: '/work/feat-x', origin: 'enter' as const, provenAt: 1 }],
  agents: [
    { id: 'explore', kind: 'subagent' as const, label: 'explore', spawnedAt: 1 },
    { id: 'build', kind: 'workflow' as const, label: 'build', spawnedAt: 2 },
  ],
}

test('auto: a worktree or agent this run proved is created; the root and the master agent are no find', () => {
  expect(why(autoReasonsOf(PROOFS, 'wt:/work/feat-x'))).toEqual(['created', ['created'], 'created'])
  expect(why(autoReasonsOf(PROOFS, 'ag:explore'))).toEqual(['created', ['created'], 'created'])
  expect(why(autoReasonsOf(PROOFS, 'ag:build'))).toEqual(['created', ['created'], 'created'])
  expect(autoReasonsOf(PROOFS, 'wt:/work')).toBeUndefined()
  expect(autoReasonsOf(PROOFS, 'ag:master')).toBeUndefined()
  expect(autoReasonsOf(undefined, 'ag:explore')).toBeUndefined()
})

test('the trackers answer through the interface: reasonsOf of each tracker is the function the row uses', () => {
  const by = (id: string) =>
    TRACKERS.find(t => t.id === id) as Tracker & { reasonsOf: (d: never, id: string) => unknown }
  expect(by('repos').reasonsOf(WORLD_REPOS as never, `rp:${WORLD_REPOS[0]!.key}`)).toEqual(reasonSet('updated'))
  expect(by('processes').reasonsOf(WORLD_PROCESSES as never, 'bg:1')).toEqual(reasonSet('created'))
  expect(by('auto').reasonsOf(PROOFS as never, 'ag:explore')).toEqual(reasonSet('created'))
})

// ---------------------------------------------------------------- the rows carry the reasons

const flat = (rows: readonly TreeRow[]): TreeRow[] => rows.flatMap(r => [r, ...flat(r.children ?? [])])

test('every item row of the pane carries the reasons of its record', async () => {
  const t = await paneWorld()
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  const byKey = new Map(t.items().map(i => [i.key, i]))
  const rows = sections
    .filter(s => ['prs', 'github', 'jira', 'artifact', 'web', 'file'].includes(s.id))
    .flatMap(s => s.rows)
  expect(rows.length).toBeGreaterThan(10)
  for (const row of rows) expect([row.id, row.reasons]).toEqual([row.id, byKey.get(row.id)?.reasons])
  // The file rows show what the counters hold: made, edited and read, or only read, or made.
  const file = (key: string) => rows.find(r => r.id === key)?.reasons
  expect(why(file('file:/work/docs/spec.md'))).toEqual(['updated', ['updated', 'read'], 'updated'])
  expect(why(file('file:/work/README.md'))).toEqual(['read', ['read'], 'read'])
  expect(why(file('file:/work/plan.md'))).toEqual(['created', ['created'], 'created'])
})

test('an untracked child row has no reasons, and a tracked Jira record drawn under another root shows its own', async () => {
  const t = await paneWorld()
  const jira = (await t.m.paneData(t.w.ports, NO_VIEW)).find(s => s.id === 'jira')!
  const epicId = 'jira:acme.atlassian.net/ISS-1'
  const epic = jira.rows.find(r => r.id === epicId)!
  expect(epic.reasons).toBeDefined()
  expect((epic.children ?? []).length).toBeGreaterThan(0)
  // PROJ-201 is a child node of the epic and a record of its own (#48): it has no root row, and its nested row shows
  // the reasons of that record (#62, R7). PROJ-202 and PROJ-301 are plain child nodes.
  const nodes = flat(epic.children ?? [])
  const tracked = t.items().find(i => i.key === 'jira:acme.atlassian.net/PROJ-201')
  expect(jira.rows.some(r => r.id === tracked?.key)).toBe(false)
  expect(tracked?.reasons).toBeDefined()
  expect(nodes.map(r => [r.id, r.reasons])).toEqual([
    [`${epicId}/PROJ-201`, tracked?.reasons],
    [`${epicId}/PROJ-201/PROJ-301`, undefined],
    [`${epicId}/PROJ-202`, undefined],
  ])
})

test('the rows of repos and processes carry the reasons of their records', async () => {
  const t = await paneWorld()
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  const rowsOf = (id: string) => flat(sections.find(s => s.id === id)?.rows ?? [])
  expect(rowsOf('repos').map(r => why(r.reasons)?.[2])).toEqual(['read', 'updated'])
  expect(rowsOf('processes').map(r => why(r.reasons)?.[2])).toEqual(['created', 'created', 'created'])
})

test('the rows of worktrees and agents carry created for a proof, and none for the root and the master agent', async () => {
  const t = await paneWorld()
  t.w.state.set('auto', {
    ...WORLD_AUTO,
    worktrees: WORLD_SNAPSHOT.worktrees
      .filter(r => r.depth === 1)
      .map(r => ({ path: r.path, origin: 'enter', provenAt: 1 })),
    agents: WORLD_SNAPSHOT.agents
      .filter(r => r.kind !== 'master')
      .map(r => ({ id: r.id.slice(3), kind: r.kind, label: r.label, spawnedAt: 1 })),
  } as never)
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  const rowsOf = (id: string) => flat(sections.find(s => s.id === id)?.rows ?? [])
  const reasonOf = (id: string, rowId: string) => rowsOf(id).find(r => r.id === rowId)?.reasons?.strongest
  expect(reasonOf('worktrees', 'wt:/work')).toBeUndefined()
  expect(reasonOf('worktrees', 'wt:/work/feat-x')).toBe('created')
  expect(reasonOf('agents', 'ag:master')).toBeUndefined()
  expect(reasonOf('agents', 'ag:explore')).toBe('created')
  expect(reasonOf('agents', 'ag:review')).toBe('created') // a nested agent too
})

// ---------------------------------------------------------------- a kind reason that is off is dropped and reported

const kindOf = (category: string, reasons: unknown) =>
  ({
    category,
    rank: 50,
    reasons,
    decode: (i: StoredItem) => (i.category === category ? i : null),
    merge: (cur: StoredItem | null) => cur,
    row: (i: StoredItem) => ({ id: i.key, owner: category, cells: {} }),
  }) as unknown as NonNullable<Tracker['kinds']>[number]

const trackerOf = (id: string, ...kinds: NonNullable<Tracker['kinds']>[number][]): Tracker => ({
  id,
  order: 70,
  config: specOf({ enabled: bool(true) }),
  kinds,
  init: () => {},
  store: ctx => ctx.config.slice(),
})

const build = (...kinds: NonNullable<Tracker['kinds']>[number][]) =>
  fakeItems({ trackers: [...itemTrackers(), trackerOf('extra', ...kinds)] })

const OFF = (word: string) => `reasons: kind review reason "${word}" is not mapped to a core reason. The reason is off.`

test('a kind that declares reasons, each mapped to one core reason, builds with no problem', () => {
  const t = build(
    kindOf('review', [
      { id: 'reviewed', core: 'read' },
      { id: 'approved', core: 'updated' },
    ]),
  )
  expect(t.items.problems()).toEqual([])
})

test('an unmapped kind reason is dropped with a problem, and the mod and the other kinds go on', async () => {
  const t = build(kindOf('review', [{ id: 'reviewed' }, { id: 'approved', core: 'updated' }]))
  expect(t.items.problems()).toEqual([OFF('reviewed')])
  const items = await t.started() // the whole item service starts: nothing threw
  expect(items.ready).toBe(true)
  expect(build(kindOf('review', [{ id: 'reviewed', core: 'seen' }])).items.problems()).toEqual([OFF('reviewed')])
})

test('a repeated kind reason is dropped with a problem, and so is one that means two core reasons in two kinds', () => {
  const twice = [
    { id: 'reviewed', core: 'read' },
    { id: 'reviewed', core: 'read' },
  ]
  expect(build(kindOf('review', twice)).items.problems()).toEqual([
    'reasons: kind review declares reason "reviewed" twice. The reason is off.',
  ])
  const clash = build(
    kindOf('review', [{ id: 'seen', core: 'read' }]),
    kindOf('audit', [{ id: 'seen', core: 'updated' }]),
  )
  expect(clash.items.problems()).toEqual([
    'reasons: kind audit maps "seen" to updated, but kind review maps it to read. The reason is off.',
  ])
  const agree = build(kindOf('review', [{ id: 'seen', core: 'read' }]), kindOf('audit', [{ id: 'seen', core: 'read' }]))
  expect(agree.items.problems()).toEqual([])
})

test('Kinds keeps the words that passed and none that are off, by category', () => {
  const review = kindOf('review', [{ id: 'reviewed' }, { id: 'approved', core: 'updated' }])
  const audit = kindOf('audit', [{ id: 'approved', core: 'created' }])
  const kinds = new Kinds({ trackers: [trackerOf('extra', review, audit)] } as unknown as KindsDeps)
  expect(kinds.kindReasons('review')).toEqual([{ id: 'approved', core: 'updated' }])
  expect(kinds.kindReasons('audit')).toEqual([]) // its only word clashes with the one of review
  expect(kinds.kindReasons('nobody')).toEqual([])
  expect(kinds.problems()).toHaveLength(2)
})

/** A `Kinds` over the kinds of one extra tracker, with the ports of a context inert. */
const kindsOf = (...kinds: NonNullable<Tracker['kinds']>[number][]) =>
  new Kinds({
    trackers: [trackerOf('extra', ...kinds)],
    live: () => true,
    config: { slice: () => ({}), global: () => GLOBAL_DEFAULTS },
    facts: { read: () => undefined },
    host: () => undefined,
    tools: () => undefined,
    items: {},
  } as unknown as KindsDeps)

test('a kind is handed its kept reasons: a word that lost a clash cannot claim its core reason through its own list', () => {
  const review = kindOf('review', [{ id: 'seen', core: 'read' }])
  const audit = kindOf('audit', [
    { id: 'seen', core: 'updated' },
    { id: 'signed', core: 'created' },
  ])
  const kinds = kindsOf(review, audit)
  const ctxOf = (kind: typeof review) => kinds.context(kind, { source: 'prompt', mode: 'full', purpose: 'capture' })
  // The kind that came first keeps the word. The later one lost it, with a problem line, and keeps its other word.
  expect(ctxOf(review).kindReasons).toEqual([{ id: 'seen', core: 'read' }])
  expect(ctxOf(audit).kindReasons).toEqual([{ id: 'signed', core: 'created' }])
  expect(kinds.problems()).toEqual([
    'reasons: kind audit maps "seen" to updated, but kind review maps it to read. The reason is off.',
  ])
  // `kindReason(ctx.kindReasons, …)` is how a kind claims a word: the lost word throws, the kept one maps.
  expect(kindReason(ctxOf(audit).kindReasons, 'signed')).toBe('created')
  expect(() => kindReason(ctxOf(audit).kindReasons, 'seen')).toThrow(/seen/)
  expect(kindReason(ctxOf(review).kindReasons, 'seen')).toBe('read')
  // A context for no kind in particular, and a kind with no word, hold none.
  expect(kinds.plain({ source: 'scan', mode: 'full', purpose: 'lookup' }).kindReasons).toEqual([])
  const plain = kindOf('plain', undefined)
  const own = { source: 'prompt', mode: 'full', purpose: 'capture' } as const
  expect(kindsOf(plain).context(plain, own).kindReasons).toEqual([])
})

test('the help view lists the kind reasons that are off, and the other trackers still track', async () => {
  const w = managerWorld({ extra: [trackerOf('extra', kindOf('review', [{ id: 'reviewed' }]))] })
  await w.m.ensureStarted(w.w.ports)
  expect(w.m.problems()).toEqual([OFF('reviewed')])
  expect(await helpTextOf(w.w.ports, w.m)).toContain(`Problems\n  ${OFF('reviewed')}`)
  await w.m.row(w.w.ports, promptRow('See https://docs.example/a'))
  expect(w.keys()).toEqual(['web:https://docs.example/a'])
})

/**
 * Two kinds that share the word `seen` with two core reasons: `review` keeps it, `audit` loses it. `audit` still calls
 * `kindReason(ctx.kindReasons, 'seen')` when it claims a URL, so its claim throws. Its own URLs are `audit.example`.
 */
const clashKinds = () => {
  const review = kindOf('review', [{ id: 'seen', core: 'read' }])
  const audit = {
    ...kindOf('audit', [{ id: 'seen', core: 'updated' }]),
    claimUrl: (url: string, _label: string | undefined, ctx: KindContext): Claim | null =>
      url.startsWith('https://audit.example/')
        ? {
            category: 'audit',
            key: `audit:${url}`,
            source: ctx.source,
            reason: kindReason(ctx.kindReasons, 'seen'),
            at: ctx.now,
            fields: { url },
          }
        : null,
  } as unknown as NonNullable<Tracker['kinds']>[number]
  return [review, audit] as const
}

test('a kind word that is off cannot stop the text scan: the other kinds still track, and no audit item appears', async () => {
  const w = managerWorld({ extra: [trackerOf('extra', ...clashKinds())] })
  await w.m.ensureStarted(w.w.ports)
  expect(w.m.problems()).toHaveLength(1) // audit lost `seen`
  await w.m.row(w.w.ports, promptRow('See https://docs.example/a and https://audit.example/x'))
  // The claim of audit throws, so audit gives none; its URL does not fall to web; the web claim of the other URL stays.
  expect(w.keys()).toEqual(['web:https://docs.example/a'])
})

test('a kind word that is off does not abort the replay of a transcript', async () => {
  const t = build(...clashKinds())
  const items = await t.started()
  await items.replay(
    transcriptItems([
      { role: 'user', text: 'See https://audit.example/x and issue #5', toolUses: [] },
      { role: 'assistant', text: 'It is in [docs](https://docs.example/a)', toolUses: [] },
    ]),
  )
  expect(t.keys().sort()).toEqual(['gh:github.com/acme/web#5', 'web:https://docs.example/a'])
})

test('the shipped kinds declare no reason of their own, and every one builds with no problem', () => {
  expect(TRACKERS.flatMap(t => t.kinds ?? []).filter(k => k.reasons !== undefined)).toEqual([])
  expect(fakeItems().items.problems()).toEqual([])
})

// ---------------------------------------------------------------- the old store is dropped

test('a stored or carried record with no valid reasons stays out; one with reasons loads', async () => {
  const t = fakeItems()
  const items = await t.started()
  const good = {
    key: 'web:https://good.example/',
    category: 'web',
    url: 'https://good.example/',
    label: 'good',
    sources: ['response'],
    reasons: reasonSet('mentioned'),
    firstSeen: 1,
    lastSeen: 1,
    seenCount: 1,
  }
  const { reasons: _gone, ...before } = { ...good, key: 'web:https://old.example/', url: 'https://old.example/' }
  const odd = { ...good, key: 'web:https://odd.example/', url: 'https://odd.example/', reasons: { first: 'seen' } }
  await items.slot.restore([good, before, odd] as never, 'load')
  expect(t.keys()).toEqual(['web:https://good.example/'])
  await items.slot.clear?.()
  await items.slot.restore([good, before, odd] as never, 'carry')
  expect(t.keys()).toEqual(['web:https://good.example/'])
  const settled = (await items.slot.settle([] as never, [good, before, odd] as never)) as unknown as StoredItem[]
  expect(settled.map(i => i.key)).toEqual(['web:https://good.example/'])
})

// A hot reload keeps `$.state`, so the live list of a build before #62 can reach the new code at the start of a load.
// The same rule holds for it as for a stored copy: a record with no valid reasons stays out, before any merge reads them.
const live = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  category: 'web',
  url: key.slice(4),
  label: 'x',
  sources: ['response'],
  reasons: reasonSet('mentioned'),
  firstSeen: 1,
  lastSeen: 1,
  seenCount: 1,
  ...extra,
})

test('a hot reload: the live list drops a record with no valid reasons at the start, and keeps one with reasons', async () => {
  const t = fakeItems()
  const { reasons: _gone, ...before } = live('web:https://old.example/')
  // An old web row of an artifact URL (R13) would be re-keyed, and so would outlive the drop if the check came after.
  const { reasons: _none, ...oldArtifact } = live('web:https://claude.ai/artifact/D3zR4h4m4W1diV3brT2Mbo')
  const odd = live('web:https://odd.example/', { reasons: { first: 'seen' } })
  t.w.state.set('items', [live('web:https://good.example/'), before, oldArtifact, odd] as never)
  await t.started()
  expect(t.keys()).toEqual(['web:https://good.example/'])
})

test('a hot reload: a live list whose records all have reasons is not written again at the start', async () => {
  const t = fakeItems()
  t.w.state.set('items', [live('web:https://good.example/')] as never)
  await t.items.start(t.hostCtx)
  expect(t.persisted).toEqual([])
  expect(t.keys()).toEqual(['web:https://good.example/'])
})

test('settle: a live record with no valid reasons stays out, like a stored one', async () => {
  const t = fakeItems()
  const items = await t.started()
  const { reasons: _gone, ...before } = live('web:https://old.example/')
  const settled = (await items.slot.settle(
    [live('web:https://live.example/'), before] as never,
    [live('web:https://stored.example/')] as never,
  )) as unknown as StoredItem[]
  expect(settled.map(i => i.key).sort()).toEqual(['web:https://live.example/', 'web:https://stored.example/'])
})
