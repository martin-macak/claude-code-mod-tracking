// Parity of the sections with the legacy composers (plan L5, Task 14; decision K12). The legacy draw path (hooks/ui/*)
// still draws the pane, the band and the `/track` text from records until L6 swaps it. This test builds one world and
// reads it through both paths: the sections of the trackers (`paneData`, `bandData`) and `viewInputs` with the legacy
// composers. The texts, the rows, the notes and the band must be equal, so L6 can swap the renderers with no change in
// bytes. A failure here is a bug in a section, never in the legacy composer or in this test.
import { expect, test } from 'claude-code/testing'
import { NO_VIEW } from '../core/infra/views'
import type { Json } from '../core/interfaces/items'
import type { Cell, SectionSpec, TreeRow } from '../core/interfaces/view'
import { markerOf } from '../core/lib/levels'
import type { Tone } from '../core/lib/rows'
import { composeBand, composeCommandText, composePane } from '../hooks/ui/auto-view'
import type { PaneSection } from '../hooks/ui/view'
import { viewInputs } from '../hooks/view-inputs'
import {
  NOW,
  paneItems,
  paneWorld,
  setBranches,
  WORLD_AUTO,
  WORLD_BRANCHES,
  WORLD_SNAPSHOT,
} from './fixtures/pane-world'
import { sectionsText } from './fixtures/section-text'

type World = Awaited<ReturnType<typeof paneWorld>>

/** The row of a section or of the legacy pane, as one comparable tuple. */
type Line = [
  string,
  number,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  boolean,
  boolean,
  boolean,
  Tone,
  Tone,
]

async function legacyOf(t: World) {
  return viewInputs(t.w.ports, t.m.facts, { live: id => t.m.live(id) })
}

function legacySections(v: Awaited<ReturnType<typeof legacyOf>>): PaneSection[] {
  // The `/track` text draws with nothing folded.
  return composePane(v.items, v.processes, v.processUi, { ...v.ctx, folded: [] }, v.repos)
}

/** The tone of a cell, from its color token (plan L6 A1: `ok` is `success`, `warn` is `warning`, `bad` is `error`). */
const toneOf = (c: Cell | undefined): Tone =>
  c?.dim ? 'dim' : c?.fg === 'success' ? 'ok' : c?.fg === 'warning' ? 'warn' : c?.fg === 'error' ? 'bad' : 'plain'

const legacyLines = (s: PaneSection): Line[] =>
  s.rows.map(r => [
    r.id,
    r.depth,
    r.key,
    r.title,
    r.type,
    r.status,
    r.extra ?? '',
    r.mark ?? '',
    markerOf(r.prio?.level),
    r.dim === true,
    r.dismissId !== undefined,
    r.prio !== undefined,
    r.tone,
    r.extraTone ?? 'plain',
  ])

/** The rows of a section with their children after them, each with its depth. */
function newLines(s: SectionSpec): Line[] {
  const out: Line[] = []
  const walk = (rows: readonly TreeRow[], depth: number): void => {
    for (const r of rows) {
      const text = (id: string): string => r.cells[id]?.text ?? ''
      out.push([
        r.id,
        depth,
        text('key'),
        text('title'),
        text('type'),
        text('status'),
        text('extra'),
        text('mark'),
        text('prio'),
        r.dim === true,
        r.can?.dismiss === true,
        r.can?.priority === true,
        toneOf(r.cells.status),
        toneOf(r.cells.extra),
      ])
      walk(r.children ?? [], depth + 1)
    }
  }
  walk(s.rows, 0)
  return out
}

/** `Jira 6`, `GitHub 4 (1 ✗)`: the band the sections give, as the legacy band prints it. A zero count is left out. */
function bandText(band: readonly SectionSpec[]): string | null {
  const parts = band.flatMap(s =>
    s.band && s.band.count > 0
      ? [`${s.band.label} ${s.band.count}${s.band.failing > 0 ? ` (${s.band.failing} ✗)` : ''}`]
      : [],
  )
  return parts.length > 0 ? parts.join(' · ') : null
}

/** The three comparisons, over any world. */
async function expectParity(t: World): Promise<void> {
  const v = await legacyOf(t)
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  const legacy = legacySections(v)
  expect(sectionsText(sections)).toBe(composeCommandText(v.items, v.processes, v.processUi, v.ctx, v.repos))
  expect(sections.map(s => [s.id, s.title, s.note?.text])).toEqual(legacy.map(s => [s.id, s.title, s.note]))
  for (const s of legacy) expect(newLines(sections.find(x => x.id === s.id)!)).toEqual(legacyLines(s))
  expect(bandText(await t.m.bandData(t.w.ports))).toBe(composeBand(v.items, v.processes, v.ctx.auto ?? null, v.repos))
}

