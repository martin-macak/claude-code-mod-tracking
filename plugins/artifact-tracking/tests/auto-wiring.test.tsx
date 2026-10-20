// Kit tests of the auto-tracking wiring (spec 13.3). Stubs sit beneath the mod.
// The kit raises `agent.spawn` and `turn.complete`, but `$.tool.call` drops `agentId` (d.ts:12640), so a subagent's own
// tool calls are covered by events.test.ts, ledger.test.ts and agents.test.ts, and by the live smoke run.
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, test } from 'claude-code/testing'
import { addReason } from '../core/lib/reasons'
import * as ev from './fixtures/events'
import { prNode } from './fixtures/gh-discovery'
import { porcelain as gitPorcelain } from './fixtures/git'
import { LIMITS } from './fixtures/limits'
import { headersOf, mountPane as mount, select } from './fixtures/pane'
import { DISCOVERED, reasonsOfSources } from './fixtures/reasons'
import { BAND, clearSession, prompt, quiet, response, START, sleep, track, world } from './fixtures/world'

const MAIN = '/work'
const PR7 = 'gh:github.com/acme/web#7'
type World = ReturnType<typeof world>

const porcelain = (...kids: [string, string][]): string => gitPorcelain(MAIN, ...kids)

/** A git repo at /work with the given child worktrees in porcelain. */
function repo(w: World, ...kids: [string, string][]): void {
  w.fake.isRepo = true
  w.fake.toplevel = MAIN
  w.fake.cwd = MAIN
  w.fake.porcelain = porcelain(...kids)
}

const enter = ($: Engine, w: World, name = 'probe-wt') => {
  w.fake.tools.EnterWorktree = {
    worktreePath: `${MAIN}/.claude/worktrees/${name}`,
    worktreeBranch: `worktree-${name}`,
    message: 'created',
  }
  return $.tool.call({ tool: 'EnterWorktree', name } as never)
}

/** Moves the clock, then waits until no new process.run call comes and the promise chains settle. */
async function settle(w: World, ms: number): Promise<void> {
  await w.clock.advance(ms)
  await quiet(w.calls)
  await sleep(30)
}
const WINDOW = LIMITS.autoDebounceMs + 10
const TICK = LIMITS.tickMs + 10

const queries = (calls: string[][]): string[] =>
  calls
    .filter(c => c[0] === 'gh' && c.some(x => x.includes('pullRequests(')))
    .map(c => c.find(x => x.startsWith('query='))!)

const textOf = async ($: Engine): Promise<string> => (await track($)).text ?? ''

type Mounted = {
  find(q: unknown): Promise<unknown>
  press(q: unknown): Promise<void>
  unmount(): Promise<void>
}
const mountPane = ($: Engine, bodyColumns = 62) => mount($, { bodyColumns })
const mountBand = ($: Engine) => $.ui.mount({ ...BAND, surface: 'terminal' } as never) as unknown as Promise<Mounted>
/** Stands for the engine's own band, which the hook returns inside its Box as next(e). */
const engineBand = (on: On) => on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))

test('session.start arms the tick: with no pane, a worktree added with no event shows in the band after one tick', async ($, on) => {
  engineBand(on)
  const w = world(on)
  repo(w)
  await $.session.start(START)
  await enter($, w) // the proof exists, the worktree is not in porcelain yet
  await settle(w, WINDOW)
  w.fake.porcelain = porcelain(['probe-wt', 'worktree-probe-wt']) // a plain `git worktree add`: no event
  const before = await mountBand($)
  expect(await before.find({ text: 'Worktrees' })).toBeUndefined()
  await before.unmount()
  await settle(w, TICK)
  const after = await mountBand($)
  expect(await after.find({ text: 'Worktrees 1' })).toBeDefined()
  await after.unmount()
})

