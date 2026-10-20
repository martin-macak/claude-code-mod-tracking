import { When } from '@cucumber/cucumber'
import { countLines } from '../support/session.ts'
import { sleep, waitUntil } from '../support/wait.ts'
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

// For a key that sends a prompt (the resolve key). The key does nothing until the PR lane has saved what it looked up (a
// toast says so), so it is pressed again every second until the screen shows its effect. A second press is safe: a
// queued PR refuses it. The turn that the press starts is the one to wait for, so the mark is taken before the first
// press: a command or a key before it started none.
When(
  'I press {string} until the screen matches {regex}, then Claude finishes',
  async function (this: DemoWorld, key: string, re: RegExp) {
    this.tl.phase('normal')
    this.turnMark = countLines(this.signalFile)
    await waitUntil(
      () => {
        if (re.test(this.tmux.capture())) return true
        this.tmux.key(key)
        return undefined
      },
      {
        timeoutMs: this.config.screenTimeoutMs,
        intervalMs: 1000,
        what: `the screen to match ${re} while "${key}" is pressed`,
        last: () => this.tmux.capture(),
      },
    )
    await this.finishTurn()
  },
)

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
