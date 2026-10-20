// Kit pane tests (plan L6, Task 14; spec 7): the pane the person sees. One focus Button per row, a header row per
// section, Enter on a row, the selected row by id, the footer keys, the help view, the "N more" row, the theme colors and
// the largest list the store allows. The text of `/track` is in register.test.tsx. Every test awaits `ui.drawn()` before it
// reads the tree.
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'
import { BUDGET, fits, measure } from '../ux/tree-data-table/budget'
import { LIMITS } from './fixtures/limits'
import { focusOn, handleFor, headersOf, mountPane, type PaneUi, rowsOf, select } from './fixtures/pane'
import { HANG_GUARD, prompt, quiet, response, SESSION, START, track, world } from './fixtures/world'

type World = ReturnType<typeof world>
type On = Parameters<typeof world>[0]

const CONFIG = '/home/u/.config/claude-code/mods/tracker/config.json'
const withUi = (ui: object) => ({ [CONFIG]: JSON.stringify({ version: 1, global: { ui } }) })

/** Captured and listed: the rows of `text` are in the list and the pane can draw them. */
async function listed($: Engine, w: World, text: string, via = response): Promise<void> {
  await $.session.append(via(text))
  await w.clock.advance(LIMITS.captureDebounceMs + 10)
  await quiet(w.calls)
  await track($)
  await quiet(w.calls)
}

const LINKS = 'See https://one.example/ and https://two.example/'
const THREE = 'See https://one.example/ and https://two.example/ and https://three.example/'

/** A pane over `text`, mounted. The caller unmounts it. */
async function paneOver($: Engine, on: On, text: string): Promise<{ w: World; ui: PaneUi }> {
  const w = world(on)
  await listed($, w, text)
  return { w, ui: await mountPane($) }
}

const footerOf = async (ui: PaneUi) => (await ui.findAll({ type: 'Button' })).filter(b => b.props.hotkey !== undefined)
const footerKeys = async (ui: PaneUi) => (await footerOf(ui)).map(b => b.key)
const hotkeysOf = async (ui: PaneUi) => (await footerOf(ui)).map(b => b.props.hotkey)
const HOTKEYS = ['r', 'h', 'x', '1', '2', '3', '0']
const lineOf = (text: string, s: string) => text.split('\n').findIndex(l => l.includes(s))

// ---------------------------------------------------------------- rows

for (const surface of ['terminal', 'desktop'] as const) {
  // This test asserts no time. The kit stops it after 5 s, which a busy machine exceeds (issue #104). HANG_GUARD only
  // has to catch a hang.
  test(`pane: each section has a bold header row with its column headers (${surface})`, HANG_GUARD, async ($, on) => {
    const w = world(on)
    await listed($, w, 'Look at issue #5 and https://acme.atlassian.net/browse/ISS-1', prompt)
    const ui = await mountPane($, { surface })
    const headers = headersOf(await ui.drawn())
    expect(headers).toContainEqual(['Key', 'Summary', 'Type', 'Status'])
    expect(headers.some(h => h[0] === 'Ref' && h[1] === 'Title')).toBe(true)
    await ui.unmount()
  })

  test(`pane: every drawn row has exactly one Button, keyed r0, r1, … in order (${surface})`, async ($, on) => {
    const w = world(on)
    await listed($, w, 'Look at issue #5 and https://acme.atlassian.net/browse/ISS-1', prompt)
    const ui = await mountPane($, { surface })
    const rows = rowsOf(await ui.drawn())
    expect(rows.length).toBeGreaterThan(2)
    expect(rows.map(r => r.handle)).toEqual(rows.map((_, i) => `r${i}`))
    const buttons = await ui.findAll({ type: 'Button' })
    expect(buttons.length - (await footerOf(ui)).length).toBe(rows.length)
    await ui.unmount()
  })
}

test('pane: Enter on a Jira root hides its children and shows them again', async ($, on) => {
  const w = world(on)
  await listed($, w, 'Look at issue #5 and https://acme.atlassian.net/browse/ISS-1', prompt)
  const ui = await mountPane($)
  expect(await ui.find({ text: 'PROJ-201' })).toBeDefined()
  await ui.press({ key: await handleFor(ui, 'ISS-1') })
  expect(await ui.find({ text: 'PROJ-201' })).toBeUndefined()
  expect(await ui.find({ text: 'ISS-1' })).toBeDefined()
  await ui.press({ key: await handleFor(ui, 'ISS-1') })
  expect(await ui.find({ text: 'PROJ-201' })).toBeDefined()
  await ui.unmount()
})

