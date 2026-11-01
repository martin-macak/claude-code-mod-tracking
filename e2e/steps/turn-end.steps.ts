import { Given, When } from '@cucumber/cucumber'
import { TURN_END_MARK } from '../support/turn-end-probe.ts'
import type { DemoWorld } from '../support/world.ts'

// Issue #197. Put the step before the step that starts the session. The probe plugin (support/turn-end-probe.ts) adds a mark to
// the text that the `turn.complete` hooks return, and the engine draws that text as one row. The mark and the strip line of the
// mod are in that row: when the screen shows the mark, the line would show too.
Given('a plugin that marks the end of a turn', function (this: DemoWorld) {
  this.installTurnEndProbe()
})

// The Stop hook is no such event: `Claude finishes` returns before the `turn.complete` hook of the mod has returned.
When('the end of the turn has drawn', async function (this: DemoWorld) {
  await this.waitScreen(
    screen => screen.includes(TURN_END_MARK),
    `the screen to show the end-of-turn mark "${TURN_END_MARK}"`,
  )
})
