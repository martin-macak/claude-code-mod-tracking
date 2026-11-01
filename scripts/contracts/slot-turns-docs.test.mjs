// The e2e README and the demo-scenario skill name the slot-turns scenarios and their cost (issue #206). A later edit must not
// drop the text unnoticed. The anchors are the feature file, the cost words and the number of scenarios, which the feature pins.
// Run: node --experimental-transform-types --no-warnings --import ./scripts/coverage/loader.mjs --test scripts/contracts/slot-turns-docs.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const FEATURE = read('../../e2e/features/slot-turns.feature')
const DOCS = [
  ['e2e/README.md', read('../../e2e/README.md')],
  ['demo-scenario SKILL.md', read('../../.agents/skills/demo-scenario/SKILL.md')],
]

test('the feature has the four scenarios that the docs count', () => {
  assert.equal(FEATURE.split('\n').filter(l => l.startsWith('  Scenario:')).length, 4)
})

for (const [name, text] of DOCS) {
  test(`${name} names slot-turns.feature, its four scenarios and its cost`, () => {
    assert.ok(text.includes('slot-turns.feature'), `${name} names the feature`)
    assert.ok(/four scenarios/i.test(text), `${name} counts the scenarios`)
    assert.ok(text.includes('no model turn'), `${name} says that no model turn is paid`)
    assert.ok(text.includes('no login'), `${name} says that no login is needed`)
    assert.ok(text.includes('10 to 30 s'), `${name} gives the time of a scenario`)
  })
}