test('pane: Enter on a leaf shows its default detail and the link; Enter again hides it', async ($, on) => {
  const w = world(on)
  await listed($, w, 'See https://one.example/')
  const ui = await mountPane($)
  expect(await ui.find({ text: 'link:' })).toBeUndefined()
  await ui.press({ key: await handleFor(ui, 'one.example') })
  expect(await ui.find({ text: 'link:' })).toBeDefined()
  expect((await ui.findAll({ type: 'Text' })).some(t => t.text === 'https://one.example/')).toBe(true)
  await ui.press({ key: await handleFor(ui, 'one.example') })
  expect(await ui.find({ text: 'link:' })).toBeUndefined()
  expect((await ui.findAll({ type: 'Text' })).some(t => t.text === 'https://one.example/')).toBe(false)
  await ui.unmount()
})

// ---------------------------------------------------------------- selection

test('pane: a focus on a row handle selects that row; a footer Button or the close mark keeps it', async ($, on) => {
  const { ui } = await paneOver($, on, LINKS)
  await focusOn($, 'r1')
  let rows = rowsOf(await ui.drawn())
  expect(rows.map(r => r.selected)).toEqual([false, true])
  expect(rows[1]).toMatchObject({ background: 'blue', text: expect.stringContaining('two.example') })
  expect(rows[0]?.background).toBeUndefined()
  await focusOn($, 'refresh')
  rows = rowsOf(await ui.drawn())
  expect(rows.map(r => r.selected)).toEqual([false, true])
  await focusOn($) // the close mark
  rows = rowsOf(await ui.drawn())
  expect(rows.map(r => r.selected)).toEqual([false, true])
  await ui.unmount()
})

test('pane: autoFocus sits on the first handle until a row is selected', async ($, on) => {
  const { ui } = await paneOver($, on, LINKS)
  expect(rowsOf(await ui.drawn()).map(r => r.autoFocus)).toEqual([true, false])
  await focusOn($, 'r1')
  expect(rowsOf(await ui.drawn()).map(r => r.autoFocus)).toEqual([false, false])
  await ui.unmount()
})

test('pane: /track clear forgets the selection and the open rows; a row tracked again starts plain', async ($, on) => {
  const { w, ui } = await paneOver($, on, LINKS)
  await select($, ui, 'two.example')
  await ui.press({ key: await handleFor(ui, 'two.example') })
  expect(await ui.find({ text: 'link:' })).toBeDefined()
  await track($, 'clear')
  await listed($, w, LINKS)
  await ui.redraw()
  const rows = rowsOf(await ui.drawn())
  expect(rows.map(r => r.selected)).toEqual([false, false])
  expect(rows.map(r => r.autoFocus)).toEqual([true, false])
  expect(await ui.find({ text: 'link:' })).toBeUndefined()
  await ui.unmount()
})

test('pane: 1 raises the selected row, draws ▲ and keeps the selection on it', async ($, on) => {
  const { ui } = await paneOver($, on, LINKS)
  await select($, ui, 'two.example')
  await ui.press({ key: 'prio-1' })
  const text = (await track($)).text ?? ''
  expect(lineOf(text, 'two.example')).toBeLessThan(lineOf(text, 'one.example'))
  const [first] = rowsOf(await ui.drawn())
  expect(first?.text).toContain('▲')
  expect(first?.text).toContain('two.example')
  expect(first?.selected).toBe(true)
  await ui.unmount()
})

// A Button drawn dim does nothing, whatever the route says. So these two tests check that the Button is dim, and the
// route behind a live Button with no row is proved in pane-session.test.ts ('a row key with no row selected or a stale one
// does nothing').
test('pane: a row key with no selected row is dim and changes nothing', async ($, on) => {
  const { ui } = await paneOver($, on, LINKS)
  const before = (await track($)).text
  for (const key of ['dismiss', 'prio-1']) {
    expect((await ui.findAll({ type: 'Button' })).find(b => b.key === key)?.props.dimColor, key).toBe(true)
    await ui.press({ key })
  }
  expect((await track($)).text).toBe(before)
  await ui.unmount()
})

