import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

// These tests pin what e2e/README.md says about running one scenario and about the @artifacts scenario: which profile
// selects it, and the scope of `make e2e` and `make e2e-safe`. They use `--dry-run`: no hook runs, so they take no
// lock, start no tmux and make no model turn.
const e2eDir = fileURLToPath(new URL('..', import.meta.url))
const cucumber = join(e2eDir, 'node_modules', '@cucumber', 'cucumber', 'bin', 'cucumber.js')

type Selected = { uri: string; name: string; tags: string[]; steps: string[] }

const selections = new Map<string, Selected[]>()

// The scenarios that `cucumber-js --dry-run <args>` selects. Each cucumber process takes about 1.3 s, so one process
// runs per distinct argument list. No test changes a result: they only `filter` and `map` it.
function select(...args: string[]): Selected[] {
  const key = JSON.stringify(args)
  const cached = selections.get(key)
  if (cached) return cached
  const selected = dryRun(args)
  selections.set(key, selected)
  return selected
}

function dryRun(args: string[]): Selected[] {
  const run = spawnSync(process.execPath, [cucumber, '--dry-run', '--format', 'json', ...args], {
    cwd: e2eDir,
    encoding: 'utf8',
    // A dry run takes a few seconds at most. An argument that makes cucumber hang must fail soon, not block the run.
    timeout: 30_000,
  })
  assert.equal(run.status, 0, `cucumber-js ${args.join(' ')}: ${run.error?.message ?? run.signal ?? run.stderr}`)
  const features = JSON.parse(run.stdout) as {
    uri: string
    elements: { name: string; tags?: { name: string }[]; steps: { keyword: string; name: string }[] }[]
  }[]
  return features.flatMap(feature =>
    feature.elements.map(({ name, tags, steps }) => ({
      uri: feature.uri,
      name,
      tags: (tags ?? []).map(tag => tag.name),
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

// The @artifacts scenario publishes a private page to claude.ai with the login of the person. A command that
// merely names a feature file must never run it (issue #198: it did, twice). Only a profile that says so selects it.
const ARTIFACTS = '@artifacts'
const OPT_IN_PROFILES = ['artifacts', 'all']
const artifactScenarios = (selected: Selected[]) => selected.filter(s => s.tags.includes(ARTIFACTS))

test('the default profile selects scenarios, and none of them is an @artifacts scenario', () => {
  const selected = select()
  assert.ok(selected.length > 0, 'the default profile selects something')
  assert.deepEqual(artifactScenarios(selected), [])
})

test('a bare feature path selects no @artifacts scenario', () => {
  assert.deepEqual(artifactScenarios(select(PANE)), [])
  // Naming the feature file of the scenario does not select it either: the tag expression of the default profile wins.
  const artifactsFeature = 'features/artifacts.feature'
  assert.deepEqual(
    select(artifactsFeature).filter(s => s.uri === artifactsFeature),
    [],
  )
})

test('no profile of cucumber.mjs selects an @artifacts scenario, except the opt-in profiles', async () => {
  const config = (await import(pathToFileURL(join(e2eDir, 'cucumber.mjs')).href)) as Record<string, unknown>
  const profiles = Object.keys(config)
  assert.ok(profiles.includes('default'), 'the default profile exists')
  for (const opt of OPT_IN_PROFILES) assert.ok(profiles.includes(opt), `the opt-in profile ${opt} exists`)
  for (const profile of profiles.filter(name => !OPT_IN_PROFILES.includes(name))) {
    const selected = profile === 'default' ? select() : select('-p', profile)
    assert.deepEqual(artifactScenarios(selected), [], `the profile ${profile} must not select an @artifacts scenario`)
  }
})

test('the artifacts profile selects the @artifacts scenario and nothing else', () => {
  const selected = select('-p', 'artifacts')
  assert.ok(selected.length > 0, 'the profile selects the scenario')
  assert.deepEqual(selected, artifactScenarios(selected))
})

test('--tags keeps working with the default profile: it narrows the selection and never adds @artifacts', () => {
  const skip = select('--tags', 'not @artifacts')
  assert.deepEqual(skip, select())
  // The tag expressions of the profile and of the command line are joined with `and`, so this selects nothing.
  assert.deepEqual(select('--tags', ARTIFACTS), [])
})

test('the demo profile still selects the @demo scenario alone', () => {
  const selected = select('-p', 'demo')
  assert.ok(selected.length > 0, 'the demo profile selects the scenario')
  assert.ok(
    selected.every(s => s.tags.includes('@demo')),
    'every selected scenario is @demo',
  )
})

// The arguments that the recipe of a make target gives to cucumber-js. The tests below select scenarios with them, so
// they check what the target runs and not what a document says. It takes the text of the Makefile, so a test can feed
// it a recipe of its own.
function parseRecipeArgs(makefileText: string, target: string): string[] {
  const makefile = makefileText.split('\n')
  const at = makefile.findIndex(line => line.startsWith(`${target}:`))
  assert.notEqual(at, -1, `the Makefile has a ${target} target`)
  // The recipe is the run of tab-indented lines under the target.
  const recipeLines = makefile.slice(at + 1)
  const end = recipeLines.findIndex(line => !line.startsWith('\t'))
  // A backslash at the end of a line continues the recipe on the next one, as make and the shell read it.
  const recipe = recipeLines
    .slice(0, end)
    .join('\n')
    .replace(/\\\n\s*/g, ' ')
  assert.match(recipe, /cucumber-js/, `the ${target} target runs cucumber-js`)
  // Plain words only: the test cannot read a quoted argument, so it cuts the recipe at the first shell operator.
  const args = recipe
    .split('cucumber-js')[1]!
    .split(/&&|;|\|/)[0]!
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  assert.ok(
    args.every(arg => !/['"$\\]/.test(arg)),
    `the recipe of ${target} has an argument this test cannot read: ${args}`,
  )
  return args
}

const recipeArgs = (target: string): string[] =>
  parseRecipeArgs(readFileSync(join(e2eDir, '..', 'Makefile'), 'utf8'), target)

// A Makefile with one target, `demo-target`, whose recipe is the lines given.
const makefileWith = (...recipe: string[]) =>
  ['demo-target: e2e-deps', ...recipe, '', 'other:', '\ttrue', ''].join('\n')

test('the recipe parser reads a recipe line that ends in a backslash together with the next line', () => {
  const makefile = makefileWith('\tcd e2e && npx cucumber-js \\', '\t  -p all')
  assert.deepEqual(parseRecipeArgs(makefile, 'demo-target'), ['-p', 'all'])
})

test('the recipe parser refuses a backslash inside a word, which it cannot read', () => {
  const makefile = makefileWith('\tcd e2e && npx cucumber-js --name a\\ b')
  assert.throws(() => parseRecipeArgs(makefile, 'demo-target'), /an argument this test cannot read/)
})

const names = (list: Selected[]) => list.map(s => `${s.uri}: ${s.name}`).sort()

test('make e2e runs every scenario: the profile of its recipe selects the @artifacts scenario and all the others', () => {
  const selected = select(...recipeArgs('e2e'))
  assert.equal(artifactScenarios(selected).length, artifactScenarios(select('-p', 'artifacts')).length)
  assert.deepEqual(names(selected), names([...select(), ...select('-p', 'artifacts')]))
})

test('make e2e-safe runs the default profile: every scenario except @artifacts, so it publishes nothing', () => {
  const selected = select(...recipeArgs('e2e-safe'))
  assert.ok(selected.length > 0, 'the target selects scenarios')
  assert.deepEqual(artifactScenarios(selected), [], 'the target selects no @artifacts scenario')
  assert.deepEqual(names(selected), names(select()), 'the target selects what the default profile selects')
})
