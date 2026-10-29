// The control character rule of the preview (issue #57, L2, G9). The engine refuses a whole tree when the source of a `Code` or
// the text of a `Markdown` holds a control character other than tab and newline: the pane is blank and its keys are dead. A file is
// outside data, so every string that the preview draws goes through this rule first. Pure.
import { expect, test } from 'claude-code/testing'
import { sanitize } from '../ux/text/sanitize'

const FFFD = '�'

test('sanitize keeps tab, newline and every printable character, so ordinary source comes back as it was', () => {
  const source = 'export const one = 1\n\tconst two = "é €"\n\n// 日本語 😀\n'
  expect(sanitize(source)).toBe(source)
  expect(sanitize('')).toBe('')
})

test('sanitize turns a CRLF pair into a newline: a Windows file keeps its lines', () => {
  expect(sanitize('a\r\nb\r\n')).toBe('a\nb\n')
})

test('sanitize turns a lone CR, a NUL, an ESC, a form feed, DEL and the C1 controls into U+FFFD, one for each', () => {
  expect(sanitize('a\rb')).toBe(`a${FFFD}b`)
  expect(sanitize('\r\r\n')).toBe(`${FFFD}\n`) // the pair is one newline, the CR before it is lone
  for (const ch of ['\u0000', '\u001b', '\u000c', '\u0007', '\u007f', '\u0085', '\u009f'])
    expect(sanitize(`a${ch}b`), JSON.stringify(ch)).toBe(`a${FFFD}b`)
  // The edges of the ranges, where a typo would move them: BS and VT are the first controls on either side of tab and newline, US is the
  // last of C0.
  for (const ch of ['\u0008', '\u000b', '\u001f']) expect(sanitize(`a${ch}b`), JSON.stringify(ch)).toBe(`a${FFFD}b`)
  expect(sanitize('\u001b[31mred\u001b[0m')).toBe(`${FFFD}[31mred${FFFD}[0m`) // an ANSI escape loses its ESC and is text
})

test('sanitize leaves what lies just outside the ranges: tab, newline, the space, NBSP (U+00A0, after the C1 range) and the first printable', () => {
  for (const ch of ['\t', '\n', ' ', '\u00a0', '\u00a1', '¡'])
    expect(sanitize(`a${ch}b`), JSON.stringify(ch)).toBe(`a${ch}b`)
})

test('sanitize leaves the Unicode that the engine draws on its own: the bidi override and the unpaired surrogate are not control characters', () => {
  expect(sanitize('a‮b')).toBe('a‮b')
  expect(sanitize('a\uD800b')).toBe('a\uD800b')
})

test('sanitize is idempotent, and its result holds no character the engine would refuse', () => {
  const dirty = 'x\u0000\r\ny\u001b\rz\u0085\u007f\tend\n'
  const once = sanitize(dirty)
  expect(sanitize(once)).toBe(once)
  expect(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(once)).toBe(false)
})