test('EnterWorktree adds a child; ExitWorktree keep keeps it live; remove makes it removed; the root stays', async ($, on) => {
  const w = world(on)
  repo(w, ['probe-wt', 'worktree-probe-wt'])
  await $.session.start(START)
  await enter($, w)
  await settle(w, WINDOW)
  let text = await textOf($)
  expect(text).toContain('Worktrees  git · 1 live')
  expect(text).toContain('probe-wt  worktree-probe-wt')
  w.fake.tools.ExitWorktree = { action: 'keep', originalCwd: MAIN, worktreePath: `${MAIN}/.claude/worktrees/probe-wt` }
  await $.tool.call({ tool: 'ExitWorktree', action: 'keep' } as never)
  await settle(w, WINDOW)
  text = await textOf($)
  expect(text).toContain('1 live')
  expect(text).not.toContain('removed')
  w.fake.porcelain = porcelain()
  w.fake.tools.ExitWorktree = {
    action: 'remove',
    originalCwd: MAIN,
    worktreePath: `${MAIN}/.claude/worktrees/probe-wt`,
  }
  await $.tool.call({ tool: 'ExitWorktree', action: 'remove' } as never)
  await settle(w, WINDOW)
  text = await textOf($)
  expect(text).toContain('1 removed')
  expect(text).toContain('probe-wt  worktree-probe-wt  removed')
  expect(text).toContain('work  main') // the root row stays
})

test('agent.spawn plus an agent-<id> porcelain record: a Worktrees child and an Agents row with the worktree branch', async ($, on) => {
  const w = world(on)
  repo(w, ['agent-a94bdd45b56e2c631', 'worktree-agent-a94bdd45b56e2c631'])
  w.fake.spawnId = 'a94bdd45b56e2c631'
  w.fake.agents = [{ id: 'a94bdd45b56e2c631', status: 'running', description: 'iso agent', type: 'general-purpose' }]
  await $.session.start(START)
  await $.agent.spawn(ev.SPAWN_INPUT as never)
  await settle(w, WINDOW)
  const text = await textOf($)
  expect(text).toContain('Worktrees  git · 1 live')
  expect(text).toContain('Agents  1 running')
  expect(text).toContain('● iso-agent  worktree-agent-a94bdd45  agent-a94bdd45')
  expect(text).not.toContain('a94bdd45b56e2c631') // ids compact to 8 hex
})

test('turn.complete with the agent id dims an agent the list does not hold; reason error marks it failed', async ($, on) => {
  const w = world(on)
  repo(w)
  await $.session.start(START)
  w.fake.spawnId = 'a1'
  await $.agent.spawn(ev.SPAWN_INPUT as never)
  w.fake.spawnId = 'a2'
  await $.agent.spawn({ ...ev.SPAWN_INPUT, name: 'second' } as never)
  await $.turn.complete({ turnId: 't1', agentId: 'a1', reason: 'answer', isAborted: false, answer: '' } as never)
  await $.turn.complete({ turnId: 't2', agentId: 'a2', reason: 'error', isAborted: false, answer: '' } as never)
  await settle(w, WINDOW)
  const text = await textOf($)
  expect(text).toContain('Agents  2 ended')
  expect(text).toContain('✓ iso-agent')
  expect(text).toContain('✗ second')
})

test('a workflow agent.spawn lists a wf·3 row', async ($, on) => {
  const w = world(on)
  repo(w)
  await $.session.start(START)
  w.fake.spawnId = 'w1'
  await $.agent.spawn(ev.WORKFLOW_SPAWN_INPUT as never)
  await settle(w, WINDOW)
  expect(await textOf($)).toContain('● wf·3 architect')
})

test('a Bash result with gitOperation.pr runs the discovery after the debounce, before any tick', async ($, on) => {
  const w = world(on)
  repo(w, ['probe-wt', 'worktree-probe-wt'])
  await $.session.start(START)
  await enter($, w)
  await settle(w, WINDOW)
  const before = queries(w.calls).length
  w.fake.nodes['head:worktree-probe-wt'] = [
    prNode({ number: 7, headRefName: 'worktree-probe-wt', title: 'Opened here' }),
  ]
  w.fake.tools.Bash = ev.BASH_PR_RAN.result
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --draft' } as never)
  await settle(w, WINDOW) // 760 ms, far below the 30 s tick
  expect(queries(w.calls)).toHaveLength(before + 1)
  expect(await textOf($)).toContain('Opened here')
})

