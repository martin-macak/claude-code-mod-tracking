// The fake `acli` of the e2e harness, as a program. `bin/acli` runs it. The answers are in support/fake-acli.ts.
// FAKE_ACLI_SPEC: the spec file (JSON). Without it the program refuses, so a stray PATH never fakes Jira silently.
// FAKE_ACLI_LOG: a file that gets one JSON line per call. Absent: no log.
// The shape is that of fake-gh/main.ts, kept apart on purpose: the fake gh also holds a call back, the fake acli does not.
import { appendFileSync, readFileSync } from 'node:fs'
import { answer, type FakeAcliSpec } from '../support/fake-acli.ts'
import { logLineOf } from '../support/fake-cli.ts'

const specFile = process.env.FAKE_ACLI_SPEC
if (specFile === undefined || specFile === '') {
  process.stderr.write('fake acli: FAKE_ACLI_SPEC is not set\n')
  process.exitCode = 2
} else {
  let spec: FakeAcliSpec | undefined
  try {
    spec = JSON.parse(readFileSync(specFile, 'utf8')) as FakeAcliSpec
  } catch (error) {
    // Exit 2, as for no spec: exit 1 is the exit of a call the fake refuses, and this call is not logged.
    process.stderr.write(`fake acli: cannot read FAKE_ACLI_SPEC: ${error instanceof Error ? error.message : error}\n`)
    process.exitCode = 2
  }
  if (spec !== undefined) {
    const argv = process.argv.slice(2)
    const result = answer(argv, spec)
    const logFile = process.env.FAKE_ACLI_LOG
    if (logFile) appendFileSync(logFile, `${logLineOf(argv, result)}\n`)
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    process.exitCode = result.exitCode
  }
}
