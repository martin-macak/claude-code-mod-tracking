import { existsSync, readFileSync } from 'node:fs'
import { Given, Then } from '@cucumber/cucumber'
import { fakeAcliSpec, type StatusCategory } from '../support/fake-acli.ts'
import { callsOf, type FakeCall } from '../support/fake-cli.ts'
import { waitUntil } from '../support/wait.ts'
import type { DemoWorld } from '../support/world.ts'

// The fake acli (support/fake-acli.ts) answers the calls of the jira tracker for one work item from a spec, so a scenario can
// show a Jira row without a Jira site, an account or a network. Put these steps before the step that starts the session.
const CATEGORIES: ReadonlySet<string> = new Set<StatusCategory>(['new', 'indeterminate', 'done'])

// Issue #226. acli is logged in to one site, and that site has one work item. The status category is the one of Jira
// (`new`, `indeterminate` or `done`): it sets the token of the row.
Given(
  'a fake acli logged in to {string} with the work item {string} {string} of type {string} in status {string} of category {word}',
  function (
    this: DemoWorld,
    site: string,
    key: string,
    summary: string,
    issueType: string,
    status: string,
    category: string,
  ) {
    if (!CATEGORIES.has(category)) throw new Error(`fake acli: ${category} is not one of ${[...CATEGORIES]}`)
    this.tl.phase('cut')
    this.setFakeAcli(
      fakeAcliSpec(site, [{ key, summary, issueType, status, statusCategory: category as StatusCategory }]),
    )
  },
)

// Issue #226. The model runs one command with the Bash tool, then says "Ran.". The session needs the tool and a rule that
// spares the dialog: `and the tool "Bash(acli jira workitem view:*)"`.
Given('a fake model that runs the command {string}', async function (this: DemoWorld, command: string) {
  await this.startFakeApi([
    [
      { type: 'text', text: 'I will run it.' },
      { type: 'tool_use', id: 'toolu_e2e_bash', name: 'Bash', input: { command } },
    ],
    [{ type: 'text', text: 'Ran.' }],
  ])
})

function log(world: DemoWorld) {
  const { logFile } = world.fakeAcliFiles
  return existsSync(logFile) ? callsOf(readFileSync(logFile, 'utf8')) : []
}

const failureReport = (world: DemoWorld) =>
  `fake acli calls: ${
    log(world)
      .map(c => `${c.call} (exit ${c.exit}) ${c.argv.join(' ')}`)
      .join(', ') || '(none: the fake is not first on the PATH of claude)'
  }\n--- screen ---\n${world.tmux.capture()}`

async function answered(world: DemoWorld, what: string, match: (c: FakeCall) => boolean) {
  world.tl.phase('fast')
  await waitUntil(() => (log(world).some(c => c.exit === 0 && match(c)) ? true : undefined), {
    timeoutMs: world.config.screenTimeoutMs,
    what: `the fake acli to answer ${what}`,
    last: () => failureReport(world),
  })
  world.tl.phase('normal')
}

// A call that the fake answered with exit 0. This is what shows that claude ran the fake and not a real acli.
Then('the fake acli answered {string}', async function (this: DemoWorld, call: string) {
  await answered(this, `"${call}"`, c => c.call === call)
})

// The exact argv. The refresh of the mod makes the same kind of call with `--fields` and `--json` added, so only the argv
// tells the Bash call of the model from a call of the mod.
Then('the fake acli answered {string} for {string}', async function (this: DemoWorld, call: string, argv: string) {
  await answered(this, `"${argv}"`, c => c.call === call && c.argv.join(' ') === argv)
})

// A call the fake does not know is a call the scenario never planned for: the mod would have asked real Jira.
Then('the fake acli answered no unsupported call', function (this: DemoWorld) {
  const calls = log(this)
  const unknown = calls.filter(c => c.call === 'unsupported').map(c => `acli ${c.argv.join(' ')}`)
  if (calls.length === 0) throw new Error(`the fake acli got no call\n${failureReport(this)}`)
  if (unknown.length > 0)
    throw new Error(`the fake acli got an unsupported call:\n  ${unknown.join('\n  ')}\n${failureReport(this)}`)
})