test('a Bash that names a repo whose git never answers still kicks the PR discovery', async ($, on) => {
  const w = world(on)
  repo(w, ['probe-wt', 'worktree-probe-wt'])
  await $.session.start(START)
  await enter($, w)
  await settle(w, WINDOW)
  const before = queries(w.calls).length
  w.fake.nodes['head:worktree-probe-wt'] = [prNode({ number: 7, headRefName: 'worktree-probe-wt', title: 'Opened' })]
  let release: () => void = () => {}
  const held = new Promise<undefined>(resolve => {
    release = () => resolve(undefined)
  })
  w.fake.run = argv => (argv[0] === 'git' && argv[2] === '/x/sdk' ? held : undefined)
  w.fake.tools.Bash = ev.BASH_PR_RAN.result
  try {
    await $.tool.call({ tool: 'Bash', command: 'git -C /x/sdk status && gh pr create --draft' } as never)
    await settle(w, WINDOW)
    expect(queries(w.calls)).toHaveLength(before + 1)
  } finally {
    release()
  }
})

test('a PR added elsewhere shows within one tick; a base match shows as stacked; the default branch gets no alias', async ($, on) => {
  const w = world(on)
  repo(w, ['probe-wt', 'worktree-probe-wt'])
  await $.session.start(START)
  await enter($, w)
  await settle(w, WINDOW)
  w.fake.nodes['head:worktree-probe-wt'] = [prNode({ number: 7, headRefName: 'worktree-probe-wt' })]
  w.fake.nodes['base:worktree-probe-wt'] = [
    prNode({ number: 9, baseRefName: 'worktree-probe-wt', headRefName: 'feat/band', title: 'Stack: band counts' }),
  ]
  await settle(w, TICK)
  const text = await textOf($)
  expect(text).toContain('Pull requests  gh ·')
  expect(text).toContain('#7  PR 7')
  expect(text).toContain('#9  Stack: band counts  →worktree-probe-wt')
  const all = queries(w.calls)
  expect(all[0]).toContain('baseRefName: "main"') // the default branch is not known yet
  expect(all.at(-1)).not.toContain('baseRefName: "main"')
})

test('a PR body ref becomes an item with the via prefix; a commented ref does not; it goes when the PR leaves', async ($, on) => {
  const w = world(on)
  repo(w, ['probe-wt', 'worktree-probe-wt'])
  await $.session.start(START)
  await enter($, w)
  await settle(w, WINDOW)
  w.fake.nodes['head:worktree-probe-wt'] = [
    prNode({ number: 7, headRefName: 'worktree-probe-wt', body: 'Needs #1\n<!-- see #12 -->' }),
  ]
  await settle(w, TICK)
  let text = await textOf($)
  expect(text).toContain('↳#7')
  expect(text).not.toContain('#12')
  w.fake.nodes['head:worktree-probe-wt'] = []
  await settle(w, TICK)
  text = await textOf($)
  expect(text).not.toContain('↳#7')
  expect(text).not.toContain('Pull requests  gh ·')
})

async function withVisiblePr($: Engine, w: World): Promise<void> {
  repo(w, ['probe-wt', 'worktree-probe-wt'])
  await $.session.start(START)
  await enter($, w)
  w.fake.nodes['head:worktree-probe-wt'] = [
    prNode({ number: 7, headRefName: 'worktree-probe-wt', title: 'Opened here' }),
  ]
  await settle(w, WINDOW)
  expect(await textOf($)).toContain('Opened here')
}

test('an x press dismisses a PR for the run: it stays hidden after the next tick', async ($, on) => {
  const w = world(on)
  await withVisiblePr($, w)
  const pane = await mountPane($)
  await select($, pane, '#7')
  await pane.press({ key: 'dismiss' })
  await pane.unmount()
  await settle(w, TICK)
  expect(await textOf($)).not.toContain('Opened here')
})

