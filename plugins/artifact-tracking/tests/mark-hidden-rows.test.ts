// Issue #138, review of PR #239 (Codex, P2): a mark ends when its row is gone from the tracker. A rule of the view that only
// leaves the row out (the TTL of an ended row, the row cap, `/track clean --hide`, the filter `t`, a view) does not end it: the
// row comes back with its mark when the rule lets it. The next mark write used to prune by the sections that `paneData` returns,
// and those leave such a row out. These tests run the real manager and the real session, on the world of the pane tests.
import { expect, test } from 'claude-code/testing'
import { NO_VIEW } from '../core/infra/views'
import type { Json } from '../core/interfaces/items'
import { type PaneHost, PaneSession } from '../hooks/pane-session'
import type { WorktreeProof } from '../trackers/auto/types'
import { buttonOf, press, starsOf, texts } from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { flat, MIN, noDockerIssue, proc, proof, setAgents, setProcesses, type World } from './fixtures/hide-world'
import { KEYS, NOW, paneWorld, WORLD_AUTO } from './fixtures/pane-world'

const OLD = 'wt:/work/old-wt' // the removed child of the world
const FEAT = 'wt:/work/feat-x' // a live child: shown by every rule below, and it takes a bulk key (`m` is live on it)

/** A proof that dates the removal of `OLD`. */
const setRemoved = (t: World, removedAt: number): void =>
  void t.w.state.set('auto', {
    ...WORLD_AUTO,
    worktrees: [{ path: '/work/old-wt', origin: 'agent', provenAt: 1, removedAt } satisfies WorktreeProof],
  } as unknown as Json)

/** The pane over the real manager. `pressOn` selects a row (or keeps the selection: null) and presses one Button of a drawing. */
function pane(t: World) {
  const session = new PaneSession()
  const host: PaneHost = t.m
  const draw = () => session.draw(t.w.ports, host, EL, { bodyColumns: 120 })
  const pressOn = async (row: string | null, key: string): Promise<void> => {
    if (row !== null) t.w.state.set('selected', row)
    press(buttonOf(await draw(), key))
    await session.idle()
  }
  return { draw, pressOn }
}

const marksOf = (t: World): unknown => t.w.state.get('marks')
const viewLine = (tree: unknown): string | undefined => texts(tree).find(([, s]) => s.startsWith('View:'))?.[1]
/** The ids of every row that the sections of the pane hold now, a child included. */
const shownIds = async (t: World): Promise<string[]> =>
  (await t.m.paneData(t.w.ports, NO_VIEW)).flatMap(s => flat(s.rows))

test('a mark on a row that the TTL hides stays when another row is marked, and comes back with the row (Codex review of #239)', async () => {
  const t = await paneWorld()
  setRemoved(t, NOW - 11 * MIN) // past removedTtlMs: the row is hidden until `a`
  const { draw, pressOn } = pane(t)
  expect(await shownIds(t)).not.toContain(OLD)

  await pressOn(null, 'show-all') // a: the row shows
  await pressOn(OLD, 'mark')
  expect(marksOf(t)).toEqual([OLD])
  await pressOn(null, 'show-all') // a again: the row is hidden, its mark is not drawn or counted
  expect(marksOf(t)).toEqual([OLD])
  expect(viewLine(await draw())).not.toContain('marked')

  await pressOn(FEAT, 'mark') // the write that pruned the mark of the hidden row
  expect(marksOf(t)).toEqual([OLD, FEAT])
  expect(viewLine(await draw())).toContain('1 marked') // only `FEAT` is drawn

  await pressOn(null, 'show-all') // a: the row is back, with its mark
  const tree = await draw()
  expect(starsOf(tree)).toBe(2)
  expect(viewLine(tree)).toContain('2 marked')
})

