import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// These tests pin what e2e/README.md says about running one scenario. They use `--dry-run`: no hook runs, so
// they take no lock, start no tmux and make no model turn.
const e2eDir = fileURLToPath(new URL('..', import.meta.url))
const cucumber = join(e2eDir, 'node_modules', '@cucumber', 'cucumber', 'bin', 'cucumber.js')

type Selected = { uri: string; name: string; steps: string[] }

// The scenarios that `cucumber-js --dry-run <args>` selects.
function select(...args: string[]): Selected[] {
  const run = spawnSync(process.execPath, [cucumber, '--dry-run', '--format', 'json', ...args], {
    cwd: e2eDir,
    encoding: 'utf8',
  })
  assert.equal(run.status, 0, run.stderr)
  const features = JSON.parse(run.stdout) as {
    uri: string
    elements: { name: string; steps: { keyword: string; name: string }[] }[]
  }[]
  return features.flatMap(feature =>
    feature.elements.map(({ name, steps }) => ({
      uri: feature.uri,
      name,
      steps: steps.filter(step => step.keyword !== 'Before' && step.keyword !== 'After').map(step => step.name),
    })),
  )
}

// The line of a scenario in a feature file, so the tests do not break when a scenario moves.
function lineOf(feature: string, title: string): number {
  const lines = readFileSync(join(e2eDir, feature), 'utf8').split('\n')
  const at = lines.findIndex(line => line.trimStart().startsWith(`Scenario: ${title}`))
  assert.notEqual(at, -1, `${feature} has no scenario "${title}"`)
  return at + 1
}

const PANE = 'features/pane.feature'
const TITLE = 'Tab moves the selection and x dismisses the selected row'

test('a path with the one profile runs that scenario and nothing else', () => {
  const selected = select('-p', 'one', `${PANE}:${lineOf(PANE, TITLE)}`)
  assert.deepEqual(
    selected.map(({ uri, name }) => ({ uri, name })),
    [{ uri: PANE, name: TITLE }],
  )
})

test('a path with the default profile merges with its paths and also runs the other feature files', () => {
  const selected = select(`${PANE}:${lineOf(PANE, TITLE)}`)
  assert.ok(
    selected.some(s => s.uri === PANE && s.name === TITLE),
    'the scenario of the path runs',
  )
  const others = new Set(selected.filter(s => s.uri !== PANE).map(s => s.uri))
  assert.ok(others.size >= 2, `the other feature files run too: ${[...others]}`)
  // Only the scenario of the path runs from its own file: the line filter still holds there.
  assert.deepEqual(
    selected.filter(s => s.uri === PANE).map(s => s.name),
    [TITLE],
  )
})

test('the tag @inline-help selects the inline help scenario alone', () => {
  const selected = select('--tags', '@inline-help')
  assert.equal(selected.length, 1)
  assert.match(selected[0]!.name, /3 config problems the inline help view/)
})

test('the h scenario of issue #140 runs docked at 120x36 and inline at 100x40, and each example checks its placement', () => {
  const examples = select('-p', 'one', PANE).filter(s =>
    s.name.startsWith('h moves the ring from a tracker key to h: back'),
  )
  assert.equal(examples.length, 2)
  const docked = examples.find(s => s.name.endsWith('at 120x36'))
  const inline = examples.find(s => s.name.endsWith('at 100x40'))
  assert.ok(docked !== undefined && inline !== undefined, 'one example for each size')
  // The size alone proves nothing: Claude Code decides where it seats the pane. The step reads what it drew.
  assert.ok(docked.steps.includes('a terminal of 120 columns by 36 rows'))
  assert.ok(docked.steps.includes('the pane is docked'))
  assert.ok(inline.steps.includes('a terminal of 100 columns by 40 rows'))
  assert.ok(inline.steps.includes('the pane is inline'))
})

test('the inline help scenario sets the width of the config file path before it writes the config file', () => {
  const [scenario] = select('--tags', '@inline-help')
  const steps = scenario!.steps
  const width = steps.findIndex(step => /^the tracker config file path is \d+ cells wide$/.test(step))
  assert.notEqual(width, -1, 'a step sets the width')
  assert.ok(width < steps.indexOf('the tracker config file:'), 'before the step that writes the file')
  assert.ok(steps.includes('the pane is inline'))
})