test('/track clear dismisses the current auto items; with a discovery reply in flight they stay gone', async ($, on) => {
  const w = world(on)
  await withVisiblePr($, w)
  let release = () => {}
  w.fake.discoveryHold = new Promise<void>(resolve => {
    release = resolve
  })
  await w.clock.advance(TICK) // the tick's discovery call now waits
  await quiet(w.calls)
  await track($, 'clear')
  release()
  w.fake.discoveryHold = undefined
  await settle(w, TICK)
  expect(await textOf($)).toBe('No tracked items yet.')
})

test('/clear keeps the root, the children and the dismiss list', async ($, on) => {
  const w = world(on, { isolateState: true })
  repo(w, ['probe-wt', 'worktree-probe-wt'], ['other', 'worktree-other'])
  await $.session.start(START)
  await enter($, w, 'probe-wt')
  await enter($, w, 'other')
  await settle(w, WINDOW)
  const pane = await mountPane($)
  await select($, pane, 'other')
  await pane.press({ key: 'dismiss' })
  await pane.unmount()
  await clearSession($, w, 'sess-2', 'clear') // /clear: a new id and an empty state
  await settle(w, TICK)
  const text = await textOf($)
  expect(text).toContain('probe-wt')
  expect(text).toContain('work  main')
  expect(text).not.toContain('other')
})

test('a second session.start with another cwd keeps the root; one tick makes one discovery call', async ($, on) => {
  const w = world(on)
  repo(w, ['probe-wt', 'worktree-probe-wt'])
  await $.session.start(START)
  await enter($, w)
  await settle(w, WINDOW)
  await $.session.start({ ...START, cwd: '/elsewhere' })
  await settle(w, WINDOW)
  const before = queries(w.calls).length
  await settle(w, TICK)
  expect(queries(w.calls)).toHaveLength(before + 1)
  expect(await textOf($)).toContain('work  main')
})

test('three failed discovery calls open the breaker; worktrees and agents still update on the next tick', async ($, on) => {
  const w = world(on)
  repo(w, ['probe-wt', 'worktree-probe-wt'])
  await $.session.start(START)
  await enter($, w)
  await settle(w, WINDOW)
  w.fake.discoveryMode = 'transport'
  for (let i = 0; i < 3; i++) await settle(w, TICK)
  w.fake.porcelain = porcelain(['probe-wt', 'worktree-probe-wt'], ['second', 'worktree-second'])
  await enter($, w, 'second')
  await settle(w, TICK)
  const text = await textOf($)
  expect(text).toContain('second  worktree-second')
  expect(text).toContain('paused')
})

test('discovery replies with errors and no data leave the breaker closed and item refresh running', async ($, on) => {
  const w = world(on)
  repo(w, ['probe-wt', 'worktree-probe-wt'])
  await $.session.start(START)
  await enter($, w)
  await settle(w, WINDOW)
  w.fake.discoveryMode = 'query-error'
  await $.session.append(response('https://github.com/cli/cli/pull/14640'))
  for (let i = 0; i < 3; i++) await settle(w, TICK)
  const text = await textOf($)
  expect(text).toContain('discovery failed: Field x')
  expect(text).not.toContain('paused')
  expect(text).toContain('Address review feedback') // the item refresh still ran
})

test('a refused tick period ends the interval; the next hook re-arms it and a later tick runs a round', async ($, on) => {
  engineBand(on)
  const w = world(on, { refuseEvery: LIMITS.tickMs })
  repo(w)
  await $.session.start(START)
  await enter($, w)
  await settle(w, WINDOW)
  w.fake.porcelain = porcelain(['probe-wt', 'worktree-probe-wt'])
  await settle(w, 2 * LIMITS.tickMs + 10) // the refused interval never ticks
  const stale = await mountBand($)
  expect(await stale.find({ text: 'Worktrees 1' })).toBeUndefined()
  await stale.unmount()
  await $.session.append(prompt('hello')) // a hook: ensureTick sees the old beat and arms the interval again
  await settle(w, TICK)
  const fresh = await mountBand($)
  expect(await fresh.find({ text: 'Worktrees 1' })).toBeDefined()
  await fresh.unmount()
})

