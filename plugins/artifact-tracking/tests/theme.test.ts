// The theme: tokens to engine colors, glyphs, cell props, and the typed wrappers over h. Pure.
import { expect, test } from 'claude-code/testing'
import type { Cell } from '../core/interfaces/view'
import { cellWidth } from '../ux/text/cell-width'
import { COLOR, cellBox, cellText, GLYPH } from '../ux/theme'
import { box, button, link, text } from '../ux/tree-data-table/el'
import { EL } from './fixtures/elements'

/** The theme keys of the d.ts (`ThemeKey`, claude-code 2.1.302 line 13229). */
const THEME_KEYS = [
  'text',
  'inverseText',
  'inactive',
  'subtle',
  'suggestion',
  'remember',
  'success',
  'error',
  'warning',
  'merged',
  'claude',
  'permission',
  'planMode',
  'autoAccept',
  'promptBorder',
  'bashBorder',
  'ide',
  'diffAdded',
  'diffRemoved',
  'diffAddedDimmed',
  'diffRemovedDimmed',
  'diffAddedWord',
  'diffRemovedWord',
]
/** Named colors the live engine paints from the theme palette (ui.md "Colors"). */
const NAMED = ['red', 'green', 'blue', 'yellow', 'cyan', 'magenta', 'white', 'black', 'gray', 'redBright']

test('every token maps to a painted color with no colon', () => {
  for (const color of Object.values(COLOR)) {
    expect(THEME_KEYS.includes(color) || NAMED.includes(color)).toBe(true)
    expect(color.includes(':')).toBe(false)
  }
  expect(Object.keys(COLOR).sort()).toEqual(
    ['accent', 'claude', 'error', 'inactive', 'selected', 'subtle', 'success', 'warning'].sort(),
  )
})

test('accent is suggestion and selected is blue', () => {
  expect(COLOR.accent).toBe('suggestion')
  expect(COLOR.selected).toBe('blue')
})

test('the glyphs are one cell each', () => {
  expect(Object.values(GLYPH).map(cellWidth)).toEqual([1, 1, 1, 1])
})

test('cellText maps fg to its theme color, dim to dimColor and keeps truncate-end', () => {
  expect(cellText({ text: 'x', fg: 'error', weight: 'bold' }, false)).toEqual({
    wrap: 'truncate-end',
    color: 'error',
    weight: 'bold',
  })
  expect(cellText({ text: 'x' }, true)).toEqual({ wrap: 'truncate-end', dimColor: true })
  expect(cellText({ text: 'x', dim: true }, false)).toEqual({ wrap: 'truncate-end', dimColor: true })
  expect(cellText({ text: 'x', fg: 'accent' }, false)).toEqual({ wrap: 'truncate-end', color: 'suggestion' })
  expect(cellText({ text: 'x' }, false)).toEqual({ wrap: 'truncate-end' })
})

test('cellText leaves a dim cell dim when the row is dim too', () => {
  expect(cellText({ text: 'x', dim: true }, true)).toEqual({ wrap: 'truncate-end', dimColor: true })
})

test('cellBox puts bg on the cell Box', () => {
  expect(cellBox({ text: 'x', bg: 'selected' })).toEqual({ backgroundColor: 'blue' })
  expect(cellBox({ text: 'x', bg: 'accent' })).toEqual({ backgroundColor: 'suggestion' })
  expect(cellBox({ text: 'x' })).toEqual({})
})

test('a raw color string is not a Cell color', () => {
  // @ts-expect-error a raw color is not a ColorToken
  const bad: Cell = { text: 'x', fg: 'red' }
  expect(bad.text).toBe('x')
})

test('box, text, button and link build through h', () => {
  expect(text(EL, { wrap: 'truncate-end' }, 'a')).toEqual({
    type: 'Text',
    props: { wrap: 'truncate-end' },
    children: ['a'],
  })
  expect(box(EL, { flexDirection: 'row' }, text(EL, {}, 'a'), [null, 'b'])).toEqual({
    type: 'Box',
    props: { flexDirection: 'row' },
    children: [{ type: 'Text', props: {}, children: ['a'] }, 'b'],
  })
  const onPress = () => {}
  expect(button(EL, { key: 'r0', label: '▸', plain: true, onPress })).toEqual({
    type: 'Button',
    props: { key: 'r0', label: '▸', plain: true, onPress },
    children: [],
  })
  expect(link(EL, { href: 'https://a.b/c' }, 'x')).toEqual({
    type: 'Link',
    props: { href: 'https://a.b/c' },
    children: ['x'],
  })
})
