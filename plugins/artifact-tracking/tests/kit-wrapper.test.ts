// The `test` of the kit wiring tests (fixtures/kit.ts) gives each test a hang guard of 30 s unless the test names its own
// limit. Issue #104: the kit stops a test after 5 s, a busy machine runs a normal wiring test past that, and the test
// fails with no wrong behaviour in it. The kit's own `test` is a stub here, so the check reads what the wrapper passes on.
import { expect, test } from 'claude-code/testing'
import { HANG_GUARD_MS, withHangGuard } from './fixtures/kit'

type Call = { name: string; options: Record<string, unknown>; body: unknown }

/** A stand-in for the kit's `test`: it records the registration instead of running anything. */
function recorder() {
  const calls: Call[] = []
  const register = (name: string, ...rest: unknown[]) => {
    const body = rest[rest.length - 1]
    const options = rest.length === 2 ? (rest[0] as Record<string, unknown>) : {}
    calls.push({ name, options, body })
  }
  // The wrapper takes a `test` of the kit's type. The recorder has the same call shape.
  return { calls, test: withHangGuard(register as never) }
}

test('the hang guard is 30 s, six times the kit limit of 5 s', () => {
  expect(HANG_GUARD_MS).toBe(30_000)
})

test('a test with no options gets the hang guard, and its body goes through unchanged', () => {
  const r = recorder()
  const body = () => {}
  r.test('plain', body)
  expect(r.calls).toEqual([{ name: 'plain', options: { timeoutMs: HANG_GUARD_MS }, body }])
  expect(r.calls[0]!.body).toBe(body)
})

test('options with no limit keep their other keys and get the hang guard', () => {
  const r = recorder()
  const body = () => {}
  r.test('with a plugin list', { plugins: [] }, body)
  expect(r.calls[0]!.options).toEqual({ plugins: [], timeoutMs: HANG_GUARD_MS })
})

test('a limit that a test names stays, lower or higher than the guard', () => {
  const r = recorder()
  r.test('tight', { timeoutMs: 1_000 }, () => {})
  r.test('roomy', { timeoutMs: 120_000 }, () => {})
  expect(r.calls.map(c => c.options.timeoutMs)).toEqual([1_000, 120_000])
})

test('a limit that is named and undefined gets the hang guard', () => {
  const r = recorder()
  r.test('undefined limit', { timeoutMs: undefined }, () => {})
  expect(r.calls[0]!.options.timeoutMs).toBe(HANG_GUARD_MS)
})

test('the options object of the caller is not changed', () => {
  const r = recorder()
  const own = { plugins: [] }
  r.test('shared options', own, () => {})
  expect(own).toEqual({ plugins: [] })
})