/** A refused tick period, then one hook that has no event fact: it must still arm the interval again. */
async function rearmedBy(hook: ($: Engine, w: World) => Promise<unknown>, $: Engine, on: On): Promise<boolean> {
  engineBand(on)
  const w = world(on, { refuseEvery: LIMITS.tickMs })
  repo(w)
  await $.session.start(START)
  await enter($, w)
  await settle(w, WINDOW)
  w.fake.porcelain = porcelain(['probe-wt', 'worktree-probe-wt'])
  await settle(w, 2 * LIMITS.tickMs + 10)
  await hook($, w)
  await settle(w, TICK)
  const band = await mountBand($)
  const found = (await band.find({ text: 'Worktrees 1' })) !== undefined
  await band.unmount()
  return found
}

test('a main-loop turn.complete with no agent id re-arms a refused tick', async ($, on) => {
  const turn = ($: Engine) => $.turn.complete({ turnId: 't1', reason: 'answer', isAborted: false, answer: '' } as never)
  expect(await rearmedBy($ => turn($), $, on)).toBe(true)
})

test('a Bash call that kicks nothing re-arms a refused tick', async ($, on) => {
  const bash = ($: Engine, w: World) => {
    w.fake.tools.Bash = { stdout: 'ok', stderr: '', exitCode: 0 }
    return $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  }
  expect(await rearmedBy(bash, $, on)).toBe(true)
})

test('R7 live: when the session works in the PR branch, the PR is top with a dim star; back on main it is not', async ($, on) => {
  const w = world(on)
  await withVisiblePr($, w)
  expect(await textOf($)).not.toContain('★')
  w.fake.cwd = `${MAIN}/.claude/worktrees/probe-wt` // the master loop now works on worktree-probe-wt
  await settle(w, TICK)
  expect(await textOf($)).toContain('★ #7  Opened here')
  const pane = await mountPane($, 100)
  expect((await pane.findAll({ type: 'Text' })).find(t => t.text === '★')?.props.dimColor).toBe(true)
  await pane.unmount()
  w.fake.cwd = MAIN
  await settle(w, TICK)
  expect(await textOf($)).not.toContain('★')
})

test('at 62 columns the PR row keeps its columns, and x dismisses it', async ($, on) => {
  const w = world(on)
  await withVisiblePr($, w)
  const prHeaders = async (cols: number) => {
    const pane = await mountPane($, cols)
    const headers = headersOf(await pane.drawn()).find(h => h.includes('PR'))
    await pane.unmount()
    return headers
  }
  // The checks always sit in their own column now. The legacy pane hid it below 70 columns and put a glyph in State.
  expect(await prHeaders(62)).toEqual(['PR', 'Title', 'Branch', 'State', 'Checks'])
  expect(await prHeaders(34)).toEqual(['PR', 'Title', 'State']) // Branch (priority 2) and Checks (1) drop on a narrow pane
  const pane = await mountPane($, 62)
  await select($, pane, '#7')
  await pane.press({ key: 'dismiss' })
  await pane.unmount()
  expect(await textOf($)).not.toContain('Opened here')
})

