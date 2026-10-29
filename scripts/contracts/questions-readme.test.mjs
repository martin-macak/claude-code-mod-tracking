// The README lists every secret pattern that the questions tracker masks (issue #71). The list in the code is the source:
// `SECRET_PATTERNS` in `trackers/questions/secrets.ts`. A pattern the README does not name is a mask the person cannot know
// about, and a name in the README with no pattern behind it is a promise the code does not keep. The kit has no fs, so this
// check runs under node in `make test-scripts`.
// Run: node --experimental-transform-types --no-warnings --import ./scripts/coverage/loader.mjs --test scripts/contracts/questions-readme.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { SECRET_PATTERNS } from '../../plugins/artifact-tracking/trackers/questions/secrets.ts'

const README = readFileSync(
  fileURLToPath(new URL('../../plugins/artifact-tracking/README.md', import.meta.url)),
  'utf8',
)

/** The lines of the README section "Questions and answers" that list the masked patterns: a bullet each. */
function maskedSection() {
  const start = README.indexOf('<!-- masked-patterns:start -->')
  const end = README.indexOf('<!-- masked-patterns:end -->')
  assert.ok(
    start >= 0 && end > start,
    'the README marks the list of masked patterns with <!-- masked-patterns:start --> and <!-- masked-patterns:end -->',
  )
  return README.slice(start, end)
    .split('\n')
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).trim())
}

test('the README lists every pattern of SECRET_PATTERNS by its label, in the order of the code', () => {
  assert.deepEqual(
    maskedSection(),
    SECRET_PATTERNS.map(p => p.label),
  )
})

test('every pattern has an id and a label, and the ids are unique', () => {
  const ids = SECRET_PATTERNS.map(p => p.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const p of SECRET_PATTERNS) {
    assert.match(p.id, /^[a-z][a-z0-9-]*$/)
    assert.ok(p.label.length > 0, p.id)
  }
})

// Issue #246. `/track qa` answers a stub where a surface draws, so the README must tell the person how to give the calls to the
// model on purpose: `--send`. The old promise ("run it when you want the model to have the calls") named no flag.
test('the README names --send as the way to give the calls to the model', () => {
  assert.ok(
    README.includes('Run `--send` when you want the model to have the calls.'),
    'the Privacy section tells the person to run --send when the model should have the calls',
  )
  assert.ok(README.includes('| `/track qa [--send] [n]` |'), 'the command table names the flag')
  assert.ok(!README.includes('Run it when you want the model to have the calls'), 'the old promise names no flag')
})
