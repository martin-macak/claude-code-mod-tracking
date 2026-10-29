import { Given } from '@cucumber/cucumber'
import { pinOriginHead } from '../support/session.ts'
import type { DemoWorld } from '../support/world.ts'

// Before the session step. A scenario runs at DEMO_COLS x DEMO_ROWS (120x36 by default), where the /track pane is docked
// beside the transcript. This step sets another size, for example 100 columns by 40 rows, where the pane is inline: a
// box under the transcript. A recorded scenario keeps the size of its recording.
Given('a terminal of {int} columns by {int} rows', function (this: DemoWorld, cols: number, rows: number) {
  this.setTerminalSize(cols, rows)
})

Given('a Claude Code session with the artifact-tracking mod', async function (this: DemoWorld) {
  await this.launch()
})

// After the session step, before the pane asks git. The clone has `origin/HEAD` at its HEAD whatever the checkout that started the
// harness was (support/session.ts, `pinOriginHead`). The diff mode reads git when a file is previewed, so the order is free.
// A slash is an alternative in a cucumber expression, so the one of `origin/HEAD` is escaped.
Given('the clone has origin\\/HEAD at its HEAD', function (this: DemoWorld) {
  pinOriginHead(this.cloneDir)
})

// The tools, separated by spaces, run without a permission dialog. The session may use tools.
Given(
  'a Claude Code session with the artifact-tracking mod and the tools {string}',
  async function (this: DemoWorld, tools: string) {
    await this.launch(undefined, tools.split(' ').filter(Boolean))
  },
)

Given(
  'a Claude Code session with the artifact-tracking mod and the prompt {string}',
  async function (this: DemoWorld, prompt: string) {
    await this.launch(prompt)
  },
)
