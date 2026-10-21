// The resolve and files keys of the github tracker (issue #50, P2 and P3), through a LifecycleManager over fakePorts: the
// footer states, the press, the prompt, the queued state, and the git calls behind the files key.
import { expect, test } from 'claude-code/testing'
import type { Json } from '../core/interfaces/items'
import type { RunResult } from '../core/interfaces/ports'
import type { RowRef } from '../core/interfaces/view'
import { githubTracker } from '../trackers/github'
import type { LaneState, MergeNote } from '../trackers/github/types'
import { res, until } from './fixtures/items'
import { managerWorld } from './fixtures/manager'
import { LANE, named } from './fixtures/reasons'

const NOW = 1_000_000
const K7 = 'gh:github.com/acme/web#7'
const K5 = 'gh:github.com/acme/web#5'
const OID = '3ee957a877544efaf8eea208694fdcd92da716bc'

const pr = (over: Record<string, unknown> = {}) => ({
  key: K7,
  category: 'github',
  url: 'https://github.com/acme/web/pull/7',
  label: 'acme/web#7',
  ...LANE,
  firstSeen: 1,
  lastSeen: 1,
  seenCount: 0,
  host: 'github.com',
  owner: 'acme',
  repo: 'web',
  number: 7,
  type: 'pr',
  title: 'PR 7',
  state: 'open',
  checks: 'success',
  mergeable: 'CONFLICTING',
  mergeStateStatus: 'DIRTY',
  headRefName: 'feat/a',
  baseRefName: 'main',
  refreshedAt: NOW,
  ...over,
})
const issue = () => ({
  ...named(pr({ key: K5, number: 5, type: 'issue', url: 'https://github.com/acme/web/issues/5' })),
  mergeable: undefined,
})

const lane = (merge: Record<string, MergeNote> | undefined, over: Partial<LaneState> = {}): LaneState => ({
  prs: { ok: true },
  defaultBranch: 'main',
  ...(merge !== undefined ? { merge } : {}),
  ...over,
})

const WT = { worktree: '/x/wt-a' }
const ROW = (id = K7): RowRef => ({ id, owner: 'github', group: 'prs', can: { dismiss: true, priority: true } })

type Setup = {
  items?: object[]
  state?: LaneState
  run?: (argv: string[]) => RunResult | undefined | Promise<RunResult | undefined>
}

async function setup(o: Setup = {}) {
  const t = managerWorld({
    trackers: () => [githubTracker()],
    fake: { now: NOW, session: { cwd: '/work' } },
    run: async argv => o.run?.(argv),
  })
  t.w.state.set('items', (o.items ?? [pr()]) as unknown as Json)
  t.w.state.set('github', (o.state ?? lane({ [K7]: WT })) as unknown as Json)
  await t.m.start(t.w.ports, { cwd: '/work', fromSessionStart: true })
  return t
}

const laneState = (t: Awaited<ReturnType<typeof setup>>) => t.w.state.get('github') as unknown as LaneState
const footer = async (t: Awaited<ReturnType<typeof setup>>, id = K7) =>
  Object.fromEntries((await t.m.footer(t.w.ports, ROW(id), false)).map(k => [k.buttonKey, k.enabled]))

// ---------------------------------------------------------------- the keys

test('the github tracker declares the resolve key (c) and the files key (f), and no key is taken', async () => {
  const t = await setup()
  expect(githubTracker().keys).toEqual([
    { id: 'resolve', key: 'c', label: 'resolve', scope: 'row' },
    { id: 'files', key: 'f', label: 'files', scope: 'row' },
  ])
  expect(t.m.problems()).toEqual([])
  expect(t.m.keys.get('github.resolve')).toMatchObject({ key: 'c', owner: 'github', scope: 'row' })
})

test('a github row selected: resolve and files work for a conflicted PR, and not for an issue', async () => {
  const t = await setup({ items: [pr(), issue()] })
  expect(await footer(t, K7)).toMatchObject({ 'github.resolve': true, 'github.files': true })
  expect(await footer(t, K5)).toMatchObject({ 'github.resolve': false, 'github.files': false })
})

test('AC10: with no local worktree the resolve key is off and the files key stays on', async () => {
  const t = await setup({ state: lane({ [K7]: {} }) })
  expect(await footer(t)).toMatchObject({ 'github.resolve': false, 'github.files': true })
})

test('the resolve key is off for a PR that does not conflict, one that is not open, and one the lane has no note on', async () => {
  for (const [items, state] of [
    [[pr({ mergeable: 'MERGEABLE' })], lane({})],
    [[pr({ state: 'merged' })], lane({ [K7]: WT })],
    [[pr()], lane(undefined)],
  ] as const) {
    const t = await setup({ items: [...items], state })
    expect(await footer(t)).toMatchObject({ 'github.resolve': false, 'github.files': false })
  }
})

