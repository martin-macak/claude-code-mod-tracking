// A shell test under `scripts/` that no make target runs proves nothing: no gate, no hook and no CI job calls it, so a
// later edit breaks the rule it pins with no failure (issue #223: scripts/ci/check-pr-body.test.sh was such a file).
// `make test-scripts` is the target that make verify and test.yml run. This check fails when a `scripts/**/*.test.sh`
// file is missing from its recipe.
// Run: node --experimental-transform-types --no-warnings --import ./scripts/coverage/loader.mjs --test scripts/contracts/test-scripts-wiring.test.mjs
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** The repo-relative paths of every `*.test.sh` file under `scripts/`. */
const shellTests = (dir = 'scripts') =>
  readdirSync(`${ROOT}${dir}`, { withFileTypes: true }).flatMap(entry => {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) return shellTests(path)
    return entry.name.endsWith('.test.sh') ? [path] : []
  })

/** The recipe of `make test-scripts`: the tab-indented lines under the target, up to the next line that is not one. */
const recipe = target => {
  const lines = readFileSync(`${ROOT}Makefile`, 'utf8').split('\n')
  const start = lines.findIndex(line => line.startsWith(`${target}:`))
  assert.ok(start >= 0, `the Makefile has a ${target} target`)
  const body = lines.slice(start + 1)
  const end = body.findIndex(line => !line.startsWith('\t'))
  return body.slice(0, end < 0 ? body.length : end).join('\n')
}

test('make test-scripts runs every shell test under scripts/', () => {
  const tests = shellTests()
  assert.ok(tests.length > 0, 'scripts/ holds shell tests, or this check proves nothing')
  const text = recipe('test-scripts')
  assert.deepEqual(
    tests.filter(path => !text.includes(path)),
    [],
  )
})
