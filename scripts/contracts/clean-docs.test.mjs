// The README and the spec say what `/track clean` does to a live worktree and to an exited container (issue #123). The code is
// the source: the config keys of the auto and processes trackers, the usage line and the words of the plan. A key that a doc does not list is a switch the person cannot find, and a
// plan line in the README that the code does not write is a promise it does not keep. Prose beyond these anchors has no test:
// a contract on wording would be overfit. The kit has no fs, so this check runs under node in `make test-scripts`.
// Run: node --experimental-transform-types --no-warnings --import ./scripts/coverage/loader.mjs --test scripts/contracts/clean-docs.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CLEAN_USAGE, planText } from '../../plugins/artifact-tracking/core/lib/clean-text.ts'
import { AUTO_DEFAULTS } from '../../plugins/artifact-tracking/trackers/auto/config.ts'
import { PROCESSES_DEFAULTS } from '../../plugins/artifact-tracking/trackers/processes/config.ts'
import { NO_OWN_NAME, NOT_ALONE } from '../../plugins/artifact-tracking/trackers/processes/probe.ts'

const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const README = read('../../plugins/artifact-tracking/README.md')
const SPEC = read('../../docs/superpowers/specs/2026-10-18-arch-hardening-design.md')
const KB = read('../../docs/knowledge-base/claude-code-mods/concepts/process-tracking-signals.md')

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

// ---------------------------------------------------------------- containers (issue #123, PR 2)

const readmeContainers = lineOf(README, '| `/track clean --yes containers` |')
const specProcesses = lineOf(SPEC, '| `processes` |')

test('the README row of --yes containers points to the paragraph that holds the container rules', () => {
  assert.ok(readmeContainers.includes('(see **Containers** below)'), readmeContainers)
  assert.ok(README.includes('\n**Containers.** '), 'the README has the paragraph the row points to')
})

test('every key of the processes config except `enabled` has a README Configuration row with its default, and is in spec 5.7', () => {
  const keys = Object.keys(PROCESSES_DEFAULTS).filter(k => k !== 'enabled')
  assert.ok(keys.includes('destroyContainers'), 'the schema has the switch of issue #123')
  for (const key of keys) {
    const row = `| \`trackers.processes.${key}\` | ${PROCESSES_DEFAULTS[key]} |`
    assert.ok(
      README.split('\n').some(l => l.startsWith(row)),
      `the README table has: ${row}`,
    )
    assert.ok(specProcesses.includes(`\`${key}\``), `spec 5.7 lists ${key}`)
  }
})

test('spec 5.12 names the usage line of the code, with the kinds that the code accepts', () => {
  assert.ok(specClean.includes(CLEAN_USAGE.replaceAll('|', '\\|')), `the clean row has: ${CLEAN_USAGE}`)
})

test('the README example plan has the lines that the code writes for a remove-container step and for one that is skipped', () => {
  const head = 'Containers (apply with /track clean --yes containers)'
  const step = { kind: 'containers', id: 'docker:ctr:api', label: 'api', action: 'remove-container' }
  const skipped = {
    kind: 'containers',
    id: 'docker:ctr:web',
    label: 'web',
    action: 'remove-container',
    skip: 'the container id is not proven',
  }
  const written = planText([{ step }, { step: skipped }], []).split('\n')
  const at = written.indexOf(head)
  assert.ok(at >= 0, 'planText writes the head of the kind')
  const readme = README.split('\n')
  const from = readme.indexOf(head)
  assert.ok(from >= 0, `the README example plan has: ${head}`)
  assert.deepEqual(readme.slice(from, from + 3), written.slice(at, at + 3))
})

test('the README audit log names remove-container', () => {
  assert.ok(lineOf(README, '**Audit log.**').includes('`remove-container`'))
})

test('the README lists the checks of a container in the order of the code: id, state, label, creation time, name', () => {
  const start = README.indexOf('\n**Containers.** ')
  assert.ok(start >= 0, 'the README has the Containers paragraph')
  const items = README.slice(start, README.indexOf('\n**Worktrees.**', start))
    .split('\n')
    .filter(l => /^\d+\. /.test(l))
  for (const [i, l] of items.entries())
    assert.ok(l.startsWith(`${i + 1}. `), `the items are numbered 1, 2, 3, ...: ${l.slice(0, 40)}`)
  const at = word => {
    const i = items.findIndex(l => l.includes(word))
    assert.ok(i >= 0, `an item has "${word}"`)
    return i
  }
  const order = [
    'docker container inspect',
    '`docker named another container`',
    '`exited`',
    '`org.testcontainers`',
    '`Created`',
    '`--name`',
  ].map(at)
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    items.map(l => l.slice(0, 30)).join(' | '),
  )
})

test('spec 5.12 names what the container apply checks and its limits', () => {
  for (const word of [
    '`docker container inspect --format',
    '`org.testcontainers`',
    '`SPAWN_WINDOW_MS`',
    '`docker rm <id>`',
    '`containerGone`',
    '`containerIdExact`',
    'no upper bound',
    'no `-v`',
    '`REMOVE_TIMEOUT_MS`',
    '120 s',
    'docker rm did not finish',
  ])
    assert.ok(specClean.includes(word), `the clean row has "${word}"`)
})