test('AC9: the resolve key is off while the PR is queued', async () => {
  const t = await setup({ state: lane({ [K7]: { ...WT, queuedAt: NOW - 1 } }) })
  expect(await footer(t)).toMatchObject({ 'github.resolve': false })
})

test('AC11: with gh logged out the resolve and files keys are off', async () => {
  const t = await setup()
  t.w.state.set('tools', { gh: { name: 'gh', available: true, loggedIn: false, breaker: 'closed' } } as unknown as Json)
  expect(await footer(t)).toMatchObject({ 'github.resolve': false, 'github.files': false })
})

// ---------------------------------------------------------------- resolve

test('AC8: a press sends one prompt filled from the record, marks the PR queued and says so in a toast', async () => {
  const t = await setup()
  await t.m.runAction(t.w.ports, 'github', 'resolve', K7)
  expect(t.w.prompts).toHaveLength(1)
  const text = t.w.prompts[0]!
  expect(text).toContain('Resolve the merge conflicts on PR #7 (https://github.com/acme/web/pull/7).')
  expect(text).toContain('Head branch: feat/a. Base branch: main. Worktree: /x/wt-a.')
  expect(text).toContain('Ask me before you push')
  expect(laneState(t).merge?.[K7]?.queuedAt).toBe(NOW)
  expect(laneState(t).merge?.[K7]?.worktree).toBe('/x/wt-a') // the note keeps what the lane found
  expect(t.w.ui.toasts).toEqual(['Resolve prompt sent'])
})

test('AC8: the row reads queued after the press', async () => {
  const t = await setup()
  await t.m.runAction(t.w.ports, 'github', 'resolve', K7)
  const prs = (await t.m.paneData(t.w.ports, { selected: null, expanded: new Set() })).find(s => s.id === 'prs')!
  expect(prs.rows[0]?.extras?.[0]?.text).toBe('queued')
})

test('AC9: a second press sends no second prompt, also when two presses race', async () => {
  const t = await setup()
  await t.m.runAction(t.w.ports, 'github', 'resolve', K7)
  await t.m.runAction(t.w.ports, 'github', 'resolve', K7)
  expect(t.w.prompts).toHaveLength(1)
  const racing = await setup()
  await Promise.all([
    racing.m.runAction(racing.w.ports, 'github', 'resolve', K7),
    racing.m.runAction(racing.w.ports, 'github', 'resolve', K7),
  ])
  expect(racing.w.prompts).toHaveLength(1)
})

test('after ten minutes a press sends the prompt again', async () => {
  const t = await setup({ state: lane({ [K7]: { ...WT, queuedAt: NOW - 600_000 } }) })
  await t.m.runAction(t.w.ports, 'github', 'resolve', K7)
  expect(t.w.prompts).toHaveLength(1)
  expect(laneState(t).merge?.[K7]?.queuedAt).toBe(NOW)
})

test('AC10 race guard: a press that finds the key off after the footer drew it on sends nothing and says why in a toast', async () => {
  // The footer draws an off key dim and inert, so a person never gets this toast. A press that raced a step still must not
  // send a prompt: the check runs again at the press. The person reads the reason in the hint of the row (review m2).
  const t = await setup({ state: lane({ [K7]: {} }) })
  await t.m.runAction(t.w.ports, 'github', 'resolve', K7)
  expect(t.w.prompts).toEqual([])
  expect(t.w.ui.toasts).toEqual(['resolve: no local worktree has the branch feat/a'])
  expect(laneState(t).merge?.[K7]?.queuedAt).toBeUndefined()
})

test('m3: a prompt that a hook refuses is taken back: the row stops reading queued, a toast says so, and a press may try again', async () => {
  const t = await setup()
  t.w.promptRefusal = 'blocked by a hook'
  await t.m.runAction(t.w.ports, 'github', 'resolve', K7)
  await until(() => laneState(t).merge?.[K7]?.queuedAt === undefined, 'the note without queuedAt')
  expect(t.w.ui.toasts).toEqual(['Resolve prompt sent', 'Resolve prompt refused: blocked by a hook'])
  expect(laneState(t).merge?.[K7]?.worktree).toBe('/x/wt-a') // only the press is taken back
  const prs = (await t.m.paneData(t.w.ports, { selected: null, expanded: new Set() })).find(s => s.id === 'prs')!
  expect(prs.rows[0]?.extras?.[0]?.text).toBe('✗ conflicts')
  t.w.promptRefusal = undefined
  await t.m.runAction(t.w.ports, 'github', 'resolve', K7)
  expect(t.w.prompts).toHaveLength(2)
  expect(laneState(t).merge?.[K7]?.queuedAt).toBe(NOW)
})

