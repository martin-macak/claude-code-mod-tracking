// Kit only: the engine's own `h` builds the shape the node stand-in (scripts/coverage/kit-shim.ts) builds.
// A pure test cannot show it: node has no engine. scripts/coverage/kit-shim.test.ts asserts the same values, so a change
// on one side shows here. The engine is the reference: it leaves out an empty `props` and an empty `children`, and it
// drops a prop that holds null or undefined (probed on 2.1.302).
import { expect, test } from 'claude-code/testing'

const plain = (node: unknown): unknown => JSON.parse(JSON.stringify(node))

test('the engine h builds what the node stand-in builds', () => {
  const built = h('Box', { width: 3 }, h('Text', null, 'a'), ['b', null, false, [7]])
  expect(plain(built)).toEqual({
    type: 'Box',
    props: { width: 3 },
    children: [{ type: 'Text', children: ['a'] }, 'b', '7'],
  })
  const fn = h((p: never) => ({ type: 'X', props: p }) as never, { k: 1 }, 'c')
  expect(plain(fn)).toEqual({ type: 'X', props: { k: 1, children: ['c'] } })
})

test('the engine h leaves out an empty props and an empty children, as the node stand-in does', () => {
  expect(plain(h('Box', null))).toEqual({ type: 'Box' })
  expect(plain(h('Box', {}, null, false, true))).toEqual({ type: 'Box' })
  expect(plain(h('Box', { a: null, b: undefined, c: 0, d: false, e: '', children: ['z'] }))).toEqual({
    type: 'Box',
    props: { c: 0, d: false, e: '' },
  })
  expect(plain(h((p: never) => ({ type: 'X', props: p }) as never, null))).toEqual({
    type: 'X',
    props: { children: [] },
  })
})
