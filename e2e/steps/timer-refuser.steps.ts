import { Given, Then } from '@cucumber/cucumber'
import { refusals } from '../support/timer-refuser.ts'
import { waitUntil } from '../support/wait.ts'
import type { DemoWorld } from '../support/world.ts'

// A hook of another plugin can refuse an engine timer: the timer never fires and the caller hears nothing (issue #193). This
// probe plugin denies `clock.after` of one delay and passes the others (support/timer-refuser.ts). Put the step before the
// step that starts the session. Deny a delay that no other timer of the mod shares.
Given('a plugin that refuses clock.after of {int} ms', function (this: DemoWorld, ms: number) {
  this.installTimerRefuser(ms)
})

// The probe counts its refusals in a log. The step makes a scenario prove that the refusal took place, so the check of the
// ring does not pass in a run where nothing was refused.
Then('the timer refuser has refused a timer', async function (this: DemoWorld) {
  const probe = this.timerRefuser
  if (probe === undefined) throw new Error('the timer refuser has refused a timer: no timer refuser in this scenario')
  await waitUntil(() => (refusals(probe.logFile) > 0 ? true : undefined), {
    timeoutMs: this.config.screenTimeoutMs,
    what: 'the timer refuser to refuse a timer',
    last: () => `${refusals(probe.logFile)} refusals`,
  })
})
