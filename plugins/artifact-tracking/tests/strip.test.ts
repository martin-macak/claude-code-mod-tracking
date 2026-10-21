// The strip on the duration line (issue #69, P2): the engine's line, then the counts and a plain open Button. Pure.
import { expect, test } from 'claude-code/testing'
import { renderStrip, STRIP_KEY } from '../ux/strip'
import { EL } from './fixtures/elements'

interface Node {
  type: string
  props: Record<string, unknown>
  children: unknown[]
}
const asNode = (n: unknown) => n as Node

const engine = { type: 'Text', props: {}, children: ['Cogitated for 0s'] }
const strip = { ord: 7, counts: '+3 new · 1 seen again' }

test('renderStrip draws the engine line, then one row with the counts and a plain open Button', () => {
  const pressed: string[] = []
  const root = asNode(renderStrip(EL, engine as never, strip, () => void pressed.push('open')))
  expect(root.type).toBe('Box')
  expect(root.props).toEqual({ flexDirection: 'column' })
  expect(root.children[0]).toBe(engine) // the engine's line stays as it was
  const row = asNode(root.children[1])
  // Two cells in: the strip stands under the words of the duration line, not under its glyph (live, 2.1.306).
  expect(row.props).toEqual({ columnGap: 1, marginLeft: 2 })
  const [counts, open] = row.children.map(asNode)
  expect(counts).toMatchObject({ type: 'Text', props: { dimColor: true, wrap: 'truncate-end' } })
  expect(counts!.children).toEqual(['+3 new · 1 seen again'])
  expect(open).toMatchObject({ type: 'Button', props: { key: STRIP_KEY, plain: true, label: 'open' } })
  expect(open!.props.hotkey).toBeUndefined() // a plain open Button: no digit, the band owns the 9
  ;(open!.props.onPress as () => void)()
  expect(pressed).toEqual(['open'])
})

test('renderStrip with no press draws the counts alone: a click on a transcript Button is not delivered on the main screen', () => {
  const root = asNode(renderStrip(EL, engine as never, strip))
  const row = asNode(root.children[1])
  expect(row.children.map(asNode).map(c => c.type)).toEqual(['Text'])
  expect(row.children.map(asNode).map(c => c.children[0])).toEqual(['+3 new · 1 seen again'])
})