test('the README Containers paragraph says that docker rm has a limit of 120 s and what an rm that runs past it reads', () => {
  const start = README.indexOf('\n**Containers.** ')
  const paragraph = README.slice(start, README.indexOf('\n**Worktrees.**', start))
  for (const word of ['120 s', '`skipped: docker rm did not finish, the container may be gone: <line>`'])
    assert.ok(paragraph.includes(word), `the paragraph has "${word}"`)
})

// Review of PR 285. A row with no `--name` is never removed (P1), and a listing that the runner cut sets no `containerGone` (P2).
// Each is a promise of the code, so each doc says it with the words that the code writes.
test('the README, spec 5.12 and the KB page say that a row with no --name is never removed, with the reason that the plan prints', () => {
  const start = README.indexOf('\n**Containers.** ')
  const paragraph = README.slice(start, README.indexOf('\n**Worktrees.**', start))
  assert.ok(paragraph.includes(`\`skipped: ${NO_OWN_NAME}\``), 'the README paragraph has the plan reason')
  assert.ok(specClean.includes(`\`skipped: ${NO_OWN_NAME}\``), 'spec 5.12 has the plan reason')
  assert.ok(KB.includes(`\`skipped: ${NO_OWN_NAME}\``), 'the KB page has the plan reason')
})

// Review of PR 285, P1 again, and the ninth round (the lone-command rule). A `--name` is no proof that the run made the container: Docker
// keeps names unique, so a run that failed on a taken name pairs with the id of the old container that holds it. The row needs
// `containerRunAlone`, and the parser grants it to one case only: the whole Bash call is one detached `docker run` (`isLoneRun`). Each doc
// names the mark, the reason that the plan prints, the rule and its cost. Nine rounds each closed one variant of "a command around the run
// prints an id" and opened the next, so the docs name none of the guards that the rule replaced.
test('the README, spec 5.12 and the KB page say that only a lone docker run is removed, with the reason that the plan prints and the cost', () => {
  const start = README.indexOf('\n**Containers.** ')
  const paragraph = README.slice(start, README.indexOf('\n**Worktrees.**', start))
  for (const [name, text] of [
    ['the README paragraph', paragraph],
    ['spec 5.12', specClean],
    ['the KB page', KB],
  ]) {
    const flat = text.replace(/\s+/g, ' ')
    assert.ok(flat.includes(`\`skipped: ${NOT_ALONE}\``), `${name} has the plan reason`)
    assert.ok(flat.includes('`containerRunAlone`'), `${name} names the mark`)
    assert.ok(flat.includes('one simple command'), `${name} says that the call is one simple command`)
    assert.ok(flat.includes('no wrapper before `docker`'), `${name} says that a wrapper withholds the mark`)
    assert.ok(flat.includes('no leading assignment'), `${name} says that an assignment withholds the mark`)
    assert.ok(flat.includes('no redirection of any kind'), `${name} says that a redirection withholds the mark`)
    assert.ok(
      flat.includes('a backslash does not continue'),
      `${name} says that a line break withholds the mark unless a backslash continues the line`,
    )
    // A backslash continues a line outside single quotes only: in single quotes `\<newline>` keeps both characters, and Docker
    // prints the part after the newline on a line of its own (round ten of PR 285).
    assert.ok(
      flat.includes('a backslash does not continue outside single quotes'),
      `${name} says that a backslash continues the line outside single quotes only`,
    )
    for (const word of ['`$(`', '`${`', "`$'`", 'backtick'])
      assert.ok(flat.includes(word), `${name} names a text that withholds the mark: ${word}`)
    assert.ok(
      flat.includes('`cd /x && docker run -d --name api nginx`') &&
        flat.includes('`env docker run -d --name api nginx`'),
      `${name} pins the cost`,
    )
    for (const gone of [
      'PRINTS_NOTHING',
      'PRINTS_ALONE',
      'mayPrintAnId',
      'mayHoldNewline',
      'hasCommandSubstitution',
      'setTurnsTraceOn',
      'setMayPrint',
      'exportMayPrintList',
      'cdMayPrintDirectory',
      'leadMayPrint',
    ])
      assert.ok(!flat.includes(gone), `${name} names a guard that the lone-command rule removed: ${gone}`)
  }
  assert.ok(README.includes('`containerRunAlone: true`'), 'the README Container ids paragraph names the mark')
  // The Known limits of the README say the rule in one sentence.
  assert.ok(
    README.includes('`/track clean` removes a container only when its `docker run -d` was the whole Bash command.'),
    'the README Known limits say that a container is removed only when its run was the whole Bash command',
  )
})

test('the README, spec 5.12 and the KB page say that a cut docker ps listing sets no containerGone mark', () => {
  const start = README.indexOf('\n**Containers.** ')
  const paragraph = README.slice(start, README.indexOf('\n**Worktrees.**', start))
  for (const [name, text] of [
    ['the README paragraph', paragraph],
    ['spec 5.12', specClean],
    ['the KB page', KB],
  ])
    assert.ok(text.includes('proves no absence'), `${name} says that a cut listing proves no absence`)
})
