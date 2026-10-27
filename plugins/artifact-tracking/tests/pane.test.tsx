// Kit pane tests (plan L6, Task 14; spec 7): the pane the person sees. One focus Button per row, a header row per
// section, Enter on a row, the selected row by id, the footer keys, the help view, the "N more" row, the theme colors and
// the largest list the store allows. The text of `/track` is in register.test.tsx. Every test awaits `ui.drawn()` before it
// reads the tree.
import type { Engine } from 'claude-code/testing'
import { expect, mock } from 'claude-code/testing'
import { RING_PAUSE_MS } from '../hooks/pane-refocus'
import { wrapRows } from '../ux/text/wrap'
import { BUDGET, fits, measure } from '../ux/tree-data-table/budget'
import { footerRows } from '../ux/tree-data-table/footer'
import { hintRows, NO_KEYS_HINT } from '../ux/tree-data-table/hint'
import { SUMMARY_ROWS } from '../ux/tree-data-table/status'
import { viewLineRows } from '../ux/tree-data-table/viewline'
import { HELP_FOOTER, HELP_FOOTER_ROWS, LIVE_VIEW_KEYS, NO_ROW_FOOTER, VIEW_LINE_KEYS } from './fixtures/drawn'
import { test } from './fixtures/kit'
import { LIMITS } from './fixtures/limits'
import { focusOn, handleFor, headersOf, mountPane, type PaneUi, rowsOf, select } from './fixtures/pane'
import { reasonsOfSources } from './fixtures/reasons'
import { prompt, quiet, response, SESSION, START, track, until, world } from './fixtures/world'

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

/**
 * The footer Buttons of the pane: the ones with a hotkey that are not on the view line (issue #63, L3). Do not use it on the help
 * view: its footer holds the keys of the view line too (`helpFooterOf`), and this leaves them out.
 */
const footerOf = async (ui: PaneUi) =>
  (await ui.findAll({ type: 'Button' })).filter(
    b => b.props.hotkey !== undefined && !VIEW_LINE_KEYS.includes(String(b.key)),
  )
const viewLineOf = async (ui: PaneUi) =>
  (await ui.findAll({ type: 'Button' })).filter(b => VIEW_LINE_KEYS.includes(String(b.key)))
const footerKeys = async (ui: PaneUi) => (await footerOf(ui)).map(b => b.key)
/**
 * The footer Buttons of the help view: every Button with a hotkey. The help view has no view line (issue #200), so `g`, `a`, `t`
 * and `m` are footer Buttons there, dim, after `0`. `footerOf` leaves them out.
 */
const helpFooterOf = async (ui: PaneUi) =>
  (await ui.findAll({ type: 'Button' })).filter(b => b.props.hotkey !== undefined)
const helpFooterKeys = async (ui: PaneUi) => (await helpFooterOf(ui)).map(b => b.key)
const HELP_FOOTER_KEYS = [...['refresh', 'help', 'dismiss', 'prio-1', 'prio-2', 'prio-3', 'prio-0'], ...VIEW_LINE_KEYS]
/**
 * The hotkey and label of every Button of the help footer that the pane drew, and of every key of `HELP_FOOTER` (the model that
 * `HELP_FOOTER_ROWS` counts). A test that fits the help view to the body takes `HELP_FOOTER_ROWS` and asserts the two lists equal,
 * so the rows it adds are the rows of the footer on the screen.
 */
const drawnHelpFooter = async (ui: PaneUi) =>
  (await helpFooterOf(ui)).map(b => ({ key: String(b.props.hotkey), label: String(b.props.label) }))
const modelHelpFooter = HELP_FOOTER.map(k => ({ key: k.key, label: k.label }))
const hotkeysOf = async (ui: PaneUi) => (await footerOf(ui)).map(b => b.props.hotkey)
const HOTKEYS = ['r', 'h', 'x', '1', '2', '3', '0']
const lineOf = (text: string, s: string) => text.split('\n').findIndex(l => l.includes(s))

// ---------------------------------------------------------------- rows

