// Stand-in for 'claude-code' when the pure tests run under `node --test` (make coverage).
// It exports nothing. A pure module imports only types from 'claude-code', and
// `import type` is erased. A value import (`import { atom } from 'claude-code'`) in
// a pure file fails at load time with "does not provide an export named", on purpose:
// that file is not pure. Keep it out of the pure tests, or keep the import out of it.
export {}
