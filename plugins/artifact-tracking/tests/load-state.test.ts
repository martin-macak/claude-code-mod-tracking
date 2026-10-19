// LoadState: one value per load, keyed by the facts of the context. Plan: L5 Task 12.
import { expect, test } from 'claude-code/testing'
import { Facts } from '../core/infra/facts'
import { LoadState } from '../core/lib/load-state'

test('of builds the value once per load and gives the same one to every context of that load', () => {
  const loads = new LoadState<{ n: number }>()
  const facts = new Facts()
  let built = 0
  const make = () => ({ n: ++built })
  const first = loads.of({ facts }, make)
  expect(loads.of({ facts }, make)).toBe(first)
  expect(built).toBe(1)
})

test('two loads keep their own values, and get answers undefined before the first of', () => {
  const loads = new LoadState<string>()
  const a = new Facts()
  const b = new Facts()
  expect(loads.get({ facts: a })).toBeUndefined()
  expect(loads.of({ facts: a }, () => 'a')).toBe('a')
  expect(loads.of({ facts: b }, () => 'b')).toBe('b')
  expect(loads.get({ facts: a })).toBe('a')
  expect(loads.get({ facts: b })).toBe('b')
})