for (const surface of ['terminal', 'desktop'] as const) {
  test(`pane: one bold header row names the columns of every group, and no group has its own (${surface})`, async ($, on) => {
    const w = world(on)
    await listed($, w, 'Look at issue #5 and https://acme.atlassian.net/browse/ISS-1', prompt)
    const ui = await mountPane($, { surface })
    expect(headersOf(await ui.drawn())).toEqual([['Name', 'Description', 'Type', 'Status']])
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
    expect(buttons.length - (await footerOf(ui)).length - (await viewLineOf(ui)).length).toBe(rows.length)
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

// Issue #108: the ring of a pane that takes the keys again starts on the selected row, so the first Down does not jump
// to the first row.
test('pane: autoFocus sits on the first handle until a row is selected, then on the handle of the selected row', async ($, on) => {
  const { ui } = await paneOver($, on, LINKS)
  expect(rowsOf(await ui.drawn()).map(r => r.autoFocus)).toEqual([true, false])
  await focusOn($, 'r1')
  expect(rowsOf(await ui.drawn()).map(r => r.autoFocus)).toEqual([false, true])
  await ui.unmount()
})

// Issue #108, option 2: a click is a press. A press on a row selects it, besides opening or closing it.
test('pane: a press on a row selects that row and opens it', async ($, on) => {
  const { ui } = await paneOver($, on, THREE)
  expect(rowsOf(await ui.drawn()).map(r => r.selected)).toEqual([false, false, false])
  await ui.press({ key: await handleFor(ui, 'two.example') })
  await ui.redraw() // an isolated world answers `state.set` itself: draw once more, as `select()` does
  const rows = rowsOf(await ui.drawn())
  expect(rows.map(r => r.selected)).toEqual([false, true, false])
  expect(rows[1]?.background).toBe('blue')
  expect(await ui.find({ text: 'link:' })).toBeDefined()
  await ui.press({ key: await handleFor(ui, 'three.example') })
  await ui.redraw()
  expect(rowsOf(await ui.drawn()).map(r => r.selected)).toEqual([false, false, true])
  await ui.unmount()
})

// Issue #115. A press on a row selects it, and the pane must also get the keys, or the next Up or Down goes to the prompt.
// `ui.open` with `focus: true` is the one call that grants the keyboard (`ui.focus` is refused without it). The kit cannot
// hand a pane the keys, so this pins the ask and the wiring of the port. That Down then moves the selection is e2e and live.
test('pane: a press on a row of a pane with no keys asks the engine for the keys; a pane with the keys asks for none', async ($, on) => {
  const w = world(on)
  await listed($, w, THREE)
  for (const [isFocused, asked] of [
    [false, 1],
    [true, 0],
  ] as const) {
    const ui = await mountPane($, { isFocused })
    const before = w.opened.length
    await ui.press({ key: await handleFor(ui, 'two.example') })
    if (asked > 0) await until(() => w.opened.length > before, 'the ask for the keys')
    await ui.redraw()
    await quiet(w.calls) // no more calls come: a pane with the keys asks for none
    expect(rowsOf(await ui.drawn()).map(r => r.selected)).toEqual([false, true, false])
    expect(w.opened.slice(before)).toHaveLength(asked)
    if (asked > 0) expect(w.opened.at(-1)).toMatchObject({ id: 'track', focus: true })
    await ui.unmount()
  }
})

// Issue #108, option 4: with no keys the highlight is not live. The keys go to the prompt box, and the pane says so.
const NO_KEYS = 'ctrl+x Tab'

test('pane: a pane with no keys draws no background and says the keys go to the prompt', async ($, on) => {
  const w = world(on)
  await listed($, w, LINKS)
  const ui = await mountPane($, { isFocused: false })
  await select($, ui, 'two.example')
  const rows = rowsOf(await ui.drawn())
  expect(rows.map(r => r.selected)).toEqual([false, true]) // the marker stays: it is where the selection is
  expect(rows[1]?.background).toBeUndefined()
  const hint = (await ui.findAll({ type: 'Text' })).find(t => t.text?.includes(NO_KEYS))
  expect(hint?.text).toContain('prompt')
  expect(hint?.props.dimColor).toBe(true)
  await ui.unmount()
})

// The live check of the no-keys state is one terminal run. `Pane.isFocused` is `types-only` on the desktop: the engine may
// report `false` there while the person uses the mouse. This pins what the desktop pane draws for each value, so the
// behavior is known whichever way the engine goes.
test('pane: a desktop pane draws the marker dim and the hint when isFocused is false, and the background when true', async ($, on) => {
  const w = world(on)
  await listed($, w, LINKS)
  for (const [isFocused, background] of [
    [false, undefined],
    [true, 'blue'],
  ] as const) {
    const ui = await mountPane($, { surface: 'desktop', isFocused })
    await select($, ui, 'two.example')
    const rows = rowsOf(await ui.drawn())
    expect(rows.map(r => r.selected)).toEqual([false, true])
    expect(rows[1]?.background).toBe(background)
    const hint = (await ui.findAll({ type: 'Text' })).find(t => t.text?.includes(NO_KEYS))
    expect(hint !== undefined).toBe(!isFocused)
    await ui.unmount()
  }
})

test('pane: a pane with the keys draws the background and no hint', async ($, on) => {
  const { ui } = await paneOver($, on, LINKS)
  await select($, ui, 'two.example')
  expect(rowsOf(await ui.drawn())[1]?.background).toBe('blue')
  expect((await ui.findAll({ type: 'Text' })).some(t => t.text?.includes(NO_KEYS))).toBe(false)
  await ui.unmount()
})

test('pane: the help view of a pane with no keys draws no hint line, so it still fits the body', async ($, on) => {
  world(on)
  const ui = await mountPane($, { isFocused: false })
  await ui.press({ key: 'help' })
  expect((await ui.findAll({ type: 'Text' })).some(t => t.text?.includes(NO_KEYS))).toBe(false)
  expect(await ui.find({ text: 'Row keys (act on the selected or marked rows)' })).toBeDefined()
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

// Issue #138, through the engine: `m` marks the selected row, `x` asks about the marked rows and the second `x` dismisses them.
// The cases of the question (a double tap, a key that ends it, a ring move) are in pane-session.test.ts.
test('pane: m marks rows, x asks about them, the second x dismisses them and the marks end', async ($, on) => {
  const { ui } = await paneOver($, on, THREE)
  for (const row of ['one.example', 'three.example']) {
    await select($, ui, row)
    await ui.press({ key: 'mark' })
    await ui.redraw()
  }
  expect(rowsOf(await ui.drawn()).map(r => r.text.includes('*'))).toEqual([true, false, true])
  expect(await ui.find({ text: 'View: list · 2 marked' })).toBeDefined()
  await ui.press({ key: 'dismiss' })
  await ui.redraw()
  expect(await ui.find({ text: 'Dismiss 2 marked rows? x again: yes' })).toBeDefined()
  const asked = (await track($)).text
  expect(asked).toContain('one.example')
  expect(asked).toContain('three.example') // asking dismisses nothing
  await ui.press({ key: 'dismiss' })
  await ui.redraw()
  const left = (await track($)).text
  expect(left).toContain('two.example')
  expect(left).not.toContain('one.example')
  expect(left).not.toContain('three.example')
  expect(rowsOf(await ui.drawn()).map(r => r.text.includes('*'))).toEqual([false])
  expect(await ui.find({ text: 'View: list' })).toBeDefined()
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

// Issue #193. The wake behind the ring pause must be a timer of the mod's own runtime, not a call of `$`: a hook can refuse
// the engine clock and no hook can refuse a `setTimeout`. Every other test of the pause runs on `fakePorts`, whose wake is
// never refused whatever the real port does, and `register.tsx` is outside the node coverage run. This one goes through the
// real port (`portsOf`): the engine timer of the pause is refused, and the kit clock moves only when a test moves it, so
// only a wake that is a real timer can end the pause. The pause reads the real wall clock (`wall: Date.now`), and a drawing
// that returns after its deadline of `RING_PAUSE_MS` ends it too, and cancels the wake: no line is then written. So the test
// must cause no drawing after the one frame of the press. It adds none, and the press itself draws that frame. A drawing
// that a test adds there makes the test flaky on a loaded machine, because it may land late. The line that the wake writes
// when it wins is the proof, and the test waits for it (causality, no wall time). It fails, with a timeout at `until`, when
// `wake` in `register.tsx` is made a call of `$.clock.after`. The ring request itself is out of reach: the kit cannot show a
// `$.ui.focus` call of the mod (gotchas.md, row 69), so the log line stands for "the wait ended".
test('pane: h with the engine timer of the ring pause refused ends its pause by the wake of the runtime', async ($, on) => {
  const w = world(on, { refuseAfter: RING_PAUSE_MS })
  await listed($, w, LINKS)
  const ui = await mountPane($)
  await focusOn($, 'help') // the person moves the ring onto h: help, so the mod knows where it is and `h` asks for it again
  const wakeLines = () =>
    w.fake.logs.filter(l => l.text.startsWith(`pane ring pause: the engine timer of ${RING_PAUSE_MS} ms did not fire`))
  await ui.press({ key: 'help' }) // draws the help view: the one frame, and no drawing follows it
  await until(() => wakeLines().length > 0, 'the wake that ends the refused ring pause')
  expect(wakeLines().map(l => l.to)).toEqual(['debug']) // one line, to the debug log
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
  expect(await ui.find({ text: 'Row keys (act on the selected or marked rows)' })).toBeDefined()
  expect((await ui.findAll({ type: 'Text' })).some(t => t.text?.startsWith('Config file:'))).toBe(true)
  expect(rowsOf(await ui.drawn())).toEqual([])
  await ui.press({ key: 'help' })
  expect(await ui.find({ text: 'Row keys (act on the selected or marked rows)' })).toBeUndefined()
  expect(rowsOf(await ui.drawn()).length).toBe(2)
  await ui.unmount()
})

// The inline pane of a short terminal (issue #92): 100 columns and 40 rows give a body of 11 rows. The full help view with
// its footer needs 18 rows once the start ran: the started mod registers the row keys of the github tracker (a group
// title and two keys) and the copy key of the questions tracker (a group title and one key), and the help view has the
// version line of issue #65. The compact form keeps its first lines and the footer in view together.
const MANIFEST = JSON.stringify({ name: 'artifact-tracking', version: '1.2.3' })
// The body of the inline pane at 100x40: 11 rows for the help lines and the footer, with no gap. The help lines: Pane keys
// (title, one line of keys), Row keys (title, one line of keys), the groups of the trackers on one row, the config line and the
// version line. The footer takes two rows since issue #200: the four dim Buttons of g, a, t and m wrap it.
const SHORT_ROWS = 11
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
  // The footer holds the four dim Buttons of g, a, t and m since issue #200, so it takes two rows at 96 cells, not one: the view
  // is 9 rows beside it (it was 10 beside a 1-row footer) and the two fill the body to the row.
  expect(await drawnHelpFooter(ui)).toEqual(modelHelpFooter)
  expect(HELP_FOOTER_ROWS).toBe(2)
  expect(gap + help.length + HELP_FOOTER_ROWS).toBe(SHORT_ROWS)
  expect(gap + help.length + HELP_FOOTER_ROWS).toBeLessThanOrEqual(11) // the view and the footer fit the body
  expect(JSON.stringify(help.at(-1))).toContain('Version: 1.2.3')
  expect(JSON.stringify(help[0])).toContain('Pane keys')
  expect(footer).toBeDefined()
  expect(await helpFooterKeys(ui)).toEqual(HELP_FOOTER_KEYS)
  expect(await footerKeys(ui)).toEqual(['refresh', 'help', 'dismiss', 'prio-1', 'prio-2', 'prio-3', 'prio-0'])
  expect(await ui.find({ text: 'Row keys (act on the selected or marked rows)' })).toBeDefined()
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
  expect(await drawnHelpFooter(ui)).toEqual(modelHelpFooter) // two rows since issue #200: the four dim Buttons of g, a, t and m wrap the footer
  expect(HELP_FOOTER_ROWS).toBe(2)
  expect(gap + help.length + wrapped + HELP_FOOTER_ROWS).toBeLessThanOrEqual(11) // the help lines, the wrapped row and the footer fit
  expect(JSON.stringify(help.at(-2))).toContain(`Config file: ${LIVE_PATH}`)
  expect(JSON.stringify(help.at(-1))).toContain('Version: 1.2.3')
  expect(JSON.stringify(help[0])).toContain('Pane keys')
  expect(JSON.stringify(help)).toContain('resolve') // every key is drawn: the github keys too
  expect(JSON.stringify(help)).toContain('files')
  expect(footer).toBeDefined()
  expect(await helpFooterKeys(ui)).toEqual(HELP_FOOTER_KEYS)
  for (const b of (await helpFooterOf(ui)).slice(7)) expect(b.props.dimColor, String(b.key)).toBe(true) // g, a, t and m draw dim
  await ui.unmount()
})

test('pane: h in a docked pane keeps the full help view, one key to a line', async ($, on) => {
  world(on, { manifest: MANIFEST })
  await track($)
  const ui = await mountPane($, { bodyColumns: 96, bodyRows: 28, placement: 'dock' })
  await ui.press({ key: 'help' })
  const { gap, help } = await helpTree(ui)
  expect(gap).toBe(1)
  // 4 titles, 14 keys (g, a, t and m, the github keys c and f and the questions key y of the started mod), the config line, the version line
  expect(help).toHaveLength(20)
  expect(JSON.stringify(help[0])).toContain('Pane keys')
  expect(JSON.stringify(help[1])).toContain('refresh')
  await ui.unmount()
})

// The cap on the config problems (issue #144): a file with 60 unknown keys gives 50 problems and a count of 10. The inline
// body of 11 rows has no row left for a problem, so the compact form counts all 60. A tall body takes the full form.
const withUnknownKeys = (n: number) => ({
  [CONFIG]: JSON.stringify({ global: Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i])) }),
})

test('pane: h with 60 config problems in a short inline pane counts all 60 and keeps Pane keys and the footer in view', async ($, on) => {
  world(on, { manifest: MANIFEST, disk: withUnknownKeys(60) })
  mock.env(on, { HOME: '/home/u' })
  await track($)
  const ui = await mountPane($, { bodyColumns: 96, bodyRows: 11, placement: 'inline' })
  await ui.press({ key: 'help' })
  const { gap, help, footer } = await helpTree(ui)
  expect(JSON.stringify(help.at(-1))).toContain('60 problems: /track help') // 50 listed and 10 left out
  expect(JSON.stringify(help[0])).toContain('Pane keys')
  expect(JSON.stringify(help)).not.toContain('debug log') // the count line of the config is no problem of the view
  expect(await drawnHelpFooter(ui)).toEqual(modelHelpFooter)
  expect(gap + help.length + HELP_FOOTER_ROWS).toBeLessThanOrEqual(11) // the help lines and the footer fit the body: the path is short
  expect(footer).toBeDefined()
  await ui.unmount()
})

test('pane: h with 60 config problems in a tall pane lists 50, then one line that counts the rest and names the log', async ($, on) => {
  world(on, { manifest: MANIFEST, disk: withUnknownKeys(60) })
  mock.env(on, { HOME: '/home/u' })
  await track($)
  const ui = await mountPane($, { bodyColumns: 96, bodyRows: 200, placement: 'dock' })
  await ui.press({ key: 'help' })
  const { help } = await helpTree(ui)
  const texts = help.map(n => JSON.stringify(n))
  expect(texts.filter(t => t.includes('unknown key'))).toHaveLength(50)
  expect(texts.at(-1)).toContain('10 more problems: see /home/u/.claude/debug/latest (claude --debug)')
  expect(texts.at(-2)).toContain('global.k49: unknown key')
  await ui.unmount()
})

test('pane: a body shorter than the footer plus one line still draws the help view and every footer key', async ($, on) => {
  world(on)
  const ui = await mountPane($, { bodyColumns: 96, bodyRows: 1, placement: 'inline' })
  await ui.press({ key: 'help' })
  // No start: nothing fits, so the fewest rows: 2 titles, 2 lines of keys (the six row keys, m among them, hold one line: each group's columns are as wide as its widest key), the config line
  expect((await helpTree(ui)).help).toHaveLength(5)
  expect(await helpFooterKeys(ui)).toEqual(HELP_FOOTER_KEYS) // the four dim Buttons of g, a, t and m too, not only the 7 of the pane
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

// ---------------------------------------------------------------- the views (issue #63, L3)

test('pane: g cycles by list, by status and flat: the group titles and the view line change, the row stays selected', async ($, on) => {
  const { ui } = await paneOver($, on, LINKS)
  await focusOn($, 'r1')
  expect(await ui.find({ text: 'Web links' })).toBeDefined()
  expect(await ui.find({ text: 'View: list' })).toBeDefined()
  await ui.press({ key: 'view' })
  // A web link has no state to speak of: the status token is none, so by status it is the one group, "No status".
  expect(await ui.find({ text: 'No status' })).toBeDefined()
  expect(await ui.find({ text: 'Web links' })).toBeUndefined()
  expect(await ui.find({ text: 'View: status' })).toBeDefined()
  expect(rowsOf(await ui.drawn()).filter(r => r.selected).length).toBe(1)
  await ui.press({ key: 'view' })
  expect(await ui.find({ text: 'All' })).toBeDefined()
  expect(await ui.find({ text: 'View: flat' })).toBeDefined()
  await ui.press({ key: 'view' })
  expect(await ui.find({ text: 'Web links' })).toBeDefined()
  expect(await ui.find({ text: 'View: list' })).toBeDefined()
  await ui.unmount()
})

test('pane: /track view and global.ui.view set the view the pane opens in; g then goes on from there', async ($, on) => {
  const w = world(on, { disk: withUi({ view: 'status', views: ['status', 'reason'] }) })
  mock.env(on, { HOME: '/home/u' })
  await $.session.start(START)
  await listed($, w, LINKS)
  const ui = await mountPane($)
  expect(await ui.find({ text: 'View: status' })).toBeDefined()
  await ui.press({ key: 'view' })
  expect(await ui.find({ text: 'View: reason' })).toBeDefined()
  expect(await ui.find({ text: 'Mentioned' })).toBeDefined() // the links were named in a reply: the strongest reason
  await ui.unmount()
})

test('pane: t hides the rows that were only mentioned, and a second t shows them again; the view line counts them', async ($, on) => {
  const { ui } = await paneOver($, on, LINKS)
  expect(rowsOf(await ui.drawn()).length).toBe(2)
  await ui.press({ key: 'touched' })
  expect(rowsOf(await ui.drawn())).toEqual([])
  expect(await ui.find({ text: 'View: list · touched only · 2 hidden' })).toBeDefined()
  await ui.press({ key: 'touched' })
  expect(rowsOf(await ui.drawn()).length).toBe(2)
  expect(await ui.find({ text: 'View: list' })).toBeDefined()
  await ui.unmount()
})

// ---------------------------------------------------------------- the window (issue #109)

// The engine scrolls a pane tree as a whole, so rows taller than the body push the title, the header and the footer out of
// view. The pane draws a window of the rows instead. The inline pane at 100x40 has a body of 11 rows, the docked pane at
// 120x37 one of 31 (drawn here 95 cells wide as in #109; the live check of issue #63 measured 49 cells, which
// tests/one-table.test.ts holds). The kit does not show paint or the focus ring: the live checks of the PR do.
const links = (n: number) => Array.from({ length: n }, (_, i) => `https://site${i}.example/page${i}`).join(' ')
const INLINE = { bodyColumns: 96, bodyRows: 11, placement: 'inline' } as const
const DOCKED = { bodyColumns: 95, bodyRows: 31, placement: 'dock' } as const
const handlesIn = async (ui: PaneUi) =>
  (await ui.findAll({ type: 'Button' })).map(b => b.key ?? '').filter(k => /^r\d+$/.test(k))
const stops = async (ui: PaneUi) =>
  ((await ui.findAll({ type: 'Box' })) as unknown as { props: Record<string, unknown> }[]).filter(
    b => b.props.height === 0,
  )

test('pane: inline 100x40 with 12 links shows the title, the header and the footer with the rows that fit', async ($, on) => {
  const w = world(on)
  await listed($, w, links(12))
  const ui = await mountPane($, INLINE)
  const tree = await ui.drawn()
  // The view line takes one of the 11 rows (issue #63, L3): 5 of the 12 rows show where 6 did.
  expect(rowsOf(tree)).toHaveLength(5)
  expect(await ui.find({ text: 'Web links' })).toBeDefined()
  expect(headersOf(tree)).toContainEqual(['Name', 'Description'])
  expect(await footerKeys(ui)).toEqual(['refresh', 'help', 'dismiss', 'prio-1', 'prio-2', 'prio-3', 'prio-0'])
  expect(await ui.find({ text: '▼ 7 more below' })).toBeDefined()
  expect(await ui.find({ text: /more above/ })).toBeUndefined()
  expect(await ui.find({ text: 'View: list' })).toBeDefined()
  expect((await viewLineOf(ui)).map(b => b.props.hotkey)).toEqual(['g', 'a', 't', 'm'])
  await ui.unmount()
})

test('pane: docked 120x37 with 36 links shows the title, the header and the footer with the rows that fit', async ($, on) => {
  const w = world(on)
  await listed($, w, links(36))
  const ui = await mountPane($, DOCKED)
  const tree = await ui.drawn()
  // The view line takes one of the 26 rows. The status area (issue #138) takes three more: the summary row above the table, and the
  // selected-row line and the health line in the footer Box.
  expect(rowsOf(tree)).toHaveLength(22)
  expect(await ui.find({ text: 'Web links' })).toBeDefined()
  expect(headersOf(tree)).toContainEqual(['Name', 'Description'])
  expect(await footerKeys(ui)).toEqual(['refresh', 'help', 'dismiss', 'prio-1', 'prio-2', 'prio-3', 'prio-0'])
  expect(await ui.find({ text: '▼ 14 more below' })).toBeDefined()
  await ui.unmount()
})

// Issue #138, PR 2: with 18 body rows or more, docked or inline, the pane draws a summary row above the table and the selected-row
// line and the health line in the footer Box. A pane of 120x37 has 31 body rows, one of 100x60 has 18, and one of 100x40 has 11.
const lines = async (ui: PaneUi) => (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '')

test('pane: docked 120x37 draws the summary, the selected row and the health beside the view line and the footer', async ($, on) => {
  const w = world(on)
  await listed($, w, links(36))
  const ui = await mountPane($, DOCKED)
  await ui.drawn()
  const text = await lines(ui)
  expect(text[0]).toBe('Links 36') // the words of the band, the first line of the pane
  expect(text).toContain('No row selected') // nothing is selected when the pane opens
  expect(text).toContain('Health:')
  expect(text).toContain('View: list')
  expect(await footerKeys(ui)).toEqual(['refresh', 'help', 'dismiss', 'prio-1', 'prio-2', 'prio-3', 'prio-0'])
  // A ring move onto a row selects it: the line names it, after its label.
  await select($, ui, 'site3.example')
  const after = await lines(ui)
  expect(after).toContain('Selected:')
  expect(after).not.toContain('No row selected')
  expect(after[after.indexOf('Selected:') + 1]).toContain('site3.example/page3') // a Link: the Text holds its href too
  await ui.unmount()
})

test('pane: inline 100x60 (18 body rows) draws the full form, also while the keys are in the prompt', async ($, on) => {
  const w = world(on)
  await listed($, w, links(36))
  const tall = { bodyColumns: 96, bodyRows: 18, placement: 'inline' } as const
  for (const isFocused of [true, false]) {
    const ui = await mountPane($, { ...tall, isFocused })
    await ui.drawn()
    const text = await lines(ui)
    expect(text, String(isFocused)).toContain('No row selected')
    expect(text, String(isFocused)).toContain('Health:')
    expect(await footerKeys(ui), String(isFocused)).toEqual([
      'refresh',
      'help',
      'dismiss',
      'prio-1',
      'prio-2',
      'prio-3',
      'prio-0',
    ])
    await ui.unmount()
  }
})

test('pane: inline 100x40 (11 body rows) and 17 rows draw no status area: the view line and the footer, as before', async ($, on) => {
  const w = world(on)
  await listed($, w, links(12))
  for (const bodyRows of [11, 17]) {
    const ui = await mountPane($, { bodyColumns: 96, bodyRows, placement: 'inline' })
    await ui.drawn()
    const text = await lines(ui)
    expect(text, String(bodyRows)).not.toContain('No row selected')
    expect(text, String(bodyRows)).not.toContain('Health:')
    expect(text, String(bodyRows)).toContain('View: list')
    await ui.unmount()
  }
})

test('pane: the health line names the tools of the trackers that run, with their notes', async ($, on) => {
  const w = world(on)
  await listed($, w, links(3))
  const ui = await mountPane($, DOCKED)
  await ui.drawn()
  const text = (await lines(ui)).join('\n')
  expect(text).toContain('gh ready')
  expect(text).toContain('acli ready')
  expect(text).toContain('no problems')
  await ui.unmount()
})

test('pane: the health line leaves out the tool of a tracker that the config turned off', async ($, on) => {
  const w = world(on, { disk: { [CONFIG]: JSON.stringify({ version: 1, trackers: { jira: { enabled: false } } }) } })
  mock.env(on, { HOME: '/home/u' })
  await listed($, w, links(3))
  const ui = await mountPane($, DOCKED)
  await ui.drawn()
  const text = (await lines(ui)).join('\n')
  expect(text).toContain('gh ready')
  expect(text).not.toContain('acli') // never probed: it would say `checking…` for good
  await ui.unmount()
})

// Issue #109, review finding M2: a pane that has no keys draws one hint line above the tree (issue #108). The window gets
// the rows below that line, else the tree is one line too tall, the engine scrolls and the footer drops out of view.
test('pane: a windowed pane with no keys keeps the title, the header, the hint and the footer in view', async ($, on) => {
  const w = world(on)
  await listed($, w, links(12))
  const ui = await mountPane($, { ...INLINE, isFocused: false })
  const tree = await ui.drawn()
  const rows = rowsOf(tree).length
  expect(rows).toBe(4) // one row less than the pane that has the keys
  expect(await ui.find({ text: 'Web links' })).toBeDefined()
  expect(headersOf(tree)).toContainEqual(['Name', 'Description'])
  expect((await ui.findAll({ type: 'Text' })).some(t => t.text === NO_KEYS_HINT)).toBe(true)
  expect(await ui.find({ text: '▼ 8 more below' })).toBeDefined()
  expect(await footerKeys(ui)).toEqual(['refresh', 'help', 'dismiss', 'prio-1', 'prio-2', 'prio-3', 'prio-0'])
  // The hint line, the title, the header, the rows, the hint below, the gap, the view line and the footer are the body, to the line.
  expect(1 + 2 + rows + 1 + 1 + 1 + 1).toBe(INLINE.bodyRows)
  await ui.unmount()
})

test('pane: a hint line that wraps in a narrow body costs the window both of its rows', async ($, on) => {
  const w = world(on)
  await listed($, w, links(12))
  const narrow = { bodyColumns: 40, bodyRows: 16, placement: 'inline' } as const
  const hint = wrapRows(NO_KEYS_HINT, narrow.bodyColumns)
  const footer = footerRows(NO_ROW_FOOTER, narrow.bodyColumns, false)
  // `View: list` and the three keys do not fit 40 cells in one row: the view line takes two (issue #63, L3).
  const line = viewLineRows({ text: 'View: list', keys: LIVE_VIEW_KEYS }, narrow.bodyColumns)
  expect(hint).toBe(2)
  expect(line).toBe(2)
  const ui = await mountPane($, { ...narrow, isFocused: false })
  const rows = rowsOf(await ui.drawn()).length
  expect(hint + 2 + rows + 1 + 1 + line + footer).toBe(narrow.bodyRows)
  await ui.unmount()
})

test('pane: a pane that has the keys gives the window the whole body: no hint line to pay for', async ($, on) => {
  const w = world(on)
  await listed($, w, links(12))
  const ui = await mountPane($, { ...INLINE, isFocused: true })
  expect(rowsOf(await ui.drawn())).toHaveLength(5)
  expect((await ui.findAll({ type: 'Text' })).some(t => t.text === NO_KEYS_HINT)).toBe(false)
  await ui.unmount()
})

// Issue #109, the owner's wish: with fewer rows than the body holds, the footer sits at the bottom of the pane. A docked body
// has a fixed height, so the tree takes all of it and the footer grows to the end. An inline pane is as tall as its tree
// (`Pane.scroll`: "Inline the frame fits the tree"): padding it would stretch every pane, so it stays under the last row.
const pinOf = async (ui: PaneUi) =>
  ((await ui.findAll({ type: 'Box' })) as unknown as { props: Record<string, unknown> }[])
    .map(b => b.props)
    .filter(p => p.minHeight !== undefined || p.flexGrow !== undefined)

test('pane: docked with 3 links, the footer sits at the bottom of the body', async ($, on) => {
  const w = world(on)
  await listed($, w, links(3))
  const ui = await mountPane($, DOCKED)
  expect(rowsOf(await ui.drawn())).toHaveLength(3)
  expect(await pinOf(ui)).toEqual([
    expect.objectContaining({ minHeight: DOCKED.bodyRows - SUMMARY_ROWS }), // the body less the summary row of the full status area
    expect.objectContaining({ flexGrow: 1, justifyContent: 'flex-end' }),
  ])
  expect(await footerKeys(ui)).toEqual(['refresh', 'help', 'dismiss', 'prio-1', 'prio-2', 'prio-3', 'prio-0'])
  await ui.unmount()
})

test('pane: docked with 3 links and no keys, the tree and the hint line above it fill the body together', async ($, on) => {
  const w = world(on)
  await listed($, w, links(3))
  const ui = await mountPane($, { ...DOCKED, isFocused: false })
  // The hint line and the summary row are the first rows of the body.
  expect((await pinOf(ui))[0]).toMatchObject({
    minHeight: DOCKED.bodyRows - hintRows(DOCKED.bodyColumns) - SUMMARY_ROWS,
  })
  await ui.unmount()
})

test('pane: inline with 3 links, nothing is padded: the footer stays under the last row', async ($, on) => {
  const w = world(on)
  await listed($, w, links(3))
  const ui = await mountPane($, INLINE)
  expect(rowsOf(await ui.drawn())).toHaveLength(3)
  expect(await pinOf(ui)).toEqual([])
  await ui.unmount()
})

test('pane: a tall body shows all 12 links, with no hint and no stop', async ($, on) => {
  const w = world(on)
  await listed($, w, links(12))
  const ui = await mountPane($, { ...DOCKED, bodyRows: 40 })
  expect(rowsOf(await ui.drawn())).toHaveLength(12)
  expect(await ui.find({ text: /more (above|below)/ })).toBeUndefined()
  expect(await stops(ui)).toEqual([])
  await ui.unmount()
})

test('pane: every row keeps a Button in the same order, so Tab and the arrows walk all 12 rows', async ($, on) => {
  const w = world(on)
  await listed($, w, links(12))
  const ui = await mountPane($, INLINE)
  expect(await handlesIn(ui)).toEqual(Array.from({ length: 12 }, (_, i) => `r${i}`))
  expect(await stops(ui)).toHaveLength(7) // the 7 rows out of the window are bare stops
  await ui.unmount()
})

test('pane: the ring walks down every row and back up; the window follows and the selected row stays in view', async ($, on) => {
  const w = world(on)
  await listed($, w, links(12))
  const ui = await mountPane($, INLINE)
  const walk = [...Array.from({ length: 12 }, (_, i) => i), ...Array.from({ length: 11 }, (_, i) => 10 - i)]
  for (const at of walk) {
    await focusOn($, `r${at}`) // Tab or an arrow: the ring lands on the stop, the hook selects its row
    await ui.redraw() // a world with isolateState answers state.set itself, so the pane is drawn once more here
    const rows = rowsOf(await ui.drawn())
    expect(rows.length, `row ${at}`).toBeLessThanOrEqual(6)
    expect(rows.find(r => r.selected)?.handle, `row ${at}`).toBe(`r${at}`)
    expect(await footerKeys(ui), `row ${at}`).toHaveLength(7)
    expect(await ui.find({ text: 'Web links' }), `row ${at}`).toBeDefined()
  }
  await ui.unmount()
})

test('pane: a focus on a stop below the window moves the window by the least, with no hint left below at the end', async ($, on) => {
  const w = world(on)
  await listed($, w, links(12))
  const ui = await mountPane($, INLINE)
  await focusOn($, 'r5') // the first stop below the window
  await ui.redraw()
  let rows = rowsOf(await ui.drawn())
  expect(rows.map(r => r.handle)).toEqual(['r2', 'r3', 'r4', 'r5']) // a hint above and one below take 2 of the 8 lines
  expect(rows.find(r => r.selected)?.handle).toBe('r5')
  await focusOn($, 'r11')
  await ui.redraw()
  rows = rowsOf(await ui.drawn())
  expect(rows.at(-1)?.handle).toBe('r11')
  expect(await ui.find({ text: /more below/ })).toBeUndefined()
  expect(await ui.find({ text: '▲ 7 more above' })).toBeDefined()
  await ui.unmount()
})

test('pane: the help view of a short pane keeps its fit while rows are windowed', async ($, on) => {
  const w = world(on, { manifest: MANIFEST })
  await listed($, w, links(12))
  const ui = await mountPane($, INLINE)
  expect(rowsOf(await ui.drawn())).toHaveLength(5)
  await ui.press({ key: 'help' })
  const { gap, help } = await helpTree(ui)
  expect(await drawnHelpFooter(ui)).toEqual(modelHelpFooter)
  expect(gap + help.length + HELP_FOOTER_ROWS).toBeLessThanOrEqual(11)
  expect(JSON.stringify(help[0])).toContain('Pane keys')
  expect(await stops(ui)).toEqual([])
  await ui.unmount()
})

// The wheel or a page key reaches the `ui.scroll` hook with a whole-row `offset`; the kit refuses a call without one.
const scroll = ($: Engine, by: number, bodyRows: number) =>
  $.ui.scroll({
    component: 'Pane',
    requestId: 'track',
    plugin: 'artifact-tracking',
    offset: 0,
    by,
    bodyRows,
    contentRows: bodyRows,
    origin: { kind: 'person' },
  } as never)

test('pane: PageDown in a windowed pane selects the row a page less one below (ui.scroll hook)', async ($, on) => {
  const w = world(on)
  await listed($, w, links(12))
  const ui = await mountPane($, INLINE)
  await focusOn($, 'r0')
  await ui.redraw()
  expect(await scroll($, 11, 11)).toEqual({}) // the hook answered: the engine has nothing to scroll
  await ui.redraw()
  expect(rowsOf(await ui.drawn()).find(r => r.selected)?.handle).toBe('r4') // a page of 5 rows less one
  await ui.unmount()
})

test('pane: with no window the ui.scroll hook leaves the move to the engine', async ($, on) => {
  const w = world(on)
  await listed($, w, links(12))
  const ui = await mountPane($, { ...INLINE, bodyRows: 40 })
  await focusOn($, 'r0')
  await ui.redraw()
  const err = await scroll($, 1, 40).then(
    () => undefined,
    e => String(e),
  )
  expect(err).toContain('no implementation for ui.scroll') // the kit engine behind next(e): the hook did not answer
  expect(rowsOf(await ui.drawn()).find(r => r.selected)?.handle).toBe('r0')
  await ui.unmount()
})

// ---------------------------------------------------------------- colors

test('pane: a status token draws its theme color', async ($, on) => {
  const w = world(on)
  await listed($, w, 'https://github.com/cli/cli/pull/14640')
  const ui = await mountPane($)
  const texts = await ui.findAll({ type: 'Text' })
  // The PR is open and its checks fail: the token is failed, so the word draws in the error color (issue #63, L2).
  expect(texts.find(t => t.text === 'open')?.props.color).toBe('error')
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
  reasons: reasonsOfSources(['response']),
  firstSeen: n,
  lastSeen: n,
  seenCount: 1,
})

test('pane: the largest list the store allows draws whole in a tall body', { timeoutMs: 20_000 }, async ($, on) => {
  const items = Array.from({ length: 500 }, (_, i) => webRec(i + 1))
  world(on, {
    disk: withUi({ sectionRows: 300, maxRows: 1000 }),
    seed: { 'v2:index': [SESSION], ['v2:s:' + SESSION]: { items } },
  })
  mock.env(on, { HOME: '/home/u' })
  await $.session.start(START)
  const ui = await mountPane($, { bodyRows: 1000 })
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

test(
  'pane: the largest list the store allows, windowed, keeps every row a stop inside the budget',
  { timeoutMs: 20_000 },
  async ($, on) => {
    const items = Array.from({ length: 500 }, (_, i) => webRec(i + 1))
    world(on, {
      disk: withUi({ sectionRows: 300, maxRows: 1000 }),
      seed: { 'v2:index': [SESSION], ['v2:s:' + SESSION]: { items } },
    })
    mock.env(on, { HOME: '/home/u' })
    await $.session.start(START)
    const ui = await mountPane($, DOCKED)
    const more = (await ui.findAll({ type: 'Button' })).find(b => /^m\d+$/.test(b.key ?? ''))
    await ui.press({ key: more?.key ?? 'none' })
    const tree = await ui.drawn()
    expect(rowsOf(tree).length).toBe(22) // the status area takes three of the 25 rows
    expect((await handlesIn(ui)).length).toBe(500)
    expect((await footerOf(ui)).length).toBe(7)
    expect(fits(measure(tree), BUDGET)).toBe(true)
    await ui.unmount()
  },
)

// ---------------------------------------------------------------- /track help

test('/track help prints the help view as text', async ($, on) => {
  world(on)
  const text = (await track($, 'help')).text ?? ''
  expect(text.startsWith('Pane keys (Tab, Shift+Tab, Up, Down move between rows)\n  r  refresh\n  h  help')).toBe(true)
  expect(text).toContain('Config file:')
})
