// What the fake CLIs of the e2e harness share: the result of one call and the call log (fake `gh`, fake `acli`). A fake
// answers with a `FakeResult`, its program appends `logLineOf()` to the log, and a step reads the log with `callsOf()`.
// This file imports nothing, so the plugin tests can import it.

/** What one call gets. `call` names the kind of call for the log: `unsupported` for one the fake does not answer. */
export type FakeResult = { exitCode: number; stdout: string; stderr: string; call: string }

export type FakeCall = { call: string; exit: number; argv: string[] }

const MAX_ARG = 200

/** One line of the call log. A long argument (the query) is cut, because the call name says what it was. */
export function logLineOf(argv: readonly string[], result: FakeResult): string {
  const short = argv.map(a => (a.length > MAX_ARG ? `${a.slice(0, MAX_ARG - 1)}…` : a))
  return JSON.stringify({ call: result.call, exit: result.exitCode, argv: short })
}

/** The calls of a log file, one per line. A line that is not a call is skipped. */
export function callsOf(text: string): FakeCall[] {
  const calls: FakeCall[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      const c: unknown = JSON.parse(line)
      if (typeof c === 'object' && c !== null && 'call' in c && 'exit' in c && 'argv' in c) calls.push(c as FakeCall)
    } catch {
      // A half-written line: the next read has it whole.
    }
  }
  return calls
}