// Every rule that leaves a row out of the sections reads `hidden.showAll` (`ViewContext.hidden`). The inventory that the pruning
// reads sets it, so one set of cases covers the TTL of an agent, of a worktree and of a process row, the cap of the process rows
// and the sweep of `/track clean --hide`. A process row takes no bulk key, so `m` is dim on it: its mark comes from a write of
// the atom, not from `m`.
const RULES: { rule: string; hidden: string; world: () => Promise<World> }[] = [
  {
    rule: 'the TTL of a removed worktree',
    hidden: OLD,
    world: async () => {
      const t = await paneWorld()
      setRemoved(t, NOW - 11 * MIN)
      return t
    },
  },
  {
    rule: 'the TTL of an ended agent',
    hidden: 'ag:review',
    world: async () => {
      const t = await paneWorld()
      setAgents(t, [proof('review', { endedAt: NOW - 11 * MIN })])
      t.w.state.set('expanded', ['ag:explore']) // `ag:review` is a child of `ag:explore`: open it so the row is drawn
      return t
    },
  },
  {
    rule: 'the TTL of an ended process row',
    hidden: 'bg:done',
    world: async () => {
      const t = await paneWorld()
      noDockerIssue(t)
      setProcesses(t, [proc('bg:live', 'running'), proc('bg:done', 'completed', { endedAt: NOW - 31 * MIN })])
      return t
    },
  },
  {
    rule: 'the row cap of the process rows',
    hidden: 'done0',
    world: async () => {
      const t = await paneWorld({ config: { processes: { maxRows: 20 } } })
      noDockerIssue(t)
      // 25 rows that ended inside the TTL, `done0` the oldest end: the cap takes it first.
      setProcesses(
        t,
        Array.from({ length: 25 }, (_, i) =>
          proc(`done${i}`, 'completed', { firstSeen: 1000 + i * 1000, endedAt: NOW - (30 - i) * 1000 }),
        ),
      )
      return t
    },
  },
  {
    rule: '/track clean --hide',
    hidden: OLD,
    world: async () => {
      const t = await paneWorld()
      t.w.state.set('hidden', { showAll: false, before: NOW }) // the sweep: every ended row goes, whatever its TTL
      return t
    },
  },
]

for (const { rule, hidden, world } of RULES) {
  test(`${rule} hides a marked row: the next mark write keeps its mark, and a shows the row marked`, async () => {
    const t = await world()
    t.w.state.set('marks', [hidden])
    const { draw, pressOn } = pane(t)
    expect(await shownIds(t), 'the rule hides the row').not.toContain(hidden)
    expect(starsOf(await draw())).toBe(0)

    await pressOn(FEAT, 'mark')
    expect(marksOf(t)).toEqual([hidden, FEAT])

    await pressOn(null, 'show-all') // a
    const tree = await draw()
    expect(starsOf(tree)).toBe(2)
    expect(viewLine(tree)).toContain('2 marked')
  })
}

test('a mark of a row that is gone from the tracker still ends with the next mark write', async () => {
  const t = await paneWorld()
  setRemoved(t, NOW - 11 * MIN)
  t.w.state.set('marks', [OLD, 'wt:/work/never-was'])
  const { pressOn } = pane(t)
  await pressOn(FEAT, 'mark')
  expect(marksOf(t)).toEqual([OLD, FEAT]) // `OLD` is hidden, not gone; the other row was never held
})

test('a dismissed row is gone from the tracker: its mark ends with the next mark write', async () => {
  const t = await paneWorld()
  t.w.state.set('marks', [KEYS.web])
  const { pressOn } = pane(t)
  await t.m.dismiss(t.w.ports, [KEYS.web])
  expect(await shownIds(t)).not.toContain(KEYS.web)
  await pressOn(FEAT, 'mark')
  expect(marksOf(t)).toEqual([FEAT])
})

// The filter `t`, the view `g` and the caps of the table act on the groups that the pane draws, after the sections are read.
// The pruning reads the sections, so none of them can end a mark. A pass here pins that: a change that reads the groups, as the
// first version of the pruning read `paneData` through a rule of the view, fails it.
test('the filter t and each view leave the marks of the rows they hide alone', async () => {
  for (const view of ['list', 'tracker', 'status', 'reason', 'flat'] as const) {
    const t = await paneWorld()
    t.w.state.set('marks', [KEYS.head]) // a PR that the lane found and the session never touched: `t` leaves it out
    await t.w.ports.state.view.update(() => view)
    await t.w.ports.state.filters.update(() => ({ touchedOnly: true }))
    const { draw, pressOn } = pane(t)
    expect(viewLine(await draw()), view).toMatch(/touched only · [1-9]\d* hidden/) // `t` hides rows, the head PR among them
    await pressOn(FEAT, 'mark')
    expect(marksOf(t), view).toEqual([KEYS.head, FEAT])
  }
})
