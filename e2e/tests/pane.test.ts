import assert from 'node:assert/strict'
import { test } from 'node:test'
import { arrowOf, focusedTexts, paneTextAt, selectedLine, stripOpenAt, withFocus } from '../support/pane.ts'

test('selectedLine finds the row with the > gutter', () => {
  const line = 'abc │> ▲ ▸ two.example/b  two.example/b'
  assert.equal(selectedLine(`header\n${line}\nx`), line)
})

test('selectedLine returns the first such line', () => {
  assert.equal(selectedLine('│> one\n│> two'), '│> one')
})

test('selectedLine returns undefined without one', () => {
  assert.equal(selectedLine('│  ▸ one.example/a\n│  ▸ two.example/b'), undefined)
})

test('a > inside the transcript is not a selection', () => {
  assert.equal(selectedLine('see a > b │  ▸ one.example/a'), undefined)
})

// The ANSI lines below are what `tmux capture-pane -e -p` returned for the live pane (Claude Code 2.1.304). The focus
// ring draws the focused Button in reverse video (SGR 7).
const ROW_FOCUSED =
  '\u001b[49m  \u001b[38;5;246m"cc-plugin-sec\u001b[39m        \u001b[38;5;153m\u001b[48;5;235m│\u001b[39m\u001b[48;5;68m>   ' +
  '\u001b[7m▸\u001b[0m\u001b[48;5;68m \u001b]8;id=1rpcvv4;https://a.example/1\u001b\\a.example/1\u001b]8;;\u001b\\ a.example/1'
const ROW_BLURRED =
  '\u001b[49m  \u001b[38;5;246mon past it.\u001b[39m           \u001b[38;5;153m\u001b[48;5;235m│\u001b[39m\u001b[48;5;68m>   ▸ ' +
  '\u001b]8;id=fv1bo8;https://e.example/5\u001b\\e.example/5\u001b]8;;\u001b\\ e.example/5'
const MORE_FOCUSED =
  '\u001b[49m                        \u001b[38;5;153m\u001b[48;5;235m│\u001b[39m    \u001b[7m2 more\u001b[0m\u001b[48;5;235m'
const MORE_BLURRED = '\u001b[49m                        \u001b[38;5;153m\u001b[48;5;235m│\u001b[39m    2 more'

test('focusedTexts returns the text drawn in reverse video', () => {
  assert.deepEqual(focusedTexts(MORE_FOCUSED), ['2 more'])
})

test('focusedTexts finds the glyph of a focused row and skips the link markup', () => {
  assert.deepEqual(focusedTexts(ROW_FOCUSED), ['▸'])
})

test('focusedTexts returns nothing for a screen with no reverse video', () => {
  assert.deepEqual(focusedTexts(`${ROW_BLURRED}\n${MORE_BLURRED}`), [])
})

test('focusedTexts tells the focused Button from the blurred one across lines', () => {
  assert.deepEqual(focusedTexts(`${ROW_BLURRED}\n${MORE_FOCUSED}`), ['2 more'])
  assert.deepEqual(focusedTexts(`${ROW_FOCUSED}\n${MORE_BLURRED}`), ['▸'])
})

test('focusedTexts ends a run at the end of its line and at a reset', () => {
  assert.deepEqual(focusedTexts('\u001b[7mone\ntwo\u001b[0m three'), ['one'])
  assert.deepEqual(focusedTexts('\u001b[7mone\u001b[27m two \u001b[7mthree\u001b[m'), ['one', 'three'])
})

test('focusedTexts reads SGR 7 inside a list of parameters', () => {
  assert.deepEqual(focusedTexts('\u001b[1;7mbold\u001b[0m \u001b[0;7;33mmore\u001b[0m'), ['bold', 'more'])
})

test('focusedTexts does not read the 7 of a color as reverse video', () => {
  assert.deepEqual(focusedTexts('\u001b[38;5;7mgrey\u001b[0m \u001b[48;2;7;7;7mdark\u001b[0m'), [])
})

