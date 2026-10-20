// Kit tests of the resolve and files keys of a conflicted PR (issue #50), through the real hooks: the PR lane finds a
// CONFLICTING PR and the worktree of its branch, the pane shows the chip, and a press of the footer key reaches
// `$.prompt.submit`, or runs git. The engine's `prompt.submit` and `process.run` are stubs beneath the mod.
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect } from 'claude-code/testing'
import { prNode } from './fixtures/gh-discovery'
import { porcelain as gitPorcelain } from './fixtures/git'
import { test } from './fixtures/kit'
import { LIMITS } from './fixtures/limits'
import { mountPane, select } from './fixtures/pane'
import { BAND, quiet, START, sleep, world } from './fixtures/world'

const MAIN = '/work'
const BRANCH = 'worktree-probe-wt'
const WINDOW = LIMITS.autoDebounceMs + 10
const OID = '3ee957a877544efaf8eea208694fdcd92da716bc'
type World = ReturnType<typeof world>

/** A git repo at /work with one child worktree on `BRANCH`, and a CONFLICTING PR #7 on that branch. */
function conflicted(w: World, mergeable = 'CONFLICTING'): void {
  w.fake.isRepo = true
  w.fake.toplevel = MAIN
  w.fake.cwd = MAIN
  w.fake.porcelain = gitPorcelain(MAIN, ['probe-wt', BRANCH])
  w.fake.nodes[`head:${BRANCH}`] = [
    prNode({
      number: 7,
      headRefName: BRANCH,
      mergeable,
      mergeStateStatus: mergeable === 'CONFLICTING' ? 'DIRTY' : 'CLEAN',
    }),
  ]
}

const enter = ($: Engine, w: World) => {
  w.fake.tools.EnterWorktree = {
    worktreePath: `${MAIN}/.claude/worktrees/probe-wt`,
    worktreeBranch: BRANCH,
    message: 'created',
  }
  return $.tool.call({ tool: 'EnterWorktree', name: 'probe-wt' } as never)
}

async function settle(w: World, ms: number): Promise<void> {
  await w.clock.advance(ms)
  await quiet(w.calls)
  await sleep(30)
}

/** Records every prompt the mod submits. The stub answers like core: the prompt entered, or a hook dropped it. */
function submits(on: On, refusal?: string): string[] {
  const sent: string[] = []
  on('prompt.submit', (_$, e) => {
    sent.push(e.text)
    return refusal === undefined ? { text: e.text } : { drop: refusal }
  })
  return sent
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await sleep(10)
  if (!cond()) throw new Error(`timed out waiting for ${what}`)
}

/** The session at the point where the pane has the conflicted row, mounted, with that row selected. */
async function paneWithConflict($: Engine, on: On, mergeable = 'CONFLICTING', refusal?: string) {
  const sent = submits(on, refusal)
  const w = world(on)
  conflicted(w, mergeable)
  await $.session.start(START)
  await enter($, w)
  await settle(w, WINDOW)
  const ui = await mountPane($, { bodyColumns: 80 })
  await select($, ui, '#7')
  return { w, ui, sent }
}

test('the pane shows the ✗ conflicts chip on the row the lane found, and the band counts it (AC1, AC7)', async ($, on) => {
  // Stands for the engine's own band, which the hook returns inside its Box as next(e).
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))
  const { ui } = await paneWithConflict($, on)
  expect(await ui.find({ text: '✗ conflicts' })).toBeDefined()
  const band = (await $.ui.mount({ ...BAND, surface: 'terminal' } as never)) as unknown as {
    find(q: unknown): Promise<unknown>
    unmount(): Promise<void>
  }
  expect(await band.find({ text: 'PRs 1 (1 conflict)' })).toBeDefined()
  await band.unmount()
  await ui.unmount()
})

test('one press of the resolve key submits the prompt once; a second press sends nothing (AC8, AC9)', async ($, on) => {
  const { ui, sent } = await paneWithConflict($, on)
  await ui.press({ key: 'github.resolve' })
  await until(() => sent.length === 1, 'the prompt')
  expect(sent[0]).toContain('Resolve the merge conflicts on PR #7 (https://github.com/acme/web/pull/7).')
  expect(sent[0]).toContain(`Head branch: ${BRANCH}. Base branch: main. Worktree: ${MAIN}/.claude/worktrees/probe-wt.`)
  expect(sent[0]).toContain('Ask me before you push')
  await ui.redraw()
  expect(await ui.find({ text: 'queued' })).toBeDefined() // AC8: the row says so
  await ui.press({ key: 'github.resolve' })
  await sleep(50)
  expect(sent).toHaveLength(1) // AC9
  await ui.unmount()
})

test('a prompt that a hook refuses is taken back: the row stays ✗ conflicts and a second press tries again (review m3)', async ($, on) => {
  const { ui, sent } = await paneWithConflict($, on, 'CONFLICTING', 'blocked by policy')
  await ui.press({ key: 'github.resolve' })
  await until(() => sent.length === 1, 'the first attempt')
  await sleep(50)
  await ui.redraw()
  expect(await ui.find({ text: 'queued' })).toBeUndefined()
  expect(await ui.find({ text: '✗ conflicts' })).toBeDefined()
  await ui.press({ key: 'github.resolve' })
  await until(() => sent.length === 2, 'the second attempt')
  await ui.unmount()
})

test('a PR that does not conflict has the resolve key off: a press sends nothing', async ($, on) => {
  const { ui, sent } = await paneWithConflict($, on, 'MERGEABLE')
  await ui.press({ key: 'github.resolve' })
  await sleep(50)
  expect(sent).toEqual([])
  expect(await ui.find({ text: '✗ conflicts' })).toBeUndefined()
  await ui.unmount()
})

test('the files key runs a fetch and merge-tree, and the pane lists the files under the PR', async ($, on) => {
  const sent = submits(on)
  const w = world(on)
  conflicted(w)
  const git: string[][] = []
  w.fake.run = argv => {
    if (argv[0] !== 'git') return undefined
    if (argv[1] === 'fetch') {
      git.push(argv)
      return { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
    }
    if (argv[1] === 'merge-tree') {
      git.push(argv)
      return {
        exitCode: 1,
        stdout: `${OID}\0src/a.ts\0src/b.ts\0`,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      }
    }
    return undefined
  }
  await $.session.start(START)
  await enter($, w)
  await settle(w, WINDOW)
  const ui = await mountPane($, { bodyColumns: 80 })
  await select($, ui, '#7')
  expect(await ui.find({ text: 'src/a.ts' })).toBeUndefined()
  await ui.press({ key: 'github.files' })
  await until(() => git.length === 2, 'the two git calls')
  await sleep(50)
  await ui.redraw()
  expect(await ui.find({ text: 'src/a.ts' })).toBeDefined()
  expect(await ui.find({ text: 'src/b.ts' })).toBeDefined()
  expect(sent).toEqual([]) // listing the files asks Claude for nothing
  await ui.unmount()
})
