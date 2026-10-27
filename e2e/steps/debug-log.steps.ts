import { Given, Then } from '@cucumber/cucumber'
import { debugLogHolds, debugLogTail } from '../support/debug-log.ts'
import { waitUntil } from '../support/wait.ts'
import type { DemoWorld } from '../support/world.ts'

// The mod writes lines to the debug log of the session with `$.ui.log(text, { to: 'debug' })`. The screen shows none of them.
// Put the first step before the step that starts the session: the file is a flag of the launch.
Given('the session writes a debug log', function (this: DemoWorld) {
  this.enableDebugLog()
})

// Waits for a line that holds the text. The text is read as it is, not as a pattern. A scenario that must show the wake of
// the ring pause (issue #193) uses it to tell the wake from a stray drawing: only the wake writes that line.
Then('the debug log shows {string}', async function (this: DemoWorld, text: string) {
  const file = this.debugLog
  if (file === undefined)
    throw new Error('the debug log shows: no debug log in this scenario (`the session writes a debug log`)')
  await waitUntil(() => (debugLogHolds(file, text) ? true : undefined), {
    timeoutMs: this.config.screenTimeoutMs,
    what: `the debug log to show "${text}"`,
    last: () => debugLogTail(file, 8),
  })
})
