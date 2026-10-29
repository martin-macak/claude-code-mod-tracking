// Kit tests of the file preview (issue #57, L2): the pane the person sees when `v` opens a file. The real engine mounts the tree,
// so these are the checks that `Code` and its props are accepted, that a source with control characters does not blank the pane
// (the engine refuses the whole tree for one), that a file over the caps shows its notice and keeps the Buttons, and that an inline
// pane of 11 body rows (100x40) gets the whole tall tree for the engine to scroll. The fake `head` answers from the stub disk. The
// 100,000 characters of the engine are out of reach here (the file tracker keeps 60,000), so the budget guard is in preview-view.test.ts.
// The kit has no `$.ui.close` at run time (pane.test.tsx says so), so Esc is in pane-preview.test.ts.
// Design study R10, R14, S6, S7: https://github.com/martin-macak/claude-code-mod-tracking/issues/57#issuecomment-6414682787
import type { Engine } from 'claude-code/testing'
import { expect, mock } from 'claude-code/testing'
import { test } from './fixtures/kit'
import { LIMITS } from './fixtures/limits'
import { mountPane, type PaneUi, select } from './fixtures/pane'
import {
  fileTool,
  graphqlCalls,
  quiet,
  res,
  response,
  START,
  sleep,
  track,
  until,
  world,
  writeCreated,
} from './fixtures/world'

type World = ReturnType<typeof world>

/** A world with one tracked file, `/work/src/a.ts`, whose `head` read answers `text`. */
async function withFile(
  $: Engine,
  on: Parameters<typeof world>[0],
  text: string,
  opts?: Parameters<typeof world>[1],
): Promise<{ w: World; reads: string[][] }> {
  const w = world(on, opts)
  mock.env(on, { HOME: '/home/u' }) // the provider reads HOME for the globs of secretPaths that start with ~/
  const reads: string[][] = []
  w.fake.files['/work/src/a.ts'] = '/work/src/a.ts' // the stub disk: the file is there
  w.fake.run = async argv => {
    if (argv[0] !== 'head') return undefined
    reads.push(argv)
    return res(text)
  }
  await $.session.start(START)
  await fileTool($, w.fake, 'Write', writeCreated('/work/src/a.ts'))
  await quiet(w.calls)
  return { w, reads }
}

/** Waits until the pane draws the preview: its key line ends in the hint. A hang guard of 20 s, as `until` has. */
async function shown(ui: PaneUi): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if ((await ui.find({ text: 'Esc back' })) !== undefined) return
    await sleep(10)
  }
  throw new Error('timed out waiting for the preview')
}

/** The pane with the row selected and `v` pressed. */
async function opened(
  $: Engine,
  on: Parameters<typeof world>[0],
  text: string,
  mount: Parameters<typeof mountPane>[1] = {},
  opts?: Parameters<typeof world>[1],
): Promise<{ ui: PaneUi; reads: string[][]; w: World }> {
  const { w, reads } = await withFile($, on, text, opts)
  const ui = await mountPane($, mount)
  await select($, ui, 'a.ts')
  await ui.press({ key: 'preview' })
  await until(() => reads.length > 0, 'the read of the file') // the read runs apart from the press
  await shown(ui)
  return { ui, reads, w }
}

const buttonKeys = async (ui: PaneUi) => (await ui.findAll({ type: 'Button' })).map(b => b.key)

test('preview: v on a file row opens the source in place of the table: the header, the key line, then the code', async ($, on) => {
  const { ui, reads } = await opened($, on, 'export const one = 1\nexport const two = 2\n')
  expect(reads).toEqual([['head', '-c', '262144', '--', '/work/src/a.ts']])
  expect(await ui.find({ text: 'src/a.ts' })).toBeDefined() // the header
  expect(await ui.find({ text: ' · code · view · 2 lines' })).toBeDefined()
  expect(await ui.find({ text: 'Esc back' })).toBeDefined()
  expect(await buttonKeys(ui)).toEqual(['preview', 'refresh'])
  const [code] = await ui.findAll({ type: 'Code' })
  expect(code?.props).toMatchObject({
    source: 'export const one = 1\nexport const two = 2\n',
    path: '/work/src/a.ts',
    startLine: 1,
  })
  // The table is gone: no row handle, no footer key of the list.
  expect((await buttonKeys(ui)).some(k => /^r\d+$/.test(String(k)))).toBe(false)
  await ui.unmount()
})

test('preview: a source with control characters is drawn, not refused: the engine would blank the pane for one', async ($, on) => {
  // No NUL here: a NUL in the first 8 KB makes the file binary, and the provider shows a notice (file-preview.test.ts).
  const { ui } = await opened($, on, 'a\u001b[31mred\u0007\r\nb\rc\u0085\u007f\n')
  const [code] = await ui.findAll({ type: 'Code' })
  expect(code?.props.source).toBe('a\uFFFD[31mred\uFFFD\nb\uFFFDc\uFFFD\uFFFD\n')
  expect(await buttonKeys(ui)).toEqual(['preview', 'refresh'])
  await ui.unmount()
})

test('preview: a file over the caps shows its notice and a source within the cap, and keeps its keys', async ($, on) => {
  const { ui } = await opened($, on, `${'x'.repeat(99)}\n`.repeat(2500)) // 250,000 characters, 2,500 lines
  // 2,500 lines of 100 characters: the cap of 60,000 characters comes before the cap of 2,000 lines, and the notice says it.
  expect(await ui.find({ text: 'Truncated: the first 600 of 2500 lines.' })).toBeDefined()
  const [code] = await ui.findAll({ type: 'Code' })
  expect(String(code?.props.source).length).toBeLessThanOrEqual(60_000)
  expect(await buttonKeys(ui)).toEqual(['preview', 'refresh'])
  await ui.unmount()
})

test('preview: r reads the file again and does not refresh the trackers', async ($, on) => {
  const { ui, reads, w } = await opened($, on, 'one\n', {}, { ghAuthFails: 1 })
  // A pull request link gives the trackers work to do, so a refresh of them shows in the calls (as in the Refresh test of register.test.tsx).
  await $.session.append(response('https://github.com/cli/cli/pull/14640'))
  await w.clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(w.calls)
  await track($)
  await quiet(w.calls)
  const before = graphqlCalls(w.calls).length
  expect(before).toBeGreaterThan(0)
  await ui.press({ key: 'refresh' })
  await until(() => reads.length > 1, 'the second read of the file')
  await quiet(w.calls)
  expect(reads).toHaveLength(2)
  expect(graphqlCalls(w.calls).length).toBe(before) // a refresh of the trackers would have asked GitHub again
  expect(await ui.find({ text: 'Esc back' })).toBeDefined() // still the preview
  await ui.unmount()
})

test('preview: an inline pane of 11 body rows (100x40) gets the whole tall tree, keys first, for the engine to scroll', async ($, on) => {
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`)
  const { ui } = await opened($, on, `${lines.join('\n')}\n`, { placement: 'inline', bodyRows: 11, bodyColumns: 96 })
  expect(await ui.find({ text: 'Esc back' })).toBeDefined() // the key line is in the tree, before the content
  expect(await buttonKeys(ui)).toEqual(['preview', 'refresh'])
  const [code] = await ui.findAll({ type: 'Code' })
  // No window cuts the tree: the 60 lines are all in the one Code, and the engine scrolls it.
  expect(String(code?.props.source).split('\n').filter(Boolean)).toEqual(lines)
  await ui.unmount()
})
