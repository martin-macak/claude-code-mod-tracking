// Facts: named Json values one tracker publishes and others read. Pure.
import { expect, test } from 'claude-code/testing'
import { Facts } from '../core/infra/facts'

test('publish then read returns the value', () => {
  const facts = new Facts()
  facts.publish('auto.root', '/work')
  facts.publish('session.repo', { host: 'github.com', owner: 'acme', repo: 'web' })
  expect(facts.read<string>('auto.root')).toBe('/work')
  expect(facts.read('session.repo')).toEqual({ host: 'github.com', owner: 'acme', repo: 'web' })
})

test('a missing fact reads undefined', () => {
  const facts = new Facts()
  expect(facts.read('auto.root')).toBeUndefined()
})

test('a second publish replaces the first', () => {
  const facts = new Facts()
  facts.publish('auto.branches', ['a'])
  facts.publish('auto.branches', ['b', 'c'])
  expect(facts.read('auto.branches')).toEqual(['b', 'c'])
})

test('publishing undefined withdraws the fact', () => {
  const facts = new Facts()
  facts.publish('auto.root', '/work')
  facts.publish('auto.root', undefined)
  expect(facts.read('auto.root')).toBeUndefined()
})
