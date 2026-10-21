import { When } from '@cucumber/cucumber'
import { focusedTexts, selectedLine } from '../support/pane.ts'
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

// A key the person repeats, one press at a time. Each press waits until the selected row moved, so a slow redraw cannot
// swallow a key (issue #104). Use it only for presses that move between rows: a press onto the footer does not change the
// selected row, so the wait would time out.
When('I press {string} {int} times', async function (this: DemoWorld, key: string, times: number) {
  this.tl.phase('normal')
  for (let i = 0; i < times; i++) {
    const before = selectedLine(this.tmux.capture())
    this.tmux.key(key)
    await this.waitScreen(
      screen => selectedLine(screen) !== before,
      `press ${i + 1} of ${times} of ${key} to move the selected row`,
    )
  }
})

// A key the person repeats until the focus ring reaches a Button. Each press waits until the ring moved (reverse video), so
// a slow redraw cannot swallow a key (issue #104), and the count of presses is no part of the scenario. For a walk over
// the footer, where the selected row does not move and `I press {string} {int} times` would time out.
const MOST_PRESSES = 30

When(
  'I press {string} until the focus ring is on {string}',
  async function (this: DemoWorld, key: string, text: string) {
    this.tl.phase('normal')
    for (let presses = 0; ; presses++) {
      const before = focusedTexts(this.tmux.captureAnsi())
      if (before.some(focused => focused.includes(text))) return
      if (presses >= MOST_PRESSES)
        throw new Error(`the focus ring did not reach "${text}" in ${MOST_PRESSES} presses of ${key}`)
      this.tmux.key(key)
      await this.waitScreen(
        screen => focusedTexts(screen).join('\n') !== before.join('\n'),
        `press ${presses + 1} of ${key} to move the focus ring off ${JSON.stringify(before)}`,
        { ansi: true },
      )
    }
  },
)

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
