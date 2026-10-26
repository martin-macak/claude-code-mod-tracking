// The three gate documents tell a person or an agent which e2e run to do after a change in `plugins/` or `e2e/`: AGENTS.md,
// the PR template and the pr-shepherd skill. `make e2e-safe` is the normal run (issue #223). `make e2e` adds the @artifacts
// scenario, which publishes a private page to claude.ai with the login of the person. A gate document that still names
// `make e2e` makes every author run that scenario. This check keeps the three documents in step. The pr-body check reads
// no box text, so a PR body that still names `make e2e` passes it (scripts/ci/check-pr-body.test.sh pins that).
// Run: node --experimental-transform-types --no-warnings --import ./scripts/coverage/loader.mjs --test scripts/contracts/e2e-gate-docs.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const read = path => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')

const GATE_DOCS = ['AGENTS.md', '.github/pull_request_template.md', '.agents/skills/pr-shepherd/SKILL.md']
// The sentence of a gate document that says when to run an e2e target.
const TRIGGER = /after a change in `plugins\/` or `e2e\/`|when `plugins\/` or `e2e\/` changed/i

const triggerLines = path =>
  read(path)
    .split('\n')
    .filter(line => TRIGGER.test(line))

for (const path of GATE_DOCS) {
  test(`${path} names make e2e-safe as the run after a change in plugins/ or e2e/`, () => {
    const lines = triggerLines(path)
    assert.ok(lines.length > 0, `${path} has a line that says when to run an e2e target, or this check proves nothing`)
    assert.deepEqual(
      lines.filter(line => !line.includes('`make e2e-safe`')),
      [],
    )
  })
}
