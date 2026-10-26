// The README and the spec say what `/track clean` does to a live worktree (issue #123). The code is the source: the config
// keys of the auto tracker and the words of the plan. A key that a doc does not list is a switch the person cannot find, and a
// plan line in the README that the code does not write is a promise it does not keep. Prose beyond these anchors has no test:
// a contract on wording would be overfit. The kit has no fs, so this check runs under node in `make test-scripts`.
// Run: node --experimental-transform-types --no-warnings --import ./scripts/coverage/loader.mjs --test scripts/contracts/clean-docs.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { planText } from '../../plugins/artifact-tracking/core/lib/clean-text.ts'
import { AUTO_DEFAULTS } from '../../plugins/artifact-tracking/trackers/auto/config.ts'

const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const README = read('../../plugins/artifact-tracking/README.md')
const SPEC = read('../../docs/superpowers/specs/2026-10-18-arch-hardening-design.md')

/** The one line of `text` that starts with `prefix`. */
function lineOf(text, prefix) {
  const lines = text.split('\n').filter(l => l.startsWith(prefix))
  assert.equal(lines.length, 1, `exactly one line starts with ${prefix}`)
  return lines[0]
}

const readmeRow = lineOf(README, '| `/track clean --yes worktrees` |')
const specClean = lineOf(SPEC, '| `clean [--hide\\|--log\\|--yes <kind>...]` |')
const specAuto = lineOf(SPEC, '| `auto` |')

test('the README row of --yes worktrees points to the paragraph that holds the live-tree rules', () => {
  assert.ok(readmeRow.includes('(see **Live worktrees** below)'), readmeRow)
  assert.ok(README.includes('\n**Live worktrees.** '), 'the README has the paragraph the row points to')
})

/** The sentence of the clean row that lists what `apply` checks again, in the order of the code. */
function applySentence() {
  const start = specClean.indexOf('`apply` checks again')
  assert.ok(start >= 0, 'the clean row says what `apply` checks again')
  return specClean.slice(start, specClean.indexOf('. ', start))
}

test('spec 5.12 lists the checks of apply in the order of the code: the proof comes before the switch', () => {
  const sentence = applySentence()
  assert.ok(sentence.includes('the proof') && sentence.includes('the switch'), sentence)
  assert.ok(sentence.indexOf('the proof') < sentence.indexOf('the switch'), sentence)
})

test('spec 5.12 says that apply reads the session cwd and the agent ledger at the step of each tree, before the status', () => {
  const sentence = applySentence()
  const at = word => {
    const i = sentence.indexOf(word)
    assert.ok(i >= 0, `the apply sentence has "${word}": ${sentence}`)
    return i
  }
  const [cwd, ledger, agent, status] = ['`session.cwd()`', 'the agent ledger', 'a running agent', '`git status'].map(at)
  assert.ok(cwd < ledger && ledger < agent && agent < status, sentence)
  // The cwd and the ledger move while an earlier remove runs (up to 120 s), so each is read again at the step of its tree.
  assert.ok(sentence.slice(cwd, agent).includes('read at the step of each tree'), sentence)
  assert.ok(sentence.includes('where the pane draws'), 'a running agent is the one that the pane draws in the tree')
})

test('spec 5.12 puts the check for a worktree inside the tree after the running agent and before the status, read at the step of each tree', () => {
  const sentence = applySentence()
  const at = word => {
    const i = sentence.indexOf(word)
    assert.ok(i >= 0, `the apply sentence has "${word}": ${sentence}`)
    return i
  }
  const [agent, inside, status] = ['a running agent', 'a worktree inside the tree', '`git status'].map(at)
  assert.ok(agent < inside && inside < status, sentence)
  // An agent can add a worktree while an earlier remove runs (up to 120 s), so the list is read again for each tree.
  const part = sentence.slice(inside, status)
  assert.ok(part.includes('read again at the step of each tree'), part)
  assert.ok(part.includes('holds the worktree <path>'), part)
})

test('the README lists the worktree inside the tree after the running agent and before the status, in numbered order', () => {
  const start = README.indexOf('\n**Live worktrees.** ')
  assert.ok(start >= 0, 'the README has the Live worktrees paragraph')
  const items = README.slice(start, README.indexOf('\n**Audit log.**', start))
    .split('\n')
    .filter(l => /^\d+\. /.test(l))
  for (const [i, l] of items.entries())
    assert.ok(l.startsWith(`${i + 1}. `), `the items are numbered 1, 2, 3, ...: ${l.slice(0, 40)}`)
  const at = word => {
    const i = items.findIndex(l => l.includes(word))
    assert.ok(i >= 0, `an item has "${word}"`)
    return i
  }
  const [agent, inside, status] = [
    '`an agent still works in it`',
    '`holds the worktree <path>`',
    'git status --porcelain',
  ].map(at)
  assert.ok(agent < inside && inside < status, items.map(l => l.slice(0, 30)).join(' | '))
  assert.ok(items[inside].includes('at the check of each tree'), 'the list is read at the check of each tree')
})

test('spec 5.12 states the limits: a squash- or rebase-merged branch is skipped, no git fetch runs, a remove stops at 120 s', () => {
  for (const word of ['squash', 'git fetch', '120 s'])
    assert.ok(specClean.includes(word), `the clean row has "${word}"`)
})

test('every key of the auto config except `enabled` has a README Configuration row with its default, and is in spec 5.7', () => {
  const keys = Object.keys(AUTO_DEFAULTS).filter(k => k !== 'enabled')
  assert.ok(keys.includes('destroyWorktrees'), 'the schema has the switch of issue #123')
  for (const key of keys) {
    const row = `| \`trackers.auto.${key}\` | ${AUTO_DEFAULTS[key]} |`
    assert.ok(
      README.split('\n').some(l => l.startsWith(row)),
      `the README table has: ${row}`,
    )
    assert.ok(specAuto.includes(`\`${key}\``), `spec 5.7 lists ${key}`)
  }
})

test('the README audit log names remove-worktree, and its example plan has the line that the code writes for that step', () => {
  assert.ok(lineOf(README, '**Audit log.**').includes('`remove-worktree`'))
  const label = '/work/.claude/worktrees/wf_ab12cd-3'
  const step = { kind: 'worktrees', id: `wt:${label}`, label, action: 'remove-worktree' }
  const written = planText([{ step }], [])
    .split('\n')
    .find(l => l.startsWith(`  ${label}:`))
  assert.ok(written, 'planText writes a line for the step')
  assert.ok(README.split('\n').includes(written), `the README example plan has: ${written}`)
})
