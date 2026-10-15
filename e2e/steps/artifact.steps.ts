import { After, type ITestCaseHookParameter, Status, Then, When } from '@cucumber/cucumber'
import { countLines } from '../support/session.ts'
import { waitUntil } from '../support/wait.ts'
import type { DemoWorld } from '../support/world.ts'

// The URL the Artifact tool prints: the base58 id of a 128-bit UUID.
const ARTIFACT_URL = /https:\/\/claude\.ai\/artifact\/[1-9A-HJ-NP-Za-km-z]{16,22}/

Then('the screen shows an artifact URL', async function (this: DemoWorld) {
  await this.waitScreen(screen => ARTIFACT_URL.test(screen), 'the screen to show an artifact URL')
  this.artifact = ARTIFACT_URL.exec(this.tmux.capture())?.[0]
})

Then('the artifact is deleted', function (this: DemoWorld) {
  this.artifact = undefined
})

// The Artifact tool asks before a delete. Its dialog lists "No" first, so Down picks "Yes".
// Ends with the turn, so a run where no dialog opens does not wait for one.
async function finishConfirming(world: DemoWorld, text: string): Promise<void> {
  let answered = false
  await waitUntil(
    () => {
      if (!answered && world.tmux.capture().includes(text)) {
        world.tmux.key('Down')
        world.tmux.key('Enter')
        answered = true
      }
      return countLines(world.signalFile) > world.turnMark ? true : undefined
    },
    { timeoutMs: world.config.turnTimeoutMs, what: 'the turn to end', last: () => world.tmux.capture() },
  )
}

When('Claude finishes, and I confirm {string} if asked', async function (this: DemoWorld, text: string) {
  this.tl.phase('fast')
  await finishConfirming(this, text)
  this.tl.phase('normal')
})

// A failed run must not leave a page on claude.ai. Runs before the world tears down the session.
After({ tags: '@artifacts' }, async function (this: DemoWorld, { result }: ITestCaseHookParameter) {
  if (result?.status !== Status.FAILED || this.artifact === undefined) return
  try {
    this.tmux.key('Escape') // a pane or a dialog may hold the prompt
    await this.typePrompt(`Delete the artifact ${this.artifact} with the Artifact tool.`)
    await finishConfirming(this, 'Permanently delete')
  } catch (e) {
    console.error(`cleanup failed: delete ${this.artifact} by hand. ${e instanceof Error ? e.message : e}`)
  }
})