/** A press whose refusal the test holds back until it calls the returned function. */
async function heldRefusal() {
  let refuse: (why: string) => void = () => {}
  const gate = new Promise<string>(resolve => {
    refuse = resolve
  })
  const t = await setup()
  t.w.promptRefusal = gate
  await t.m.runAction(t.w.ports, 'github', 'resolve', K7)
  const change = (patch: (s: LaneState) => LaneState) =>
    t.w.ports.state.slot.update('github', cur => patch(cur as unknown as LaneState) as unknown as Json)
  return { t, refuse, change }
}

test('m3: a refusal that arrives after a newer press takes nothing back', async () => {
  const { t, refuse, change } = await heldRefusal()
  await change(s => ({ ...s, merge: { [K7]: { ...WT, queuedAt: NOW + 5 } } }))
  refuse('too late')
  await until(() => t.w.ui.toasts.length === 2, 'the refusal toast')
  expect(laneState(t).merge?.[K7]?.queuedAt).toBe(NOW + 5)
})

test('m3: a refusal that arrives after the PR stopped conflicting does not bring a note back', async () => {
  const { t, refuse, change } = await heldRefusal()
  await change(s => ({ ...s, merge: undefined }))
  refuse('too late')
  await until(() => t.w.ui.toasts.length === 2, 'the refusal toast')
  expect(laneState(t).merge).toBeUndefined()
})

test('M3: a fork PR whose head name is a local worktree branch has both keys off and a press sends and runs nothing', async () => {
  // The note holds a worktree on purpose: the check refuses a fork PR whatever the note says.
  const t = await setup({ items: [pr({ headRefName: 'main', crossRepo: true })], state: lane({ [K7]: WT }) })
  expect(await footer(t)).toMatchObject({ 'github.resolve': false, 'github.files': false })
  await t.m.runAction(t.w.ports, 'github', 'resolve', K7)
  await t.m.runAction(t.w.ports, 'github', 'files', K7)
  expect(t.w.prompts).toEqual([])
  expect(t.w.calls.filter(c => c[0] === 'git')).toEqual([])
  expect(t.w.ui.toasts).toEqual([
    'resolve: the head branch is in a fork, not in this repo',
    'files: the head branch is in a fork, not in this repo',
  ])
  const prs = (await t.m.paneData(t.w.ports, { selected: null, expanded: new Set() })).find(s => s.id === 'prs')!
  expect(prs.rows[0]?.extras?.at(-1)).toEqual({ text: 'fork PR', dim: true }) // where a person reads why
})

test('n2: the keys also work with a file row selected under the PR, and the note is the PR note', async () => {
  const FILE = `${K7}#files:0`
  const t = await setup({ run: GIT_OK(['src/a.ts']) })
  expect(await footer(t, FILE)).toMatchObject({ 'github.resolve': true, 'github.files': true })
  await t.m.runAction(t.w.ports, 'github', 'resolve', FILE)
  expect(t.w.prompts).toHaveLength(1)
  expect(laneState(t).merge?.[K7]?.queuedAt).toBe(NOW)
  expect(Object.keys(laneState(t).merge ?? {})).toEqual([K7]) // no note under the id of the file row
  await t.m.runAction(t.w.ports, 'github', 'files', FILE)
  expect(laneState(t).merge?.[K7]?.files).toEqual({ at: NOW, files: ['src/a.ts'] })
  expect(Object.keys(laneState(t).merge ?? {})).toEqual([K7])
})

test('a press on no row, on an issue and on an unknown key does nothing', async () => {
  const t = await setup({ items: [pr(), issue()] })
  await t.m.runAction(t.w.ports, 'github', 'resolve', null)
  await t.m.runAction(t.w.ports, 'github', 'resolve', K5)
  await t.m.runAction(t.w.ports, 'github', 'resolve', 'gh:github.com/acme/web#404')
  expect(t.w.prompts).toEqual([])
})

test('a stacked PR sends the prompt with the stack note and the default branch of the lane', async () => {
  const t = await setup({
    items: [pr({ baseRefName: 'fix/stack-base' })],
    state: lane({ [K7]: WT }, { defaultBranch: 'develop' }),
  })
  await t.m.runAction(t.w.ports, 'github', 'resolve', K7)
  expect(t.w.prompts[0]).toContain("Base branch: fix/stack-base (stacked: it targets another PR's branch).")
  expect(t.w.prompts[0]).toContain('rebase onto origin/develop')
})

test('the prompt never carries an unsafe branch name: the press is refused', async () => {
  const t = await setup({ items: [pr({ headRefName: 'feat/x"; rm -rf /' })] })
  await t.m.runAction(t.w.ports, 'github', 'resolve', K7)
  expect(t.w.prompts).toEqual([])
  expect(t.w.ui.toasts).toEqual(['resolve: the branch name has a character that is not put in a prompt'])
})