test('a stored copy restores without auto sources, and with gh missing a tick does not bring them back', async ($, on) => {
  const base = {
    category: 'github' as const,
    url: 'https://github.com/acme/web/pull/7',
    label: 'acme/web#7',
    firstSeen: 1,
    lastSeen: 1,
    host: 'github.com',
    owner: 'acme',
    repo: 'web',
    type: 'pr' as const,
    state: 'open' as const,
  }
  const autoOnly = {
    ...base,
    key: PR7,
    number: 7,
    title: 'Auto PR 7',
    sources: [],
    reasons: DISCOVERED,
    lane: true,
    seenCount: 0,
  }
  const mentioned = {
    ...base,
    key: 'gh:github.com/acme/web#5',
    number: 5,
    url: 'https://github.com/acme/web/pull/5',
    label: 'acme/web#5',
    title: 'Web five',
    sources: ['prompt'],
    reasons: addReason(reasonsOfSources(['prompt']), 'discovered'),
    lane: true,
    via: ['gh:github.com/acme/web#9'],
    seenCount: 1,
  }
  const w = world(on, {
    missing: ['gh'],
    seed: { 'v2:index': ['sess-1'], 'v2:s:sess-1': { items: [autoOnly, mentioned] } },
  })
  await $.session.start(START)
  await settle(w, TICK)
  const text = await textOf($)
  expect(text).toContain('Web five')
  expect(text).not.toContain('Auto PR 7')
  expect(text).not.toContain('Pull requests')
  expect(text).not.toContain('↳')
})

test('/resume while a PR step is in flight: the stored copy of the new session loads first and keeps its items', async ($, on) => {
  const mentioned = {
    category: 'github' as const,
    key: 'gh:github.com/acme/web#5',
    url: 'https://github.com/acme/web/pull/5',
    label: 'acme/web#5',
    firstSeen: 1,
    lastSeen: 1,
    host: 'github.com',
    owner: 'acme',
    repo: 'web',
    number: 5,
    type: 'pr' as const,
    state: 'open' as const,
    title: 'Web five',
    sources: ['prompt'],
    reasons: reasonsOfSources(['prompt']),
    seenCount: 1,
  }
  const w = world(on, { isolateState: true, seed: { 'v2:index': ['sess-2'], 'v2:s:sess-2': { items: [mentioned] } } })
  repo(w, ['probe-wt', 'worktree-probe-wt'])
  await $.session.start(START)
  await enter($, w)
  await settle(w, WINDOW)
  w.fake.nodes['head:worktree-probe-wt'] = [
    prNode({ number: 7, headRefName: 'worktree-probe-wt', title: 'Opened here' }),
  ]
  let release = () => {}
  w.fake.discoveryHold = new Promise<void>(resolve => {
    release = resolve
  })
  await w.clock.advance(TICK) // the tick starts a PR step; its gh call waits
  await quiet(w.calls)
  await clearSession($, w, 'sess-2', 'resume') // /resume: a new id and an empty state
  release()
  w.fake.discoveryHold = undefined
  await settle(w, WINDOW)
  const text = await textOf($)
  expect(text).toContain('Opened here') // the discovery landed
  expect(text).toContain('Web five') // the stored copy was not lost behind it
})

test('a refused auto write inside the EnterWorktree hook returns the result and runs the tool once', async ($, on) => {
  const w = world(on, { isolateState: true, denyAutoWrites: true })
  const out = await enter($, w)
  expect(out).toEqual({ result: w.fake.tools.EnterWorktree }) // the real tool result, not a stand-in
  expect(out).toMatchObject({ result: { worktreePath: `${MAIN}/.claude/worktrees/probe-wt`, message: 'created' } })
  expect(w.fake.toolRuns.EnterWorktree).toBe(1)
})

test('quiet ticks with a working discovery write no state atom: tools, auto and items stay as they are (A22)', async ($, on) => {
  const w = world(on, { isolateState: true })
  repo(w, ['probe-wt', 'worktree-probe-wt'])
  await $.session.start(START)
  await enter($, w)
  await settle(w, WINDOW)
  w.fake.nodes['head:worktree-probe-wt'] = [prNode({ number: 7, headRefName: 'worktree-probe-wt' })]
  await settle(w, TICK) // the first tick finds the PR
  const before = { ...w.fake.stateSets }
  const asked = queries(w.calls).length
  for (let i = 0; i < 3; i++) await settle(w, TICK)
  expect(queries(w.calls).length).toBe(asked + 3) // gh ran on every tick, so `lastRunAt` moved
  expect(w.fake.stateSets).toEqual(before)
})
