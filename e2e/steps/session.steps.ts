import { Given } from '@cucumber/cucumber'
import type { DemoWorld } from '../support/world.ts'

Given('a Claude Code session with the artifact-tracking mod', async function (this: DemoWorld) {
  await this.launch()
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