test('pane: a focus on a row wakes the row keys of the footer by itself', async ($, on) => {
  const { ui } = await paneOver($, on, LINKS)
  const dim = async () =>
    (await ui.findAll({ type: 'Button' }))
      .filter(b => ['dismiss', 'prio-1', 'prio-2', 'prio-3', 'prio-0'].includes(b.key ?? ''))
      .map(b => b.props.dimColor)
  expect(await dim()).toEqual([true, true, true, true, true])
  await focusOn($, await handleFor(ui, 'two.example')) // no redraw call: the write of `selected` draws the pane again
  expect(await dim()).toEqual([undefined, undefined, undefined, undefined, undefined])
  await ui.unmount()
})

test('pane: x dismisses the selected row and selects the next one', async ($, on) => {
  const { ui } = await paneOver($, on, THREE)
  await select($, ui, 'two.example')
  await ui.press({ key: 'dismiss' })
  expect((await track($)).text).not.toContain('two.example')
  const rows = rowsOf(await ui.drawn())
  expect(rows.map(r => r.selected)).toEqual([false, true])
  expect(rows[1]?.text).toContain('three.example')
  await ui.unmount()
})

// The route of `x` and the digits on a row that cannot take them is proved in pane-session.test.ts ('a key on a row that
// cannot take it does nothing'); here the Buttons must draw dim.
test('pane: x and the digits are dim and inert on a process row', async ($, on) => {
  const { calls, fake } = world(on)
  fake.tools.Bash = { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'task-bg-1' }
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', tool_use_id: 'toolu_bg_1' } as never)
  await quiet(calls)
  await track($)
  const ui = await mountPane($)
  await select($, ui, 'npm run dev')
  const before = (await track($)).text
  for (const key of ['dismiss', 'prio-1']) {
    expect((await ui.findAll({ type: 'Button' })).find(b => b.key === key)?.props.dimColor).toBe(true)
    await ui.press({ key })
  }
  expect((await track($)).text).toBe(before)
  await ui.unmount()
})

// ---------------------------------------------------------------- footer and help

test('pane: every core key has one footer Button; their hotkeys are r h x 1 2 3 0', async ($, on) => {
  const { ui } = await paneOver($, on, LINKS)
  expect(await hotkeysOf(ui)).toEqual(HOTKEYS)
  expect(await footerKeys(ui)).toEqual(['refresh', 'help', 'dismiss', 'prio-1', 'prio-2', 'prio-3', 'prio-0'])
  const handles = (await ui.findAll({ type: 'Button' })).filter(b => /^r\d+$/.test(b.key ?? ''))
  expect(handles.length).toBe(2)
  for (const b of handles) expect(b.props.hotkey).toBeUndefined()
  await ui.unmount()
})

test('pane: with nothing tracked the seven footer Buttons are still drawn', async ($, on) => {
  world(on)
  const ui = await mountPane($)
  expect(rowsOf(await ui.drawn())).toEqual([])
  expect(await hotkeysOf(ui)).toEqual(HOTKEYS)
  await ui.unmount()
})

test('pane: h shows the help view with every key and the config path; h again returns', async ($, on) => {
  const { ui } = await paneOver($, on, LINKS)
  expect(rowsOf(await ui.drawn()).length).toBe(2)
  await ui.press({ key: 'help' })
  expect(await ui.find({ text: 'Row keys (act on the selected row)' })).toBeDefined()
  expect((await ui.findAll({ type: 'Text' })).some(t => t.text?.startsWith('Config file:'))).toBe(true)
  expect(rowsOf(await ui.drawn())).toEqual([])
  await ui.press({ key: 'help' })
  expect(await ui.find({ text: 'Row keys (act on the selected row)' })).toBeUndefined()
  expect(rowsOf(await ui.drawn()).length).toBe(2)
  await ui.unmount()
})

// The inline pane of a short terminal (issue #92): 100 columns and 40 rows give a body of 11 rows. The full help view with
// its footer needs 16 rows once the start ran: the started mod registers the row keys of the github tracker (a group
// title and two keys) and the help view has the version line of issue #65. The compact form keeps its first lines and the
// footer in view together.
const MANIFEST = JSON.stringify({ name: 'artifact-tracking', version: '1.2.3' })
// 9 help elements and the footer, one row each, with no gap: Pane keys (title, one line of keys), Row keys (title, two
// lines of keys), the github group (title, one line of keys), the config line and the version line.
const SHORT_ROWS = 10
// The help view of the live screen of issue #92: the config path of the e2e world, in the temp folder of macOS.
const LIVE_DIR = '/var/folders/sn/0_q8tr7x4vv44d69rbtyckwr0000gn/T/cc-tracker-config-SAq3DF'
const LIVE_PATH = `${LIVE_DIR}/config.json` // 86 cells: `Config file: <path>` is 99 cells and wraps at 96

