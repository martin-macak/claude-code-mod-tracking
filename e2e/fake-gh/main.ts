// The fake `gh` of the e2e harness, as a program. `bin/gh` runs it. The answers are in support/fake-gh.ts.
// FAKE_GH_SPEC: the spec file (JSON). Without it the program refuses, so a stray PATH never fakes GitHub silently.
// FAKE_GH_LOG: a file that gets one JSON line per call. Absent: no log.
// The `delays` map of the spec holds a call back (milliseconds by call name) before it answers.
import { appendFileSync, readFileSync } from 'node:fs'
import { answer, delayOf, type FakeGhSpec, logLineOf } from '../support/fake-gh.ts'

const specFile = process.env.FAKE_GH_SPEC
if (specFile === undefined || specFile === '') {
  process.stderr.write('fake gh: FAKE_GH_SPEC is not set\n')
  process.exitCode = 2
} else {
  const argv = process.argv.slice(2)
  const spec = JSON.parse(readFileSync(specFile, 'utf8')) as FakeGhSpec
  const result = answer(argv, spec)
  // Issue #210: a hold stands for a slow start. It comes before the log line and the answer, so the log says "answered".
  const hold = delayOf(result.call, spec)
  if (hold > 0) await new Promise(resolve => setTimeout(resolve, hold))
  const logFile = process.env.FAKE_GH_LOG
  if (logFile) appendFileSync(logFile, `${logLineOf(argv, result)}\n`)
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  process.exitCode = result.exitCode
}
