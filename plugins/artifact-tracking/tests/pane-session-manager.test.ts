// PaneSession over the real LifecycleManager: the manager fits the PaneHost contract, and the sections, the footer states,
// x and the refocus work against its own data. The cases with a fake host are in pane-session.test.ts. Plan: L6 Task 11.
import { expect, test } from 'claude-code/testing'
import { type PaneHost, PaneSession } from '../hooks/pane-session'
import { buttonOf, handlesOf, press } from './fixtures/drawn'
import { EL } from './fixtures/elements'
import { promptRow } from './fixtures/items'
import { managerWorld } from './fixtures/manager'

test('the real LifecycleManager serves the session: sections, footer states, x and the refocus', async () => {
  const t = managerWorld()
  await t.m.row(t.w.ports, promptRow('see https://one.example/ and https://two.example/ and https://three.example/'))
  const host: PaneHost = t.m // a change of either side breaks the compile here, not in register.tsx
  const session = new PaneSession()
  const first = await session.draw(t.w.ports, host, EL, 100)
  expect(handlesOf(first)).toEqual(['r0', 'r1', 'r2'])
  const dim = (tree: unknown) => buttonOf(tree, 'dismiss').props.dimColor
  expect(dim(first)).toBe(true) // no row selected: the key is off
  await session.focused(t.w.ports, 'r1') // the ring lands on the second link
  const picked = await session.draw(t.w.ports, host, EL, 100)
  expect(dim(picked)).toBeUndefined()
  press(buttonOf(picked, 'dismiss'))
  await session.idle()
  expect(t.keys()).toHaveLength(2)
  expect(t.keys().some(k => k.includes('two.example'))).toBe(false)
  const next = await session.draw(t.w.ports, host, EL, 100)
  expect(handlesOf(next)).toEqual(['r0', 'r1'])
  expect(t.w.state.get('selected')).toBe(t.keys()[1]) // the link after the dismissed one is selected
  expect(t.w.ui.focused).toEqual(['r1'])
})
