import { When } from '@cucumber/cucumber'
import { sleep } from '../support/wait.ts'
import type { DemoWorld } from '../support/world.ts'

When('I type {string}', async function (this: DemoWorld, text: string) {
  await this.typePrompt(text)
})

When('I press {string}', function (this: DemoWorld, key: string) {
  this.tl.phase('normal')
  this.tmux.key(key)
})

When('Claude finishes', async function (this: DemoWorld) {
  await this.finishTurn()
})

When('I wait for {int} seconds', async function (this: DemoWorld, seconds: number) {
  this.tl.phase('fast')
  await sleep(seconds * 1000)
  this.tl.phase('normal')
})

// agg holds an idle frame for at most --idle-time-limit (5 s), so keep pauses at or below 5.
When('I pause for {float} seconds', async function (this: DemoWorld, seconds: number) {
  this.tl.phase('normal')
  await sleep(seconds * 1000)
})
