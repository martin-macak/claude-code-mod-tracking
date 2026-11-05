// The fixtures of `tests/fixtures/questions-host-318.ts` are typed copies of the captures of the spike
// `docs/knowledge-base/claude-code-mods/sources/spikes-2026-11-05-hosts/captures/` (issue #312). The kit tests must not read the docs
// tree, and the kit has no fs, so this check runs under node in `make test-scripts`. It fails when one copy changes and the
// other does not.
// Run: node --experimental-transform-types --no-warnings --import ./scripts/coverage/loader.mjs --test scripts/contracts/questions-host-fixtures.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as fixtures from '../../plugins/artifact-tracking/tests/fixtures/questions-host-318.ts'

const CAPTURES = new URL(
  '../../docs/knowledge-base/claude-code-mods/sources/spikes-2026-11-05-hosts/captures/',
  import.meta.url,
)
const capture = name => readFileSync(fileURLToPath(new URL(name, CAPTURES)), 'utf8')

/** The fixtures from a file that a probe plugin wrote: the input of the hook and the answer of `next(e)`. */
const HOOK_CAPTURES = [
  ['HOST_NO_ANSWER_TEXT', fixtures.HOST_NO_ANSWER_TEXT, 'AskUserQuestion-host-b-hook.json'],
  ['PLAN_EDITED', fixtures.PLAN_EDITED, 'ExitPlanMode-ctrl-g.json'],
]

test('each fixture has its capture', () => {
  assert.deepEqual(Object.keys(fixtures).sort(), [...HOOK_CAPTURES.map(([name]) => name), 'HOST_FOLLOW_UP'].sort())
})

for (const [name, fixture, file] of HOOK_CAPTURES) {
  test(`${name} equals its capture: the input and the result of the call`, () => {
    const { input, ran } = JSON.parse(capture(file))
    assert.equal(fixture.toolUseId, input.tool_use_id)
    assert.deepEqual(fixture.input, input)
    assert.deepEqual(fixture.result, ran)
  })
}

// The probe came after this run, so its capture is the stdout of the run: the first line of the file is no JSON.
test('HOST_FOLLOW_UP equals the stdout of the run: the questions, the structured result and the text', () => {
  const rows = capture('host-a.jsonl').trim().split('\n').slice(1).map(JSON.parse)
  const asked = rows.find(r => r.control_request)?.control_request.request
  const seen = rows.find(r => r.tool_result)
  const { toolUseId, input, result } = fixtures.HOST_FOLLOW_UP
  assert.equal(toolUseId, asked.tool_use_id)
  assert.equal(toolUseId, seen.tool_result.tool_use_id)
  assert.deepEqual(input.questions, asked.input.questions)
  assert.deepEqual(result.result, seen.tool_use_result)
  assert.equal(result.text, seen.tool_result.content)
})

test('the session of the spike advertises the capability that the output schema names', () => {
  const { capabilities } = JSON.parse(capture('init-capabilities-host-b.json'))
  assert.ok(capabilities.includes('ask_user_question_unanswered_v1'))
})