test('focusedTexts ignores a reversed blank such as the cursor', () => {
  assert.deepEqual(focusedTexts('❯ \u001b[7m \u001b[0m'), [])
})

test('withFocus appends the focused texts to the plain screen', () => {
  assert.equal(
    withFocus('rows\n2 more', `${ROW_BLURRED}\n${MORE_FOCUSED}`),
    'rows\n2 more\n--- reverse video: ["2 more"]',
  )
})

test('withFocus says so when no text is in reverse video', () => {
  assert.equal(withFocus('rows\n2 more', `${ROW_BLURRED}\n${MORE_BLURRED}`), 'rows\n2 more\n--- reverse video: []')
})

test('arrowOf gives the 1-based column and row of the arrow of the row that shows the text, and the arrow', () => {
  const screen = 'header\nabc │>   ▸ one.example/a  one.example/a\nabc │    ▾ two.example/b  two.example/b\n'
  assert.deepEqual(arrowOf(screen, 'two.example'), { column: 10, row: 3, glyph: '▾' })
  assert.deepEqual(arrowOf(screen, 'one.example'), { column: 10, row: 2, glyph: '▸' })
})

test('arrowOf skips a line whose text after the arrow is another row and returns undefined without a match', () => {
  assert.equal(arrowOf('│    ▸ one.example/a\nno arrow two.example', 'two.example'), undefined)
  assert.equal(arrowOf('', 'one'), undefined)
})

test('paneTextAt gives the 1-based column and row of the text in the pane, right of the first border', () => {
  const screen = 'header\nabc │r: refresh  h: help\nabc │    2 more\n'
  assert.deepEqual(paneTextAt(screen, 'r: refresh'), { column: 6, row: 2 })
  assert.deepEqual(paneTextAt(screen, 'h: help'), { column: 18, row: 2 })
  assert.deepEqual(paneTextAt(screen, '2 more'), { column: 10, row: 3 })
})

test('paneTextAt ignores the transcript left of the border and a line with no border', () => {
  const screen = 'x: dismiss in a line with no border\n❯ say x: dismiss │ nothing here\nabc │x: dismiss'
  assert.deepEqual(paneTextAt(screen, 'x: dismiss'), { column: 6, row: 3 })
  assert.equal(paneTextAt('❯ 2 more │ none', '2 more'), undefined)
  assert.equal(paneTextAt('', 'x'), undefined)
})

// Issue #69, P2. The strip of `interactive` is one row under the duration line: two spaces, the counts, `open`. The lines
// below are what `tmux capture-pane -p` returned for a live fullscreen session (Claude Code 2.1.306).
test('stripOpenAt gives the 1-based column and row of the word open on the strip row, one cell inside the word', () => {
  const screen = '⏺ noted https://example.com/alpha\n\n✻ Baked for 1s · done 1:26 PM\n  +2 new open\n\n❯ '
  assert.deepEqual(stripOpenAt(screen), { column: 11, row: 4 })
  assert.deepEqual(stripOpenAt('  +1 new · 1 seen again open'), { column: 26, row: 1 })
  assert.deepEqual(stripOpenAt('  3 seen again open'), { column: 17, row: 1 })
})

test('stripOpenAt finds the row beside a docked pane too', () => {
  const screen =
    '✻ Baked for 1s · done 1:26 PM                                           │\n  +2 new open                                                           │'
  assert.deepEqual(stripOpenAt(screen), { column: 11, row: 2 })
})

test('stripOpenAt ignores the band, the main-screen strip with no Button and the text line', () => {
  const band = 'tracking Links 2 turn 1 +2 new 9: open /track                                  [-]'
  assert.equal(stripOpenAt(band), undefined)
  assert.equal(stripOpenAt('  +2 new'), undefined) // the main screen draws the counts only
  assert.equal(stripOpenAt('⏺ artifact-tracking+cc-plugin-agents-md: +2 new · /track turn 1'), undefined)
  assert.equal(stripOpenAt('│  +2 new open'), undefined) // a row of the pane is not the transcript
  assert.equal(stripOpenAt(''), undefined)
})
