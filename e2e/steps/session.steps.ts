import { Given } from '@cucumber/cucumber'
import type { DemoWorld } from '../support/world.ts'

Given('a Claude Code session with the artifact-tracking mod', async function (this: DemoWorld) {
  await this.launch()
})

Given(
  'a Claude Code session with the artifact-tracking mod and the prompt {string}',
  async function (this: DemoWorld, prompt: string) {
    await this.launch(prompt)
  },
)
