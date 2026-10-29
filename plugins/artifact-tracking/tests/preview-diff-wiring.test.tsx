// Kit tests of the diff mode of the file preview (issue #254, L3 of #57): the real engine mounts what the provider gives, so these are the
// checks that `Code` takes the diff format and the hunks that the cut writes, and that `d` and `v` on the key line move between the two
// modes. The git calls answer the shapes of the design study (P4); the unit cases of every notice are in file-diff.test.ts, and the
// budget of the key line in preview-view.test.ts. The kit has no `$.ui.close` at run time (pane.test.tsx says so), so Esc is in
// pane-preview.test.ts.
// Design study R15, R16, R17, G13: https://github.com/martin-macak/claude-code-mod-tracking/issues/57#issuecomment-6414682787
import type { Engine } from 'claude-code/testing'
import { expect, mock } from 'claude-code/testing'
import { test } from './fixtures/kit'
import { buttonKeys, mountPane, type PaneUi, seen, select } from './fixtures/pane'
import { fileTool, quiet, res, START, sleep, world, writeCreated } from './fixtures/world'

const SHA = '1efdf45aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const CHANGED = `diff --git a/a.ts b/a.ts
index de98044..5d9294b 100644
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
-one
+two
 same
\\ No newline at end of file
`

/**
 * The pane with `a.ts` tracked and its view open. `git` answers a repo at `/work` (or `top`), a base at `origin/HEAD`, and `diff` for the
 * diff call. The probe that the view starts is a call to git too, and `calls` lists it: a test that wants the calls of the diff alone
 * waits for the probe first (`probed`).
 */
async function opened($: Engine, on: Parameters<typeof world>[0], diff: string, top = res('/work\n')) {
  const w = world(on)
  mock.env(on, { HOME: '/home/u' })
  const calls: string[] = []
  w.fake.files['/work/src/a.ts'] = '/work/src/a.ts' // the stub disk: the file is there
  w.fake.run = async argv => {
    if (argv[0] === 'head') return res('one\nsame')
    if (argv[0] !== 'git') return undefined
    const word = argv.find(a => ['rev-parse', 'merge-base', 'diff', 'ls-files', 'symbolic-ref'].includes(a)) ?? ''
    if (argv.includes('--literal-pathspecs')) calls.push(word) // the preview's calls only: the auto round asks git too
    if (word === 'rev-parse') return top
    if (word === 'merge-base') return res(`${SHA}\n`)
    if (word === 'diff') return res(diff)
    return res('', 128, 'unscripted')
  }
  await $.session.start(START)
  await fileTool($, w.fake, 'Write', writeCreated('/work/src/a.ts'))
  await quiet(w.calls)
  const ui = await mountPane($, {})
  await select($, ui, 'a.ts')
  await ui.press({ key: 'preview' })
  await seen(ui, ' · code · view · 2 lines')
  return { ui, calls, w }
}

/** Draws again until the Button `key` of the key line is dim: the probe of the view has said that the mode is off. A hang guard of 20 s. */
async function dimmed(ui: PaneUi, key: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    await ui.redraw()
    const button = (await ui.findAll({ type: 'Button' })).find(b => b.key === key)
    if (button?.props.dimColor === true) return
    await sleep(10)
  }
  throw new Error(`timed out waiting for the Button ${key} to be dim`)
}

test('preview: d on the key line shows the diff in the engine, v goes back to the view, and the key line is the same in both', async ($, on) => {
  const { ui, calls, w } = await opened($, on, CHANGED)
  expect(await buttonKeys(ui)).toEqual(['preview', 'diff', 'refresh'])
  await w.clock.advance(0) // the probe of the view runs after its hook, on the timer `clock.after(0)`
  await quiet(w.calls) // a repo with a base, so the mode stays on
  expect(calls).toEqual(['rev-parse', 'merge-base'])
  calls.length = 0
  await ui.press({ key: 'diff' })
  await seen(ui, ' · code · diff · vs origin/HEAD @ 1efdf45 · +1 -1')
  expect(calls).toEqual(['rev-parse', 'merge-base', 'diff'])
  const [code] = await ui.findAll({ type: 'Code' })
  expect(code?.props).toMatchObject({
    format: 'diff',
    source: '@@ -1,2 +1,2 @@\n-one\n+two\n same\n\\ No newline at end of file\n',
    path: '/work/src/a.ts',
  })
  expect(await buttonKeys(ui)).toEqual(['preview', 'diff', 'refresh'])
  await ui.press({ key: 'preview' })
  await seen(ui, ' · code · view · 2 lines')
  expect(await ui.find({ text: 'Esc back' })).toBeDefined()
  await ui.unmount()
})

test('preview: a diff cut inside a hunk is mounted with the header of the lines it keeps, and keeps its keys', async ($, on) => {
  const body = Array.from({ length: 3000 }, (_, i) => `+line ${i}`).join('\n')
  const { ui } = await opened($, on, `diff --git a/a.ts b/a.ts\n@@ -0,0 +1,3000 @@\n${body}\n`)
  await ui.press({ key: 'diff' })
  await seen(ui, 'Truncated: the first 2000 of 3001 lines of the diff (1 of 1 hunk, the last one cut).')
  const [code] = await ui.findAll({ type: 'Code' })
  const source = String(code?.props.source)
  expect(source.split('\n')[0]).toBe('@@ -0,0 +1,1999 @@')
  expect(source.split('\n').filter(Boolean)).toHaveLength(2000)
  expect(code?.props.format).toBe('diff')
  expect(await buttonKeys(ui)).toEqual(['preview', 'diff', 'refresh'])
  await ui.unmount()
})

test('preview: a file in no repository: once the view has asked git, the diff Button is dim, and a press opens no diff and asks git no more (R16)', async ($, on) => {
  const { ui, calls, w } = await opened($, on, CHANGED, res('', 128, 'fatal: not a git repository'))
  await w.clock.advance(0) // the probe of the view runs after its hook, on the timer `clock.after(0)`
  await dimmed(ui, 'diff') // the probe is one call
  expect(calls).toEqual(['rev-parse'])
  expect(await buttonKeys(ui)).toEqual(['preview', 'diff', 'refresh'])
  await ui.press({ key: 'diff' }) // the toast says why (core, tests/pane-preview.test.ts); nothing opens
  await quiet(w.calls)
  expect(calls).toEqual(['rev-parse'])
  expect(await ui.find({ text: ' · code · view · 2 lines' })).toBeDefined()
  expect(await ui.find({ text: ' · code · diff' })).toBeUndefined()
  await ui.unmount()
})