/** The tree of the pane as `[help Box, footer Box]` and the gap between them. */
async function helpTree(ui: PaneUi) {
  const tree = (await ui.drawn()) as { props?: { rowGap?: number }; children: { children: unknown[] }[] }
  return { gap: tree.props?.rowGap ?? 0, help: tree.children[0]?.children ?? [], footer: tree.children[1] }
}

test('pane: h in a short inline pane draws the compact help view, so Pane keys and the footer fit the body', async ($, on) => {
  world(on, { manifest: MANIFEST })
  await track($) // the pane opens from /track, after the start has read the version
  const ui = await mountPane($, { bodyColumns: 96, bodyRows: 11, placement: 'inline' })
  await ui.press({ key: 'help' })
  const { gap, help, footer } = await helpTree(ui)
  expect(gap + help.length + 1).toBe(SHORT_ROWS)
  expect(gap + help.length + 1).toBeLessThanOrEqual(11 - 1) // the drawn view fits the body with one row of slack
  expect(JSON.stringify(help.at(-1))).toContain('Version: 1.2.3')
  expect(JSON.stringify(help[0])).toContain('Pane keys')
  expect(footer).toBeDefined()
  expect(await footerKeys(ui)).toEqual(['refresh', 'help', 'dismiss', 'prio-1', 'prio-2', 'prio-3', 'prio-0'])
  expect(await ui.find({ text: 'Row keys (act on the selected row)' })).toBeDefined()
  await ui.unmount()
})

// The started mod, the version line and the config path of the live screen together: the compact form must still show
// the `Pane keys` line and the footer at once in the 11-row body (the acceptance criterion of issue #92).
test('pane: h in a short inline pane with a started mod, the version and the live config path fits the 11-row body', async ($, on) => {
  world(on, { manifest: MANIFEST, disk: { [`${LIVE_DIR}/config.json`]: JSON.stringify({ version: 1 }) } })
  mock.env(on, { CLAUDE_TRACKER_CONFIG_DIR: LIVE_DIR, HOME: '/home/u' })
  await track($)
  const ui = await mountPane($, { bodyColumns: 96, bodyRows: 11, placement: 'inline' })
  await ui.press({ key: 'help' })
  const { gap, help, footer } = await helpTree(ui)
  const wrapped = 1 // `Config file: <86 cells>` does not fit 96 cells: the path takes its own row
  expect(gap + help.length + wrapped + 1).toBeLessThanOrEqual(11) // the help lines, the wrapped row and the footer fit
  expect(JSON.stringify(help.at(-2))).toContain(`Config file: ${LIVE_PATH}`)
  expect(JSON.stringify(help.at(-1))).toContain('Version: 1.2.3')
  expect(JSON.stringify(help[0])).toContain('Pane keys')
  expect(JSON.stringify(help)).toContain('resolve') // every key is drawn: the github keys too
  expect(JSON.stringify(help)).toContain('files')
  expect(footer).toBeDefined()
  expect(await footerKeys(ui)).toEqual(['refresh', 'help', 'dismiss', 'prio-1', 'prio-2', 'prio-3', 'prio-0'])
  await ui.unmount()
})

test('pane: h in a docked pane keeps the full help view, one key to a line', async ($, on) => {
  world(on, { manifest: MANIFEST })
  await track($)
  const ui = await mountPane($, { bodyColumns: 96, bodyRows: 28, placement: 'dock' })
  await ui.press({ key: 'help' })
  const { gap, help } = await helpTree(ui)
  expect(gap).toBe(1)
  expect(help).toHaveLength(14) // 3 titles, 9 keys (the started mod adds the github keys c and f), the config line, the version line
  expect(JSON.stringify(help[0])).toContain('Pane keys')
  expect(JSON.stringify(help[1])).toContain('refresh')
  await ui.unmount()
})