test('parity: the /track text of the sections equals the legacy text', async () => {
  const t = await paneWorld()
  const v = await legacyOf(t)
  const text = sectionsText(await t.m.paneData(t.w.ports, NO_VIEW))
  expect(text).toBe(composeCommandText(v.items, v.processes, v.processUi, v.ctx, v.repos))
  // The world draws every section, so the text is not trivially equal.
  for (const title of [
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
    expect(text).toContain(`${title}  `)
  expect(text.split('\n').length).toBeGreaterThan(50)
})

test('parity: every row matches the legacy row', async () => {
  const t = await paneWorld()
  const v = await legacyOf(t)
  const sections = await t.m.paneData(t.w.ports, NO_VIEW)
  const legacy = legacySections(v)
  // The same sections, with the same ids, titles and notes, in the same order.
  expect(sections.map(s => [s.id, s.title, s.note?.text])).toEqual(legacy.map(s => [s.id, s.title, s.note]))
  expect(sections).toHaveLength(10)
  let rows = 0
  for (const s of legacy) {
    const got = newLines(sections.find(x => x.id === s.id)!)
    expect(got).toEqual(legacyLines(s))
    rows += got.length
  }
  expect(rows).toBeGreaterThan(35)
})

test('parity: the band of the sections equals the legacy band', async () => {
  const t = await paneWorld()
  const v = await legacyOf(t)
  const band = bandText(await t.m.bandData(t.w.ports))
  expect(band).toBe(composeBand(v.items, v.processes, v.ctx.auto ?? null, v.repos))
  expect(band).toBe(
    'Jira 4 · GitHub 7 · Artifacts 2 · Links 2 · Files 3 · Repos 2 · Worktrees 2 · Agents 2 · PRs 3 (1 ✗) · Processes 3 (1 ✗)',
  )
})

/** A tracker that is off publishes no fact. The world seeds them all, so a world with a tracker off withdraws its facts. */
async function worldWithOff(off: readonly string[]): Promise<World> {
  const t = await paneWorld({ off })
  if (off.includes('processes')) t.m.facts.publish('processes.ui', undefined)
  if (off.includes('auto')) {
    for (const fact of ['auto.root', 'auto.branches', 'auto.checkedAt']) t.m.facts.publish(fact, undefined)
    t.w.state.delete('github') // no round, so no PR lane ran: it has no default branch either
  }
  return t
}

test('parity: a world with a tracker off', async () => {
  for (const off of [
    ['repos'],
    ['processes'],
    ['github'],
    ['jira', 'artifact', 'file'],
    ['repos', 'processes'],
    ['auto'],
  ])
    await expectParity(await worldWithOff(off))
})

test('parity: the Pull requests note for a failed discovery, a skip, and branches over the cap', async () => {
  const t = await paneWorld()
  const lanes = [
    { prs: { ok: false, error: 'boom', at: NOW }, defaultBranch: 'main' },
    { prs: { ok: false, skipped: 'no-gh' } },
    { prs: { ok: false, skipped: 'not-logged-in' } },
    { prs: { ok: false, skipped: 'host-not-authed' }, defaultBranch: 'main' },
    { prs: { ok: false, skipped: 'no-repo' } },
    { prs: { ok: true, at: NOW - 5000, untracked: 3 }, defaultBranch: 'develop' },
  ]
  for (const overflow of [0, 4]) {
    t.w.state.set('auto', { ...WORLD_AUTO, snapshot: { ...WORLD_SNAPSHOT, overflow } } as unknown as Json)
    setBranches(t.m, { current: 'feat/x', branches: WORLD_BRANCHES, overflow })
    for (const lane of lanes) {
      t.w.state.set('github', lane as unknown as Json)
      await expectParity(t)
    }
  }
})

test('parity: the not-logged-in note names the host of the session repo: a GHE host, and github.com with none', async () => {
  const t = await paneWorld() // its session repo is on github.com
  const note = async () => (await t.m.paneData(t.w.ports, NO_VIEW)).find(s => s.id === 'prs')?.note?.text
  const hosts: [Json | undefined, string][] = [
    [{ host: 'ghe.acme.io', owner: 'acme', repo: 'web' }, 'ghe.acme.io'],
    [{ host: 'github.com', owner: 'acme', repo: 'web' }, 'github.com'],
    [undefined, 'github.com'], // not looked up yet
  ]
  for (const [repo, host] of hosts) {
    t.m.facts.publish('session.repo', repo)
    for (const skipped of ['not-logged-in', 'host-not-authed']) {
      t.w.state.set('github', { prs: { ok: false, skipped }, defaultBranch: 'main' } as unknown as Json)
      await expectParity(t)
      expect(await note()).toBe(`gh not logged in to ${host}`)
    }
  }
})

test('parity: a lane that skipped shows its note on top of an empty section, only with branches to poll', async () => {
  const t = await paneWorld()
  const items = paneItems().filter(i => !(i.sources as string[]).includes('auto'))
  t.w.state.set('items', items as unknown as Json)
  for (const skipped of ['no-gh', 'not-logged-in', 'paused', 'host-not-authed', 'no-repo']) {
    t.w.state.set('github', { prs: { ok: false, skipped } } as unknown as Json)
    await expectParity(t)
  }
  t.w.state.set('github', { prs: { ok: false, error: 'boom' } } as unknown as Json)
  await expectParity(t)
  t.w.state.set('auto', { ...WORLD_AUTO, snapshot: { ...WORLD_SNAPSHOT, branches: [] } } as unknown as Json)
  setBranches(t.m, { current: 'feat/x', branches: [] })
  await expectParity(t)
})

test('parity: the auto sections for a failed git, a failed agent list and no child worktree', async () => {
  const t = await paneWorld()
  const variants = [
    { ...WORLD_SNAPSHOT, git: { ok: false, at: NOW, error: 'fatal: no repo' } },
    { ...WORLD_SNAPSHOT, agentList: { ok: false, at: NOW, error: 'x' } },
    { ...WORLD_SNAPSHOT, worktrees: WORLD_SNAPSHOT.worktrees.slice(0, 1) },
    { ...WORLD_SNAPSHOT, worktrees: WORLD_SNAPSHOT.worktrees.filter(w => w.state === 'removed' || w.depth === 0) },
    { ...WORLD_SNAPSHOT, agents: WORLD_SNAPSHOT.agents.slice(0, 1) },
  ]
  for (const snapshot of variants) {
    t.w.state.set('auto', { ...WORLD_AUTO, snapshot } as unknown as Json)
    await expectParity(t)
  }
  t.m.facts.publish('auto.checkedAt', undefined)
  await expectParity(t)
  t.m.facts.publish('auto.checkedAt', NOW) // a round that ran this very instant
  await expectParity(t)
})

test('parity: a world with nothing tracked', async () => {
  const t = await paneWorld()
  for (const slot of ['items', 'repos', 'processes', 'github']) t.w.state.delete(slot)
  t.w.state.set('auto', { ...WORLD_AUTO, snapshot: null } as unknown as Json)
  t.m.facts.publish('processes.ui', { breaker: 'closed' })
  const v = await legacyOf(t)
  expect(sectionsText(await t.m.paneData(t.w.ports, NO_VIEW))).toBe('No tracked items yet.')
  await expectParity(t)
  expect(composeBand(v.items, v.processes, v.ctx.auto ?? null, v.repos)).toBeNull()
  expect(bandText(await t.m.bandData(t.w.ports))).toBeNull()
})

test('parity: the docker issue alone draws a Processes note and no band part', async () => {
  const t = await paneWorld()
  t.w.state.set('processes', [] as unknown as Json)
  await expectParity(t)
})

// The one place in which the two paths differ. The legacy composers put Repos before Web links, and after the last item
// section when there are no web links. The sections place Repos by its rank (50): after Artifacts and before Web links
// and Files, as L6 A2 lists the pane. No person sees it before L6 swaps the renderers.
test('parity: Repos sits by its rank, not after the last item section, when there are no web links', async () => {
  const t = await paneWorld()
  t.w.state.set('items', paneItems().filter(i => i.category !== 'web') as unknown as Json)
  const v = await legacyOf(t)
  const legacy = legacySections(v).map(s => s.id)
  const sections = (await t.m.paneData(t.w.ports, NO_VIEW)).map(s => s.id)
  expect(legacy).toEqual(['worktrees', 'agents', 'prs', 'jira', 'github', 'artifact', 'file', 'repos', 'processes'])
  expect(sections).toEqual(['worktrees', 'agents', 'prs', 'jira', 'github', 'artifact', 'repos', 'file', 'processes'])
  // Apart from the place, the sections are the same.
  const all = await t.m.paneData(t.w.ports, NO_VIEW)
  for (const s of legacySections(v)) expect(newLines(all.find(x => x.id === s.id)!)).toEqual(legacyLines(s))
  expect(bandText(await t.m.bandData(t.w.ports))).toBe(composeBand(v.items, v.processes, v.ctx.auto ?? null, v.repos))
})