// ---------------------------------------------------------------- files

const GIT_OK = (files: string[]) => async (argv: string[]) =>
  argv[0] === 'git' && argv[1] === 'fetch'
    ? res()
    : argv[0] === 'git' && argv[1] === 'merge-tree'
      ? res(`${OID}\0${files.join('\0')}\0`, 1)
      : undefined

test('the files key fetches the two refs and runs merge-tree in the worktree, then lists the files in the note', async () => {
  const t = await setup({ run: GIT_OK(['src/a.ts', 'src/b.ts']) })
  await t.m.runAction(t.w.ports, 'github', 'files', K7)
  const git = t.w.calls.map((argv, i) => ({ argv, opts: t.w.callOpts[i] })).filter(c => c.argv[0] === 'git')
  expect(git.map(c => c.argv[1])).toEqual(['fetch', 'merge-tree'])
  expect(git.every(c => c.opts?.cwd === '/x/wt-a')).toBe(true)
  expect(git.every(c => c.opts?.timeoutMs === 5000)).toBe(true) // trackers.github.gitTimeoutMs
  expect(laneState(t).merge?.[K7]?.files).toEqual({ at: NOW, files: ['src/a.ts', 'src/b.ts'] })
  const prs = (await t.m.paneData(t.w.ports, { selected: null, expanded: new Set() })).find(s => s.id === 'prs')!
  expect(prs.rows[0]?.children?.map(c => c.cells.description?.text)).toEqual(['src/a.ts', 'src/b.ts'])
})

test('the files key with no worktree runs in the session folder', async () => {
  const t = await setup({ state: lane({ [K7]: {} }), run: GIT_OK(['a.ts']) })
  await t.m.runAction(t.w.ports, 'github', 'files', K7)
  const cwds = t.w.calls.flatMap((argv, i) => (argv[0] === 'git' ? [t.w.callOpts[i]?.cwd] : []))
  expect(cwds).toEqual(['/work', '/work'])
  expect(laneState(t).merge?.[K7]?.files).toEqual({ at: NOW, files: ['a.ts'] })
})

test('the files key marks the look pending while git runs, and a second press waits for it', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const t = await setup({
    run: async argv => {
      if (argv[0] === 'git' && argv[1] === 'fetch') {
        await gate
        return res()
      }
      return GIT_OK(['a.ts'])(argv)
    },
  })
  const first = t.m.runAction(t.w.ports, 'github', 'files', K7)
  await until(() => laneState(t).merge?.[K7]?.files?.pending === true, 'the pending mark')
  expect(await footer(t)).toMatchObject({ 'github.files': false })
  await t.m.runAction(t.w.ports, 'github', 'files', K7) // refused: a look is under way
  expect(t.w.calls.filter(c => c[0] === 'git' && c[1] === 'fetch')).toHaveLength(1)
  release()
  await first
  expect(laneState(t).merge?.[K7]?.files).toEqual({ at: NOW, files: ['a.ts'] })
  expect(await footer(t)).toMatchObject({ 'github.files': true })
})

test('a failed fetch lands in the note as the reason, and the PR stays resolvable', async () => {
  const t = await setup({ run: async argv => (argv[1] === 'fetch' ? res('', 128, 'fatal: no remote') : undefined) })
  await t.m.runAction(t.w.ports, 'github', 'files', K7)
  expect(laneState(t).merge?.[K7]?.files).toEqual({ at: NOW, error: 'git fetch failed: fatal: no remote' })
  expect(await footer(t)).toMatchObject({ 'github.resolve': true })
})

test('a PR that stops conflicting while git runs gets no files note', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const t = await setup({
    run: async argv => {
      if (argv[1] === 'fetch') await gate
      return GIT_OK(['a.ts'])(argv)
    },
  })
  const press = t.m.runAction(t.w.ports, 'github', 'files', K7)
  await until(() => laneState(t).merge?.[K7]?.files?.pending === true, 'the pending mark')
  await t.w.ports.state.slot.update(
    'github',
    cur => ({ ...(cur as unknown as LaneState), merge: undefined }) as unknown as Json,
  )
  release()
  await press
  expect(laneState(t).merge).toBeUndefined()
})

test('a files press on an issue, no row, or a PR that is not conflicting runs no git', async () => {
  const t = await setup({ items: [pr({ mergeable: 'MERGEABLE' }), issue()], state: lane({}) })
  await t.m.runAction(t.w.ports, 'github', 'files', null)
  await t.m.runAction(t.w.ports, 'github', 'files', K5)
  await t.m.runAction(t.w.ports, 'github', 'files', K7)
  expect(t.w.calls.filter(c => c[0] === 'git')).toEqual([])
})
