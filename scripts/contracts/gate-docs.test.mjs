// The agent gate (scripts/hooks/verify-gate.sh) is described in AGENTS.md and in the architecture knowledge base. Two kinds
// of sentence went stale after the gate changed: a line number in the script (`verify-gate.sh:101`), and a claim that the
// gate cannot see `gh stack` (it has matched `gh stack push|submit|sync|merge|link` since #58). A document points to the
// header of the script, which holds the rules, and not to a line. This check keeps the documents in step with the gate.
// A dated trial record may say what the gate did not do then: only a present-tense claim fails. The trial table in
// stacked-prs.md §3.1 and the decision record D14 do not match the phrases below, so they stay as history.
// Run: node --experimental-transform-types --no-warnings --import ./scripts/coverage/loader.mjs --test scripts/contracts/gate-docs.test.mjs
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const read = path => readFileSync(`${root}${path}`, 'utf8')

const KB = 'docs/knowledge-base/claude-code-mod-architecture'
// The documents that describe the gate. The verbatim sources and the dated design specs are no part of it.
const DOCS = [
  'AGENTS.md',
  ...readdirSync(`${root}${KB}`)
    .filter(name => name.endsWith('.md'))
    .map(name => `${KB}/${name}`),
]

const lines = DOCS.flatMap(path =>
  read(path)
    .split('\n')
    .map((text, index) => ({ at: `${path}:${index + 1}`, text })),
)

// A line that points into the script by number. The number moves with every edit of the script.
const LINE_REF = /verify-gate\.sh:\d+/
// A present-tense claim that the gate does not see a stack command.
const STALE_CLAIM = /only matches `git[^`]*push`|do(es)? not (match the agent gate regex|see `?gh stack`?|see it)/

test('the documents that describe the agent gate are found, or this check proves nothing', () => {
  assert.ok(lines.filter(line => line.text.includes('verify-gate.sh')).length >= 2)
  assert.ok(lines.filter(line => line.text.includes('gh stack')).length >= 2)
})

test('no document points into verify-gate.sh by line number', () => {
  assert.deepEqual(
    lines.filter(line => LINE_REF.test(line.text)).map(line => line.at),
    [],
  )
})

test('no document says that the agent gate cannot see gh stack', () => {
  assert.deepEqual(
    lines.filter(line => STALE_CLAIM.test(line.text)).map(line => line.at),
    [],
  )
})

// The index of the knowledge base and the page it links to gave different counts after the page lost a rule (the gate
// matches gh stack now). Every line that says how many repo rules need care must say the same number.
test('the documents agree on how many repo rules need care', () => {
  const counts = lines.flatMap(line => {
    const found = /\b(\w+) repo rules need care/.exec(line.text)
    return found ? [{ at: line.at, count: found[1].toLowerCase() }] : []
  })
  assert.ok(counts.length >= 2, 'the page and its index both say it')
  assert.equal(new Set(counts.map(entry => entry.count)).size, 1, JSON.stringify(counts))
})
