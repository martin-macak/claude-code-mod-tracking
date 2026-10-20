// The `test` of every kit test that drives the engine (a body that takes `$`): the kit's `test` with a hang guard.
// The kit stops a test after 5 s. A wiring test takes about 1 s on a quiet machine and runs past 5 s on a busy one, and
// then it fails with no wrong behaviour in it (issue #104). With 30 s the limit only catches a hang.
// A test that names a `timeoutMs` keeps it. The rule is in docs/AGENTS.md, "Tests". scripts/contracts/kit-test-contracts
// makes a kit test file take `test` from here and not from 'claude-code/testing'.
//
// Pure tests (no `$`) may take `test` from the kit directly: they run no engine and have nothing to wait for.

import { test as kitTest } from 'claude-code/testing'

/** How long a kit test may run when it names no limit of its own. The kit default is 5000 ms. */
export const HANG_GUARD_MS = 30_000

type Register = typeof kitTest

/** `register` with a default `timeoutMs` of {@link HANG_GUARD_MS}. A limit that the test names wins, lower or higher. */
export function withHangGuard(register: Register): Register {
  return (name, ...rest) => {
    if (rest.length === 1) return register(name, { timeoutMs: HANG_GUARD_MS }, rest[0])
    const [options, body] = rest
    return register(name, { ...options, timeoutMs: options.timeoutMs ?? HANG_GUARD_MS }, body)
  }
}

export const test: Register = withHangGuard(kitTest)
