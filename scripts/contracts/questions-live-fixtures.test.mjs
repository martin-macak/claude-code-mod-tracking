// The fixtures of `tests/fixtures/questions-live-316.ts` are typed copies of the captures of the spike
// `docs/knowledge-base/claude-code-mods/sources/spikes-2026-11-01/captures/` (issue #208). The kit tests must not read the docs
// tree, and the kit has no fs, so this check runs under node in `make test-scripts`. It fails when one copy changes and the
// other does not.
// Run: node --experimental-transform-types --no-warnings --import ./scripts/coverage/loader.mjs --test scripts/contracts/questions-live-fixtures.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as fixtures from '../../plugins/artifact-tracking/tests/fixtures/questions-live-316.ts'

const CAPTURES = new URL(
  '../../docs/knowledge-base/claude-code-mods/sources/spikes-2026-11-01/captures/',
  import.meta.url,
)

test('there are fixtures to compare', () => {
  assert.ok(Object.keys(fixtures).length >= 7)
})

for (const [name, fixture] of Object.entries(fixtures)) {
  test(`${name} equals its capture: the input and the result of the call`, () => {
    const file = fileURLToPath(new URL(`AskUserQuestion-${fixture.toolUseId}.json`, CAPTURES))
    const capture = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(fixture.input, capture.input)
    assert.deepEqual(fixture.result, capture.ran)
  })
}