test('pane: a body shorter than the footer plus one line still draws the help view and every footer key', async ($, on) => {
  world(on)
  const ui = await mountPane($, { bodyColumns: 96, bodyRows: 1, placement: 'inline' })
  await ui.press({ key: 'help' })
  expect((await helpTree(ui)).help).toHaveLength(6) // no start: the compact form of the core keys, no version line
  expect(await hotkeysOf(ui)).toEqual(HOTKEYS)
  await ui.unmount()
})

// The kit has no `$.ui.close` at run time (`$.ui` holds render, scroll, focus, press, input, select and mount), so the
// close hook cannot be raised here. pane-session.test.ts holds the cases of `PaneSession.closed`: no selection, no help
// view, no refocus left over, and a failed write that does not stop the other.

// ---------------------------------------------------------------- caps

test('pane: a section over its cap ends in an N more row; Enter shows the next chunk', async ($, on) => {
  const w = world(on, { disk: withUi({ sectionRows: 5 }) })
  mock.env(on, { HOME: '/home/u' })
  await $.session.start(START)
  await listed(
    $,
    w,
    'See https://a.example/1 https://b.example/2 https://c.example/3 https://d.example/4 https://e.example/5 https://f.example/6 https://g.example/7',
  )
  const ui = await mountPane($)
  const more = async () => (await ui.findAll({ type: 'Button' })).filter(b => /^m\d+$/.test(b.key ?? ''))
  expect(rowsOf(await ui.drawn()).length).toBe(5)
  expect((await more()).map(b => b.text)).toEqual(['2 more'])
  await ui.press({ key: (await more())[0]?.key ?? 'none' })
  expect(rowsOf(await ui.drawn()).length).toBe(7)
  expect(await more()).toEqual([])
  await ui.unmount()
})

// ---------------------------------------------------------------- colors

test('pane: a status tone draws its theme color', async ($, on) => {
  const w = world(on)
  await listed($, w, 'https://github.com/cli/cli/pull/14640')
  const ui = await mountPane($)
  const texts = await ui.findAll({ type: 'Text' })
  expect(texts.find(t => t.text === 'open')?.props.color).toBe('success')
  expect(texts.find(t => t.text === '✗ checks')?.props.color).toBe('error')
  for (const t of texts) expect(String(t.props.color ?? '')).not.toContain(':')
  await ui.unmount()
})

// ---------------------------------------------------------------- the budget

const webRec = (n: number) => ({
  key: `web:https://page${n}.example/`,
  category: 'web',
  url: `https://page${n}.example/`,
  label: `Page number ${n}`,
  sources: ['response'],
  firstSeen: n,
  lastSeen: n,
  seenCount: 1,
})

test('pane: the largest list the store allows draws whole', { timeoutMs: 20_000 }, async ($, on) => {
  const items = Array.from({ length: 500 }, (_, i) => webRec(i + 1))
  world(on, {
    disk: withUi({ sectionRows: 300, maxRows: 1000 }),
    seed: { 'v2:index': [SESSION], ['v2:s:' + SESSION]: { items } },
  })
  mock.env(on, { HOME: '/home/u' })
  await $.session.start(START)
  const ui = await mountPane($)
  const buttons = async () => (await ui.findAll({ type: 'Button' })).map(b => b.key ?? '')
  expect(rowsOf(await ui.drawn()).length).toBe(300)
  const more = (await buttons()).find(k => /^m\d+$/.test(k))
  expect((await ui.findAll({ type: 'Button' })).find(b => b.key === more)?.text).toBe('200 more')
  await ui.press({ key: more ?? 'none' })
  const tree = await ui.drawn()
  expect(rowsOf(tree).length).toBe(500)
  const keys = await buttons()
  expect(keys.filter(k => /^r\d+$/.test(k)).length).toBe(500)
  expect((await footerOf(ui)).length).toBe(7)
  expect(keys.some(k => /^m\d+$/.test(k))).toBe(false)
  expect(fits(measure(tree), BUDGET)).toBe(true)
  await ui.unmount()
})

// ---------------------------------------------------------------- /track help

test('/track help prints the help view as text', async ($, on) => {
  world(on)
  const text = (await track($, 'help')).text ?? ''
  expect(text.startsWith('Pane keys\n  r  refresh\n  h  help')).toBe(true)
  expect(text).toContain('Config file:')
})
