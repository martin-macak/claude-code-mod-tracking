import assert from 'node:assert/strict'
import { test } from 'node:test'
import { focusedTexts, selectedLine, withFocus } from '../support/pane.ts'

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
