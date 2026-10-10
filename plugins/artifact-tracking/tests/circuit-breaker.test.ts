// CircuitBreaker: pure, fake time.
import { expect, test } from 'claude-code/testing'
import { CircuitBreaker } from '../hooks/tools/circuit-breaker'

const MIN = 60_000

test('closed breaker allows calls and stays closed below the threshold', () => {
  const b = new CircuitBreaker(3, 5 * MIN)
  b.failure(0)
  b.failure(0)
  expect(b.state).toBe('closed')
  expect(b.allows(0)).toBe(true)
})

test('a success resets the failure count', () => {
  const b = new CircuitBreaker(3, 5 * MIN)
  b.failure(0)
  b.failure(0)
  b.success()
  b.failure(0)
  b.failure(0)
  expect(b.state).toBe('closed')
})

test('third failure in a row opens it for openMs', () => {
  const b = new CircuitBreaker(3, 5 * MIN)
  for (let i = 0; i < 3; i++) b.failure(1000)
  expect(b.state).toBe('open')
  expect(b.openUntil).toBe(1000 + 5 * MIN)
  expect(b.allows(1000 + 5 * MIN - 1)).toBe(false)
})

test('after openMs one probe call goes through, a second waits', () => {
  const b = new CircuitBreaker(3, 5 * MIN)
  for (let i = 0; i < 3; i++) b.failure(0)
  expect(b.allows(5 * MIN)).toBe(true)
  expect(b.state).toBe('half-open')
  expect(b.allows(5 * MIN)).toBe(false)
})

test('half-open: success closes, failure opens again for a full period', () => {
  const ok = new CircuitBreaker(3, 5 * MIN)
  for (let i = 0; i < 3; i++) ok.failure(0)
  ok.allows(5 * MIN)
  ok.success()
  expect(ok.state).toBe('closed')

  const bad = new CircuitBreaker(3, 5 * MIN)
  for (let i = 0; i < 3; i++) bad.failure(0)
  bad.allows(5 * MIN)
  bad.failure(5 * MIN)
  expect(bad.state).toBe('open')
  expect(bad.openUntil).toBe(10 * MIN)
})

test('peek answers like allows but takes nothing', () => {
  const b = new CircuitBreaker(3, 5 * MIN)
  for (let i = 0; i < 3; i++) b.failure(0)
  expect(b.peek(0)).toBe(false)
  expect(b.peek(5 * MIN)).toBe(true)
  expect(b.peek(5 * MIN)).toBe(true) // still true: peek did not take the half-open slot
  expect(b.allows(5 * MIN)).toBe(true)
  expect(b.peek(5 * MIN)).toBe(false)
})

test('reset moves an open breaker to half-open at once', () => {
  const b = new CircuitBreaker(3, 5 * MIN)
  for (let i = 0; i < 3; i++) b.failure(0)
  b.reset()
  expect(b.state).toBe('half-open')
  expect(b.allows(1)).toBe(true)
})
